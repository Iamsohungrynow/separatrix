//! Problem representations: Ising models and QUBOs.
//!
//! Conventions (fixed across the whole crate):
//!
//! * **Ising**: spins `s ∈ {−1, +1}ⁿ`, energy
//!   `E(s) = −½ Σ_{i≠j} J_ij s_i s_j − Σ_i h_i s_i`
//!   with `J` symmetric and zero-diagonal. Positive `J_ij` favors alignment.
//! * **QUBO**: bits `x ∈ {0, 1}ⁿ`, objective
//!   `f(x) = Σ_i Q_ii x_i + Σ_{i<j} Q_ij x_i x_j`
//!   (upper-triangular convention; the diagonal holds the linear terms).
//! * Every solver **minimizes**.
//!
//! [`IsingModel::from_qubo`] maps between the two so that
//! `f(x) = E(s) + offset` with `x_i = (1 + s_i)/2`.

use num_traits::Float;

/// Dense symmetric Ising model. Storage is a full row-major `n × n` matrix so
/// solvers can stream rows in the hot loop; setters keep it symmetric with a
/// zero diagonal.
#[derive(Debug, Clone, PartialEq)]
pub struct IsingModel<T> {
    n: usize,
    j: Vec<T>,
    h: Vec<T>,
}

impl<T: Float> IsingModel<T> {
    pub fn new(n: usize) -> Self {
        Self {
            n,
            j: vec![T::zero(); n * n],
            h: vec![T::zero(); n],
        }
    }

    pub fn n(&self) -> usize {
        self.n
    }

    /// Set coupling `J_ij = J_ji = value`. Panics if `i == j` (the diagonal is
    /// identically zero) or out of range.
    pub fn set_coupling(&mut self, i: usize, j: usize, value: T) {
        assert!(
            i != j,
            "Ising coupling requires i != j (diagonal is fixed at zero)"
        );
        assert!(i < self.n && j < self.n, "coupling index out of range");
        self.j[i * self.n + j] = value;
        self.j[j * self.n + i] = value;
    }

    pub fn coupling(&self, i: usize, j: usize) -> T {
        self.j[i * self.n + j]
    }

    pub fn set_field(&mut self, i: usize, value: T) {
        self.h[i] = value;
    }

    pub fn field(&self, i: usize) -> T {
        self.h[i]
    }

    pub fn fields(&self) -> &[T] {
        &self.h
    }

    /// Row `i` of the coupling matrix (length `n`, `row[i] == 0`).
    #[inline]
    pub fn j_row(&self, i: usize) -> &[T] {
        &self.j[i * self.n..(i + 1) * self.n]
    }

    /// `E(s) = −½ Σ_{i≠j} J_ij s_i s_j − Σ_i h_i s_i`.
    ///
    /// Panics if `spins.len() != n`; entries must be ±1.
    pub fn energy(&self, spins: &[i8]) -> T {
        assert_eq!(spins.len(), self.n, "spin vector length mismatch");
        let half = T::from(0.5).unwrap();
        let mut pair = T::zero();
        let mut field = T::zero();
        for i in 0..self.n {
            let s_i = T::from(spins[i]).unwrap();
            let row = self.j_row(i);
            let mut acc = T::zero();
            for (&jv, &sv) in row.iter().zip(spins.iter()) {
                acc = acc + jv * T::from(sv).unwrap();
            }
            pair = pair + s_i * acc;
            field = field + self.h[i] * s_i;
        }
        -half * pair - field
    }

    /// Local fields `ℓ_i = Σ_j J_ij s_j + h_i`. The energy change of flipping
    /// spin `i` is `ΔE = 2 s_i ℓ_i` (with `s_i` the pre-flip value).
    pub fn local_fields(&self, spins: &[i8]) -> Vec<T> {
        assert_eq!(spins.len(), self.n, "spin vector length mismatch");
        (0..self.n)
            .map(|i| {
                let row = self.j_row(i);
                let mut acc = self.h[i];
                for (&jv, &sv) in row.iter().zip(spins.iter()) {
                    acc = acc + jv * T::from(sv).unwrap();
                }
                acc
            })
            .collect()
    }

    /// RMS of the off-diagonal couplings, `σ = sqrt(Σ_{i≠j} J_ij² / (n(n−1)))`.
    /// Used by solver auto-scaling heuristics (Goto et al.'s `ξ₀`).
    pub fn coupling_rms(&self) -> T {
        if self.n < 2 {
            return T::zero();
        }
        let mut sum = T::zero();
        for i in 0..self.n {
            let row = self.j_row(i);
            for (j, &v) in row.iter().enumerate() {
                if j != i {
                    sum = sum + v * v;
                }
            }
        }
        let pairs = T::from(self.n * (self.n - 1)).unwrap();
        (sum / pairs).sqrt()
    }

    /// Largest absolute external field.
    pub fn field_max_abs(&self) -> T {
        self.h
            .iter()
            .fold(T::zero(), |m, &v| if v.abs() > m { v.abs() } else { m })
    }

    /// Convert a QUBO into `(ising, offset)` such that for any bits `x` and
    /// the corresponding spins `s_i = 2 x_i − 1`:
    /// `qubo.objective(x) == ising.energy(s) + offset`.
    pub fn from_qubo(qubo: &QuboModel<T>) -> (Self, T) {
        let n = qubo.n();
        let quarter = T::from(0.25).unwrap();
        let half = T::from(0.5).unwrap();
        let mut ising = Self::new(n);
        let mut offset = T::zero();

        for i in 0..n {
            let q_ii = qubo.term(i, i);
            offset = offset + half * q_ii;
            let mut linear = half * q_ii;
            for j in 0..n {
                if j == i {
                    continue;
                }
                let q_ij = qubo.term(i, j);
                linear = linear + quarter * q_ij;
                if j > i {
                    offset = offset + quarter * q_ij;
                    ising.set_coupling(i, j, -quarter * q_ij);
                }
            }
            ising.set_field(i, -linear);
        }
        (ising, offset)
    }
}

/// Dense QUBO in the upper-triangular convention:
/// `f(x) = Σ_i Q_ii x_i + Σ_{i<j} Q_ij x_i x_j`.
#[derive(Debug, Clone, PartialEq)]
pub struct QuboModel<T> {
    n: usize,
    q: Vec<T>,
}

impl<T: Float> QuboModel<T> {
    pub fn new(n: usize) -> Self {
        Self {
            n,
            q: vec![T::zero(); n * n],
        }
    }

    pub fn n(&self) -> usize {
        self.n
    }

    /// Set the coefficient of `x_i x_j` (or the linear coefficient of `x_i`
    /// when `i == j`). Order of `i`/`j` does not matter; the value is stored
    /// once, in the upper triangle.
    pub fn set_term(&mut self, i: usize, j: usize, value: T) {
        assert!(i < self.n && j < self.n, "QUBO index out of range");
        let (a, b) = if i <= j { (i, j) } else { (j, i) };
        self.q[a * self.n + b] = value;
    }

    /// Coefficient of `x_i x_j` (upper-triangular lookup, order-insensitive).
    pub fn term(&self, i: usize, j: usize) -> T {
        let (a, b) = if i <= j { (i, j) } else { (j, i) };
        self.q[a * self.n + b]
    }

    /// `f(x) = Σ_i Q_ii x_i + Σ_{i<j} Q_ij x_i x_j` for bits `x ∈ {0,1}ⁿ`.
    pub fn objective(&self, bits: &[u8]) -> T {
        assert_eq!(bits.len(), self.n, "bit vector length mismatch");
        let mut total = T::zero();
        for i in 0..self.n {
            if bits[i] == 0 {
                continue;
            }
            let row = &self.q[i * self.n..(i + 1) * self.n];
            total = total + row[i];
            for (&coeff, &bit) in row[(i + 1)..].iter().zip(bits[(i + 1)..].iter()) {
                if bit != 0 {
                    total = total + coeff;
                }
            }
        }
        total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn energy_of_two_aligned_spins() {
        // E = -J s0 s1 - h0 s0 - h1 s1
        let mut m = IsingModel::<f64>::new(2);
        m.set_coupling(0, 1, 1.0);
        m.set_field(0, 0.5);
        assert_eq!(m.energy(&[1, 1]), -1.0 - 0.5);
        assert_eq!(m.energy(&[1, -1]), 1.0 - 0.5);
        assert_eq!(m.energy(&[-1, -1]), -1.0 + 0.5);
    }

    #[test]
    fn qubo_objective_counts_upper_triangle_once() {
        let mut q = QuboModel::<f64>::new(3);
        q.set_term(0, 0, 1.0);
        q.set_term(2, 0, 2.0); // stored as (0,2)
        q.set_term(1, 2, -3.0);
        assert_eq!(q.objective(&[1, 0, 1]), 1.0 + 2.0);
        assert_eq!(q.objective(&[1, 1, 1]), 1.0 + 2.0 - 3.0);
        assert_eq!(q.objective(&[0, 0, 0]), 0.0);
    }

    #[test]
    fn qubo_to_ising_matches_on_all_configs() {
        let mut q = QuboModel::<f64>::new(3);
        q.set_term(0, 0, 1.5);
        q.set_term(1, 1, -2.0);
        q.set_term(0, 1, 3.0);
        q.set_term(1, 2, -1.0);
        q.set_term(0, 2, 0.5);

        let (ising, offset) = IsingModel::from_qubo(&q);
        for mask in 0..8u32 {
            let bits: Vec<u8> = (0..3).map(|b| ((mask >> b) & 1) as u8).collect();
            let spins: Vec<i8> = bits.iter().map(|&b| if b == 1 { 1 } else { -1 }).collect();
            let f = q.objective(&bits);
            let e = ising.energy(&spins) + offset;
            assert!((f - e).abs() < 1e-12, "mask {mask}: f={f} e={e}");
        }
    }
}
