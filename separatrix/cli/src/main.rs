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
        runtime_ms: u64,
    },
    TooLarge {
        error: &'static str,
        subsets: String,
    },
}

#[derive(Serialize)]
struct SolverOut {
    solver: String,
    bits: Vec<u8>,
    weights: Vec<f64>,
    objective_int: String,
    feasible_raw: bool,
    repaired: bool,
    gap_int: Option<String>,
    gap_rel: Option<f64>,
    runtime_ms: u64,
}

#[derive(Serialize)]
struct Response {
    n: usize,
    k: usize,
    scale: f64,
    exact: Option<ExactOut>,
    results: Vec<SolverOut>,
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("separatrix-cli error: {msg}");
    std::process::exit(1);
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

    let qubo = match build_selection_qubo(&PortfolioSpec {
        mu: &req.mu,
        sigma: &sigma_flat,
        risk_aversion: req.risk_aversion,
        k: req.k,
        penalty: req.penalty,
    }) {
        Ok(q) => q,
        Err(e) => fail(e),
    };
    let qq = QuantizedQubo::quantize(&qubo, DEFAULT_MAX_COEFF);
    let (ising, _offset) = IsingModel::from_qubo(&qq.to_qubo());

    // Ground truth first, so heuristic gaps can be computed as we go.
    let mut exact_out: Option<ExactOut> = None;
    let mut exact_obj: Option<i128> = None;
    if req.solvers.iter().any(|s| s == "exact") {
        let started = Instant::now();
        match exact_k(&qq, req.k, req.max_exact_subsets) {
            Ok((bits, obj)) => {
                exact_obj = Some(obj);
                exact_out = Some(ExactOut::Solved {
                    bits,
                    objective_int: obj.to_string(),
                    runtime_ms: started.elapsed().as_millis() as u64,
                });
            }
            Err(Error::TooManySubsets { subsets, .. }) => {
                exact_out = Some(ExactOut::TooLarge {
                    error: "TOO_LARGE",
                    subsets: subsets.to_string(),
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
        let runtime_ms = started.elapsed().as_millis() as u64;

        let objective = qq.objective(&bits);
        let (gap_int, gap_rel) = match exact_obj {
            Some(e) => {
                let gap = objective - e;
                (Some(gap.to_string()), Some(gap as f64 / (e.abs().max(1)) as f64))
            }
            None => (None, None),
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
            feasible_raw,
            repaired: !feasible_raw,
            gap_int,
            gap_rel,
            runtime_ms,
        });
    }

    let response = Response {
        n,
        k: req.k,
        scale: qq.scale,
        exact: exact_out,
        results,
    };
    match serde_json::to_string(&response) {
        Ok(line) => println!("{line}"),
        Err(e) => fail(format!("serializing response: {e}")),
    }
}
