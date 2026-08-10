//! The canonical integer objective.
//!
//! Portfolio QUBOs are built from floats, but float objectives are a poor
//! settlement layer: two machines can disagree in the last bits. This module
//! quantizes a QUBO to integer coefficients once, and from then on the integer
//! objective — evaluated in `i128`, no rounding, no platform variance — is the
//! *canonical* number every solver optimizes and reports. It is exactly the
//! computation an on-chain program can replay to verify a submitted solution.

use crate::model::QuboModel;

/// Default coefficient bound: fits `i32`, so a single term product fits `i64`
/// and any realistic sum fits `i128` with enormous headroom.
pub const DEFAULT_MAX_COEFF: i64 = i32::MAX as i64;

/// A QUBO with integer coefficients (upper-triangular convention, like
/// [`QuboModel`]) and the scale that maps integer objective values back to the
/// original float units.
#[derive(Debug, Clone, PartialEq)]
pub struct QuantizedQubo {
    n: usize,
    q: Vec<i64>,
    /// `integer_value ≈ float_value * scale`.
    pub scale: f64,
}

impl QuantizedQubo {
    /// Quantize `qubo` so the largest |coefficient| becomes `max_coeff`.
    ///
    /// Panics if `max_coeff <= 0` or any coefficient is non-finite.
    pub fn quantize(qubo: &QuboModel<f64>, max_coeff: i64) -> Self {
        assert!(max_coeff > 0, "max_coeff must be positive");
        let n = qubo.n();
        let mut max_abs = 0.0f64;
        for i in 0..n {
            for j in i..n {
                let v = qubo.term(i, j);
                assert!(v.is_finite(), "QUBO coefficient ({i},{j}) is not finite");
                max_abs = max_abs.max(v.abs());
            }
        }
        let scale = if max_abs == 0.0 {
            1.0
        } else {
            max_coeff as f64 / max_abs
        };
        let mut q = vec![0i64; n * n];
        for i in 0..n {
            for j in i..n {
                q[i * n + j] = (qubo.term(i, j) * scale).round() as i64;
            }
        }
        Self { n, q, scale }
    }

    pub fn n(&self) -> usize {
        self.n
    }

    /// Integer coefficient of `x_i x_j` (order-insensitive).
    pub fn term(&self, i: usize, j: usize) -> i64 {
        let (a, b) = if i <= j { (i, j) } else { (j, i) };
        self.q[a * self.n + b]
    }

    /// The exact integer objective `Σ_i q_ii x_i + Σ_{i<j} q_ij x_i x_j`,
    /// evaluated in `i128`. This is the canonical, replayable number.
    pub fn objective(&self, bits: &[u8]) -> i128 {
        assert_eq!(bits.len(), self.n, "bit vector length mismatch");
        let mut total: i128 = 0;
        for i in 0..self.n {
            if bits[i] == 0 {
                continue;
            }
            let row = &self.q[i * self.n..(i + 1) * self.n];
            total += row[i] as i128;
            for (&coeff, &bit) in row[(i + 1)..].iter().zip(bits[(i + 1)..].iter()) {
                if bit != 0 {
                    total += coeff as i128;
                }
            }
        }
        total
    }

    /// Map an integer objective back to the original float units.
    pub fn dequantize(&self, objective: i128) -> f64 {
        objective as f64 / self.scale
    }

    /// The integer coefficients as a float QUBO. Solvers should be pointed at
    /// *this* model (not the pre-quantization floats) so that what they
    /// optimize is exactly what [`objective`](Self::objective) scores.
    /// Coefficients bounded by [`DEFAULT_MAX_COEFF`] are exactly representable
    /// in `f64`, so no precision is lost in this direction.
    pub fn to_qubo(&self) -> QuboModel<f64> {
        let mut qubo = QuboModel::new(self.n);
        for i in 0..self.n {
            for j in i..self.n {
                let v = self.q[i * self.n + j];
                if v != 0 {
                    qubo.set_term(i, j, v as f64);
                }
            }
        }
        qubo
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_and_score() {
        let mut q = QuboModel::<f64>::new(2);
        q.set_term(0, 0, -1.0);
        q.set_term(1, 1, 0.5);
        q.set_term(0, 1, 0.25);

        let qq = QuantizedQubo::quantize(&q, 1000);
        // max_abs = 1.0 -> scale 1000
        assert_eq!(qq.term(0, 0), -1000);
        assert_eq!(qq.term(1, 1), 500);
        assert_eq!(qq.term(0, 1), 250);

        assert_eq!(qq.objective(&[1, 0]), -1000);
        assert_eq!(qq.objective(&[1, 1]), -1000 + 500 + 250);
        assert!((qq.dequantize(qq.objective(&[1, 1])) - (-0.25)).abs() < 1e-9);
    }

    #[test]
    fn zero_qubo_scale_is_one() {
        let q = QuboModel::<f64>::new(3);
        let qq = QuantizedQubo::quantize(&q, DEFAULT_MAX_COEFF);
        assert_eq!(qq.scale, 1.0);
        assert_eq!(qq.objective(&[1, 1, 1]), 0);
    }

    #[test]
    fn integer_roundtrip_matches_float_model() {
        let mut q = QuboModel::<f64>::new(4);
        q.set_term(0, 0, 3.7);
        q.set_term(1, 2, -1.9);
        q.set_term(3, 3, 0.61);
        q.set_term(0, 3, 2.2);

        let qq = QuantizedQubo::quantize(&q, DEFAULT_MAX_COEFF);
        let as_float = qq.to_qubo();
        let bits = [1u8, 1, 1, 1];
        // The float view of the integer model scores identically (i32-bounded
        // integers are exact in f64).
        assert_eq!(as_float.objective(&bits), qq.objective(&bits) as f64);
    }
}
