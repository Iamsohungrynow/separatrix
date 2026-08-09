//! # separatrix
//!
//! Quantum-inspired Ising/QUBO solvers in pure Rust: **simulated bifurcation**
//! (the Toshiba-lineage bSB/dSB algorithms, Goto et al. 2019/2021) next to the
//! classical baselines any honest benchmark needs — simulated annealing,
//! parallel tempering, and exact enumeration as ground truth.
//!
//! The name: as the pump ramps, each SB oscillator crosses the *separatrix* —
//! the boundary between basins of attraction — and commits to spin +1 or −1.
//!
//! ## Honesty contract
//!
//! Simulated bifurcation is a **classical** algorithm derived from the
//! adiabatic dynamics of Kerr-parametric-oscillator networks. This crate
//! claims no quantum advantage and no guaranteed speedup over classical
//! baselines; that is what the baselines are *for*. On small instances, exact
//! methods are fast and provably optimal — measure heuristics against
//! [`exact`], and report optimality gaps, not adjectives.
//!
//! ## Example
//!
//! ```
//! use separatrix::{IsingModel, QuboModel, Solver, SbConfig};
//!
//! // A 3-bit QUBO: minimize  -x0 - x1 + 2·x0·x1 - x2
//! let mut qubo = QuboModel::<f64>::new(3);
//! qubo.set_term(0, 0, -1.0);
//! qubo.set_term(1, 1, -1.0);
//! qubo.set_term(0, 1, 2.0);
//! qubo.set_term(2, 2, -1.0);
//!
//! let (ising, offset) = IsingModel::from_qubo(&qubo);
//! let result = Solver::Sb(SbConfig::default()).solve(&ising).unwrap();
//!
//! let objective = qubo.objective(&result.bits());
//! assert_eq!(objective, result.energy + offset);
//! assert_eq!(objective, -2.0); // optimum: exactly one of x0/x1, plus x2
//! ```
//!
//! ## Determinism and portability
//!
//! Every solver is seeded explicitly and fully deterministic for a given
//! (config, seed) — results are reproducible bit-for-bit on the same target.
//! The crate has no OS-entropy dependency and the core builds for
//! `wasm32-unknown-unknown` with `default-features = false`.
//!
//! For settlement-grade objectives (e.g. scoring solutions on-chain), quantize
//! once with [`QuantizedQubo`] and treat its `i128` integer objective as
//! canonical; floats are for dynamics, integers are for keeping score.

pub mod exact;
pub mod model;
mod parallel;
pub mod pt;
pub mod quantized;
pub mod result;
mod rng;
pub mod sa;
pub mod sb;

pub use model::{IsingModel, QuboModel};
pub use pt::PtConfig;
pub use quantized::{QuantizedQubo, DEFAULT_MAX_COEFF};
pub use result::{spins_from_bits, SolveResult};
pub use sa::SaConfig;
pub use sb::{SbConfig, SbVariant};

use num_traits::Float;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The exact solver enumerates 2ⁿ states and refuses problems it cannot
    /// finish in reasonable time.
    ProblemTooLarge { n: usize, max: usize },
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Error::ProblemTooLarge { n, max } => write!(
                f,
                "problem has {n} spins; exact enumeration is capped at {max}"
            ),
        }
    }
}

impl std::error::Error for Error {}

/// Uniform entry point over every solver in the crate, convenient for
/// benchmark harnesses that iterate `[Solver; N]`.
#[derive(Debug, Clone)]
pub enum Solver {
    /// Simulated bifurcation (ballistic or discrete per the config).
    Sb(SbConfig),
    /// Simulated annealing.
    Sa(SaConfig),
    /// Parallel tempering.
    Pt(PtConfig),
    /// Exhaustive ground truth (n ≤ [`exact::MAX_N`]).
    Exact,
}

impl Solver {
    pub fn name(&self) -> &'static str {
        match self {
            Solver::Sb(cfg) => match cfg.variant {
                SbVariant::Ballistic => "bSB",
                SbVariant::Discrete => "dSB",
            },
            Solver::Sa(_) => "SA",
            Solver::Pt(_) => "PT",
            Solver::Exact => "exact",
        }
    }

    pub fn solve<T: Float + Send + Sync>(
        &self,
        model: &IsingModel<T>,
    ) -> Result<SolveResult<T>, Error> {
        match self {
            Solver::Sb(cfg) => Ok(sb::solve(model, cfg)),
            Solver::Sa(cfg) => Ok(sa::solve(model, cfg)),
            Solver::Pt(cfg) => Ok(pt::solve(model, cfg)),
            Solver::Exact => exact::solve(model),
        }
    }
}
