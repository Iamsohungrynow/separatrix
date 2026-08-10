//! Cross-cutting invariants, mostly property-based.
//!
//! The two load-bearing guarantees:
//! 1. No heuristic ever reports an energy below the exact ground state
//!    (that would mean the energy bookkeeping is broken somewhere).
//! 2. Model transformations (gauge flips, QUBO<->Ising, quantization) preserve
//!    objectives exactly where they promise to.

use proptest::prelude::*;
use separatrix::{
    exact, IsingModel, PtConfig, QuantizedQubo, QuboModel, SaConfig, SbConfig, SbVariant, Solver,
    DEFAULT_MAX_COEFF,
};

/// Build a dense Ising model from flat coefficient lists.
fn ising_from_parts(n: usize, couplings: &[f64], fields: &[f64]) -> IsingModel<f64> {
    let mut m = IsingModel::new(n);
    let mut idx = 0;
    for i in 0..n {
        for j in (i + 1)..n {
            m.set_coupling(i, j, couplings[idx]);
            idx += 1;
        }
    }
    for (i, &h) in fields.iter().enumerate() {
        m.set_field(i, h);
    }
    m
}

fn arb_ising(max_n: usize) -> impl Strategy<Value = IsingModel<f64>> {
    (2..=max_n).prop_flat_map(|n| {
        let pairs = n * (n - 1) / 2;
        (
            Just(n),
            prop::collection::vec(-5.0..5.0f64, pairs),
            prop::collection::vec(-3.0..3.0f64, n),
        )
            .prop_map(|(n, couplings, fields)| ising_from_parts(n, &couplings, &fields))
    })
}

fn arb_qubo(max_n: usize) -> impl Strategy<Value = QuboModel<f64>> {
    (1..=max_n).prop_flat_map(|n| {
        let terms = n * (n + 1) / 2;
        (Just(n), prop::collection::vec(-10.0..10.0f64, terms)).prop_map(|(n, vals)| {
            let mut q = QuboModel::new(n);
            let mut idx = 0;
            for i in 0..n {
                for j in i..n {
                    q.set_term(i, j, vals[idx]);
                    idx += 1;
                }
            }
            q
        })
    })
}

fn spins_from_mask(n: usize, mask: u64) -> Vec<i8> {
    (0..n)
        .map(|b| if (mask >> b) & 1 == 1 { 1 } else { -1 })
        .collect()
}

proptest! {
    /// Gauge invariance: flipping spin k while negating J's row/column k and
    /// h_k leaves the energy unchanged.
    #[test]
    fn gauge_flip_preserves_energy(
        model in arb_ising(10),
        k_raw in 0usize..10,
        mask in any::<u64>(),
    ) {
        let n = model.n();
        let k = k_raw % n;

        let mut gauged = IsingModel::<f64>::new(n);
        for i in 0..n {
            for j in (i + 1)..n {
                let v = model.coupling(i, j);
                let v = if i == k || j == k { -v } else { v };
                gauged.set_coupling(i, j, v);
            }
            let h = model.field(i);
            gauged.set_field(i, if i == k { -h } else { h });
        }

        let spins = spins_from_mask(n, mask);
        let mut flipped = spins.clone();
        flipped[k] = -flipped[k];

        let a = model.energy(&spins);
        let b = gauged.energy(&flipped);
        prop_assert!((a - b).abs() < 1e-9, "gauge violation: {a} vs {b}");
    }

    /// QUBO -> Ising preserves the objective (up to the reported offset) on
    /// every configuration.
    #[test]
    fn qubo_ising_roundtrip(qubo in arb_qubo(8), mask in any::<u64>()) {
        let n = qubo.n();
        let (ising, offset) = IsingModel::from_qubo(&qubo);
        let bits: Vec<u8> = (0..n).map(|b| ((mask >> b) & 1) as u8).collect();
        let spins: Vec<i8> = bits.iter().map(|&x| if x == 1 { 1 } else { -1 }).collect();
        let f = qubo.objective(&bits);
        let e = ising.energy(&spins) + offset;
        prop_assert!((f - e).abs() < 1e-8, "qubo {f} vs ising {e}");
    }

    /// The float view of a quantized QUBO scores identically to the exact
    /// integer objective (i32-bounded integers are exact in f64).
    #[test]
    fn quantized_objective_is_exact(qubo in arb_qubo(8), mask in any::<u64>()) {
        let n = qubo.n();
        let qq = QuantizedQubo::quantize(&qubo, DEFAULT_MAX_COEFF);
        let bits: Vec<u8> = (0..n).map(|b| ((mask >> b) & 1) as u8).collect();
        prop_assert_eq!(qq.to_qubo().objective(&bits), qq.objective(&bits) as f64);
    }

    /// No heuristic ever beats exact enumeration; every reported energy is the
    /// true energy of the reported spins.
    #[test]
    fn heuristics_never_beat_exact(model in arb_ising(8)) {
        let ground = exact::solve(&model).unwrap();
        let solvers = [
            Solver::Sb(SbConfig { variant: SbVariant::Ballistic, steps: 300, replicas: 2, seed: 7, ..SbConfig::default() }),
            Solver::Sb(SbConfig { variant: SbVariant::Discrete, steps: 300, replicas: 2, seed: 7, ..SbConfig::default() }),
            Solver::Sa(SaConfig { sweeps: 200, restarts: 2, seed: 7, ..SaConfig::default() }),
            Solver::Pt(PtConfig { sweeps: 200, replicas: 4, seed: 7, ..PtConfig::default() }),
        ];
        for solver in &solvers {
            let r = solver.solve(&model).unwrap();
            prop_assert!(
                r.energy >= ground.energy - 1e-9,
                "{} reported {} below ground state {}",
                solver.name(), r.energy, ground.energy
            );
            let recomputed = model.energy(&r.spins);
            prop_assert!(
                (recomputed - r.energy).abs() < 1e-9,
                "{} reported energy {} but its spins score {}",
                solver.name(), r.energy, recomputed
            );
        }
    }
}

/// On a fixed 16-spin dense instance with generous budgets, every heuristic
/// should reach the exact ground state. Deterministic (fixed seeds) — if a
/// solver change breaks this, quality regressed and the budget/tuning
/// trade-off needs a conscious decision, not a silent one.
#[test]
fn all_solvers_reach_ground_state_at_n16() {
    let n = 16;
    let mut model = IsingModel::<f64>::new(n);
    let mut state: u64 = 42;
    let mut next = move || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((state >> 33) as f64 / (1u64 << 31) as f64) * 4.0 - 2.0
    };
    for i in 0..n {
        for j in (i + 1)..n {
            model.set_coupling(i, j, next());
        }
        model.set_field(i, next() * 0.5);
    }

    let ground = exact::solve(&model).unwrap();
    let solvers = [
        Solver::Sb(SbConfig { variant: SbVariant::Ballistic, steps: 4000, replicas: 16, seed: 1, ..SbConfig::default() }),
        Solver::Sb(SbConfig { variant: SbVariant::Discrete, steps: 4000, replicas: 16, seed: 1, ..SbConfig::default() }),
        Solver::Sa(SaConfig { sweeps: 3000, restarts: 16, seed: 1, ..SaConfig::default() }),
        Solver::Pt(PtConfig { sweeps: 3000, replicas: 16, seed: 1, ..PtConfig::default() }),
    ];
    for solver in &solvers {
        let r = solver.solve(&model).unwrap();
        assert!(
            (r.energy - ground.energy).abs() < 1e-9,
            "{} missed the ground state: {} vs {}",
            solver.name(),
            r.energy,
            ground.energy
        );
    }
}

/// The full pipeline a portfolio run will use: float QUBO -> quantize ->
/// solve the integer model -> integer objective matches exact enumeration of
/// the same integer model.
#[test]
fn quantized_pipeline_end_to_end() {
    let n = 12;
    let mut qubo = QuboModel::<f64>::new(n);
    let mut state: u64 = 7;
    let mut next = move || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((state >> 33) as f64 / (1u64 << 31) as f64) * 2.0 - 1.0
    };
    for i in 0..n {
        for j in i..n {
            qubo.set_term(i, j, next());
        }
    }

    let qq = QuantizedQubo::quantize(&qubo, DEFAULT_MAX_COEFF);
    let canonical = qq.to_qubo();
    let (ising, offset) = IsingModel::from_qubo(&canonical);

    let ground = exact::solve(&ising).unwrap();
    let heuristic = Solver::Sa(SaConfig { sweeps: 2000, restarts: 8, seed: 3, ..SaConfig::default() })
        .solve(&ising)
        .unwrap();

    // Integer objective of the heuristic's bits, scored the canonical way.
    let heuristic_obj = qq.objective(&heuristic.bits());
    let ground_obj = qq.objective(&ground.bits());
    assert!(heuristic_obj >= ground_obj);

    // Cross-representation consistency: integer objective == ising energy + offset.
    assert_eq!(heuristic_obj as f64, heuristic.energy + offset);
}

/// The generic core works at f32 too (the WASM build target).
#[test]
fn f32_models_solve() {
    let mut m = IsingModel::<f32>::new(4);
    m.set_coupling(0, 1, 1.0);
    m.set_coupling(2, 3, 1.0);
    m.set_field(0, 0.5);
    let r = Solver::Sa(SaConfig::default()).solve(&m).unwrap();
    assert_eq!(r.spins[0], r.spins[1]);
    assert_eq!(r.spins[2], r.spins[3]);
    assert_eq!(r.spins[0], 1);
}

/// At f32, incremental-energy drift must never leak into results: every
/// solver's reported energy must be *exactly* `model.energy(&spins)` — the
/// number is recomputed from the configuration, not accumulated.
#[test]
fn f32_reported_energy_is_exactly_the_energy_of_the_spins() {
    let n = 24;
    let mut m = IsingModel::<f32>::new(n);
    let mut state: u64 = 99;
    let mut next = move || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((state >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
    };
    for i in 0..n {
        for j in (i + 1)..n {
            m.set_coupling(i, j, next());
        }
        m.set_field(i, next() * 0.5);
    }

    let solvers = [
        Solver::Sb(SbConfig { variant: SbVariant::Ballistic, steps: 1000, replicas: 4, seed: 5, ..SbConfig::default() }),
        Solver::Sb(SbConfig { variant: SbVariant::Discrete, steps: 1000, replicas: 4, seed: 5, ..SbConfig::default() }),
        Solver::Sa(SaConfig { sweeps: 2000, restarts: 4, seed: 5, ..SaConfig::default() }),
        Solver::Pt(PtConfig { sweeps: 2000, replicas: 8, seed: 5, ..PtConfig::default() }),
    ];
    for solver in &solvers {
        let r = solver.solve(&m).unwrap();
        assert_eq!(
            r.energy,
            m.energy(&r.spins),
            "{}: reported energy is not the energy of the reported spins",
            solver.name()
        );
    }
}
