# The one genuinely quantum thing in this repository

**Status as of 2026-08-16: the pipeline is written, verified, and has been run
end to end in simulation. It has _not_ been run on quantum hardware. No IBM
Quantum credential exists in this repository, `--dry-run` defaults to on, and
no job has ever been submitted. Every hardware number in this document is
either a published device specification or an explicitly-labelled estimate —
none of it is a measurement taken by this project.**

Everything else under the Separatrix banner is **quantum-inspired and
classical**:

| Component | What it actually is |
| --- | --- |
| bSB / dSB | A symplectic Euler integrator for a classical Hamiltonian ODE |
| SA | Single-flip Metropolis Monte Carlo |
| PT | Replica exchange Monte Carlo |
| `exact` | Depth-first search over `C(N,K)` subsets |

Not one of those touches a qubit. `separatrix/README.md` says so, and it
should keep saying so. `scripts/heron_qaoa.py` is the single exception: it
builds a quantum circuit and can execute it on a superconducting quantum
processor.

---

## 1. What QAOA is doing here, in plain language

The portfolio problem is: *out of 10 assets, pick exactly 3, minimising*

```
f(x) = (1/k²)·xᵀΣx − (λ/k)·μᵀx
```

— low covariance, high expected return, exactly `k` names. There are
`C(10,3) = 120` ways to do that.

A classical solver walks through candidate portfolios. QAOA instead prepares a
quantum state that is a **superposition of all 120 feasible portfolios at
once**, then reshapes that superposition so that the good portfolios end up
with large amplitudes and the bad ones with small amplitudes. Measure it, and
you get a portfolio drawn from the reshaped distribution rather than a uniform
one.

The reshaping alternates two operations, `p` times:

1. **Phase separation.** Every basis state (= every portfolio) picks up a
   phase proportional to its objective value: `exp(−i·γ·f(x))`. Good and bad
   portfolios now differ in *phase*, not yet in probability.
2. **Mixing.** A second operation makes neighbouring portfolios interfere.
   Where phases align, amplitude builds up; where they oppose, it cancels.

That is the whole idea: *encode the cost in phases, then use interference to
turn phase differences into probability differences.* The angles `γ₁…γ_p` and
`β₁…β_p` control how hard each step pushes, and they are what gets optimized.

### The cardinality constraint, and why the mixer matters

Textbook QAOA uses an **X mixer** starting from `|+⟩^n`, which explores all
`2^n = 1024` bitstrings — including the 904 that pick the wrong number of
assets. To discourage those you add a penalty `P·(Σx − k)²` to the objective.
The penalty coefficient has to be larger than any possible gain from breaking
the constraint, which in this instance makes it roughly **an order of
magnitude larger than the portfolio signal itself**. The circuit then spends
most of its rotation angle enforcing arithmetic rather than optimizing
finance.

This pipeline uses the **XY mixer on a Dicke state** instead, which is the
state of the art for cardinality-constrained problems:

- The **Dicke state** `|D^n_k⟩` is the uniform superposition over *exactly*
  the bitstrings of Hamming weight `k` — i.e. precisely the 120 feasible
  portfolios, and nothing else. It is prepared deterministically with the
  Bärtschi–Eidenbenz "split & cyclic shift" construction
  ([arXiv:1904.07358](https://arxiv.org/abs/1904.07358)).
- The **XY mixer** `Σ (XᵢXⱼ + YᵢYⱼ)/2` commutes with the total number
  operator, so it can move amplitude *between* weight-3 states but never
  *out* of the weight-3 subspace.

The constraint is therefore enforced by the **symmetry of the circuit**, not
by a penalty. No penalty term appears in the cost operator at all, and in a
noiseless run **no shot can ever return the wrong number of assets**. The
measured leakage out of the feasible subspace in the run below was `4.3e-33`
— floating-point dust.

The script implements both. `--mixer x` selects the penalty formulation, and
section 6 reports what that costs.

### Honesty machinery built into the script

The script refuses to produce a number it cannot justify:

- The prepared Dicke state is checked against the analytic `|D^n_k⟩` vector
  and the run **aborts** if fidelity is below `1 − 1e-9`.
- The float Hamiltonian the circuit encodes is checked against the **canonical
  integer objective** on all 120 feasible portfolios before a single gate is
  laid down; a disagreement aborts the run.
- The Python re-scoring of the feasible set is compared against
  `separatrix-cli`'s own `exact` block (best *and* worst); a mismatch aborts.
- Scoring uses the same canonical integer objective as the workbench and the
  Solana verifier — floats build the model, integers keep the score.

---

## 2. What will be claimed, and what will not

When this runs on hardware, the claim is exactly this:

> A cardinality-constrained portfolio instance from the Separatrix study was
> mapped to a 10-qubit Ising Hamiltonian, QAOA parameters were optimized in
> noiseless simulation, and the resulting circuit was executed once on
> \<backend\>, an IBM Quantum \<processor\> device. Of N shots, M returned a
> feasible portfolio. The best of those scored `gap_norm = …` against the
> proven optimum from exhaustive enumeration, ranking …/120.

And explicitly **not**:

- ❌ **No quantum advantage.** None. At `n=10, k=3`, exact enumeration proves
  the optimum in **0.011 ms**. The QPU cannot approach that, and neither can
  the simulation, whose parameter optimization alone took 80 seconds.
- ❌ **No speedup.** The classical heuristics in this repo solve this instance
  in under 5 ms. The quantum job will spend minutes to hours in a queue.
- ❌ **No claim that QAOA scales.** This instance was chosen *because* it is
  small enough to have provable ground truth, not because it is hard.
- ❌ **No claim from the simulation about hardware.** The simulated result
  below is noiseless. It says what the algorithm does, not what the device
  does.
- ❌ **Nothing at all until a job runs.** Until then the artifact says
  `"executed": false, "status": "not_run"` and every hardware cell reads
  **NOT RUN**.

The honest reason to do this at all: it establishes that the repo's objective,
its quantization, and its scoring are portable to a genuine quantum
formulation — and it produces a real, checkable measurement of where 2026-era
hardware sits on a problem this project actually cares about. A bad result
published honestly is worth more than a good result that is really a
simulation with a quantum-sounding label.

---

## 3. What the simulation achieved (run 20260816-133556)

> The full artifact for this run is committed at
> [`reports/examples/heron-simulation/`](../reports/examples/heron-simulation/)
> — `result.json` and `report.md`, exactly as the script emitted them. Every
> figure quoted below is in that file, including the ones that say **not run**.

Run with no credentials, no hardware:

```
python scripts/heron_qaoa.py --fake-backend FakeKingston
```

**Instance** — real repo data, `data/leash.db`, rebalance date **2026-07-31**,
universe `ADA, ALGO, APT, ARB, ATOM, AVAX, BCH, BNB, BONK, BTC`, `k=3`,
`λ=0.5`. QUBO digest `412a2c02…15c6e`.

**Ground truth** — optimum `ALGO, BNB, BTC`, objective `-3767163568`, worst
feasible `-3541184768`, spread `225978800`, proven by enumeration in 0.011 ms.

| Method | `gap_norm` | At the optimum? | Runtime |
| --- | ---: | :---: | ---: |
| exact | 0.000000 | yes | 0.011 ms |
| bSB | 0.000000 | yes | 0.73 ms |
| dSB | 0.037106 | no | 0.70 ms |
| SA | 0.000000 | yes | 0.56 ms |
| PT | 0.000000 | yes | 4.48 ms |
| **QAOA p=2, XY/Dicke (simulated, noiseless)** | **0.000000** | **yes** | 80.5 s (parameter optimization) |
| QAOA p=2 (hardware) | **NOT RUN** | — | — |
| random feasible guess, best of 4096 | 0.000000 | P = 1.000 | — |

**The last row is the important one.** With only 120 feasible portfolios,
4096 uniform random draws contain the optimum with probability ≈ 1. So "QAOA
found the optimum" is **not evidence of anything** at this size — random
guessing found it too. The best-of-m comparison is saturated, and the script
says so in those words rather than banking the tie as a win.

The comparison that does carry information is the **per-shot distribution**:

| Sampler | Mean `gap_norm` per shot | P(optimum) per shot |
| --- | ---: | ---: |
| uniform random feasible portfolio | 0.462707 | 0.0083 |
| QAOA p=2, XY/Dicke (noiseless) | **0.202798** | **0.0664** |

A single shot from the optimized circuit is **2.28× closer to the optimum on
average** than a random feasible portfolio, and **8.0× more likely** to *be*
the optimum. That, and only that, is what the algorithm can be credited with.
Feasible shots: **4096 / 4096 (100%)**, exactly as the XY-mixer symmetry
argument requires.

**Conclusion for TASK 3: the pipeline works end to end and the simulated QAOA
does find the proven optimum — but at this size so does random guessing, and
the only defensible claim is the per-shot distribution bias above.**

### What the X mixer costs (`--mixer x`)

Same instance, same budget, penalty formulation instead:

| | XY / Dicke | X / penalty |
| --- | ---: | ---: |
| Feasible shots | 100% | **61.1%** |
| Mean `gap_norm` per shot | 0.2028 | 0.4533 |
| P(optimum) per shot | 0.0664 | **0.0039** |

The penalty version is *worse than random* at hitting the optimum (0.0039 vs
0.0083) while throwing away 39% of its shots. The script's verdict for it
reads "**mixed and not a win**". This is why the XY/Dicke formulation is the
default.

---

## 4. Noise expectation — what hardware will probably do

This section is an **estimate from gate counts**, not a measurement.

The optimized `p=2` circuit is 10 qubits, depth 110, with **187 two-qubit
gates** in the ideal (all-to-all) form. The cost layer alone needs all 45
`R_zz` couplings per layer, because the covariance matrix is dense.

Real IBM devices are **heavy-hex**: each qubit has at most 3 neighbours. An
all-to-all interaction pattern must therefore be routed with SWAPs. Compiling
the same circuit against `FakeKingston` (a stored snapshot of `ibm_kingston`'s
156-qubit Heron r2 coupling map, `optimization_level=3`) gives:

**depth 1368, and 679 native two-qubit gates** — a 3.6× blow-up from routing.

`ibm_kingston` publishes a median two-qubit error rate of **2.03×10⁻³**. If
errors were independent, the probability that a shot survives all 679
two-qubit gates untouched is

```
(1 − 0.00203)^679 ≈ 0.25
```

so roughly **three quarters of shots will contain at least one two-qubit
error**, before readout error, idling/decoherence during a depth-1368 circuit,
or crosstalk are counted. Realistic expectation: **20–30% of shots survive
approximately intact.**

And here is the sharp edge of the XY/Dicke design: **any single bit-flip
breaks the Hamming-weight symmetry**, so a corrupted shot almost always
returns the wrong number of assets and is *visibly* discarded rather than
silently scored. The feasible fraction the script reports is therefore a
direct, honest read-out of how much of the circuit's structure the device
preserved. Expect it to be far below 100%, and expect the report to say so.

Best guess, stated as a guess: the hardware run finds a mediocre feasible
portfolio, `gap_norm` somewhere between 0.1 and 0.5, a feasible fraction
around 20–40%, and a per-shot distribution close to — possibly worse than —
uniform random. **If that happens, the artifact will say "did NOT beat random
guessing" in bold, and that sentence stays in.**

Lowering the cost: `--p 1` cuts the routed circuit to **depth 967 and 452
native two-qubit gates** on the same map, lifting the same survival estimate to
`(1 − 0.00203)^452 ≈ 0.40`. It is the more likely configuration to show signal
on hardware, at the price of a weaker ideal distribution. (Gate counts depend
on the optimized angles, so they shift a little between runs; these are the
numbers the runs quoted here actually produced.)

---

## 5. Access research — the state of free/cheap real quantum hardware

Checked **2026-08-16**. Prices and plans move; re-verify before spending.

### IBM Quantum Open Plan — still exists, and is the right choice here

| | |
| --- | --- |
| **Status** | Alive. Free tier still open to new signups. |
| **Allowance** | **10 minutes of QPU runtime per rolling 28-day window.** |
| **2026 promotion** | Users who log ≥ 20 minutes of compute in any 12-month period can opt in to **180 minutes over the following 12 months** (announced 2026-03-16/20). |
| **Hardware** | **`ibm_kingston` — Heron r2, 156 qubits**, 340k CLOPS, median 2-qubit error **2.03×10⁻³** — was opened to *all* Open Plan users in the same March 2026 announcement. |
| **Region** | **us-east only.** Open Plan instances cannot be created in other regions. |
| **Execution modes** | **Job mode and batch mode only. Sessions are blocked on the Open Plan** and a session job will fail. This pipeline submits a single job in job mode, so it is compatible. |
| **Signup** | Free IBM Cloud account at `quantum.cloud.ibm.com`. No credit card for the Open Plan. |
| **Queue** | Typically **5 minutes to 2 hours**, load-dependent. `service.least_busy(operational=True, simulator=False)` picks the shortest queue. |

**Does the free plan permit this kind of job?** Yes. A single 10-qubit,
4096-shot sampler job in job mode is exactly the intended Open Plan workload,
and consumes a few seconds of the 10-minute allowance.

Newer IBM silicon exists — **Nighthawk** (120 qubits, ~5,000 two-qubit gate
circuits, released to cloud access around January 2026) and **Loon** (an
experimental error-correction testbed) — but Heron r2 `ibm_kingston` is what
the Open Plan explicitly grants, and 156 qubits is already 15× more than this
instance needs. Qubit count is not the binding constraint here; two-qubit
fidelity and connectivity are.

### Current Python SDK

| Package | Version installed & verified here | Notes |
| --- | --- | --- |
| `qiskit` | **2.5.2** | The 2.x series; `qiskit.quantum_info.Statevector` does all local simulation, so **Aer is not required**. |
| `qiskit-ibm-runtime` | **0.49.0** (released 2026-08-10) | Provides `QiskitRuntimeService` and the V2 primitives. |

The **V2 primitives** are the current API and differ substantially from V1:

- `Sampler` is now an alias of `SamplerV2`.
- `sampler.run()` takes a list of **PUBs** (`[isa_circuit]`), not a bare
  circuit, and returns per-PUB results: `job.result()[0]`.
- Counts live under the classical register name:
  `pub_result.data.meas.get_counts()` for a circuit built with
  `measure_all()`. (The script probes several register names defensively.)
- Circuits **must already be ISA-compliant** — transpiled to the backend's
  basis and coupling map via
  `generate_preset_pass_manager(backend=…, optimization_level=…)`. Submitting
  an untranspiled circuit is rejected.
- Channel: `channel="ibm_quantum_platform"` with an IBM Cloud **API key** and
  optionally the instance **CRN**. The old `channel="ibm_quantum"` of the
  classic platform is gone — the classic IBM Quantum Platform was sunset on
  **2025-07-01** — and `ibm_cloud` is a deprecated alias of the same endpoint.

### If the Open Plan disappears — cheapest real alternatives

| Route | Price | Cost of one 4096-shot job | Notes |
| --- | --- | ---: | --- |
| **IBM Pay-As-You-Go** | ~**$96/minute** of QPU time | a few dollars | Rate reported by a third-party price tracker; IBM's own plans page did not state a figure. **Confirm on IBM's pricing page before spending.** Billing is by QPU-occupancy time, not shots — a deeper circuit costs more at the same shot count. |
| **AWS Braket — Rigetti Cepheus** | $0.30/task + **$0.000425/shot** | **$2.04** | Cheapest real superconducting QPU per shot. |
| **AWS Braket — IQM Garnet** | $0.30/task + $0.00145/shot | $6.24 | |
| **AWS Braket — IQM Emerald** | $0.30/task + $0.00160/shot | $6.85 | |
| **AWS Braket — IonQ Forte** | $0.30/task + **$0.08/shot** | **$328** | Trapped-ion: all-to-all connectivity, so *no SWAP blow-up* — the 187 ideal two-qubit gates stay ~187. Far higher fidelity per gate, far higher price. |

**Recommendation:** IBM Open Plan (free) first. If a second platform is worth
it, IonQ Forte is the scientifically interesting one — all-to-all connectivity
removes exactly the routing overhead that dominates the heavy-hex estimate in
section 4 — but at $328 for one job, run it at 512 shots (~$41) instead. Note
that Braket is not Qiskit-native; the script would need a
`qiskit-braket-provider` adapter or a rewrite against the Braket SDK. That
adapter is **not** written.

---

## 6. Step by step: how to actually run it

### 6.1 Install

```
python -m pip install -r requirements-quantum.txt
```

`qiskit` is deliberately **not** in `requirements.txt` — nothing in the agent,
the workbench, the dashboard or the 338-test suite needs it, and it pulls
~250 MB of wheels. Keep the main install light.

Also make sure the Rust CLI is built, since the script gets its ground truth
from it:

```
cd separatrix && cargo build --release
```

### 6.2 Get an IBM Quantum credential

1. Go to **<https://quantum.cloud.ibm.com>** and create a free IBM Cloud
   account. No credit card is needed for the Open Plan.
2. On the dashboard, create an **Open Plan** instance. It will be in the
   **us-east** region — that is the only region the Open Plan supports.
3. Create an **API key**. *It is shown once.* Copy it immediately.
4. From **Instances**, copy the instance **CRN** (the copy icon at the end of
   the row).

### 6.3 Put the credential somewhere the script will find it

The script reads `IBM_QUANTUM_TOKEN` (or `QISKIT_IBM_TOKEN`) and
`IBM_QUANTUM_INSTANCE` (or `QISKIT_IBM_INSTANCE`) from the environment.

PowerShell:

```powershell
$env:IBM_QUANTUM_TOKEN    = "<your api key>"
$env:IBM_QUANTUM_INSTANCE = "<your instance CRN>"
```

bash:

```bash
export IBM_QUANTUM_TOKEN="<your api key>"
export IBM_QUANTUM_INSTANCE="<your instance CRN>"
```

Or save it once into `~/.qiskit/qiskit-ibm.json` and skip the env vars:

```python
from qiskit_ibm_runtime import QiskitRuntimeService
QiskitRuntimeService.save_account(
    channel="ibm_quantum_platform", token="<api key>", instance="<CRN>", set_as_default=True,
)
```

**Do not put the token in `.env`, in a commit, or anywhere under `secrets/`
that gets shipped.** It is a live credential against a metered account.

### 6.4 Rehearse without spending anything

```
# Pure simulation, no network. Proves the pipeline end to end.
python scripts/heron_qaoa.py

# See what the circuit costs on the real coupling map. Still offline,
# still no credential, still executes nothing.
python scripts/heron_qaoa.py --fake-backend FakeKingston

# With a credential: compile against the live backend. Still submits nothing,
# because --dry-run is on by default.
python scripts/heron_qaoa.py --backend ibm_kingston
```

### 6.5 Submit — the one command that actually uses the QPU

```
python scripts/heron_qaoa.py --backend ibm_kingston --no-dry-run
```

`--no-dry-run` is required; there is no other way to reach a QPU from this
script, and omitting `--backend` is a hard error. The script prints the **job
id** immediately and exits without waiting.

Add `--wait` to block until the job finishes and write the completed artifact
in one go — but the queue is typically **5 minutes to 2 hours**, so the
two-step flow is usually nicer:

```
python scripts/heron_qaoa.py --backend ibm_kingston --fetch-job <job-id>
```

Every stage is deterministic given `--seed` (default 42), so `--fetch-job`
rebuilds the *identical* instance and the *identical* optimized circuit before
attaching the hardware counts. The re-derivation is free and the artifact is
self-consistent.

### 6.6 Expected cost and time

- **QPU time:** a single 4096-shot job at this depth is on the order of a few
  seconds of quantum time — comfortably inside the 10-minute window. The
  script records whatever usage the job reports; trust that number, not this
  estimate.
- **Wall-clock:** 5 minutes to 2 hours of queue, plus ~90 s of local
  parameter optimization.
- **Money:** $0 on the Open Plan.
- **Allowance:** you should be able to run this ~50+ times per 28-day window.
  Use `--p 1` to halve the circuit if you want to spend less per shot.

### 6.7 Where the artifact lands

```
reports/heron/<YYYYMMDD-HHMMSS>/result.json   # full artifact, incl. raw counts
reports/heron/<YYYYMMDD-HHMMSS>/report.md     # the readable write-up
```

`reports/` is gitignored except `reports/examples/`, so a run does not dirty
the tree. Copy the directory into `reports/examples/` if you want to commit
the hardware artifact — and if you do, **commit the one you got, not the one
you wanted**.

---

## 7. Limitations

1. **The hardware run has not happened.** Everything in section 4 is an
   estimate from gate counts and published error rates.
2. **`n=10, k=3` is a toy.** It was chosen so exact ground truth is instant.
   Nothing here says anything about instances where enumeration fails.
3. **Best-of-m is saturated at this size** (section 3). Only the per-shot
   distribution carries information, and it is the weaker claim.
4. **The parameters are optimized noiselessly.** Noise-aware optimization
   (or error mitigation) would likely do better on hardware and is not
   implemented. That is a deliberate honesty choice: a variational loop
   against the QPU would blow the free allowance and make "one circuit, one
   job" untrue.
5. **No error mitigation.** No ZNE, no PEC, no twirling, no dynamical
   decoupling. The raw device result is the point.
6. **The Trotter split of the XY ring mixer** is exact within each of the two
   colour classes but approximate between them. With `n` odd the two classes
   overlap and the split is coarser; the script warns.
7. **Braket is not wired up.** The alternative-provider pricing in section 5 is
   research, not a working code path.
8. **Simulation is capped at 24 qubits** by design — beyond that the
   statevector and the `C(n,k)` enumeration both stop being free.

---

## References

- H. Goto et al., *Combinatorial optimization by simulating adiabatic
  bifurcations*, Sci. Adv. 5 eaav2372 (2019) — the classical algorithm this
  repo is actually built on.
- E. Farhi, J. Goldstone, S. Gutmann, *A Quantum Approximate Optimization
  Algorithm*, [arXiv:1411.4028](https://arxiv.org/abs/1411.4028).
- S. Hadfield et al., *From the QAOA to a Quantum Alternating Operator Ansatz*,
  [arXiv:1709.03489](https://arxiv.org/abs/1709.03489) — XY mixers and
  constraint-preserving ansätze.
- A. Bärtschi, S. Eidenbenz, *Deterministic Preparation of Dicke States*,
  [arXiv:1904.07358](https://arxiv.org/abs/1904.07358) — the SCS construction
  implemented in `build_dicke_circuit`.
- [IBM Quantum plans overview](https://quantum.cloud.ibm.com/docs/en/guides/plans-overview)
- [Migrate to the V2 primitives](https://quantum.cloud.ibm.com/docs/en/guides/v2-primitives)
- [Amazon Braket pricing](https://aws.amazon.com/braket/pricing/)
