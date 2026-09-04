# Quantum primitives: Dicke preparation + XY-ring mixer on all-to-all hardware

The reference document for the `quantum/` package. It characterises a
*constraint-preserving ansatz* — Bärtschi–Eidenbenz Dicke-state preparation
followed by an XY-ring mixer — across an (n, k) grid, on the connectivity that
Quantinuum's trapped-ion QCCD hardware actually offers, and against two
limited-connectivity controls. It is the repository's entry for the Quantum
Primitives track of the Quantinuum SG Grand Challenge 2026.

**Status as of 2026-09-04: emulator only. No hardware job has been submitted,
no HQC has been spent, and no Quantinuum credential exists in this repository.**
Phase 1 of the Challenge (to 15 October 2026) is restricted to the Selene
emulator; hardware access opens on 21 October for finalists only. Every number
below is labelled **measured** (on a statevector or on Selene), **estimated**
(from a published formula), or **NOT RUN**. The committed artifact is run
`20260817-090743` under
[`reports/examples/dicke-characterisation/`](../reports/examples/dicke-characterisation/)
— `result.json` and `report.md` exactly as the sweep emitted them, plus one
generated Guppy program as provenance. Nothing in this document is extrapolated
past the largest point that ran.

Source of truth is the code: [`quantum/dicke_xy.py`](../quantum/dicke_xy.py)
(primitives, reference simulator, verification, pytket layer),
[`quantum/characterise.py`](../quantum/characterise.py) (the sweep and the
report writer) and [`quantum/selene_backend.py`](../quantum/selene_backend.py)
(the Guppy emitter and the emulator runner).

---

## 1. What is measured

For every (n, k) on the grid the harness measures four things, and refuses to
report any of them for a circuit that failed its own correctness check:

| # | Quantity | Label | Where it comes from |
| --- | --- | --- | --- |
| 1 | Fidelity of the prepared \|D^n_k⟩ against the analytically constructed Dicke vector | measured | noiseless statevector, n ≤ `--max-statevector-n` |
| 2 | Compiled depth and two-qubit gate count on three coupling graphs: all-to-all, IBM heavy-hex, and a line | measured | one pass sequence, one native gate set, three architectures |
| 3 | In-constraint probability under noise, with physical leakage separated from Hamming-weight violation | measured | Selene, n ≤ `--selene-max-n`, three error models |
| 4 | Cost in Quantinuum HQCs for one job on the compiled all-to-all circuit | estimated | the published HQC formula, upper bound |

### Why "constraint-preserving"

The cardinality constraint "exactly k of n" is the one every portfolio in the
Separatrix study obeys. Textbook QAOA handles it with a penalty term and an
X mixer, which explores all 2^n bitstrings and spends most of its rotation
budget enforcing arithmetic. The alternative used here enforces the constraint
by *symmetry*:

- \|D^n_k⟩ is the uniform superposition over exactly the C(n,k) bitstrings of
  Hamming weight k. Prepared deterministically, it is the feasible set and
  nothing else.
- The XY-ring mixer exp(−iβ(XX+YY)/2) on each ring edge commutes with the total
  number operator, so it moves amplitude *between* weight-k states and never
  *out* of the sector.

In a noiseless run no shot can violate the constraint. On a noisy device a
violated shot is therefore a direct read-out of how much circuit structure the
hardware destroyed — which is what makes the in-constraint probability a
fidelity proxy and not merely a post-selection ratio.

---

## 2. The construction and its conventions

The Dicke circuit is the Bärtschi–Eidenbenz **split-and-cyclic-shift (SCS)**
construction ([arXiv:1904.07358](https://arxiv.org/abs/1904.07358), FCT 2019):
O(kn) gates, O(n) depth, no ancillas, and the bounds hold on linear
nearest-neighbour connectivity. It is ported verbatim from
`scripts/heron_qaoa.py::build_dicke_circuit`, which took three attempts to get
right. The three conventions that make it correct, each of which has been wrong
at least once:

1. start from \|1^k 0^{n−k}⟩ — X on the **top** k qubits, not the bottom k;
2. apply SCS_{l, min(k, l−1)} for l = n, n−1, …, 2, **descending**;
3. the controlled-Ry angle is **negated**: θ = −2·arccos(√(i/l)).

`tests/test_quantum_dicke.py` pins all three: it checks the construction
against the analytic vector for every (n, k) up to n = 8 with a numpy-only
simulator, and separately checks that flipping the sign of θ is caught.

Two more conventions that matter downstream:

- **Angles.** The module's gate IR (`GateOp = (name, params, qubits)`, with
  names `x`, `cx`, `cnry`, `xxphase`, `yyphase`) carries angles in **radians**,
  matching the paper and the qiskit original. pytket takes **half-turns**; the
  division by π happens exactly once, in `ops_to_tket`. Guppy's `angle` is also
  in half-turns, so parameters pass from pytket to Guppy unscaled. (An earlier
  emitter treated `angle()` as a radian constructor; the emission self-check in
  §3 caught it with a TVD ratio of 8.8.)
- **Qubit order.** Big-endian: qubit q is bit (n−1−q) of the statevector index,
  which is pytket's convention, so the reference simulator and pytket agree
  amplitude for amplitude with no reversal. Above about eleven qubits the
  statevector is taken from qiskit instead, which is little-endian, and
  `reverse_qargs()` restores the order explicitly. \|D^n_k⟩ is invariant under
  qubit permutation, so the Dicke fidelity is convention-free; the convention
  matters for the mixer's ring edges and for reading bitstrings.

The ansatz measured is deliberately **instance-free**: Dicke preparation plus
`--p` XY-ring layers at a fixed β = 0.4 rad, no cost layer, no portfolio.
Gate counts depend on circuit structure, not on rotation angles, so β barely
affects the ledger; it does affect the exact statevector, which is why the
weight-sector check is run at this β rather than assumed. The instance-specific
QAOA lives in `scripts/heron_qaoa.py` and is documented in
[`quantum.md`](quantum.md).

### Verification, and what happens on failure

- `verify_dicke_state` compares the prepared state against the analytic
  \|D^n_k⟩ and **raises** `VerificationError` below 1 − 10⁻⁹.
- `verify_weight_sector` checks that the *whole ansatz* — after
  `FullPeepholeOptimise`, placement, routing and rebasing — still holds all of
  its amplitude in the weight-k sector, and raises below 1 − 10⁻⁹.

A circuit that fails either check stops the sweep. It is not reported with a
caveat; it is not reported at all.

---

## 3. The compile protocol and the Selene route

### Three architectures, one pass sequence

Every arm is compiled with the **same** four passes and the **same** target
gate set, so the only variable is the coupling graph:

1. `FullPeepholeOptimise` (connectivity-agnostic optimisation)
2. `DefaultMappingPass(architecture)` (placement and routing)
3. `AutoRebase` to the Helios native set {PhasedX, Rz, ZZPhase}
4. `RemoveRedundancies`

| Arm | Coupling graph | Provenance recorded in the artifact |
| --- | --- | --- |
| `all_to_all` | complete graph on n nodes | the Helios QCCD topology |
| `heavy_hex` | `FakeKingston` device snapshot (156 qubits, `qiskit-ibm-runtime`) | falls back to a generated degree-≤3 lattice, labelled differently, if the snapshot is unavailable |
| `linear` | path on n nodes | the connectivity the 2019 construction was designed for |

The ratio of two-qubit gates between arms is then a measurement of the
**routing tax**, not of how hard two different compilers were tuned. Rz is
virtual on Helios (performed in software, no gate time), so every figure leads
with the two-qubit (ZZPhase) count. Whether the compiler relabelled qubits is
recorded per arm (`identity_qubit_permutation`); Hamming weight is
permutation-invariant so this study is immune, but the fact is recorded rather
than assumed.

### Reaching Selene

Selene is the emulator Phase 1 runs on and the only local tool that models the
Helios runtime, including ion leakage. It does not accept pytket circuits; its
inputs are HUGR (i.e. Guppy) and QIR.

The QIR route was tried first and **does not work** with the installed
versions: `pytket.qir.pytket_to_qir` emits
`__quantum__qis__read_result__body`, which Selene's validator (`qir-qis`
0.1.10) rejects as an unsupported QIS function for every profile pytket-qir 2.0
offers. So `selene_backend.py` transliterates the compiled all-to-all circuit
into straight-line **Guppy** source in the Helios native gate set, and Guppy
compiles it to HUGR. Guppy's linear type system turns "a qubit used after
measurement" or "a qubit never measured" into a *compile* error, which is what
lets a machine-generated program of a few hundred gates be trusted to consume
every qubit exactly once.

Readout uses `measure_leaked` throughout. It returns a three-valued result
(0, 1, leaked), so every shot separates two events that prior art conflates:

- **physical leakage** — an ion left the computational manifold (Wood &
  Gambetta, PRA 97, 032306, the L1/L2 sense of the word);
- **sector loss** — the surviving computational state has Hamming weight ≠ k.

A leaked qubit has no bit to report and is recorded as 0, which pushes leaked
shots toward low Hamming weight and makes the *raw* in-constraint column look
worse than computational error alone warrants. The leak-free column is
unaffected.

### The emission self-check

The emitter is machine-generated and therefore checked, not trusted. Under the
`ideal` error model the emulator's sampled distribution is compared with the
circuit's exact statevector distribution (total variation distance), and that
discrepancy is compared against the shot-noise-only null obtained by sampling
the exact distribution directly with the same number of shots. A correct
emission is indistinguishable from shot noise (ratio ≈ 1); a dropped gate, a
factor of π, or a swapped qubit moves the ratio far above 1. In the committed
run the ratio ranged 0.25–1.24 over the 20 emulated points.

---

## 4. Headline results (run 20260817-090743)

Command, for the record:

```
python -m quantum.characterise --n 4 6 8 10 12 14 16 --k-mode all --p 1 --shots 1000 --selene-max-n 12 --max-statevector-n 16
```

Stack: Python 3.12.10 on Windows 11 · numpy 2.5.2 · pytket 2.18.1 ·
pytket-qiskit 0.77.0 · pytket-quantinuum 0.59.2 · qiskit 2.5.2 ·
qiskit-ibm-runtime 0.49.0 · selene-sim 0.3.0 · guppylang 1.0.1.

- **35 (n, k) points**, n = 4..16, k = 1..⌊n/2⌋. All 35 **measured** at Dicke
  fidelity 1.000000000000 against the analytic vector; logical and compiled
  weight-k population 1.000000000000 at every point. 20 points (n ≤ 12) also
  emulated under noise.
- **Routing tax (measured):** heavy-hex needs **1.96×** the two-qubit gates of
  all-to-all at the median (range 1.00×–2.28×); a line needs **2.20×** (range
  1.60×–2.65×). Same circuit, same passes, same gate set.
- **Flat in n at the widths reached.** Per-n medians of the heavy-hex
  multiplier: 1.60 (n=4), 1.90, 1.98, 2.08, 2.00, 1.95, 1.96 (n=16); linear:
  1.68, 1.90, 2.16, 2.20, 2.23, 2.20, 2.33. Bärtschi & Eidenbenz predict a
  *depth* separation of O(√(nk)) grid versus O(k log(n/k)) all-to-all, i.e. a
  penalty that widens with n. That widening is **not yet visible at n ≤ 16**
  with this compiler; no fit is attempted and none is reported.
- **Sector-loss rate (measured, under the depolarizing stand-in):**
  λ = −ln(P_in-constraint)/G_2Q has median **6.78×10⁻⁴ per two-qubit gate**
  over 20 points (range 5.38×10⁻⁴–1.02×10⁻³), against an injected two-qubit
  error of 7.9×10⁻⁴ — a ratio of **0.86**. Circuits whose two-qubit counts
  differ by a factor of 34 (12 to 404) share a rate that varies by less than
  1.9×. To the extent it is constant, the in-constraint probability of an
  unrun circuit is predictable from its compiled gate count alone, which is
  what ties the connectivity ledger to fidelity and not only to cost. The
  ratio to the injected rate is an empirical observation of this error model,
  not a derived constant.
- **Leakage and sector loss separate cleanly (measured).** Under the
  `leakage_only` channel, every leak-free shot in the run was in constraint
  (leak-free in-constraint probability 1.0000 at all 20 points). Under
  `helios_spec_depolarizing`, which has no leakage channel, the raw and
  leak-free columns coincide exactly. That is the control for the
  decomposition.
- **Dicke preparation alone versus published prior art (measured vs.
  published):** at n=10, k=3 the compiled SCS circuit costs **153** native
  two-qubit gates against **71** CNOTs published for the divide-and-conquer
  construction on H1-2 (Aktar et al.) — **2.15× worse**. Over the eleven
  overlapping points the ratio runs 1.06× (n=10, k=1) to 3.17× (n=6, k=3).
  Units are comparable to within single-qubit overhead only (theirs are
  logical CNOTs; these are ZZPhase after rebasing). This is a measurement of
  the *construction*: the 2019 SCS circuit is LNN-optimal, and paying its price
  on all-to-all hardware is the strongest argument in the run for implementing
  the all-to-all-optimal construction next.
- **Cost (estimated, upper bound):** from 52.0 HQC (n=4, k=1) to 2344.4 HQC
  (n=16, k=8) for one 1000-shot job on the compiled all-to-all circuit, by the
  published formula 5 + (C/5000)(N_1q + 10·N_2q + 5·N_M). Helios settles the
  charge dynamically at run time; nothing was submitted and no HQC was spent.

### Two corrections that must not be re-introduced

1. **The "3.6× connectivity advantage" is wrong.** That figure compared a
   heavy-hex-routed circuit against an *unrouted logical* circuit. Measured
   like for like — both arms through the same passes — the heavy-hex tax is
   1.96× at the median and the linear tax 2.20×, and neither widens visibly
   below n = 16.
2. **"Leakage" means ions leaving the computational manifold.** On a
   trapped-ion track that is the only correct use of the word (Wood &
   Gambetta). Hamming-weight violation is the **in-constraint probability**
   (Niroula et al.), also called measured success probability (Aktar et al.)
   or post-selection ratio (He et al.). The two are different physical events
   and are measured separately here; conflating them under "leakage" would
   read as a category error to a referee from Quantinuum.

### Error models, with provenance

| Name | Selene class | Parameters | What it is |
| --- | --- | --- | --- |
| `ideal` | `IdealErrorModel` | — | noiseless control for the emission self-check |
| `helios_spec_depolarizing` | `DepolarizingErrorModel` | p_1q 2.5×10⁻⁵, p_2q 7.9×10⁻⁴, p_meas = p_init 3.3×10⁻⁴ | **hand-parameterised stand-in** from published Helios spec figures; not the calibrated `QSystemErrorModel`, which is server-side in Nexus |
| `leakage_only` | `SimpleLeakageErrorModel` | p_leak 7.9×10⁻⁴ | an **upper-bound stress setting** that charges the entire two-qubit infidelity to leakage; Quantinuum publishes no Helios leakage rate |

---

## 5. Prior art, and what is new

None of the four measured quantities is new in kind:

| Published | Where | Relation to this work |
| --- | --- | --- |
| Dicke fidelity across (n, k) on Quantinuum H1-2, n ≤ 10, divide-and-conquer construction | Aktar, Bärtschi, Badawy & Eidenbenz, [arXiv:2210.03048](https://arxiv.org/abs/2210.03048), ACM TQC 5(4):27 (2024) | reproduction; their CNOT counts are the reference column in §4 |
| Dicke + ring-XY in-constraint probability on trapped ions, n = 20, XY versus penalty | Niroula et al., Sci. Rep. 12:17171 (2022) | reproduction of the metric, and the source of its name |
| Dicke + ring-XY for cardinality-constrained portfolios on H2-1 at 32 qubits | He et al., npj QI 9:121 (2023), [arXiv:2305.03857](https://arxiv.org/abs/2305.03857) | reproduction; also why the portfolio itself is not the entry |
| Depth separation O(k log(n/k)) all-to-all versus O(√(nk)) on a grid | Bärtschi & Eidenbenz, [arXiv:2207.09998](https://arxiv.org/abs/2207.09998) (2022) | a theorem, not a discovery; §4 is its empirical form at small n |

What this harness adds:

- a **like-for-like compiled cost curve** across (n, k) on three coupling
  graphs with one pass sequence, which the literature does not report;
- a **per-two-qubit-gate sector-loss rate** λ and the observation that it is
  approximately constant across a 34× range of gate counts;
- the **separation of physical leakage from sector loss**, shot by shot, which
  Selene's independent leakage channel and `measure_leaked` make possible and
  which the cited measurements do not attempt.

---

## 6. How to run

The Quantinuum stack lives in its own environment, never the main one:

```
python -m venv .venv-quantinuum
.venv-quantinuum/Scripts/python.exe -m pip install -r requirements-quantinuum.txt
```

`guppylang` needs Python ≥ 3.12. Selene runs fully offline with no account.
The analytic core, the numpy reference simulator, every metric, and the
construction tests run in a bare environment with numpy only; pytket, qiskit,
guppy and selene are imported lazily by the functions that need them.

Reproduce the committed run:

```
.venv-quantinuum/Scripts/python.exe -m quantum.characterise --n 4 6 8 10 12 14 16 --k-mode all --p 1 --shots 1000 --selene-max-n 12 --max-statevector-n 16
```

Flags (`python -m quantum.characterise --help`):

| Group | Flag | Default | Meaning |
| --- | --- | --- | --- |
| grid | `--n` | `6 8 10 12` | register widths |
| grid | `--k-mode` | `all` | `all` = every 1 ≤ k ≤ ⌊n/2⌋ (the range Aktar et al. covered); `half` = k = ⌊n/2⌋ only; `fixed` = the explicit `--k` list |
| grid | `--k` | — | for `--k-mode fixed` |
| grid | `--construction` | `scs` | Dicke construction: `scs` (2019 cascade) or `dc` (one-level divide-and-conquer, §8); recorded in the artifact and the report header |
| grid | `--p` | `1` | XY-ring mixer layers |
| grid | `--beta` | `0.4` | mixer angle in radians; representative, not optimised |
| simulation | `--max-statevector-n` | `20` | above this no statevector is built and fidelity is NOT RUN |
| simulation | `--shots` | `500` | shots per error model on Selene |
| simulation | `--seed` | `20260817` | seed for the emulator and the self-check null |
| simulation | `--selene` / `--no-selene` | on | run the noise arm (needs guppylang + selene-sim) |
| simulation | `--selene-max-n` | `12` | noisy emulation costs one trajectory per shot; above this the noise arm is NOT RUN rather than left running for hours |
| simulation | `--selene-models` | `ideal helios_spec_depolarizing leakage_only` | which error models to run |
| simulation | `--heavy-hex-device` | `FakeKingston` | fake-backend snapshot for the heavy-hex arm |
| output | `--out` | `reports/examples/dicke-characterisation` | where `result.json`, `report.md` and the example Guppy program land |
| output | `--render-only RESULT_JSON` | — | measure nothing; regenerate `report.md` from an existing artifact |

Only k ≤ ⌊n/2⌋ is ever generated: \|D^n_k⟩ and \|D^n_{n−k}⟩ differ by a layer
of X gates, so the upper half of the range carries no new information.

Two cheaper modes:

```
# the compiled-cost ledger only, no emulator — seconds rather than minutes
.venv-quantinuum/Scripts/python.exe -m quantum.characterise --no-selene

# improve the write-up without re-measuring anything
.venv-quantinuum/Scripts/python.exe -m quantum.characterise --render-only reports/examples/dicke-characterisation/result.json
```

`--render-only` matters more than it looks: the prose of `report.md` is derived
entirely from the recorded measurements, so the report can be improved without
re-running the sweep and cannot silently acquire numbers that were never
measured. The caveats list is likewise computed from the recorded
configuration rather than stored.

Selene build artefacts (compiled binaries) go to a scratch directory and never
into the repository; the smallest emitted Guppy program is copied next to the
report as provenance. Emulator plumbing failures are recorded as NOT RUN with
the exception text and the sweep continues; a *verification* failure is never
caught.

Tests:

```
.venv-quantinuum/Scripts/python.exe -m unittest discover -s tests -p "test_quantum_dicke.py"
```

68 tests in three groups: numpy-only (always runs, pins the construction),
pytket-guarded (the pytket circuit equals the IR amplitude for amplitude;
compilation preserves the sector on every architecture and emits only native
gates), and qiskit-guarded (the IR matches `scripts/heron_qaoa.py` gate for
gate and statevector for statevector up to n = 8).

---

## 7. Limits of the committed run

- **Emulated only.** Phase 1 is Selene-only; no circuit was submitted to
  hardware and every hardware column is NOT RUN.
- **The noise model is a stand-in.** Depolarizing and leakage rates are set
  from published Helios spec figures, not from Quantinuum's calibrated
  `QSystemErrorModel`, which is not in the open-source package.
- **The `leakage_only` rate is a stress setting.** It charges the whole
  published two-qubit infidelity to leakage; the leakage columns bound the
  decomposition rather than predict the device.
- **Single deterministic compilation per arm.** pytket's `DefaultMappingPass`
  is deterministic here, so the heavy-hex multiplier is a point estimate with
  no seed distribution. A seed sweep has NOT been run.
- **The committed run uses the 2019 LNN-optimal construction.** The one-level
  divide-and-conquer construction now exists in the code (§8) but has not been
  through the noise sweep; the fully recursive all-to-all-optimal constructions
  ([arXiv:2207.09998](https://arxiv.org/abs/2207.09998),
  [arXiv:2505.15413](https://arxiv.org/abs/2505.15413)) are NOT implemented.
- **The emitter is checked statistically, not proved.** The Guppy route
  replaces pytket's QIR export, which Selene rejects; correctness is
  established per point by the self-check in §3.
- **Statevector verification stops at n = 16; the noise arm stops at n = 12.**
  Nothing beyond those points is extrapolated. The 15 grid points at n = 14
  and 16 are absent from the noise tables rather than filled in.
- **The mixer's Trotter split** is exact within each of the two ring colour
  classes and approximate between them; with n odd the classes overlap and the
  split is coarser.

---

## 8. Next steps

In rough order of value per unit of work:

1. **Transpiler-seed sweep on the heavy-hex arm**, so the routing tax is a
   distribution rather than a point estimate. This is the first thing a
   referee will ask for.
2. **All-to-all-optimal Dicke preparation.** Implement the divide-and-conquer
   construction of Aktar et al. ([arXiv:2112.12435](https://arxiv.org/abs/2112.12435))
   and the O(k log(n/k))-depth construction of Bärtschi & Eidenbenz
   ([arXiv:2207.09998](https://arxiv.org/abs/2207.09998)) alongside SCS, verify
   each against the analytic vector at the same 10⁻⁹ floor, and race them at
   matched (n, k) on the same three architectures. Nobody has published that
   bake-off on trapped ions, and the 2.15× gap in §4 is the size of the prize.
   **Landed (2026-09-04, measured).** `dicke_ops_dc` in `quantum/dicke_xy.py`
   implements one level of the divide-and-conquer construction: a hypergeometric
   weight-split ladder across an `n//2` cut, then the 2019 SCS unitary on each
   half in parallel. It verifies against the analytic Dicke vector at
   1 − 1.3 × 10⁻¹⁵ (worst case) for every (n, k) with n ≤ 12 and for every cut
   position at n ≤ 8, and is selected with `--construction dc` (default stays
   `scs`, so the committed run is reproducible byte for byte; a run's header
   names the construction it used). Dicke preparation alone, compiled to the
   Helios native set on all-to-all with the report's pass sequence:

   | n | k | SCS ZZPhase | SCS 2Q depth | DC ZZPhase | DC 2Q depth | DC / SCS | Aktar et al. CNOTs | DC / Aktar |
   | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
   | 6 | 3 | 73 | 70 | 46 | 29 | 0.63 | 23 | 2.00 |
   | 8 | 3 | 113 | 108 | 86 | 48 | 0.76 | 47 | 1.83 |
   | 8 | 4 | 149 | 136 | 95 | 55 | 0.64 | 49 | 1.94 |
   | 10 | 1 | 18 | 18 | 18 | 10 | 1.00 | 17 | 1.06 |
   | 10 | 2 | 90 | 90 | 81 | 44 | 0.90 | 49 | 1.65 |
   | 10 | 3 | 153 | 146 | 126 | 67 | 0.82 | 71 | 1.77 |
   | 10 | 4 | 207 | 188 | 153 | 81 | 0.74 | 83 | 1.84 |
   | 10 | 5 | 252 | 188 | 162 | 88 | 0.64 | 85 | 1.91 |

   Read it straight: divide-and-conquer roughly halves two-qubit depth and cuts
   ZZPhase count by 10–37 %, but stays ≈ 1.8× above the published CNOT counts.
   The (10, 1) row says why: the two-qubit split gadget compiles to exactly two
   ZZPhase, matching Aktar et al., so the whole excess is pytket's decomposition
   of the three-qubit controlled-controlled-Ry gadget (≈ 9 ZZPhase each against
   their hand-decomposed 3 CNOTs). The next lever is a cheaper three-qubit
   gadget in the IR — which would help SCS equally — not a different
   construction. The fully recursive O(k log(n/k))-depth construction is still
   **not implemented**: its weight-distribution block must be correct for every
   input weight simultaneously, which a fixed-angle ladder cannot be. Neither
   DC arm has been through the noise sweep yet; the committed report is SCS only.

3. **Calibrated noise.** Run the same compiled circuits under Quantinuum's
   `QSystemErrorModel` through Nexus once credentials exist, and report the
   stand-in and the calibrated model side by side.
4. **Hardware**, if the entry reaches Phase 2: the same sweep on Helios, with
   `measure_leaked` giving the physical-leakage column a device meaning for
   the first time. The HQC column in §4 is the budget.
5. **Wider n on Selene.** The emulator ceiling for noisy non-Clifford circuits
   is roughly n = 24–26 in wall-clock terms; the noise arm currently stops at
   12 by choice, not by limit.

---

## References

- A. Bärtschi, S. Eidenbenz, *Deterministic Preparation of Dicke States*,
  FCT 2019, [arXiv:1904.07358](https://arxiv.org/abs/1904.07358) — the SCS
  construction implemented in `dicke_ops`.
- A. Bärtschi, S. Eidenbenz, *Short-Depth Circuits for Dicke State
  Preparation*, IEEE QCE 2022,
  [arXiv:2207.09998](https://arxiv.org/abs/2207.09998) — the all-to-all versus
  grid depth theorem.
- S. Aktar, A. Bärtschi, A.-H. A. Badawy, S. Eidenbenz, *A Divide-and-Conquer
  Approach to Dicke State Preparation*,
  [arXiv:2112.12435](https://arxiv.org/abs/2112.12435).
- S. Aktar, A. Bärtschi, A.-H. A. Badawy, S. Eidenbenz, *Scalable Experimental
  Bounds for Entangled Quantum State Fidelities*, ACM TQC 5(4):27 (2024),
  [arXiv:2210.03048](https://arxiv.org/abs/2210.03048) — the H1-2 Dicke
  measurements and the CNOT counts used as the reference column.
- P. Niroula et al., *Constrained quantum optimization for extractive
  summarization on a trapped-ion quantum computer*, Sci. Rep. 12:17171 (2022) —
  in-constraint probability, XY versus penalty at n = 20.
- Z. He et al., *Alignment between initial state and mixer improves QAOA
  performance for constrained optimization*, npj Quantum Inf. 9:121 (2023),
  [arXiv:2305.03857](https://arxiv.org/abs/2305.03857) — Dicke + ring-XY
  portfolios on H2-1 at 32 qubits.
- S. Hadfield et al., *From the QAOA to a Quantum Alternating Operator
  Ansatz*, [arXiv:1709.03489](https://arxiv.org/abs/1709.03489) — XY mixers and
  constraint-preserving ansätze.
- C. J. Wood, J. M. Gambetta, *Quantification and characterization of leakage
  errors*, Phys. Rev. A 97, 032306 (2018) — what "leakage" means here.
- [arXiv:2505.15413](https://arxiv.org/abs/2505.15413) — a 2025 all-to-all
  Dicke construction, listed among the unimplemented alternatives.
- Quantinuum Helios user guide and costing page (the sources of the spec
  figures and the HQC formula), linked from `HeliosSpec.source` in
  `quantum/dicke_xy.py`.
