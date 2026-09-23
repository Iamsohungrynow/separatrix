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
//!
//! ## JavaScript surface
//!
//! Hand-maintained (the bundle is built with `--no-typescript`); keep it in
//! step with the functions below. The `no-modules` bundle defines a global
//! `wasm_bindgen`: in a classic worker, `importScripts(".../separatrix_wasm.js")`
//! then `await wasm_bindgen({ module_or_path: ".../separatrix_wasm_bg.wasm" })`
//! (or `wasm_bindgen.initSync({ module })`). Every call is synchronous and
//! throws a plain string on invalid input.
//!
//! ```ts
//! type SolverName = "bSB" | "dSB" | "SA" | "PT";
//! type Indices = Uint32Array | number[];
//! type Values = Float64Array | number[];
//!
//! // QUBO terms (rows[t], cols[t], vals[t]): i == j is linear, i != j is
//! // quadratic, and every term ACCUMULATES into Q[min(i,j)][max(i,j)], so
//! // (0,1,2) and (1,0,3) give Q01 = 5. 1 <= n <= 2048; indices < n; values
//! // finite; the three arrays equal length. "objective" is always the
//! // unquantized f(x) = sum_i Q_ii x_i + sum_{i<j} Q_ij x_i x_j.
//!
//! interface SolveQuboOptions {   // every field optional; null = default
//!   seed?: number | bigint;      // 1; any non-negative integer
//!   steps?: number;              // 1000; SB steps = SA and PT sweeps
//!   replicas?: number;           // 8; bSB/dSB replicas, SA restarts; PT uses 2x
//!   solvers?: SolverName[];      // all four; run and reported in this order
//!                                // (case-insensitive, duplicates dropped)
//!   exact?: boolean;             // true
//!   exactMaxN?: number;          // 22; clamped to 26 (separatrix::exact::MAX_N)
//! }
//! interface SolveQuboReport {
//!   n: number;
//!   results: { solver: SolverName; bits: number[]; objective: number; millis: number }[];
//!   exact: { bits: number[]; objective: number; millis: number;
//!            states: string /* 2^n, decimal */ } | null;
//!   exactSkipped: boolean;
//!   exactReason: string | null;  // "n = 30 exceeds the exact limit of 22",
//!                                // "exact enumeration disabled"; null when run
//! }
//! function solve_qubo(n: number, rows: Indices, cols: Indices, vals: Values,
//!                     opts?: SolveQuboOptions): SolveQuboReport;
//!
//! interface TraceOptions {
//!   variant?: "bSB" | "dSB";     // "bSB"
//!   steps?: number;              // 1000
//!   seed?: number | bigint;      // 1
//!   frames?: number;             // 180; clamped to [2, 600]
//!   couplingScale?: number;      // 1; multiplies the solver's default c0
//!                                // (display only: solve_qubo always uses 1)
//! }
//! interface SbTraceReport {
//!   n: number;
//!   steps: number;
//!   frames: number;
//!   x: Float32Array;             // frames * n, frame-major: x[f * n + i], in [-1, 1]
//!   objective: Float64Array;     // frames: f(bits of sign(x)) at each frame
//!                                // (Ising energy + offset; sign(0) = +1)
//!   frameSteps: Uint32Array;     // frames: integration step of each frame,
//!                                // floor(f * steps / (frames - 1)); frame 0 is
//!                                // the initial condition, the last is `steps`;
//!                                // steps repeat when frames > steps + 1
//!   bits: number[];              // best configuration measured (every 100
//!                                // steps and at the end), = bSB/dSB with 1 replica
//!   bestObjective: number;       // f(bits)
//! }
//! function trace_sb(n: number, rows: Indices, cols: Indices, vals: Values,
//!                   opts?: TraceOptions): SbTraceReport;
//!
//! interface PortfolioQubo {
//!   n: number;
//!   rows: number[]; cols: number[]; vals: number[]; // upper triangle with the
//!                                // diagonal, rows[t] <= cols[t], zeros omitted;
//!                                // feed straight back into solve_qubo/trace_sb
//!   penalty: number;             // cardinality penalty P (auto-scaled)
//!   offset: number;              // P * k^2, the constant the QUBO drops:
//!                                // portfolio objective = f(x) + offset on |x| = k
//! }
//! function portfolio_qubo(mu: Values, sigma: Values /* n*n row-major */,
//!                         k: number, riskAversion: number): PortfolioQubo;
//!
//! // The original demo's calls, unchanged:
//! function solve_portfolio(mu: Float64Array, sigma: Float64Array, k: number,
//!                          riskAversion: number, seed: bigint, steps: number,
//!                          maxSubsets: number): object;
//! function subsets(n: number, k: number): string;
//! ```

use separatrix::portfolio::{
    build_selection_qubo, exact_k, repair_to_k, subset_count, PortfolioSpec,
};
use separatrix::{
    exact, sb, IsingModel, PtConfig, QuantizedQubo, QuboModel, SaConfig, SbConfig, SbVariant,
    Solver, DEFAULT_MAX_COEFF,
};
use serde::de::{self, DeserializeOwned, Deserializer};
use serde::{Deserialize, Serialize};
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

// ---------------------------------------------------------------------------
// Arbitrary QUBOs: solve_qubo, trace_sb, portfolio_qubo.
//
// Validation and option resolution are plain Rust returning `String` errors,
// so they are unit-tested natively; only the thin `#[wasm_bindgen]` wrappers
// touch `JsValue`.
// ---------------------------------------------------------------------------

/// Largest `n` the QUBO entry points accept. Models are dense: at this size
/// the float QUBO and its Ising image take 32 MiB each.
const MAX_QUBO_N: usize = 2048;

/// Frame bounds for [`trace_sb`].
const MIN_FRAMES: usize = 2;
const MAX_FRAMES: usize = 600;

fn js_err(msg: impl AsRef<str>) -> JsValue {
    JsValue::from_str(msg.as_ref())
}

/// Serialize with `null` (not `undefined`) for `None`, and plain numbers for
/// every integer type.
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::new()
        .serialize_missing_as_null(true)
        .serialize_large_number_types_as_bigints(false);
    value
        .serialize(&serializer)
        .map_err(|e| js_err(e.to_string()))
}

/// `undefined`/`null` opts mean "all defaults".
fn parse_opts<T: DeserializeOwned + Default>(opts: JsValue) -> Result<T, JsValue> {
    if opts.is_undefined() || opts.is_null() {
        return Ok(T::default());
    }
    serde_wasm_bindgen::from_value(opts).map_err(|e| {
        // The error wraps a JS `Error`, whose string form is "Error: <msg>".
        let msg = e.to_string();
        let msg = msg.strip_prefix("Error: ").unwrap_or(&msg);
        js_err(format!("invalid opts: {msg}"))
    })
}

/// Build the dense QUBO from `(i, j, v)` triplets. Diagonal terms are linear
/// coefficients; off-diagonal terms accumulate into the upper triangle
/// regardless of order.
fn qubo_from_terms(
    n: usize,
    rows: &[u32],
    cols: &[u32],
    vals: &[f64],
) -> Result<QuboModel<f64>, String> {
    if n == 0 {
        return Err("n must be at least 1".into());
    }
    if n > MAX_QUBO_N {
        return Err(format!("n = {n} exceeds the browser limit of {MAX_QUBO_N}"));
    }
    if rows.len() != cols.len() || rows.len() != vals.len() {
        return Err(format!(
            "rows, cols and vals must have equal lengths (got {}, {}, {})",
            rows.len(),
            cols.len(),
            vals.len()
        ));
    }
    let mut qubo = QuboModel::new(n);
    for (t, ((&i, &j), &v)) in rows.iter().zip(cols).zip(vals).enumerate() {
        let (i, j) = (i as usize, j as usize);
        if i >= n || j >= n {
            return Err(format!(
                "term {t}: index ({i}, {j}) out of range for n = {n}"
            ));
        }
        if !v.is_finite() {
            return Err(format!("term {t}: value {v} is not finite"));
        }
        let sum: f64 = qubo.term(i, j) + v;
        if !sum.is_finite() {
            return Err(format!(
                "term {t}: Q[{}][{}] overflows when accumulated",
                i.min(j),
                i.max(j)
            ));
        }
        qubo.set_term(i, j, sum);
    }
    Ok(qubo)
}

/// A seed from JS: a safe-integer number, a BigInt, or an integral number
/// beyond 2^53 (still exact in f64). Fractions and negatives are refused
/// rather than silently truncated, since two different inputs must never
/// reproduce the same run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Seed(u64);

impl<'de> Deserialize<'de> for Seed {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct SeedVisitor;

        impl de::Visitor<'_> for SeedVisitor {
            type Value = Seed;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a non-negative integer seed")
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Seed, E> {
                Ok(Seed(v))
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Seed, E> {
                u64::try_from(v)
                    .map(Seed)
                    .map_err(|_| E::custom(format!("seed must be a non-negative integer, got {v}")))
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Seed, E> {
                // 2^64 is exactly representable; every integral f64 below it
                // converts to u64 without loss.
                if v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v < 18_446_744_073_709_551_616.0
                {
                    Ok(Seed(v as u64))
                } else {
                    Err(E::custom(format!(
                        "seed must be a non-negative integer, got {v}"
                    )))
                }
            }
        }

        deserializer.deserialize_any(SeedVisitor)
    }
}

/// The four heuristics, in the configurations `solve_portfolio` uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Heuristic {
    Bsb,
    Dsb,
    Sa,
    Pt,
}

impl Heuristic {
    const ALL: [Heuristic; 4] = [Heuristic::Bsb, Heuristic::Dsb, Heuristic::Sa, Heuristic::Pt];

    fn parse(name: &str) -> Result<Self, String> {
        match name.to_ascii_lowercase().as_str() {
            "bsb" => Ok(Heuristic::Bsb),
            "dsb" => Ok(Heuristic::Dsb),
            "sa" => Ok(Heuristic::Sa),
            "pt" => Ok(Heuristic::Pt),
            _ => Err(format!(
                "unknown solver \"{name}\" (expected bSB, dSB, SA or PT)"
            )),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Heuristic::Bsb => "bSB",
            Heuristic::Dsb => "dSB",
            Heuristic::Sa => "SA",
            Heuristic::Pt => "PT",
        }
    }

    /// `steps` is SB integration steps or SA/PT sweeps; `replicas` is SB
    /// replicas and SA restarts, and PT runs twice as many temperature rungs
    /// (8 / 8 / 16 at the default, exactly `solve_portfolio`'s budget).
    fn solver(self, steps: usize, replicas: usize, seed: u64) -> Solver {
        match self {
            Heuristic::Bsb | Heuristic::Dsb => Solver::Sb(SbConfig {
                variant: if self == Heuristic::Bsb {
                    SbVariant::Ballistic
                } else {
                    SbVariant::Discrete
                },
                steps,
                replicas,
                seed,
                ..SbConfig::default()
            }),
            Heuristic::Sa => Solver::Sa(SaConfig {
                sweeps: steps,
                restarts: replicas,
                seed,
                ..SaConfig::default()
            }),
            Heuristic::Pt => Solver::Pt(PtConfig {
                sweeps: steps,
                replicas: 2 * replicas,
                seed,
                ..PtConfig::default()
            }),
        }
    }
}

/// `solve_qubo` opts as they arrive; `None` (missing, `undefined` or `null`)
/// takes the default.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SolveQuboOptions {
    seed: Option<Seed>,
    steps: Option<usize>,
    replicas: Option<usize>,
    solvers: Option<Vec<String>>,
    exact: Option<bool>,
    exact_max_n: Option<usize>,
}

/// Resolved and validated `solve_qubo` opts.
#[derive(Debug, PartialEq)]
struct SolvePlan {
    seed: u64,
    steps: usize,
    replicas: usize,
    solvers: Vec<Heuristic>,
    /// Largest `n` exact will run on; `None` when exact is disabled.
    exact_limit: Option<usize>,
}

impl SolvePlan {
    fn resolve(opts: SolveQuboOptions) -> Result<Self, String> {
        let steps = opts.steps.unwrap_or(1000);
        if steps == 0 {
            return Err("opts.steps must be at least 1".into());
        }
        let replicas = opts.replicas.unwrap_or(8);
        if replicas == 0 {
            return Err("opts.replicas must be at least 1".into());
        }
        let solvers = match opts.solvers {
            None => Heuristic::ALL.to_vec(),
            Some(names) => {
                let mut picked = Vec::with_capacity(names.len());
                for name in &names {
                    let h = Heuristic::parse(name)?;
                    if !picked.contains(&h) {
                        picked.push(h);
                    }
                }
                picked
            }
        };
        let exact_limit = if opts.exact.unwrap_or(true) {
            Some(opts.exact_max_n.unwrap_or(22).min(exact::MAX_N))
        } else {
            None
        };
        Ok(Self {
            seed: opts.seed.map_or(1, |s| s.0),
            steps,
            replicas,
            solvers,
            exact_limit,
        })
    }

    /// Why exact enumeration will not run on an `n`-variable instance, or
    /// `None` if it will.
    fn exact_skip_reason(&self, n: usize) -> Option<String> {
        match self.exact_limit {
            None => Some("exact enumeration disabled".into()),
            Some(limit) if n > limit => Some(format!("n = {n} exceeds the exact limit of {limit}")),
            Some(_) => None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QuboSolverRun {
    solver: &'static str,
    bits: Vec<u8>,
    objective: f64,
    millis: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QuboExactRun {
    bits: Vec<u8>,
    objective: f64,
    millis: f64,
    /// `2^n`, the configurations enumerated, as a decimal string.
    states: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QuboReport {
    n: usize,
    results: Vec<QuboSolverRun>,
    exact: Option<QuboExactRun>,
    exact_skipped: bool,
    exact_reason: Option<String>,
}

/// Solve an arbitrary QUBO, given as `(rows[t], cols[t], vals[t])` terms,
/// with the selected heuristics and (when small enough) exact enumeration.
///
/// Every solver works on the Ising image of the float QUBO; every reported
/// `objective` re-scores the returned bits on the original QUBO. No
/// quantization on this path. See the module docs for the option and report
/// shapes.
#[wasm_bindgen]
pub fn solve_qubo(
    n: usize,
    rows: Vec<u32>,
    cols: Vec<u32>,
    vals: Vec<f64>,
    opts: JsValue,
) -> Result<JsValue, JsValue> {
    let qubo = qubo_from_terms(n, &rows, &cols, &vals).map_err(js_err)?;
    let plan = SolvePlan::resolve(parse_opts(opts)?).map_err(js_err)?;
    let (ising, _offset) = IsingModel::from_qubo(&qubo);

    let mut results = Vec::with_capacity(plan.solvers.len());
    for &heuristic in &plan.solvers {
        let started = now_ms();
        let solved = heuristic
            .solver(plan.steps, plan.replicas, plan.seed)
            .solve(&ising)
            .map_err(|e| js_err(e.to_string()))?;
        let millis = now_ms() - started;
        let bits = solved.bits();
        results.push(QuboSolverRun {
            solver: heuristic.name(),
            objective: qubo.objective(&bits),
            bits,
            millis,
        });
    }

    let exact_reason = plan.exact_skip_reason(n);
    let exact = if exact_reason.is_none() {
        let started = now_ms();
        let solved = Solver::Exact
            .solve(&ising)
            .map_err(|e| js_err(e.to_string()))?;
        let millis = now_ms() - started;
        let bits = solved.bits();
        Some(QuboExactRun {
            objective: qubo.objective(&bits),
            bits,
            millis,
            states: (1u64 << n).to_string(),
        })
    } else {
        None
    };

    to_js(&QuboReport {
        n,
        results,
        exact_skipped: exact.is_none(),
        exact,
        exact_reason,
    })
}

/// `trace_sb` opts as they arrive.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TraceOptions {
    variant: Option<String>,
    steps: Option<usize>,
    seed: Option<Seed>,
    frames: Option<usize>,
    coupling_scale: Option<f64>,
}

/// Resolved `trace_sb` opts: the solver config (one replica) and the frame
/// count.
fn resolve_trace(opts: TraceOptions) -> Result<(SbConfig, usize, f64), String> {
    let variant = match opts.variant.as_deref().map(str::to_ascii_lowercase) {
        None => SbVariant::Ballistic,
        Some(v) if v == "bsb" => SbVariant::Ballistic,
        Some(v) if v == "dsb" => SbVariant::Discrete,
        Some(_) => {
            return Err(format!(
                "unknown variant \"{}\" (expected bSB or dSB)",
                opts.variant.unwrap_or_default()
            ))
        }
    };
    let steps = opts.steps.unwrap_or(1000);
    if steps == 0 {
        return Err("opts.steps must be at least 1".into());
    }
    let frames = opts.frames.unwrap_or(180).clamp(MIN_FRAMES, MAX_FRAMES);
    let scale = opts.coupling_scale.unwrap_or(1.0);
    if !(scale.is_finite() && scale > 0.0) {
        return Err("opts.couplingScale must be a positive finite number".into());
    }
    let cfg = SbConfig {
        variant,
        steps,
        replicas: 1,
        seed: opts.seed.map_or(1, |s| s.0),
        ..SbConfig::default()
    };
    Ok((cfg, frames, scale))
}

fn set(target: &js_sys::Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(target, &JsValue::from_str(key), value).map(|_| ())
}

/// Run one simulated-bifurcation replica on a QUBO and return its trajectory
/// for animation: oscillator positions at `frames` evenly spaced steps, the
/// objective of `sign(x)` at each, and the best configuration measured.
///
/// This is `separatrix::sb::trace`, i.e. the solver's own integration loop;
/// `bits` equals what bSB/dSB return with one replica and the same seed and
/// steps. Positions and per-frame objectives come back as `Float32Array` /
/// `Float64Array`.
#[wasm_bindgen]
pub fn trace_sb(
    n: usize,
    rows: Vec<u32>,
    cols: Vec<u32>,
    vals: Vec<f64>,
    opts: JsValue,
) -> Result<JsValue, JsValue> {
    let qubo = qubo_from_terms(n, &rows, &cols, &vals).map_err(js_err)?;
    let (mut cfg, frames, scale) = resolve_trace(parse_opts(opts)?).map_err(js_err)?;
    let (ising, offset) = IsingModel::from_qubo(&qubo);
    if scale != 1.0 {
        cfg.c0 = Some(scale * sb::default_coupling(&ising, cfg.a0));
    }

    let traced = sb::trace(&ising, &cfg, frames);
    let objective: Vec<f64> = traced.energies.iter().map(|&e| e + offset).collect();
    let frame_steps: Vec<u32> = traced
        .frame_steps
        .iter()
        .map(|&s| u32::try_from(s).unwrap_or(u32::MAX))
        .collect();
    let bits = traced.best.bits();
    let best_objective = qubo.objective(&bits);
    let bits_js: js_sys::Array = bits.iter().map(|&b| JsValue::from(b)).collect();

    let out = js_sys::Object::new();
    set(&out, "n", &JsValue::from(n as f64))?;
    set(&out, "steps", &JsValue::from(cfg.steps as f64))?;
    set(&out, "frames", &JsValue::from(frames as f64))?;
    set(
        &out,
        "x",
        &js_sys::Float32Array::from(traced.positions.as_slice()).into(),
    )?;
    set(
        &out,
        "objective",
        &js_sys::Float64Array::from(objective.as_slice()).into(),
    )?;
    set(
        &out,
        "frameSteps",
        &js_sys::Uint32Array::from(frame_steps.as_slice()).into(),
    )?;
    set(&out, "bits", &bits_js.into())?;
    set(&out, "bestObjective", &JsValue::from(best_objective))?;
    Ok(out.into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PortfolioQuboOut {
    n: usize,
    rows: Vec<u32>,
    cols: Vec<u32>,
    vals: Vec<f64>,
    penalty: f64,
    /// `P·k²`, the constant dropped when the cardinality penalty
    /// `P·(Σx − k)²` is expanded into QUBO coefficients (a constant cannot be
    /// stored in a QUBO). `f(x) + offset` is the portfolio objective
    /// `(1/k²)·xᵀΣx − (λ/k)·μᵀx + P·(Σx − k)²`, which on the feasible set
    /// `Σx = k` is just the risk/return objective. Optima and absolute gaps
    /// do not need it; ratios do (see `separatrix::portfolio`).
    offset: f64,
}

/// Flatten a selection QUBO into upper-triangular terms (diagonal included,
/// `rows[t] <= cols[t]`, exact zeros omitted).
fn qubo_terms(qubo: &QuboModel<f64>) -> (Vec<u32>, Vec<u32>, Vec<f64>) {
    let n = qubo.n();
    let mut rows = Vec::with_capacity(n * (n + 1) / 2);
    let mut cols = Vec::with_capacity(n * (n + 1) / 2);
    let mut vals = Vec::with_capacity(n * (n + 1) / 2);
    for i in 0..n {
        for j in i..n {
            let v = qubo.term(i, j);
            if v != 0.0 {
                rows.push(i as u32);
                cols.push(j as u32);
                vals.push(v);
            }
        }
    }
    (rows, cols, vals)
}

/// The float cardinality-constrained selection QUBO for `(mu, sigma, k, λ)`,
/// exactly as `separatrix::portfolio::build_selection_qubo` builds it (auto
/// penalty), as terms ready for [`solve_qubo`] / [`trace_sb`]. `sigma` is
/// row-major `n*n`. Unquantized: `solve_portfolio` quantizes this same QUBO
/// before solving.
#[wasm_bindgen]
pub fn portfolio_qubo(
    mu: Vec<f64>,
    sigma: Vec<f64>,
    k: usize,
    risk_aversion: f64,
) -> Result<JsValue, JsValue> {
    let built = build_selection_qubo(&PortfolioSpec {
        mu: &mu,
        sigma: &sigma,
        risk_aversion,
        k,
        penalty: None,
    })
    .map_err(|e| js_err(e.to_string()))?;
    let (rows, cols, vals) = qubo_terms(&built.qubo);
    to_js(&PortfolioQuboOut {
        n: built.qubo.n(),
        rows,
        cols,
        vals,
        penalty: built.penalty,
        offset: built.offset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::IntoDeserializer;

    #[test]
    fn terms_accumulate_into_the_upper_triangle() {
        let q = qubo_from_terms(
            3,
            &[0, 1, 2, 2, 2],
            &[1, 0, 2, 2, 0],
            &[2.0, 3.0, 1.0, 1.5, -4.0],
        )
        .unwrap();
        assert_eq!(q.term(0, 1), 5.0);
        assert_eq!(q.term(2, 2), 2.5);
        assert_eq!(q.term(0, 2), -4.0);
        assert_eq!(q.term(1, 2), 0.0);
        // x = (1, 1, 1): Q00 + Q11 + Q22 + Q01 + Q02 + Q12
        assert_eq!(q.objective(&[1, 1, 1]), 2.5 + 5.0 - 4.0);
    }

    #[test]
    fn term_validation_errors_are_specific() {
        let err = |n, r: &[u32], c: &[u32], v: &[f64]| qubo_from_terms(n, r, c, v).unwrap_err();
        assert_eq!(err(0, &[], &[], &[]), "n must be at least 1");
        assert!(err(MAX_QUBO_N + 1, &[], &[], &[]).contains("exceeds the browser limit"));
        assert!(err(2, &[0], &[1, 0], &[1.0]).contains("equal lengths (got 1, 2, 1)"));
        assert_eq!(
            err(2, &[0, 2], &[1, 0], &[1.0, 1.0]),
            "term 1: index (2, 0) out of range for n = 2"
        );
        assert_eq!(
            err(2, &[0], &[1], &[f64::NAN]),
            "term 0: value NaN is not finite"
        );
        assert!(err(2, &[0, 1], &[1, 0], &[f64::MAX, f64::MAX]).contains("overflows"));
    }

    #[test]
    fn solve_defaults_mirror_solve_portfolio() {
        let plan = SolvePlan::resolve(SolveQuboOptions::default()).unwrap();
        assert_eq!(
            plan,
            SolvePlan {
                seed: 1,
                steps: 1000,
                replicas: 8,
                solvers: Heuristic::ALL.to_vec(),
                exact_limit: Some(22),
            }
        );
        match Heuristic::Pt.solver(500, 8, 3) {
            Solver::Pt(cfg) => assert_eq!((cfg.replicas, cfg.sweeps, cfg.seed), (16, 500, 3)),
            other => panic!("expected PT, got {other:?}"),
        }
        match Heuristic::Sa.solver(500, 8, 3) {
            Solver::Sa(cfg) => assert_eq!((cfg.restarts, cfg.sweeps), (8, 500)),
            other => panic!("expected SA, got {other:?}"),
        }
        match Heuristic::Dsb.solver(500, 4, 3) {
            Solver::Sb(cfg) => {
                assert_eq!(cfg.variant, SbVariant::Discrete);
                assert_eq!((cfg.replicas, cfg.steps), (4, 500));
            }
            other => panic!("expected SB, got {other:?}"),
        }
    }

    #[test]
    fn solve_options_resolve_and_validate() {
        let plan = SolvePlan::resolve(SolveQuboOptions {
            solvers: Some(vec!["pt".into(), "bSB".into(), "PT".into()]),
            exact_max_n: Some(40),
            ..SolveQuboOptions::default()
        })
        .unwrap();
        assert_eq!(plan.solvers, vec![Heuristic::Pt, Heuristic::Bsb]);
        assert_eq!(plan.exact_limit, Some(exact::MAX_N));
        assert_eq!(plan.exact_skip_reason(26), None);
        assert_eq!(
            plan.exact_skip_reason(30).unwrap(),
            "n = 30 exceeds the exact limit of 26"
        );

        let default_plan = SolvePlan::resolve(SolveQuboOptions::default()).unwrap();
        assert_eq!(
            default_plan.exact_skip_reason(30).unwrap(),
            "n = 30 exceeds the exact limit of 22"
        );
        let off = SolvePlan::resolve(SolveQuboOptions {
            exact: Some(false),
            ..SolveQuboOptions::default()
        })
        .unwrap();
        assert_eq!(
            off.exact_skip_reason(4).unwrap(),
            "exact enumeration disabled"
        );

        let bad = |opts| SolvePlan::resolve(opts).unwrap_err();
        assert!(bad(SolveQuboOptions {
            solvers: Some(vec!["QAOA".into()]),
            ..SolveQuboOptions::default()
        })
        .contains("unknown solver \"QAOA\""));
        assert!(bad(SolveQuboOptions {
            steps: Some(0),
            ..SolveQuboOptions::default()
        })
        .contains("steps"));
        assert!(bad(SolveQuboOptions {
            replicas: Some(0),
            ..SolveQuboOptions::default()
        })
        .contains("replicas"));
    }

    #[test]
    fn trace_options_resolve_and_clamp() {
        let (cfg, frames, scale) = resolve_trace(TraceOptions::default()).unwrap();
        assert_eq!(scale, 1.0);
        assert_eq!(cfg.variant, SbVariant::Ballistic);
        assert_eq!(
            (cfg.steps, cfg.seed, cfg.replicas, frames),
            (1000, 1, 1, 180)
        );

        let (cfg, frames, _) = resolve_trace(TraceOptions {
            variant: Some("DSB".into()),
            frames: Some(10_000),
            seed: Some(Seed(9)),
            ..TraceOptions::default()
        })
        .unwrap();
        assert_eq!(
            (cfg.variant, cfg.seed, frames),
            (SbVariant::Discrete, 9, MAX_FRAMES)
        );
        let (_, frames, _) = resolve_trace(TraceOptions {
            frames: Some(0),
            ..TraceOptions::default()
        })
        .unwrap();
        assert_eq!(frames, MIN_FRAMES);

        let err = resolve_trace(TraceOptions {
            variant: Some("SA".into()),
            ..TraceOptions::default()
        })
        .unwrap_err();
        assert_eq!(err, "unknown variant \"SA\" (expected bSB or dSB)");

        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let err = resolve_trace(TraceOptions {
                coupling_scale: Some(bad),
                ..TraceOptions::default()
            })
            .unwrap_err();
            assert_eq!(err, "opts.couplingScale must be a positive finite number");
        }
        let (_, _, scale) = resolve_trace(TraceOptions {
            coupling_scale: Some(0.4),
            ..TraceOptions::default()
        })
        .unwrap();
        assert_eq!(scale, 0.4);
    }

    #[test]
    fn seeds_accept_integral_numbers_only() {
        type E = serde::de::value::Error;
        let from_f64 = |v: f64| Seed::deserialize(IntoDeserializer::<E>::into_deserializer(v));
        let from_i64 = |v: i64| Seed::deserialize(IntoDeserializer::<E>::into_deserializer(v));
        let from_u64 = |v: u64| Seed::deserialize(IntoDeserializer::<E>::into_deserializer(v));
        assert_eq!(from_f64(7.0).unwrap(), Seed(7));
        assert_eq!(from_f64(2f64.powi(60)).unwrap(), Seed(1 << 60));
        assert_eq!(from_i64(42).unwrap(), Seed(42));
        assert_eq!(from_u64(u64::MAX).unwrap(), Seed(u64::MAX));
        assert!(from_f64(1.5).is_err());
        assert!(from_f64(-1.0).is_err());
        assert!(from_f64(f64::INFINITY).is_err());
        assert!(from_f64(2f64.powi(64)).is_err());
        assert!(from_i64(-3).is_err());
    }

    #[test]
    fn portfolio_terms_round_trip_through_qubo_from_terms() {
        let mu = [0.01, -0.02, 0.005];
        let sigma = [0.04, 0.01, 0.0, 0.01, 0.09, 0.02, 0.0, 0.02, 0.05];
        let built = build_selection_qubo(&PortfolioSpec {
            mu: &mu,
            sigma: &sigma,
            risk_aversion: 0.5,
            k: 2,
            penalty: None,
        })
        .unwrap();
        let (rows, cols, vals) = qubo_terms(&built.qubo);
        assert!(rows.iter().zip(&cols).all(|(r, c)| r <= c));
        let rebuilt = qubo_from_terms(3, &rows, &cols, &vals).unwrap();
        assert_eq!(rebuilt, built.qubo);
    }
}
