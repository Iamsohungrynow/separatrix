# separatrix

**Quantum-inspired Ising/QUBO solvers in pure Rust: simulated bifurcation, with the honest baselines built in.**

Simulated Bifurcation (SB) is the Toshiba-lineage optimization algorithm derived
from the classical limit of Kerr-parametric-oscillator networks (Goto et al.,
*Science Advances* 2019 & 2021) — the algorithm family Toshiba demonstrated in
a 30 µs FPGA FX-arbitrage prototype and commercializes as the SQBM+ solver. As
the pump ramps, each oscillator crosses the *separatrix* — the boundary between
basins of attraction — and commits to spin +1 or −1. That crossing is the name.

## The honesty contract

- SB is a **classical** algorithm. This crate claims **no quantum advantage and
  no guaranteed speedup** over classical baselines.
- That's why the baselines ship in the same crate: simulated annealing,
  parallel tempering (the strongest simple classical reference), and exact
  enumeration as ground truth for n ≤ 26.
- Solution quality is reported as **optimality gap against exact/MIP ground
  truth**, never as adjectives. If a baseline wins, the benchmark says so.

## What's inside

| Module | What it does |
| --- | --- |
| `model` | Dense `IsingModel` / `QuboModel` (upper-triangular convention), exact conversions between them |
| `sb` | Ballistic and discrete SB: symplectic Euler, linear pump ramp, inelastic walls, paper-faithful `ξ₀` auto-scaling |
| `sa` | Single-flip Metropolis annealing with O(1) flip evaluation via cached local fields |
| `pt` | Parallel tempering with geometric temperature ladder and alternating-parity exchanges |
| `exact` | Gray-code exhaustive ground truth (refuses n > 26 instead of silently taking hours) |
| `quantized` | The canonical integer objective: quantize once, score in `i128` — exactly what an on-chain verifier can replay |

## Quickstart

```rust
use separatrix::{IsingModel, QuboModel, Solver, SbConfig};

let mut qubo = QuboModel::<f64>::new(3);
qubo.set_term(0, 0, -1.0);
qubo.set_term(1, 1, -1.0);
qubo.set_term(0, 1, 2.0);
qubo.set_term(2, 2, -1.0);

let (ising, offset) = IsingModel::from_qubo(&qubo);
let result = Solver::Sb(SbConfig::default()).solve(&ising).unwrap();
println!("bits = {:?}, objective = {}", result.bits(), result.energy + offset);
```

## Determinism and portability

Every solver is explicitly seeded and bit-for-bit reproducible on the same
target. There is no OS-entropy dependency; the core builds for
`wasm32-unknown-unknown` with `default-features = false` (the `parallel`
feature adds rayon-powered replicas on native targets).

For settlement-grade scoring (competitions, on-chain verification), quantize
the QUBO once with `QuantizedQubo` and treat its `i128` objective as canonical:
floats are for dynamics, integers are for keeping score.

## Benchmarks

`cargo bench` runs criterion throughput benchmarks on dense spin glasses.

Solution *quality* is measured by the Separatrix workbench in the parent repo,
which walks a real crypto universe forward and solves every rebalance with
every solver **and** exact enumeration, so each gap is measured against a
proven optimum rather than against another heuristic. From the first published
study (39 assets, K=8, 234 weekly rebalances, 2022-02 → 2026-07, exact ground
truth available on 100% of them):

| Solver | Mean gap vs optimum | At the optimum | Mean runtime |
| --- | ---: | ---: | ---: |
| bSB | 0.10% | 13.2% | 1.6 ms |
| SA | 0.14% | 1.7% | 1.0 ms |
| PT | 0.18% | 0.0% | 5.2 ms |
| dSB | 0.54% | 1.3% | 1.4 ms |
| exact | 0 | 100% | 218.6 ms |

Read that honestly: at this size exact enumeration is affordable and wins
outright, so the heuristics' value is the ~140× speed-up for a ~0.1% objective
concession — a trade that only starts to matter as C(N,K) explodes. The
methodology, cost model, baselines, and limitations are in
[`docs/workbench.md`](../docs/workbench.md); every figure above is reproducible
with the command in that document.

## Correctness

Property-based tests (proptest) enforce, among others: spin-flip gauge
invariance of the energy; exact QUBO↔Ising objective equivalence on every
configuration; exact integer/float scoring agreement after quantization; and
that **no heuristic ever reports an energy below the exact ground state**.
`cargo test` runs the lot.

## References

- H. Goto, K. Tatsumura, A. R. Dixon, *Combinatorial optimization by simulating
  adiabatic bifurcations in nonlinear Hamiltonian systems*, Science Advances 5,
  eaav2372 (2019) — aSB, the `ξ₀` scaling.
- H. Goto et al., *High-performance combinatorial optimization based on
  classical mechanics*, Science Advances 7, eabe7953 (2021) — bSB/dSB,
  inelastic walls.
- K. Tatsumura et al., FPGA/GPU SB machines and the FX-arbitrage system that
  motivated this implementation.

## Status

The crate ships the solver core plus `portfolio`: the cardinality-constrained
selection QUBO, greedy repair to exactly K, and a K-subset enumerator that
returns proven optima up to a configurable `C(N,K)` cap.

The walk-forward workbench that consumes it lives in the parent repo next to
[Leash](../README.md). Still unbuilt, and therefore still unclaimed: the
on-chain commitment/scoring program on Solana, the browser demo, and the
real-quantum-hardware comparison run.

License: MIT
