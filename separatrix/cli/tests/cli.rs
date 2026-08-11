//! End-to-end tests of the JSON protocol against the real binary.

use std::io::Write;
use std::process::{Command, Stdio};

fn run_cli(input: &str) -> (String, String, bool) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_separatrix-cli"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn separatrix-cli");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
        out.status.success(),
    )
}

/// A deterministic small instance: 6 assets, k = 2.
fn small_request(seed: u64, solvers: &str) -> String {
    format!(
        r#"{{
        "mu": [0.002, -0.001, 0.004, 0.0, 0.003, -0.002],
        "sigma": [
            [0.0009, 0.0001, 0.0002, 0.0, 0.0001, 0.0],
            [0.0001, 0.0016, 0.0, 0.0002, 0.0, 0.0001],
            [0.0002, 0.0, 0.0025, 0.0001, 0.0003, 0.0],
            [0.0, 0.0002, 0.0001, 0.0004, 0.0, 0.0001],
            [0.0001, 0.0, 0.0003, 0.0, 0.0012, 0.0002],
            [0.0, 0.0001, 0.0, 0.0001, 0.0002, 0.0018]
        ],
        "risk_aversion": 0.5,
        "k": 2,
        "solvers": [{solvers}],
        "budget": {{"sb_steps": 500, "sb_replicas": 4, "sa_sweeps": 500, "sa_restarts": 4, "pt_sweeps": 500, "pt_replicas": 8}},
        "seed": {seed}
    }}"#
    )
}

#[test]
fn full_pipeline_all_solvers() {
    let (stdout, stderr, ok) =
        run_cli(&small_request(7, r#""bsb","dsb","sa","pt","exact""#));
    assert!(ok, "cli failed: {stderr}");
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();

    assert_eq!(v["n"], 6);
    assert_eq!(v["k"], 2);
    assert!(v["scale"].as_f64().unwrap() > 0.0);

    let exact = &v["exact"];
    let exact_obj: i128 = exact["objective_int"].as_str().unwrap().parse().unwrap();
    let offset: i128 = v["objective_offset_int"].as_str().unwrap().parse().unwrap();
    let exact_portfolio: i128 = exact["portfolio_objective_int"].as_str().unwrap().parse().unwrap();
    assert_eq!(exact_portfolio, exact_obj + offset);
    // The penalty constant dominates the raw QUBO value; the portfolio
    // objective must NOT inherit that magnitude.
    assert!(
        exact_portfolio.abs() < exact_obj.abs(),
        "offset failed to remove the penalty constant: raw {exact_obj}, portfolio {exact_portfolio}"
    );
    assert_eq!(
        exact["bits"].as_array().unwrap().iter().filter(|b| b == &&serde_json::json!(1)).count(),
        2
    );

    let results = v["results"].as_array().unwrap();
    assert_eq!(results.len(), 4);
    for r in results {
        let solver = r["solver"].as_str().unwrap();
        let bits = r["bits"].as_array().unwrap();
        assert_eq!(
            bits.iter().filter(|b| b == &&serde_json::json!(1)).count(),
            2,
            "{solver}: not exactly k bits set"
        );
        let weights: f64 = r["weights"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w.as_f64().unwrap())
            .sum();
        assert!((weights - 1.0).abs() < 1e-12, "{solver}: weights sum {weights}");
        let obj: i128 = r["objective_int"].as_str().unwrap().parse().unwrap();
        let gap: i128 = r["gap_int"].as_str().unwrap().parse().unwrap();
        assert!(gap >= 0, "{solver}: negative gap {gap}");
        assert_eq!(obj - exact_obj, gap, "{solver}: inconsistent gap");
        let gap_rel = r["gap_rel"].as_f64().unwrap();
        assert!(gap_rel >= 0.0);
        // gap_norm is the gap as a fraction of the full achievable spread,
        // so it is always in [0, 1] — that is the point of it.
        let gap_norm = r["gap_norm"].as_f64().unwrap();
        assert!(
            (0.0..=1.0).contains(&gap_norm),
            "{solver}: gap_norm {gap_norm} outside [0,1]"
        );
        let range: i128 = exact["objective_range_int"].as_str().unwrap().parse().unwrap();
        assert!(range > 0, "objective range must be positive");
        assert!((gap_norm - gap as f64 / range as f64).abs() < 1e-12);
        // gap_rel is the gap over the PORTFOLIO objective of the optimum.
        let expected = gap as f64 / (exact_portfolio.abs().max(1)) as f64;
        assert!(
            (gap_rel - expected).abs() < 1e-12,
            "{solver}: gap_rel {gap_rel} not normalized by the portfolio objective ({expected})"
        );
    }
}

/// Strip wall-clock fields: they legitimately vary run to run.
fn without_runtimes(mut v: serde_json::Value) -> serde_json::Value {
    if let Some(exact) = v.get_mut("exact").and_then(|e| e.as_object_mut()) {
        exact.remove("runtime_ms");
    }
    if let Some(results) = v.get_mut("results").and_then(|r| r.as_array_mut()) {
        for r in results {
            if let Some(obj) = r.as_object_mut() {
                obj.remove("runtime_ms");
            }
        }
    }
    v
}

#[test]
fn deterministic_output_for_same_seed() {
    let req = small_request(42, r#""bsb","sa","exact""#);
    let (a, _, ok_a) = run_cli(&req);
    let (b, _, ok_b) = run_cli(&req);
    assert!(ok_a && ok_b);
    let va: serde_json::Value = serde_json::from_str(a.trim()).unwrap();
    let vb: serde_json::Value = serde_json::from_str(b.trim()).unwrap();
    assert_eq!(
        without_runtimes(va),
        without_runtimes(vb),
        "same request must produce identical results (runtimes excepted)"
    );
}

#[test]
fn exact_too_large_is_reported_not_fatal() {
    // 6 choose 2 = 15 subsets; cap at 10 forces the TOO_LARGE path.
    let req = small_request(1, r#""sa","exact""#)
        .replace("\"seed\": 1", "\"seed\": 1, \"max_exact_subsets\": 10");
    let (stdout, stderr, ok) = run_cli(&req);
    assert!(ok, "cli failed: {stderr}");
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(v["exact"]["error"], "TOO_LARGE");
    // A JSON number, per docs/workbench.md — the Python bridge requires an int.
    assert_eq!(v["exact"]["subsets"], 15);
    let r = &v["results"][0];
    assert!(r["gap_int"].is_null());
    assert!(r["gap_rel"].is_null());
    // Objective is still reported.
    let _: i128 = r["objective_int"].as_str().unwrap().parse().unwrap();
}

#[test]
fn malformed_input_fails_nonzero() {
    let (_, stderr, ok) = run_cli("{\"mu\": [0.1], \"nope\": true}");
    assert!(!ok);
    assert!(stderr.contains("separatrix-cli error"));
}

#[test]
fn dimension_mismatch_fails_nonzero() {
    let (_, stderr, ok) = run_cli(
        r#"{"mu": [0.1, 0.2], "sigma": [[0.1]], "risk_aversion": 0.5, "k": 1, "solvers": ["sa"]}"#,
    );
    assert!(!ok);
    assert!(stderr.contains("sigma"));
}
