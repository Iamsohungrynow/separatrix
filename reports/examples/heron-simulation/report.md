# QAOA on a Separatrix portfolio instance — run 20260816-133556

Generated 2026-08-16T13:37:19+00:00 · qiskit 2.5.2 · qiskit-ibm-runtime 0.49.0

## What this is, and what it is not

This is the only genuinely quantum step in the project. Everything else (bSB, dSB, SA, PT) is classical and quantum-*inspired*.

- **No quantum advantage is claimed.** At n=10, k=3 there are 120 feasible portfolios and exact enumeration proves the optimum in 0.011 ms. Nothing here beats that.
- QAOA parameters were optimized **in noiseless simulation**. The QPU, if used at all, ran exactly one circuit, once.
- The score is the repo's canonical **integer** objective and the headline metric is `gap_norm = (objective − best) / (worst − best)`, 0 = optimal, 1 = the worst portfolio available.

## Instance

- Source: `repo:data/leash.db` as of **2026-07-31**
- n = 10, k = 3, λ = 0.5
- Universe: ADA, ALGO, APT, ARB, ATOM, AVAX, BCH, BNB, BONK, BTC
- Quantized QUBO digest (`q_hash`): `412a2c0241bc3c561ce01e3570b9c1acd33bb3e12c8dfda6bdc3047396315c6e`
- Quantization scale: 6.856611e+10

## Ground truth (separatrix-cli `exact`)

- Optimal portfolio: **ALGO, BNB, BTC**
- Optimal objective (integer): `-3767163568`
- Worst feasible objective: `-3541184768`
- Achievable spread: `225978800`

## QAOA in simulation (noiseless statevector)

- Mixer: **XY ring mixer on a Dicke state |D^n_k> — Hamming weight, i.e. the cardinality constraint, is preserved exactly by the circuit's symmetry, so no penalty term is needed**
- Layers p = 2, parameters = 4, optimizer = Nelder-Mead ×12 restarts (4969 evaluations)
- Dicke state |D^10_3⟩ fidelity: 1.000000000000
- Feasible-subspace leakage in the final state: 4.336e-33
- Shots drawn from the exact final state: 4096

| Quantity | Value |
| --- | ---: |
| Best feasible portfolio found | ALGO, BNB, BTC |
| `gap_int` | 0 |
| **`gap_norm`** | **0.000000** |
| Rank among 120 feasible portfolios | 1 |
| Found the proven optimum? | yes |
| P(optimum) per shot | 0.0664 |
| Mean `gap_norm` per shot | 0.202798 |
| Feasible shots | 4096 / 4096 (100.00%) |

## Comparison

| Method | `gap_norm` | Optimal? | Runtime |
| --- | ---: | :---: | ---: |
| exact (proven optimum) | 0.000000 | yes | 0.011 ms |
| bsb | 0.000000 | yes | 0.734 ms |
| dsb | 0.037106 | no | 0.698 ms |
| sa | 0.000000 | yes | 0.558 ms |
| pt | 0.000000 | yes | 4.483 ms |
| QAOA p=2 (simulated, noiseless) | 0.000000 | yes | 80.5 s (optimization) |
| QAOA p=2 (hardware) | **NOT RUN** | — | — |
| random feasible guess, 1 draw | 0.462707 (expected) | no | — |
| random feasible guess, best of 4096 draws | 0.000000 (expected) | P=1.000 | — |

> **The best-of-4096 column above is saturated.** With only 120 feasible portfolios, 4096 uniform random draws already contain the optimum with probability 1.000. "Found the optimum" is therefore not evidence of anything at this size. The table below is the comparison that carries information.

### Per-shot distribution quality

What one sample is worth, before any best-of-m selection. This is the only figure that would still mean something at a size where enumeration is impossible.

| Sampler | Mean `gap_norm` per shot | P(optimum) per shot |
| --- | ---: | ---: |
| uniform random feasible portfolio | 0.462707 | 0.0083 |
| QAOA p=2 (simulated, noiseless) | 0.202798 | 0.0664 |
| QAOA p=2 (hardware) | **NOT RUN** | **NOT RUN** |

### Did it beat random?

Simulated QAOA (noiseless) **tied** the random baseline on the headline metric (both `gap_norm` 0.000000). That comparison is **saturated and therefore uninformative**: with only 120 feasible portfolios, 4096 uniform draws find the optimum with probability 1.000. Random guessing wins this instance too. Read the per-shot line instead. Per shot the distribution is genuinely biased towards good portfolios: mean `gap_norm` 0.202798 vs 0.462707 for a uniform draw (2.28x), and P(optimum) 0.0664 vs 0.0083 (8.0x). That bias is the only thing the circuit can be credited with — it is not a speedup, and exact enumeration still solved this instance in microseconds.

Hardware: **not run**, so there is no hardware claim to make. This section will state plainly whether the QPU beat random guessing once a job has actually executed.

## Hardware

- **Status: not_run.** No circuit was submitted to any QPU, and no hardware measurement exists for this run.
- Reason: --dry-run is on (the default). Nothing was submitted. Pass --no-dry-run together with --backend to execute.
- Ideal circuit as optimized: depth 110, 187 two-qubit gates on 10 qubits
- Offline compile preview on `FakeKingston` (156 qubits, snapshot coupling map): depth **1368**, **679** native two-qubit gates after routing. **Compiled only — not executed, no measurement.**

To run it for real, see `docs/quantum.md`.

## Reproduce

```
python scripts/heron_qaoa.py --fake-backend FakeKingston
```

