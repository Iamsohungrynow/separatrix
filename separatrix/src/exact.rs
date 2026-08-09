//! Exact ground states by exhaustive enumeration — the crate's ground truth.
//!
//! Walks all 2ⁿ configurations in binary-reflected Gray-code order, so each
//! step flips exactly one spin and the energy updates in O(1) from cached
//! local fields (with an O(n) field refresh per step). Practical to n ≈ 26 on
//! a desktop in release builds; refuses larger problems rather than silently
//! taking hours.
//!
//! Use `f64` models here: energies accumulate incrementally over 2ⁿ updates
//! and `f32` drift can misrank near-degenerate states.

use crate::model::IsingModel;
use crate::result::SolveResult;
use crate::Error;
use num_traits::Float;

/// Largest problem [`solve`] will accept.
pub const MAX_N: usize = 26;

pub fn solve<T: Float>(model: &IsingModel<T>) -> Result<SolveResult<T>, Error> {
    let n = model.n();
    if n == 0 {
        return Ok(SolveResult {
            spins: Vec::new(),
            energy: T::zero(),
            steps: 0,
            seed: 0,
            replica: 0,
        });
    }
    if n > MAX_N {
        return Err(Error::ProblemTooLarge { n, max: MAX_N });
    }

    let two = T::from(2.0).unwrap();
    let mut spins = vec![-1i8; n];
    let mut fields = model.local_fields(&spins);
    let mut energy = model.energy(&spins);
    let mut best_energy = energy;
    let mut best_spins = spins.clone();

    let total: u64 = 1u64 << n;
    for k in 1..total {
        // Gray code: configuration k differs from k-1 in bit trailing_zeros(k).
        let i = k.trailing_zeros() as usize;
        let s = T::from(spins[i]).unwrap();
        energy = energy + two * s * fields[i];
        spins[i] = -spins[i];
        let s_new = T::from(spins[i]).unwrap();
        let row = model.j_row(i);
        for (f, &jv) in fields.iter_mut().zip(row.iter()) {
            *f = *f + two * jv * s_new;
        }
        if energy < best_energy {
            best_energy = energy;
            best_spins.copy_from_slice(&spins);
        }
    }

    Ok(SolveResult {
        spins: best_spins,
        energy: best_energy,
        steps: total,
        seed: 0,
        replica: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Naive reference: score every configuration from scratch.
    fn naive_minimum(model: &IsingModel<f64>) -> f64 {
        let n = model.n();
        let mut best = f64::INFINITY;
        for mask in 0..(1u32 << n) {
            let spins: Vec<i8> = (0..n)
                .map(|b| if (mask >> b) & 1 == 1 { 1 } else { -1 })
                .collect();
            best = best.min(model.energy(&spins));
        }
        best
    }

    #[test]
    fn matches_naive_enumeration() {
        let mut m = IsingModel::<f64>::new(10);
        for i in 0..10 {
            m.set_field(i, ((i * 13 % 7) as f64) - 3.0);
            for j in (i + 1)..10 {
                m.set_coupling(i, j, (((i * 31 + j * 17) % 11) as f64) - 5.0);
            }
        }
        let r = solve(&m).unwrap();
        let expected = naive_minimum(&m);
        assert!((r.energy - expected).abs() < 1e-9);
        // The reported spins must actually score the reported energy.
        assert!((m.energy(&r.spins) - r.energy).abs() < 1e-9);
    }

    #[test]
    fn refuses_oversized_problems() {
        let m = IsingModel::<f64>::new(MAX_N + 1);
        match solve(&m) {
            Err(Error::ProblemTooLarge { n, max }) => {
                assert_eq!(n, MAX_N + 1);
                assert_eq!(max, MAX_N);
            }
            other => panic!("expected ProblemTooLarge, got {other:?}"),
        }
    }
}
