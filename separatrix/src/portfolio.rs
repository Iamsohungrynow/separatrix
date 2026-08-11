//! Cardinality-constrained portfolio selection as a QUBO.
//!
//! From `n` assets choose exactly `k`, equal-weighted. With bits
//! `x ∈ {0,1}ⁿ` and weights `w_i = x_i/k`, the (minimized) float objective is
//!
//! ```text
//! f(x) = (1/k²)·xᵀΣx − (λ/k)·μᵀx + P·(Σx − k)²
//! ```
//!
//! The constant `P·k²` arising from expanding the penalty cannot be stored in
//! a [`QuboModel`], so it is dropped from the coefficients and returned
//! separately as [`SelectionQubo::offset`]: `f(x) = qubo(x) + offset`. Optima
//! and absolute gaps are unaffected by the shift, but **relative** gaps are
//! not — dividing by a `qubo(x)` value still carrying `−P·k²` normalizes by
//! the penalty scale instead of the portfolio objective and understates the
//! gap by orders of magnitude. Always add `offset` back before forming a
//! ratio.
//!
//! Workflow: [`build_selection_qubo`] → [`QuantizedQubo::quantize`] → solve
//! the penalized QUBO with any heuristic → [`repair_to_k`] if infeasible →
//! score against [`exact_k`] ground truth. The integer objective is canonical
//! throughout; the penalty term is zero on the feasible set, so heuristics and
//! the constrained enumerator are scored on identical numbers.

use crate::model::QuboModel;
use crate::quantized::QuantizedQubo;
use crate::Error;

/// Inputs for [`build_selection_qubo`]. `sigma` is row-major `n × n` and is
/// symmetrized as `(σ_ij + σ_ji)/2` on ingestion.
#[derive(Debug, Clone)]
pub struct PortfolioSpec<'a> {
    /// Expected returns, length `n` (e.g. mean daily log-returns).
    pub mu: &'a [f64],
    /// Covariance matrix, row-major, length `n·n`.
    pub sigma: &'a [f64],
    /// Return/risk trade-off `λ ≥ 0`.
    pub risk_aversion: f64,
    /// Assets to select (`1 ≤ k ≤ n`).
    pub k: usize,
    /// Cardinality penalty `P`. `None` auto-scales (see below).
    pub penalty: Option<f64>,
}

/// A built selection QUBO plus the pieces needed to interpret its values.
#[derive(Debug, Clone)]
pub struct SelectionQubo {
    /// The penalized QUBO the solvers minimize.
    pub qubo: QuboModel<f64>,
    /// The cardinality penalty `P` actually used (auto-scaled unless supplied).
    pub penalty: f64,
    /// `P·k²`. Add to a QUBO value to recover the portfolio objective:
    /// `f(x) = qubo(x) + offset`, exact on the feasible set.
    pub offset: f64,
}

/// Build the penalized selection QUBO.
///
/// Auto-penalty: with `B = max_i (|c_i| + Σ_{j≠i} |q_ij|)` over the
/// pre-penalty coefficients (the largest possible objective change from any
/// single bit flip), `P = 2B + 1e-12`. Any single step off the cardinality
/// manifold then costs at least `P` while gaining at most `B`, so violations
/// never pay locally. This is a strong heuristic, not a global proof — which
/// is one reason the feasible-set ground truth in [`exact_k`] exists.
pub fn build_selection_qubo(spec: &PortfolioSpec<'_>) -> Result<SelectionQubo, Error> {
    let n = spec.mu.len();
    if n == 0 {
        return Err(Error::InvalidInput("empty asset universe".into()));
    }
    if spec.sigma.len() != n * n {
        return Err(Error::InvalidInput(format!(
            "sigma has {} entries, expected n*n = {}",
            spec.sigma.len(),
            n * n
        )));
    }
    if spec.k == 0 || spec.k > n {
        return Err(Error::InvalidInput(format!(
            "k = {} outside 1..={n}",
            spec.k
        )));
    }
    if !spec.risk_aversion.is_finite() || spec.risk_aversion < 0.0 {
        return Err(Error::InvalidInput("risk_aversion must be finite and >= 0".into()));
    }
    for (idx, v) in spec.mu.iter().chain(spec.sigma.iter()).enumerate() {
        if !v.is_finite() {
            return Err(Error::InvalidInput(format!(
                "non-finite input at flat index {idx}"
            )));
        }
    }
    if let Some(p) = spec.penalty {
        if !p.is_finite() || p <= 0.0 {
            return Err(Error::InvalidInput("penalty must be finite and > 0".into()));
        }
    }

    let k = spec.k as f64;
    let inv_k2 = 1.0 / (k * k);
    let lam_over_k = spec.risk_aversion / k;
    let sym = |i: usize, j: usize| (spec.sigma[i * n + j] + spec.sigma[j * n + i]) / 2.0;

    // Pre-penalty coefficients: diag c_i, pairs q_ij (i<j).
    let mut diag = vec![0.0f64; n];
    let mut pairs = vec![0.0f64; n * n];
    for i in 0..n {
        diag[i] = inv_k2 * sym(i, i) - lam_over_k * spec.mu[i];
        for j in (i + 1)..n {
            pairs[i * n + j] = 2.0 * inv_k2 * sym(i, j);
        }
    }

    let penalty = spec.penalty.unwrap_or_else(|| {
        let mut bound: f64 = 0.0;
        for (i, d) in diag.iter().enumerate() {
            let mut row = d.abs();
            for j in 0..n {
                if j != i {
                    let (a, b) = if i < j { (i, j) } else { (j, i) };
                    row += pairs[a * n + b].abs();
                }
            }
            bound = bound.max(row);
        }
        2.0 * bound + 1e-12
    });

    // Penalty expansion (constant P·k² returned as `offset`, not stored):
    // diag += P·(1 − 2k); pairs += 2P.
    let mut qubo = QuboModel::new(n);
    for i in 0..n {
        qubo.set_term(i, i, diag[i] + penalty * (1.0 - 2.0 * k));
        for j in (i + 1)..n {
            qubo.set_term(i, j, pairs[i * n + j] + 2.0 * penalty);
        }
    }
    Ok(SelectionQubo {
        qubo,
        penalty,
        offset: penalty * k * k,
    })
}

/// Contribution of bit `i` to the integer objective given the other set bits:
/// `q_ii + Σ_{j≠i, x_j=1} q_ij`. Flipping `i` on adds this; flipping it off
/// removes it.
fn contribution(qq: &QuantizedQubo, bits: &[u8], i: usize) -> i128 {
    let mut c = qq.term(i, i) as i128;
    for (j, &b) in bits.iter().enumerate() {
        if j != i && b != 0 {
            c += qq.term(i, j) as i128;
        }
    }
    c
}

/// Greedily repair `bits` to exactly `k` set bits, each step taking the
/// add/drop with the best marginal change of the canonical integer objective.
/// Already-feasible inputs are returned unchanged. O(n²) per step.
pub fn repair_to_k(qq: &QuantizedQubo, bits: &mut [u8], k: usize) {
    let n = qq.n();
    assert_eq!(bits.len(), n, "bit vector length mismatch");
    assert!(k <= n, "k must be <= n");

    let mut count: usize = bits.iter().filter(|&&b| b != 0).count();

    while count > k {
        // Drop the set bit whose removal lowers the objective most
        // (largest contribution).
        let mut best: Option<(usize, i128)> = None;
        for i in 0..n {
            if bits[i] != 0 {
                let c = contribution(qq, bits, i);
                if best.is_none_or(|(_, bc)| c > bc) {
                    best = Some((i, c));
                }
            }
        }
        bits[best.expect("count > k implies a set bit").0] = 0;
        count -= 1;
    }

    while count < k {
        // Add the unset bit with the smallest (most negative) contribution.
        let mut best: Option<(usize, i128)> = None;
        for i in 0..n {
            if bits[i] == 0 {
                let c = contribution(qq, bits, i);
                if best.is_none_or(|(_, bc)| c < bc) {
                    best = Some((i, c));
                }
            }
        }
        bits[best.expect("count < k <= n implies an unset bit").0] = 1;
        count += 1;
    }
}

/// Number of `k`-subsets of `n` elements, saturating at `u128::MAX`.
pub fn subset_count(n: usize, k: usize) -> u128 {
    if k > n {
        return 0;
    }
    let k = k.min(n - k);
    let mut acc: u128 = 1;
    for i in 0..k {
        acc = match acc.checked_mul((n - i) as u128) {
            Some(v) => v / (i as u128 + 1),
            None => return u128::MAX,
        };
    }
    acc
}

/// Exact ground truth over the feasible set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactK {
    /// Optimal configuration.
    pub bits: Vec<u8>,
    /// Its canonical integer objective (the minimum over all `k`-subsets).
    pub objective: i128,
    /// The maximum over all `k`-subsets. `worst − objective` is the full
    /// achievable spread, which makes a scale-free, penalty-free measure of
    /// how good a heuristic's answer is: `gap / spread` is stable even where
    /// the optimum sits near zero and a ratio to it would explode.
    pub worst: i128,
}

/// Exact ground truth on the feasible set: enumerate every `k`-subset and
/// return the best bits, the optimal objective, and the worst objective.
/// Refuses instances with more than `max_subsets` subsets rather than running
/// unbounded.
///
/// DFS in increasing index order with an incrementally maintained objective
/// (O(k) per node), so the total work is ~`C(n,k)·k` adds.
pub fn exact_k(qq: &QuantizedQubo, k: usize, max_subsets: u64) -> Result<ExactK, Error> {
    let n = qq.n();
    if k == 0 || k > n {
        return Err(Error::InvalidInput(format!("k = {k} outside 1..={n}")));
    }
    let subsets = subset_count(n, k);
    if subsets > max_subsets as u128 {
        return Err(Error::TooManySubsets {
            subsets,
            max: max_subsets,
        });
    }

    struct Search<'a> {
        qq: &'a QuantizedQubo,
        n: usize,
        k: usize,
        chosen: Vec<usize>,
        best_obj: i128,
        worst_obj: i128,
        best: Vec<usize>,
    }

    impl Search<'_> {
        /// DFS over index-increasing k-subsets, carrying the objective of the
        /// chosen prefix.
        fn dfs(&mut self, start: usize, obj: i128) {
            if self.chosen.len() == self.k {
                if obj < self.best_obj {
                    self.best_obj = obj;
                    self.best.clone_from(&self.chosen);
                }
                if obj > self.worst_obj {
                    self.worst_obj = obj;
                }
                return;
            }
            let remaining = self.k - self.chosen.len();
            // Highest start index that still leaves enough elements.
            for i in start..=(self.n - remaining) {
                let mut delta = self.qq.term(i, i) as i128;
                for &j in self.chosen.iter() {
                    delta += self.qq.term(i, j) as i128;
                }
                self.chosen.push(i);
                self.dfs(i + 1, obj + delta);
                self.chosen.pop();
            }
        }
    }

    let mut search = Search {
        qq,
        n,
        k,
        chosen: Vec::with_capacity(k),
        best_obj: i128::MAX,
        worst_obj: i128::MIN,
        best: Vec::new(),
    };
    search.dfs(0, 0);

    let mut bits = vec![0u8; n];
    for &i in &search.best {
        bits[i] = 1;
    }
    debug_assert_eq!(qq.objective(&bits), search.best_obj);
    Ok(ExactK {
        bits,
        objective: search.best_obj,
        worst: search.worst_obj,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::IsingModel;
    use crate::quantized::DEFAULT_MAX_COEFF;
    use crate::{exact, SaConfig, Solver};

    fn toy_spec(n: usize, seed: u64) -> (Vec<f64>, Vec<f64>) {
        // Deterministic mu/sigma; sigma symmetric positive-ish.
        let mut state = seed;
        let mut next = move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as f64 / (1u64 << 31) as f64
        };
        let mu: Vec<f64> = (0..n).map(|_| (next() - 0.5) * 0.01).collect();
        let mut sigma = vec![0.0; n * n];
        for i in 0..n {
            for j in i..n {
                let v = if i == j {
                    0.0005 + next() * 0.002
                } else {
                    (next() - 0.5) * 0.0008
                };
                sigma[i * n + j] = v;
                sigma[j * n + i] = v;
            }
        }
        (mu, sigma)
    }

    #[test]
    fn coefficients_match_hand_derivation() {
        // n=2, k=1, lambda=2, P=10:
        // diag_i = sigma_ii/1 - 2*mu_i + P(1-2) ; pair = 2*sigma_01 + 2P
        let mu = [0.01, -0.02];
        let sigma = [0.04, 0.01, 0.01, 0.09];
        let built = build_selection_qubo(&PortfolioSpec {
            mu: &mu,
            sigma: &sigma,
            risk_aversion: 2.0,
            k: 1,
            penalty: Some(10.0),
        })
        .unwrap();
        let q = &built.qubo;
        assert!((q.term(0, 0) - (0.04 - 0.02 - 10.0)).abs() < 1e-12);
        assert!((q.term(1, 1) - (0.09 + 0.04 - 10.0)).abs() < 1e-12);
        assert!((q.term(0, 1) - (0.02 + 20.0)).abs() < 1e-12);
        // offset = P·k² = 10·1
        assert!((built.offset - 10.0).abs() < 1e-12);
        assert!((built.penalty - 10.0).abs() < 1e-12);
    }

    /// `qubo(x) + offset` must equal the portfolio objective
    /// `(1/k²)xᵀΣx − (λ/k)μᵀx` on every feasible x — this is what makes a
    /// relative gap meaningful.
    #[test]
    fn offset_recovers_the_portfolio_objective() {
        let n = 10;
        let k = 4usize;
        let lambda = 0.5;
        let (mu, sigma) = toy_spec(n, 33);
        let built = build_selection_qubo(&PortfolioSpec {
            mu: &mu,
            sigma: &sigma,
            risk_aversion: lambda,
            k,
            penalty: None,
        })
        .unwrap();

        for mask in 0..(1u32 << n) {
            if mask.count_ones() as usize != k {
                continue;
            }
            let bits: Vec<u8> = (0..n).map(|b| ((mask >> b) & 1) as u8).collect();
            // Direct evaluation of the float objective.
            let kf = k as f64;
            let mut risk = 0.0;
            let mut ret = 0.0;
            for i in 0..n {
                if bits[i] == 0 {
                    continue;
                }
                ret += mu[i];
                for j in 0..n {
                    if bits[j] != 0 {
                        risk += sigma[i * n + j];
                    }
                }
            }
            let direct = risk / (kf * kf) - lambda * ret / kf;
            let via_qubo = built.qubo.objective(&bits) + built.offset;
            assert!(
                (direct - via_qubo).abs() < 1e-9,
                "mask {mask}: direct {direct} vs qubo+offset {via_qubo}"
            );
        }
    }

    #[test]
    fn auto_penalty_makes_the_global_optimum_feasible() {
        for seed in [1u64, 2, 3, 4, 5] {
            let (mu, sigma) = toy_spec(10, seed);
            let built = build_selection_qubo(&PortfolioSpec {
                mu: &mu,
                sigma: &sigma,
                risk_aversion: 0.5,
                k: 4,
                penalty: None,
            })
            .unwrap();
            let qq = QuantizedQubo::quantize(&built.qubo, DEFAULT_MAX_COEFF);
            let (ising, _) = IsingModel::from_qubo(&qq.to_qubo());
            let ground = exact::solve(&ising).unwrap();
            let ones = ground.bits().iter().filter(|&&b| b == 1).count();
            assert_eq!(ones, 4, "seed {seed}: unconstrained optimum violated k");
        }
    }

    #[test]
    fn exact_k_matches_filtered_full_enumeration() {
        let (mu, sigma) = toy_spec(12, 7);
        let built = build_selection_qubo(&PortfolioSpec {
            mu: &mu,
            sigma: &sigma,
            risk_aversion: 0.7,
            k: 4,
            penalty: None,
        })
        .unwrap();
        let qq = QuantizedQubo::quantize(&built.qubo, DEFAULT_MAX_COEFF);

        // Reference: brute-force every popcount-4 bitmask.
        let n = 12;
        let mut best = i128::MAX;
        let mut worst = i128::MIN;
        for mask in 0u32..(1 << n) {
            if mask.count_ones() as usize != 4 {
                continue;
            }
            let bits: Vec<u8> = (0..n).map(|b| ((mask >> b) & 1) as u8).collect();
            let obj = qq.objective(&bits);
            best = best.min(obj);
            worst = worst.max(obj);
        }

        let got = exact_k(&qq, 4, 1_000_000).unwrap();
        assert_eq!(got.objective, best);
        assert_eq!(got.worst, worst);
        assert_eq!(got.bits.iter().filter(|&&b| b != 0).count(), 4);
        assert_eq!(qq.objective(&got.bits), got.objective);
    }

    #[test]
    fn exact_k_refuses_oversized_instances() {
        let (mu, sigma) = toy_spec(40, 3);
        let built = build_selection_qubo(&PortfolioSpec {
            mu: &mu,
            sigma: &sigma,
            risk_aversion: 0.5,
            k: 12,
            penalty: None,
        })
        .unwrap();
        let qq = QuantizedQubo::quantize(&built.qubo, DEFAULT_MAX_COEFF);
        match exact_k(&qq, 12, 1_000_000) {
            Err(Error::TooManySubsets { subsets, max }) => {
                assert_eq!(subsets, subset_count(40, 12));
                assert_eq!(max, 1_000_000);
            }
            other => panic!("expected TooManySubsets, got {other:?}"),
        }
    }

    #[test]
    fn repair_reaches_k_and_never_beats_exact() {
        let (mu, sigma) = toy_spec(14, 11);
        let built = build_selection_qubo(&PortfolioSpec {
            mu: &mu,
            sigma: &sigma,
            risk_aversion: 0.5,
            k: 5,
            penalty: None,
        })
        .unwrap();
        let qq = QuantizedQubo::quantize(&built.qubo, DEFAULT_MAX_COEFF);
        let exact_obj = exact_k(&qq, 5, 10_000_000).unwrap().objective;

        for start_ones in [0usize, 2, 5, 9, 14] {
            let mut bits = vec![0u8; 14];
            for b in bits.iter_mut().take(start_ones) {
                *b = 1;
            }
            let feasible_before = start_ones == 5;
            let before = bits.clone();
            repair_to_k(&qq, &mut bits, 5);
            assert_eq!(bits.iter().filter(|&&b| b != 0).count(), 5);
            if feasible_before {
                assert_eq!(bits, before, "feasible input must be unchanged");
            }
            assert!(qq.objective(&bits) >= exact_obj);
        }
    }

    #[test]
    fn heuristic_pipeline_end_to_end() {
        // Solve the penalized QUBO with SA, repair, and compare to exact_k —
        // the exact flow the CLI runs.
        let (mu, sigma) = toy_spec(16, 21);
        let built = build_selection_qubo(&PortfolioSpec {
            mu: &mu,
            sigma: &sigma,
            risk_aversion: 0.5,
            k: 6,
            penalty: None,
        })
        .unwrap();
        let qq = QuantizedQubo::quantize(&built.qubo, DEFAULT_MAX_COEFF);
        let (ising, _) = IsingModel::from_qubo(&qq.to_qubo());
        let r = Solver::Sa(SaConfig {
            sweeps: 2000,
            restarts: 8,
            seed: 9,
            ..SaConfig::default()
        })
        .solve(&ising)
        .unwrap();
        let mut bits = r.bits();
        repair_to_k(&qq, &mut bits, 6);
        let exact_obj = exact_k(&qq, 6, 10_000_000).unwrap().objective;
        let gap = qq.objective(&bits) - exact_obj;
        assert!(gap >= 0);
    }

    #[test]
    fn subset_count_values() {
        assert_eq!(subset_count(40, 12), 5_586_853_480);
        assert_eq!(subset_count(30, 8), 5_852_925);
        assert_eq!(subset_count(5, 5), 1);
        assert_eq!(subset_count(4, 6), 0);
    }
}
