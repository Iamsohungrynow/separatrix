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
every solver **and** by exhaustive enumeration, so each gap is measured against
a proven optimum rather than against another heuristic. Because the enumerator
visits every feasible portfolio it also knows the *worst* one, which gives a
scale-free score: `gap_norm` is how far along the achievable objective range a
solver landed — 0 is optimal, 1 is the worst portfolio available.

From the published study (39 assets, K=8, 234 weekly rebalances, 2022-02 →
2026-07, exact ground truth on **100%** of them, up to C(39,8) = 61.5M subsets
per rebalance):

| Solver | Median `gap_norm` | At the exact optimum | Mean runtime |
| --- | ---: | ---: | ---: |
| exact | 0 | 100% | 274.3 ms |
| bSB | 0.031 | 15.0% | 2.2 ms |
| SA | 0.079 | 0% | 1.4 ms |
| PT | 0.110 | 0% | 4.9 ms |
| dSB | 0.325 | 0% | 1.8 ms |

Read that honestly. Exact enumeration is affordable at this size and wins
outright — it is the right choice here, and the heuristics are not close to
free: bSB buys its 128× speed-up by landing about 3% of the way along the
objective range, and dSB is frankly poor on these instances. The case for a
heuristic begins only where `C(N,K)` stops being enumerable. Anyone reading
"quantum-inspired solver beats classical" into this table is misreading it.

The methodology, cost model, baselines, and limitations are in
[`docs/workbench.md`](https://github.com/Iamsohungrynow/separatrix/blob/main/docs/workbench.md), including the exact command that
reproduces every figure above.

## Correctness

Property-based tests (proptest) enforce, among others: spin-flip gauge
invariance of the energy; exact QUBO↔Ising objective equivalence on every
configuration; exact integer/float scoring agreement after quantization; and
that **no heuristic ever reports an energy below the exact ground state**.
`cargo test` runs the lot.

## Related crates in this workspace

| Crate | Published | Purpose |
| --- | --- | --- |
| `separatrix` | crates.io | the library |
| `separatrix-cli` | no | JSON stdin/stdout bridge for the Python workbench (`--emit-qubo` also exports the on-chain coefficient digest) |
| `separatrix-wasm` | no | `wasm-bindgen` bindings behind Separatrix Studio |

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

`0.2.0` ships the solver core plus `portfolio`: the cardinality-constrained
selection QUBO with automatic penalty, greedy repair to exactly K, and a
K-subset enumerator that returns proven optima (best *and* worst) up to a
configurable `C(N,K)` cap. (`0.1.0` on crates.io predates the portfolio module.)

Around the crate, in the [parent repository](https://github.com/Iamsohungrynow/separatrix):

- the walk-forward workbench and the published study above;
- **Separatrix Studio** at <https://separatrix.vercel.app>: this crate compiled to
  WebAssembly (`wasm/`), solving Max-Cut, partitioning, independent set, portfolios or
  any pasted QUBO with every solver and exact enumeration in a tab;
- a **Solana program** (devnet) that commits an allocation before execution and
  re-derives its `i128` objective on-chain from the same `QuantizedQubo` scores;
- the **quantum** side: Dicke-state + XY-mixer primitives characterised on
  Quantinuum's emulator, and a QAOA pipeline for IBM hardware that has been
  run in simulation only.

Not done, and therefore not claimed: a run on real quantum hardware.

License: MIT
