//! Solver throughput on a dense random spin glass.
//!
//! Run with `cargo bench`. These are throughput benchmarks, not quality
//! benchmarks — solution quality vs. ground truth lives in the test suite and
//! the (upcoming) workbench, where optimality gaps are reported explicitly.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use separatrix::{IsingModel, PtConfig, SaConfig, SbConfig, SbVariant, Solver};

/// Deterministic dense instance from a tiny splitmix-style hash, so benches
/// need no RNG dependency and never vary between runs.
fn dense_instance(n: usize) -> IsingModel<f64> {
    let mut model = IsingModel::new(n);
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = move || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
    };
    for i in 0..n {
        for j in (i + 1)..n {
            model.set_coupling(i, j, next());
        }
    }
    model
}

fn bench_solvers(c: &mut Criterion) {
    let mut group = c.benchmark_group("dense-spin-glass");
    group.sample_size(10);

    for &n in &[64usize, 256] {
        let model = dense_instance(n);
        let solvers: Vec<(String, Solver)> = vec![
            (
                "bSB".into(),
                Solver::Sb(SbConfig {
                    variant: SbVariant::Ballistic,
                    steps: 1000,
                    replicas: 8,
                    ..SbConfig::default()
                }),
            ),
            (
                "dSB".into(),
                Solver::Sb(SbConfig {
                    variant: SbVariant::Discrete,
                    steps: 1000,
                    replicas: 8,
                    ..SbConfig::default()
                }),
            ),
            (
                "SA".into(),
                Solver::Sa(SaConfig {
                    sweeps: 1000,
                    restarts: 8,
                    ..SaConfig::default()
                }),
            ),
            (
                "PT".into(),
                Solver::Pt(PtConfig {
                    sweeps: 1000,
                    replicas: 16,
                    ..PtConfig::default()
                }),
            ),
        ];
        for (name, solver) in solvers {
            group.bench_with_input(BenchmarkId::new(name, n), &model, |b, m| {
                b.iter(|| solver.solve(m).unwrap())
            });
        }
    }
    group.finish();
}

criterion_group!(benches, bench_solvers);
criterion_main!(benches);
