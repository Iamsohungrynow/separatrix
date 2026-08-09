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
Quality benchmarks (optimality-gap tables on portfolio instances, SB vs SA vs
PT vs exact MIP) will come from the Separatrix workbench, which does not exist
yet. Until it ships and its methodology is published alongside its numbers,
this crate quotes no performance or quality figures anywhere.

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

v0.1 is the solver core, and what you see in this crate is all that exists
today. The wider Separatrix project — a portfolio workbench, a walk-forward
harness, and an on-chain commitment/scoring program on Solana — is planned
next in the parent repo alongside [Leash](../README.md). None of it ships yet,
and nothing here claims results from it.

License: MIT
