//! JSON stdin/stdout bridge to the separatrix portfolio solvers.
//!
//! Protocol: docs/workbench.md in the repo root. One request object on stdin,
//! one response line on stdout, exit 0 on success. Any error goes to stderr
//! with a non-zero exit — callers treat that as a hard failure (fail-closed).
//!
//! `objective_int` / `gap_int` are decimal strings: the canonical objective is
//! an i128 and JSON numbers stop being exact far below that.

use separatrix::portfolio::{build_selection_qubo, exact_k, repair_to_k, PortfolioSpec};
use separatrix::{
    Error, IsingModel, PtConfig, QuantizedQubo, SaConfig, SbConfig, SbVariant, Solver,
    DEFAULT_MAX_COEFF,
};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::time::Instant;

#[derive(Deserialize)]
struct Budget {
    #[serde(default = "d_sb_steps")]
    sb_steps: usize,
    #[serde(default = "d_sb_replicas")]
    sb_replicas: usize,
    #[serde(default = "d_sa_sweeps")]
    sa_sweeps: usize,
    #[serde(default = "d_sa_restarts")]
    sa_restarts: usize,
    #[serde(default = "d_pt_sweeps")]
    pt_sweeps: usize,
    #[serde(default = "d_pt_replicas")]
    pt_replicas: usize,
}

fn d_sb_steps() -> usize { 2000 }
fn d_sb_replicas() -> usize { 8 }
fn d_sa_sweeps() -> usize { 2000 }
fn d_sa_restarts() -> usize { 8 }
fn d_pt_sweeps() -> usize { 2000 }
fn d_pt_replicas() -> usize { 16 }

impl Default for Budget {
    fn default() -> Self {
        Self {
            sb_steps: d_sb_steps(),
            sb_replicas: d_sb_replicas(),
            sa_sweeps: d_sa_sweeps(),
            sa_restarts: d_sa_restarts(),
            pt_sweeps: d_pt_sweeps(),
            pt_replicas: d_pt_replicas(),
        }
    }
}

#[derive(Deserialize)]
struct Request {
    mu: Vec<f64>,
    sigma: Vec<Vec<f64>>,
    risk_aversion: f64,
    k: usize,
    #[serde(default)]
    penalty: Option<f64>,
    solvers: Vec<String>,
    #[serde(default)]
    budget: Budget,
    #[serde(default)]
    seed: u64,
    #[serde(default = "d_max_subsets")]
    max_exact_subsets: u64,
    /// Also emit the quantized objective matrix in the exact form the Solana
    /// program stores and seals it against.
    #[serde(default)]
    emit_qubo: bool,
}

fn d_max_subsets() -> u64 {
    20_000_000
}

#[derive(Serialize)]
#[serde(untagged)]
enum ExactOut {
    Solved {
        bits: Vec<u8>,
        objective_int: String,
        /// `objective_int + objective_offset_int` — the portfolio objective,
        /// free of the cardinality penalty's constant term.
        portfolio_objective_int: String,
        /// Objective of the WORST feasible k-subset.
        worst_objective_int: String,
        /// `worst − best`: the full achievable spread on the feasible set.
        objective_range_int: String,
        runtime_ms: f64,
    },
    TooLarge {
        error: &'static str,
        subsets: u128,
    },
}

#[derive(Serialize)]
struct SolverOut {
    solver: String,
    bits: Vec<u8>,
    weights: Vec<f64>,
    objective_int: String,
    portfolio_objective_int: String,
    feasible_raw: bool,
    repaired: bool,
    gap_int: Option<String>,
    gap_rel: Option<f64>,
    /// `gap_int / (worst − best)`: the gap as a fraction of the full
    /// achievable spread. Unlike `gap_rel` this stays meaningful when the
    /// optimum sits near zero, so it is the stable headline measure.
    gap_norm: Option<f64>,
    runtime_ms: f64,
}

/// The quantized problem exactly as the on-chain program stores it:
/// upper-triangular, row-major, `n(n+1)/2` i64 terms with the diagonal
/// included. `q_hash` is sha256 over those terms' little-endian bytes — the
/// digest `seal_study` recomputes before freezing a study.
#[derive(Serialize)]
struct QuboExport {
    n: usize,
    term_count: usize,
    coefficients: Vec<i64>,
    q_hash: String,
    offset_int: String,
    scale: f64,
    /// `f64::to_bits(scale)` — what `create_study` stores and what the seal
    /// digest binds, so the client never has to re-derive it.
    scale_bits: u64,
}

#[derive(Serialize)]
struct Response {
    n: usize,
    k: usize,
    scale: f64,
    /// Quantized `P·k²`. The penalized QUBO drops this constant, so a ratio
    /// taken against `objective_int` alone would normalize by the penalty
    /// scale, not the portfolio objective. Add it back first.
    objective_offset_int: String,
    exact: Option<ExactOut>,
    results: Vec<SolverOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    qubo: Option<QuboExport>,
}

/// Row-major upper-triangular index for `i <= j`, matching
/// `triangular_index` in the Solana program. The two must agree exactly or
/// the chain scores a different matrix than the solver optimized.
fn triangular_index(n: usize, i: usize, j: usize) -> usize {
    let (i, j) = if i <= j { (i, j) } else { (j, i) };
    i * n - i * i.saturating_sub(1) / 2 + (j - i)
}

/// Must match `QUBO_DOMAIN` in programs/separatrix/src/lib.rs.
const QUBO_DOMAIN: &[u8] = b"separatrix:qubo:v1";

/// Reproduce the digest `seal_study` recomputes on-chain. The preimage binds
/// the whole instance — n, k, scale and the penalty offset, not just the
/// coefficient bytes — so a matrix cannot be re-sealed under a different
/// cardinality or offset. Any divergence here and a study can never be sealed.
fn export_qubo(qq: &QuantizedQubo, k: usize, offset_int: i128) -> QuboExport {
    use sha2::{Digest, Sha256};
    let n = qq.n();
    let term_count = n * (n + 1) / 2;
    let mut coefficients = vec![0i64; term_count];
    for i in 0..n {
        for j in i..n {
            coefficients[triangular_index(n, i, j)] = qq.term(i, j);
        }
    }
    let mut hasher = Sha256::new();
    hasher.update(QUBO_DOMAIN);
    hasher.update([n as u8, k as u8]);
    hasher.update(qq.scale.to_bits().to_le_bytes());
    hasher.update(offset_int.to_le_bytes());
    for value in &coefficients {
        hasher.update(value.to_le_bytes());
    }
    QuboExport {
        n,
        term_count,
        coefficients,
        q_hash: hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        offset_int: offset_int.to_string(),
        scale: qq.scale,
        scale_bits: qq.scale.to_bits(),
    }
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("separatrix-cli error: {msg}");
    std::process::exit(1);
}

/// Sub-millisecond resolution: these solvers routinely finish in under 1 ms,
/// and integer-millisecond truncation would bias every reported mean downward.
fn elapsed_ms(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 1000.0 * 1000.0).round() / 1000.0
}

fn main() {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        fail(format!("reading stdin: {e}"));
    }
    let req: Request = match serde_json::from_str(&input) {
        Ok(r) => r,
        Err(e) => fail(format!("parsing request JSON: {e}")),
    };

    let n = req.mu.len();
    if req.sigma.len() != n || req.sigma.iter().any(|row| row.len() != n) {
        fail(format!("sigma must be {n}x{n} to match mu"));
    }
    if req.solvers.is_empty() {
        fail("no solvers requested");
    }
    let sigma_flat: Vec<f64> = req.sigma.iter().flatten().copied().collect();

    let built = match build_selection_qubo(&PortfolioSpec {
        mu: &req.mu,
        sigma: &sigma_flat,
        risk_aversion: req.risk_aversion,
        k: req.k,
        penalty: req.penalty,
    }) {
        Ok(q) => q,
        Err(e) => fail(e),
    };
    let qq = QuantizedQubo::quantize(&built.qubo, DEFAULT_MAX_COEFF);
    let (ising, _offset) = IsingModel::from_qubo(&qq.to_qubo());
    // The dropped P·k² constant, in the same integer units as the objective.
    let offset_int = (built.offset * qq.scale).round() as i128;
    let portfolio_obj = |objective: i128| objective + offset_int;

    // Ground truth first, so heuristic gaps can be computed as we go.
    let mut exact_out: Option<ExactOut> = None;
    let mut exact_obj: Option<i128> = None;
    let mut exact_range: Option<i128> = None;
    if req.solvers.iter().any(|s| s == "exact") {
        let started = Instant::now();
        match exact_k(&qq, req.k, req.max_exact_subsets) {
            Ok(found) => {
                exact_obj = Some(found.objective);
                exact_range = Some(found.worst - found.objective);
                exact_out = Some(ExactOut::Solved {
                    objective_int: found.objective.to_string(),
                    portfolio_objective_int: portfolio_obj(found.objective).to_string(),
                    worst_objective_int: found.worst.to_string(),
                    objective_range_int: (found.worst - found.objective).to_string(),
                    runtime_ms: elapsed_ms(started),
                    bits: found.bits,
                });
            }
            Err(Error::TooManySubsets { subsets, .. }) => {
                exact_out = Some(ExactOut::TooLarge {
                    error: "TOO_LARGE",
                    subsets,
                });
            }
            Err(e) => fail(e),
        }
    }

    let mut results = Vec::new();
    for name in req.solvers.iter().filter(|s| s.as_str() != "exact") {
        let b = &req.budget;
        let solver = match name.as_str() {
            "bsb" => Solver::Sb(SbConfig {
                variant: SbVariant::Ballistic,
                steps: b.sb_steps,
                replicas: b.sb_replicas,
                seed: req.seed,
                ..SbConfig::default()
            }),
            "dsb" => Solver::Sb(SbConfig {
                variant: SbVariant::Discrete,
                steps: b.sb_steps,
                replicas: b.sb_replicas,
                seed: req.seed,
                ..SbConfig::default()
            }),
            "sa" => Solver::Sa(SaConfig {
                sweeps: b.sa_sweeps,
                restarts: b.sa_restarts,
                seed: req.seed,
                ..SaConfig::default()
            }),
            "pt" => Solver::Pt(PtConfig {
                sweeps: b.pt_sweeps,
                replicas: b.pt_replicas,
                seed: req.seed,
                ..PtConfig::default()
            }),
            other => fail(format!(
                "unknown solver {other:?} (expected bsb|dsb|sa|pt|exact)"
            )),
        };

        let started = Instant::now();
        let solved = match solver.solve(&ising) {
            Ok(r) => r,
            Err(e) => fail(e),
        };
        let mut bits = solved.bits();
        let ones = bits.iter().filter(|&&b| b != 0).count();
        let feasible_raw = ones == req.k;
        if !feasible_raw {
            repair_to_k(&qq, &mut bits, req.k);
        }
        let runtime_ms = elapsed_ms(started);

        let objective = qq.objective(&bits);
        let (gap_int, gap_rel, gap_norm) = match exact_obj {
            Some(e) => {
                let gap = objective - e;
                // Normalize by the PORTFOLIO objective of the optimum. Using
                // the raw QUBO value would divide by the penalty constant and
                // understate the gap by orders of magnitude.
                let denom = portfolio_obj(e).abs().max(1) as f64;
                let norm = exact_range.map(|r| gap as f64 / r.max(1) as f64);
                (Some(gap.to_string()), Some(gap as f64 / denom), norm)
            }
            None => (None, None, None),
        };
        let weights: Vec<f64> = bits
            .iter()
            .map(|&x| if x != 0 { 1.0 / req.k as f64 } else { 0.0 })
            .collect();

        results.push(SolverOut {
            solver: name.clone(),
            bits,
            weights,
            objective_int: objective.to_string(),
            portfolio_objective_int: portfolio_obj(objective).to_string(),
            feasible_raw,
            repaired: !feasible_raw,
            gap_int,
            gap_rel,
            gap_norm,
            runtime_ms,
        });
    }

    let response = Response {
        n,
        k: req.k,
        scale: qq.scale,
        objective_offset_int: offset_int.to_string(),
        exact: exact_out,
        results,
        qubo: if req.emit_qubo {
            Some(export_qubo(&qq, req.k, offset_int))
        } else {
            None
        },
    };
    match serde_json::to_string(&response) {
        Ok(line) => println!("{line}"),
        Err(e) => fail(format!("serializing response: {e}")),
    }
}
