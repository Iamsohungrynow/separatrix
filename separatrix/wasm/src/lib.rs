//! Browser bindings for the separatrix solvers.
//!
//! The point of running this in a tab is not speed — it is that the visitor
//! can move `n` and `k` themselves and watch exact enumeration go from
//! instant to impossible while the heuristics barely notice. That crossover
//! is the entire argument for the project, and it is more convincing felt
//! than asserted.
//!
//! Everything here is the same code the workbench runs: the same QUBO
//! builder, the same quantized integer objective, the same solvers. No
//! demo-only shortcuts.

use separatrix::portfolio::{
    build_selection_qubo, exact_k, repair_to_k, subset_count, PortfolioSpec,
};
use separatrix::{
    IsingModel, PtConfig, QuantizedQubo, SaConfig, SbConfig, SbVariant, Solver, DEFAULT_MAX_COEFF,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// One solver's result on the instance.
#[derive(Serialize)]
pub struct SolverRun {
    pub solver: String,
    /// Selected asset indices, ascending.
    pub selection: Vec<usize>,
    /// Canonical integer objective, as a string (i128 exceeds JS number range).
    pub objective_int: String,
    /// Distance from the proven optimum, or null when exact was skipped.
    pub gap_int: Option<String>,
    /// Gap as a fraction of the achievable spread: 0 optimal, 1 worst.
    pub gap_norm: Option<f64>,
    pub is_optimal: Option<bool>,
    /// Whether the raw solve was already exactly k assets (before repair).
    pub feasible_raw: bool,
    pub millis: f64,
}

#[derive(Serialize)]
pub struct ExactRun {
    pub selection: Vec<usize>,
    pub objective_int: String,
    pub worst_objective_int: String,
    pub millis: f64,
    /// How many k-subsets were enumerated to prove it.
    pub subsets: String,
}

#[derive(Serialize)]
pub struct SolveReport {
    pub n: usize,
    pub k: usize,
    /// C(n,k) as a string — the number that explodes.
    pub subsets: String,
    /// True when exact was skipped because the instance was too large.
    pub exact_skipped: bool,
    pub exact: Option<ExactRun>,
    pub results: Vec<SolverRun>,
}

/// `performance.now()` in milliseconds. Falls back to 0 outside a browser so
/// the crate stays testable under a plain wasm runtime.
fn now_ms() -> f64 {
    web_time_now().unwrap_or(0.0)
}

fn web_time_now() -> Option<f64> {
    let global = js_sys::global();
    let perf = js_sys::Reflect::get(&global, &JsValue::from_str("performance")).ok()?;
    if perf.is_undefined() {
        return None;
    }
    let func = js_sys::Reflect::get(&perf, &JsValue::from_str("now")).ok()?;
    let func: js_sys::Function = func.dyn_into().ok()?;
    func.call0(&perf).ok()?.as_f64()
}

fn selection_of(bits: &[u8]) -> Vec<usize> {
    bits.iter()
        .enumerate()
        .filter(|(_, &b)| b != 0)
        .map(|(i, _)| i)
        .collect()
}

/// Solve one cardinality-constrained portfolio instance with every solver.
///
/// `mu` is length `n`; `sigma` is row-major `n*n`. `max_subsets` caps exact
/// enumeration — above it the report comes back with `exact_skipped` set, which
/// is exactly the wall the demo is built to show.
#[wasm_bindgen]
pub fn solve_portfolio(
    mu: Vec<f64>,
    sigma: Vec<f64>,
    k: usize,
    risk_aversion: f64,
    seed: u64,
    steps: usize,
    max_subsets: f64,
) -> Result<JsValue, JsValue> {
    let n = mu.len();
    if sigma.len() != n * n {
        return Err(JsValue::from_str("sigma must be n*n, row-major"));
    }
    if k == 0 || k > n {
        return Err(JsValue::from_str("k must satisfy 1 <= k <= n"));
    }

    let built = build_selection_qubo(&PortfolioSpec {
        mu: &mu,
        sigma: &sigma,
        risk_aversion,
        k,
        penalty: None,
    })
    .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let qq = QuantizedQubo::quantize(&built.qubo, DEFAULT_MAX_COEFF);
    let (ising, _) = IsingModel::from_qubo(&qq.to_qubo());

    let total_subsets = subset_count(n, k);
    let cap = if max_subsets.is_finite() && max_subsets > 0.0 {
        max_subsets as u64
    } else {
        0
    };

    // Ground truth first, when the instance is small enough to afford it.
    let mut exact = None;
    let mut exact_obj: Option<i128> = None;
    let mut spread: Option<i128> = None;
    if cap > 0 && total_subsets <= cap as u128 {
        let started = now_ms();
        if let Ok(found) = exact_k(&qq, k, cap) {
            let elapsed = now_ms() - started;
            exact_obj = Some(found.objective);
            spread = Some((found.worst - found.objective).max(1));
            exact = Some(ExactRun {
                selection: selection_of(&found.bits),
                objective_int: found.objective.to_string(),
                worst_objective_int: found.worst.to_string(),
                millis: elapsed,
                subsets: total_subsets.to_string(),
            });
        }
    }

    let solvers: Vec<(&str, Solver)> = vec![
        (
            "bSB",
            Solver::Sb(SbConfig {
                variant: SbVariant::Ballistic,
                steps,
                replicas: 8,
                seed,
                ..SbConfig::default()
            }),
        ),
        (
            "dSB",
            Solver::Sb(SbConfig {
                variant: SbVariant::Discrete,
                steps,
                replicas: 8,
                seed,
                ..SbConfig::default()
            }),
        ),
        (
            "SA",
            Solver::Sa(SaConfig {
                sweeps: steps,
                restarts: 8,
                seed,
                ..SaConfig::default()
            }),
        ),
        (
            "PT",
            Solver::Pt(PtConfig {
                sweeps: steps,
                replicas: 16,
                seed,
                ..PtConfig::default()
            }),
        ),
    ];

    let mut results = Vec::with_capacity(solvers.len());
    for (name, solver) in solvers {
        let started = now_ms();
        let solved = solver
            .solve(&ising)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let mut bits = solved.bits();
        let feasible_raw = bits.iter().filter(|&&b| b != 0).count() == k;
        if !feasible_raw {
            repair_to_k(&qq, &mut bits, k);
        }
        let millis = now_ms() - started;

        let objective = qq.objective(&bits);
        let (gap_int, gap_norm, is_optimal) = match (exact_obj, spread) {
            (Some(best), Some(range)) => {
                let gap = objective - best;
                (
                    Some(gap.to_string()),
                    Some(gap as f64 / range as f64),
                    Some(gap == 0),
                )
            }
            _ => (None, None, None),
        };

        results.push(SolverRun {
            solver: name.to_string(),
            selection: selection_of(&bits),
            objective_int: objective.to_string(),
            gap_int,
            gap_norm,
            is_optimal,
            feasible_raw,
            millis,
        });
    }

    let report = SolveReport {
        n,
        k,
        subsets: total_subsets.to_string(),
        exact_skipped: exact.is_none(),
        exact,
        results,
    };
    serde_wasm_bindgen::to_value(&report).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// `C(n, k)` as a decimal string, so the page can show the search space
/// growing without doing big-integer arithmetic in JS.
#[wasm_bindgen]
pub fn subsets(n: usize, k: usize) -> String {
    subset_count(n, k).to_string()
}
