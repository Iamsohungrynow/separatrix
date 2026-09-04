# Constraint-preserving ansaetze on all-to-all connectivity — run 20260817-090743

Generated 2026-08-17T09:26:03+00:00 · pytket 2.18.1 · selene-sim 0.3.0 · guppylang 1.0.1 · qiskit 2.5.2 · Dicke construction: `scs` (2019 SCS cascade, LNN-optimal)

## What this is, and what it is not

Every number below is labelled **measured**, **estimated**, or **NOT RUN**. Nothing is extrapolated past the largest point that actually ran.

- **Emulated, not measured on hardware.** Phase 1 of the Challenge is Selene-only. No circuit in this run touched a QPU.
- **The noise model is a hand-parameterised stand-in.** Quantinuum's calibrated `QSystemErrorModel` is server-side in Nexus; the local open-source `selene_sim` exposes only Ideal, Depolarizing and SimpleLeakage. The depolarizing arm is set from the *published* Helios infidelities (1q 2.5e-5, 2q 7.9e-4, SPAM 3.3e-4), which is not the same thing as a calibration snapshot.
- **The prepared state is checked, not assumed.** Each |D^n_k> is compared with the analytically constructed Dicke vector and the run aborts below 0.999999999000. The compiled ansatz is separately checked to still hold all of its amplitude in the weight-k sector after optimisation, placement and rebasing.
- **"In-constraint probability", not "leakage".** On a trapped-ion machine leakage means the ion leaving the computational manifold (Wood & Gambetta, PRA 97, 032306). Hamming-weight violation is a different event and is reported under its established name (Niroula et al., Sci. Rep. 12:17171). Both are measured here, separately.
- **Not a new measurement in kind.** Dicke fidelity across (n, k) on Quantinuum H1-2 is Aktar et al., arXiv:2210.03048. Dicke + ring-XY in-constraint probability on trapped ions is Niroula et al. (n=20) and He et al., npj QI 9:121 (n=32). The all-to-all vs grid depth separation is a theorem of Baertschi & Eidenbenz, arXiv:2207.09998. What is new here is the like-for-like *compiled* cost curve across (n, k), and the separation of physical leakage from sector loss.

## Headline

- **35 (n, k) points measured**, n = 4..16. 35 verified against the analytic Dicke vector; 20 also emulated under noise.
- **The routing tax is 1.96x on heavy-hex and 2.20x on a line**, in compiled two-qubit gates, against all-to-all — same circuit, same passes, same native gate set, only the coupling graph changed.
- **Sector loss is 6.78e-04 per two-qubit gate** (median over 20 points, range 5.38e-04 - 1.02e-03), so in-constraint probability is largely predictable from gate count alone — which is what ties the ledger to fidelity rather than to cost alone.
- **Physical leakage and Hamming-weight violation are separated**, shot by shot, with `measure_leaked`. Under a leakage-only channel every leak-free shot in this run was in constraint.

## Method

The same logical circuit — Baertschi-Eidenbenz SCS Dicke preparation (arXiv:1904.07358) followed by 1 XY-ring mixer layer(s) — is compiled three times with an **identical** pass sequence (`FullPeepholeOptimise` -> `DefaultMappingPass` -> `AutoRebase` to {PhasedX, Rz, ZZPhase} -> `RemoveRedundancies`) and an identical target gate set. The only difference between the arms is the coupling graph, so the ratio between them isolates the routing tax.

The mixer angle is beta = 0.4 rad, a representative non-trivial value rather than an optimised one. The ansatz here is deliberately instance-free — no cost layer, no portfolio — so there is nothing for beta to be optimised against. It barely matters for the ledger either: gate counts depend on the *structure* of the circuit, not on its rotation angles, except where a compiler can exploit a special angle, and this one is not special. What beta does affect is the exact statevector, which is why the weight-sector check is run at this beta rather than assumed.

The construction implemented is the **2019 LNN-optimal** one, O(n) depth and O(kn) gates with no ancillas. For all-to-all hardware it is known not to be depth-optimal — the O(k log(n/k)) construction of arXiv:2207.09998 is — and the `linear` arm below is the control that shows what that construction was designed for.

## 1. Verification (measured)

| n | k | C(n,k) | Dicke fidelity vs analytic | logical weight-k population | compiled weight-k population |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 1 | 4 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 4 | 2 | 6 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 6 | 1 | 6 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 6 | 2 | 15 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 6 | 3 | 20 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 8 | 1 | 8 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 8 | 2 | 28 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 8 | 3 | 56 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 8 | 4 | 70 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 10 | 1 | 10 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 10 | 2 | 45 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 10 | 3 | 120 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 10 | 4 | 210 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 10 | 5 | 252 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 12 | 1 | 12 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 12 | 2 | 66 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 12 | 3 | 220 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 12 | 4 | 495 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 12 | 5 | 792 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 12 | 6 | 924 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 14 | 1 | 14 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 14 | 2 | 91 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 14 | 3 | 364 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 14 | 4 | 1001 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 14 | 5 | 2002 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 14 | 6 | 3003 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 14 | 7 | 3432 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 16 | 1 | 16 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 16 | 2 | 120 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 16 | 3 | 560 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 16 | 4 | 1820 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 16 | 5 | 4368 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 16 | 6 | 8008 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 16 | 7 | 11440 | 1.000000000000 | 1.000000000000 | 1.000000000000 |
| 16 | 8 | 12870 | 1.000000000000 | 1.000000000000 | 1.000000000000 |

## 2. The connectivity ledger (measured)

Two-qubit gate count and depth of the compiled ansatz. `x` columns are the multiplier against the all-to-all arm — the routing tax, in the unit that dominates both error and cost.

| n | k | all-to-all 2Q | all-to-all depth | heavy-hex 2Q | x | linear 2Q | x |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 1 | 12 | 47 | 18 | 1.50 | 21 | 1.75 |
| 4 | 2 | 30 | 116 | 51 | 1.70 | 48 | 1.60 |
| 6 | 1 | 20 | 66 | 38 | 1.90 | 38 | 1.90 |
| 6 | 2 | 56 | 207 | 92 | 1.64 | 98 | 1.75 |
| 6 | 3 | 83 | 294 | 164 | 1.98 | 176 | 2.12 |
| 8 | 1 | 28 | 81 | 40 | 1.43 | 61 | 2.18 |
| 8 | 2 | 82 | 298 | 160 | 1.95 | 145 | 1.77 |
| 8 | 3 | 127 | 443 | 256 | 2.02 | 289 | 2.28 |
| 8 | 4 | 163 | 544 | 334 | 2.05 | 349 | 2.14 |
| 10 | 1 | 36 | 100 | 48 | 1.33 | 72 | 2.00 |
| 10 | 2 | 108 | 389 | 180 | 1.67 | 180 | 1.67 |
| 10 | 3 | 171 | 592 | 363 | 2.12 | 423 | 2.47 |
| 10 | 4 | 225 | 741 | 468 | 2.08 | 495 | 2.20 |
| 10 | 5 | 270 | 756 | 615 | 2.28 | 609 | 2.26 |
| 12 | 1 | 44 | 118 | 44 | 1.00 | 107 | 2.43 |
| 12 | 2 | 134 | 480 | 233 | 1.74 | 224 | 1.67 |
| 12 | 3 | 215 | 741 | 461 | 2.14 | 461 | 2.14 |
| 12 | 4 | 287 | 938 | 608 | 2.12 | 662 | 2.31 |
| 12 | 5 | 350 | 960 | 788 | 2.25 | 773 | 2.21 |
| 12 | 6 | 404 | 959 | 758 | 1.88 | 908 | 2.25 |
| 14 | 1 | 52 | 133 | 73 | 1.40 | 106 | 2.04 |
| 14 | 2 | 160 | 571 | 277 | 1.73 | 352 | 2.20 |
| 14 | 3 | 259 | 890 | 562 | 2.17 | 547 | 2.11 |
| 14 | 4 | 349 | 1135 | 721 | 2.07 | 829 | 2.38 |
| 14 | 5 | 430 | 1164 | 934 | 2.17 | 943 | 2.19 |
| 14 | 6 | 502 | 1163 | 949 | 1.89 | 1135 | 2.26 |
| 14 | 7 | 565 | 1175 | 1099 | 1.95 | 1333 | 2.36 |
| 16 | 1 | 60 | 152 | 78 | 1.30 | 159 | 2.65 |
| 16 | 2 | 186 | 662 | 327 | 1.76 | 432 | 2.32 |
| 16 | 3 | 303 | 1039 | 660 | 2.18 | 672 | 2.22 |
| 16 | 4 | 411 | 1332 | 864 | 2.10 | 1020 | 2.48 |
| 16 | 5 | 510 | 1368 | 1125 | 2.21 | 1116 | 2.19 |
| 16 | 6 | 600 | 1367 | 1179 | 1.97 | 1374 | 2.29 |
| 16 | 7 | 681 | 1382 | 1332 | 1.96 | 1614 | 2.37 |
| 16 | 8 | 753 | 1382 | 1479 | 1.96 | 1764 | 2.34 |

- **heavy-hex needs 1.96x the two-qubit gates of all-to-all** at the median over 35 grid points (range 1.00x - 2.28x).
- **linear needs 2.20x the two-qubit gates of all-to-all** at the median over 35 grid points (range 1.60x - 2.65x).

The same thing as a curve in n, which is what the theory makes a claim about:

| n | points | median heavy-hex x | median linear x |
| ---: | ---: | ---: | ---: |
| 4 | 2 | 1.60 | 1.68 |
| 6 | 3 | 1.90 | 1.90 |
| 8 | 4 | 1.98 | 2.16 |
| 10 | 5 | 2.08 | 2.20 |
| 12 | 6 | 2.00 | 2.23 |
| 14 | 7 | 1.95 | 2.20 |
| 16 | 8 | 1.96 | 2.33 |

Baertschi & Eidenbenz (arXiv:2207.09998) predict a *depth* separation of O(sqrt(nk)) on a grid against O(k log(n/k)) all-to-all, so the grid penalty should widen with n. Whether a real compiler realises that asymptotic is exactly what the column above is for, and a flat column would be as interesting as a rising one. At the widths reached here the trend should be read as suggestive, not as a fitted exponent: no fit is attempted and none is reported.

Caveat a referee will raise, stated first: these are single deterministic compilations, not medians over transpiler seeds. pytket's `DefaultMappingPass` is deterministic here, so there is no seed distribution to report; a seed sweep on the heavy-hex arm is the obvious hardening and has **NOT** been run.

### Dicke preparation alone, against published prior art

The mixer dominates the totals above, so Dicke preparation is also compiled on its own. The reference column is the published CNOT count for the *divide-and-conquer* construction of Aktar, Baertschi, Badawy & Eidenbenz (arXiv:2210.03048, ACM TQC 5(4):27), the circuits they ran on Quantinuum H1-2. Comparable but not identical units: theirs are logical CNOTs, these are native ZZPhase gates after compiling to the Helios gate set, and a CX costs one ZZPhase plus single-qubit rotations — so the ratio is meaningful to within single-qubit overhead and no further.

| n | k | this run: 2Q, all-to-all | Aktar et al. 2024 CNOTs | ratio |
| ---: | ---: | ---: | ---: | ---: |
| 4 | 1 | 6 | not published | n/a |
| 4 | 2 | 24 | not published | n/a |
| 6 | 1 | 10 | not published | n/a |
| 6 | 2 | 46 | not published | n/a |
| 6 | 3 | 73 | 23 | 3.17 |
| 8 | 1 | 14 | not published | n/a |
| 8 | 2 | 68 | not published | n/a |
| 8 | 3 | 113 | 47 | 2.40 |
| 8 | 4 | 149 | 49 | 3.04 |
| 10 | 1 | 18 | 17 | 1.06 |
| 10 | 2 | 90 | 49 | 1.84 |
| 10 | 3 | 153 | 71 | 2.15 |
| 10 | 4 | 207 | 83 | 2.49 |
| 10 | 5 | 252 | 85 | 2.96 |
| 12 | 1 | 22 | not published | n/a |
| 12 | 2 | 112 | not published | n/a |
| 12 | 3 | 193 | not published | n/a |
| 12 | 4 | 265 | not published | n/a |
| 12 | 5 | 328 | not published | n/a |
| 12 | 6 | 382 | not published | n/a |
| 14 | 1 | 26 | not published | n/a |
| 14 | 2 | 134 | not published | n/a |
| 14 | 3 | 233 | not published | n/a |
| 14 | 4 | 323 | not published | n/a |
| 14 | 5 | 404 | not published | n/a |
| 14 | 6 | 476 | not published | n/a |
| 14 | 7 | 539 | not published | n/a |
| 16 | 1 | 30 | not published | n/a |
| 16 | 2 | 156 | not published | n/a |
| 16 | 3 | 273 | not published | n/a |
| 16 | 4 | 381 | not published | n/a |
| 16 | 5 | 480 | not published | n/a |
| 16 | 6 | 570 | not published | n/a |
| 16 | 7 | 651 | not published | n/a |
| 16 | 8 | 723 | not published | n/a |

Read this as a measurement of the *construction*, not of the compiler. The circuit here is the 2019 SCS construction, which is optimal for a line; theirs is the divide-and-conquer construction, which cuts the constants by roughly 30%. Where the ratio exceeds 1 that is the price of running an LNN-optimal construction on all-to-all hardware, and it is the strongest argument in this run for implementing the all-to-all-optimal construction of arXiv:2207.09998 next.

## 3. In-constraint probability under noise

Measured on Selene (Quest statevector backend, one independent trajectory per shot), running the *compiled all-to-all* circuit emitted as Guppy in the Helios native gate set. `leaked` is the fraction of shots in which at least one ion left the computational manifold, read out with `measure_leaked` — a physically distinct event from Hamming-weight violation.

Selene does not accept pytket circuits. The QIR route was tried first and does not work with the installed versions: `pytket.qir.pytket_to_qir` emits `__quantum__qis__read_result__body`, which Selene's QIR validator (`qir-qis` 0.1.10) rejects for every profile pytket-qir 2.0 offers. So the circuit is transliterated into Guppy instead, in the Helios native gate set, and Guppy compiles it to HUGR. That emitter is machine-generated and therefore checked, not trusted — see the self-check below.

One emitted program is committed alongside this report as `guppy_example_n4_k1.py` — the exact Guppy program that was emitted, type-checked and run for n=4, k=1 — the smallest emulated point in this run, kept because it is short enough to read; the rest are regenerated by re-running the command below.

| n | k | 2Q gates | model | shots | in-constraint P | leaked shots | in-constraint P, leak-free | lambda per 2Q |
| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 4 | 1 | 12 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 4 | 1 | 12 | `helios_spec_depolarizing` | 1000 | 0.9900 | 0 | 0.9900 | 8.375e-04 |
| 4 | 1 | 12 | `leakage_only` | 1000 | 0.9230 | 93 | 1.0000 | 6.677e-03 |
| 4 | 2 | 30 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 4 | 2 | 30 | `helios_spec_depolarizing` | 1000 | 0.9840 | 0 | 0.9840 | 5.376e-04 |
| 4 | 2 | 30 | `leakage_only` | 1000 | 0.8130 | 195 | 1.0000 | 6.901e-03 |
| 6 | 1 | 20 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 6 | 1 | 20 | `helios_spec_depolarizing` | 1000 | 0.9840 | 0 | 0.9840 | 8.065e-04 |
| 6 | 1 | 20 | `leakage_only` | 1000 | 0.8930 | 151 | 1.0000 | 5.658e-03 |
| 6 | 2 | 56 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 6 | 2 | 56 | `helios_spec_depolarizing` | 1000 | 0.9530 | 0 | 0.9530 | 8.596e-04 |
| 6 | 2 | 56 | `leakage_only` | 1000 | 0.7000 | 315 | 1.0000 | 6.369e-03 |
| 6 | 3 | 83 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 6 | 3 | 83 | `helios_spec_depolarizing` | 1000 | 0.9430 | 0 | 0.9430 | 7.071e-04 |
| 6 | 3 | 83 | `leakage_only` | 1000 | 0.5860 | 425 | 1.0000 | 6.439e-03 |
| 8 | 1 | 28 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 8 | 1 | 28 | `helios_spec_depolarizing` | 1000 | 0.9720 | 0 | 0.9720 | 1.014e-03 |
| 8 | 1 | 28 | `leakage_only` | 1000 | 0.8750 | 205 | 1.0000 | 4.769e-03 |
| 8 | 2 | 82 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 8 | 2 | 82 | `helios_spec_depolarizing` | 1000 | 0.9450 | 0 | 0.9450 | 6.899e-04 |
| 8 | 2 | 82 | `leakage_only` | 1000 | 0.6060 | 428 | 1.0000 | 6.108e-03 |
| 8 | 3 | 127 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 8 | 3 | 127 | `helios_spec_depolarizing` | 1000 | 0.9310 | 0 | 0.9310 | 5.630e-04 |
| 8 | 3 | 127 | `leakage_only` | 1000 | 0.4670 | 545 | 1.0000 | 5.995e-03 |
| 8 | 4 | 163 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 8 | 4 | 163 | `helios_spec_depolarizing` | 1000 | 0.9130 | 0 | 0.9130 | 5.584e-04 |
| 8 | 4 | 163 | `leakage_only` | 1000 | 0.3590 | 647 | 1.0000 | 6.285e-03 |
| 10 | 1 | 36 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 10 | 1 | 36 | `helios_spec_depolarizing` | 1000 | 0.9690 | 0 | 0.9690 | 8.747e-04 |
| 10 | 1 | 36 | `leakage_only` | 1000 | 0.8550 | 255 | 1.0000 | 4.351e-03 |
| 10 | 2 | 108 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 10 | 2 | 108 | `helios_spec_depolarizing` | 1000 | 0.9430 | 0 | 0.9430 | 5.434e-04 |
| 10 | 2 | 108 | `leakage_only` | 1000 | 0.5450 | 504 | 1.0000 | 5.620e-03 |
| 10 | 3 | 171 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 10 | 3 | 171 | `helios_spec_depolarizing` | 1000 | 0.9070 | 0 | 0.9070 | 5.708e-04 |
| 10 | 3 | 171 | `leakage_only` | 1000 | 0.3620 | 662 | 1.0000 | 5.942e-03 |
| 10 | 4 | 225 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 10 | 4 | 225 | `helios_spec_depolarizing` | 1000 | 0.8610 | 0 | 0.8610 | 6.652e-04 |
| 10 | 4 | 225 | `leakage_only` | 1000 | 0.2660 | 736 | 1.0000 | 5.886e-03 |
| 10 | 5 | 270 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 10 | 5 | 270 | `helios_spec_depolarizing` | 1000 | 0.8340 | 0 | 0.8340 | 6.723e-04 |
| 10 | 5 | 270 | `leakage_only` | 1000 | 0.2110 | 793 | 1.0000 | 5.763e-03 |
| 12 | 1 | 44 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 12 | 1 | 44 | `helios_spec_depolarizing` | 1000 | 0.9560 | 0 | 0.9560 | 1.023e-03 |
| 12 | 1 | 44 | `leakage_only` | 1000 | 0.8450 | 282 | 1.0000 | 3.828e-03 |
| 12 | 2 | 134 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 12 | 2 | 134 | `helios_spec_depolarizing` | 1000 | 0.9190 | 0 | 0.9190 | 6.304e-04 |
| 12 | 2 | 134 | `leakage_only` | 1000 | 0.4950 | 580 | 1.0000 | 5.248e-03 |
| 12 | 3 | 215 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 12 | 3 | 215 | `helios_spec_depolarizing` | 1000 | 0.8620 | 0 | 0.8620 | 6.907e-04 |
| 12 | 3 | 215 | `leakage_only` | 1000 | 0.2950 | 726 | 1.0000 | 5.678e-03 |
| 12 | 4 | 287 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 12 | 4 | 287 | `helios_spec_depolarizing` | 1000 | 0.8400 | 0 | 0.8400 | 6.075e-04 |
| 12 | 4 | 287 | `leakage_only` | 1000 | 0.1980 | 810 | 1.0000 | 5.643e-03 |
| 12 | 5 | 350 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 12 | 5 | 350 | `helios_spec_depolarizing` | 1000 | 0.7870 | 0 | 0.7870 | 6.844e-04 |
| 12 | 5 | 350 | `leakage_only` | 1000 | 0.1350 | 869 | 1.0000 | 5.721e-03 |
| 12 | 6 | 404 | `ideal` | 1000 | 1.0000 | 0 | 1.0000 | 0.000e+00 |
| 12 | 6 | 404 | `helios_spec_depolarizing` | 1000 | 0.7790 | 0 | 0.7790 | 6.182e-04 |
| 12 | 6 | 404 | `leakage_only` | 1000 | 0.0940 | 909 | 1.0000 | 5.853e-03 |

The last two columns are the decomposition. `in-constraint P` merges two different failures — an ion that left the computational manifold, and computational-space error that moved the register to a different Hamming weight. `in-constraint P, leak-free` is the second with the first removed, using `measure_leaked` to identify the leaked shots. Under the `leakage_only` model the two columns should separate sharply; under `helios_spec_depolarizing`, which has no leakage channel at all, they should coincide exactly. That is the control.

One readout convention worth stating, because it biases the raw column: a leaked qubit has no bit to report, so it is recorded as 0. That pushes leaked shots towards low Hamming weight and makes the raw in-constraint probability *look* worse than the computational error alone warrants. The leak-free column is unaffected, and the full Hamming-weight histogram for every point is in `result.json`.

- Sector-loss rate lambda = -ln(P_in-constraint) / G_2Q under the depolarizing arm: median 6.783e-04 per two-qubit gate across 20 points (range 5.376e-04 - 1.023e-03), against an injected two-qubit error rate of 7.9e-04. The ratio is 0.86.

  That is the point of defining lambda at all. Across a 20-point grid spanning n = 4..12, circuits whose two-qubit counts differ by a factor of 34 share a sector-loss rate per two-qubit gate that varies by less than a factor of 1.9. To the extent that it is constant, the in-constraint probability of a circuit nobody has run is predictable from its compiled gate count alone — which is what makes the connectivity ledger above a statement about *fidelity*, and not only about cost.

  What is deliberately not claimed: the ratio to the injected rate is an empirical observation, not a derived constant. Turning it into one means accounting for which two-qubit Pauli errors can change Hamming weight and which cannot, and how that depends on (n, k) — a calculation this run does not attempt, and whose absence is why the number above is reported as a measurement of this error model rather than as a property of the ansatz.

### Emission self-check

The Guppy program is machine-generated from the pytket circuit, so it is checked rather than trusted: under the ideal error model its sampled distribution is compared with the circuit's exact statevector distribution, and that discrepancy is compared against the shot-noise-only null obtained by sampling the exact distribution directly. `ratio` near 1 means the emitted program is indistinguishable from the circuit it claims to be.

| n | k | TVD vs exact | shot-noise null | ratio |
| ---: | ---: | ---: | ---: | ---: |
| 4 | 1 | 0.0160 | 0.0210 | 0.76 |
| 4 | 2 | 0.0245 | 0.0360 | 0.68 |
| 6 | 1 | 0.0093 | 0.0373 | 0.25 |
| 6 | 2 | 0.0527 | 0.0540 | 0.98 |
| 6 | 3 | 0.0501 | 0.0591 | 0.85 |
| 8 | 1 | 0.0310 | 0.0330 | 0.94 |
| 8 | 2 | 0.0626 | 0.0807 | 0.78 |
| 8 | 3 | 0.0891 | 0.0861 | 1.03 |
| 8 | 4 | 0.1040 | 0.0924 | 1.13 |
| 10 | 1 | 0.0340 | 0.0310 | 1.10 |
| 10 | 2 | 0.0719 | 0.0867 | 0.83 |
| 10 | 3 | 0.1136 | 0.1317 | 0.86 |
| 10 | 4 | 0.1768 | 0.1659 | 1.07 |
| 10 | 5 | 0.1862 | 0.1769 | 1.05 |
| 12 | 1 | 0.0460 | 0.0420 | 1.10 |
| 12 | 2 | 0.1202 | 0.0966 | 1.24 |
| 12 | 3 | 0.1772 | 0.1791 | 0.99 |
| 12 | 4 | 0.2696 | 0.2606 | 1.03 |
| 12 | 5 | 0.3288 | 0.3301 | 1.00 |
| 12 | 6 | 0.3521 | 0.3653 | 0.96 |

**NOT RUN** for 15 of 35 grid points (n = 14, 16). Reason: n=14 exceeds --selene-max-n=12. Noisy emulation costs one independent trajectory per shot, so wall time grows with shots x 2^n; nothing is extrapolated past the point that was run. Those rows are absent from the table above rather than filled with an extrapolation.

## 4. Cost (estimated)

Quantinuum HQCs for a single 1000-shot job on the compiled all-to-all circuit, from the published formula `5 + (C/5000)*(N_1q + 10*N_2q + 5*N_M)`. **Upper bound**: Helios settles the charge dynamically at run time. No HQCs were spent — nothing was submitted.

| n | k | 1Q gates | 2Q gates | measurements | HQC (upper bound) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 1 | 95 | 12 | 4 | 52.0 |
| 4 | 2 | 186 | 30 | 4 | 106.2 |
| 6 | 1 | 152 | 20 | 6 | 81.4 |
| 6 | 2 | 337 | 56 | 6 | 190.4 |
| 6 | 3 | 472 | 83 | 6 | 271.4 |
| 8 | 1 | 205 | 28 | 8 | 110.0 |
| 8 | 2 | 488 | 82 | 8 | 274.6 |
| 8 | 3 | 713 | 127 | 8 | 409.6 |
| 8 | 4 | 908 | 163 | 8 | 520.6 |
| 10 | 1 | 262 | 36 | 10 | 139.4 |
| 10 | 2 | 639 | 108 | 10 | 358.8 |
| 10 | 3 | 954 | 171 | 10 | 547.8 |
| 10 | 4 | 1244 | 225 | 10 | 713.8 |
| 10 | 5 | 1491 | 270 | 10 | 853.2 |
| 12 | 1 | 318 | 44 | 12 | 168.6 |
| 12 | 2 | 790 | 134 | 12 | 443.0 |
| 12 | 3 | 1195 | 215 | 12 | 686.0 |
| 12 | 4 | 1580 | 287 | 12 | 907.0 |
| 12 | 5 | 1926 | 350 | 12 | 1102.2 |
| 12 | 6 | 2205 | 404 | 12 | 1266.0 |
| 14 | 1 | 371 | 52 | 14 | 197.2 |
| 14 | 2 | 941 | 160 | 14 | 527.2 |
| 14 | 3 | 1436 | 259 | 14 | 824.2 |
| 14 | 4 | 1916 | 349 | 14 | 1100.2 |
| 14 | 5 | 2361 | 430 | 14 | 1351.2 |
| 14 | 6 | 2732 | 502 | 14 | 1569.4 |
| 14 | 7 | 3067 | 565 | 14 | 1762.4 |
| 16 | 1 | 428 | 60 | 16 | 226.6 |
| 16 | 2 | 1092 | 186 | 16 | 611.4 |
| 16 | 3 | 1677 | 303 | 16 | 962.4 |
| 16 | 4 | 2252 | 411 | 16 | 1293.4 |
| 16 | 5 | 2796 | 510 | 16 | 1600.2 |
| 16 | 6 | 3259 | 600 | 16 | 1872.8 |
| 16 | 7 | 3689 | 681 | 16 | 2120.8 |
| 16 | 8 | 4087 | 753 | 16 | 2344.4 |

## Limits of this run

- Emulated only. Phase 1 of the Challenge is Selene-only and no circuit here was submitted to hardware; every hardware column is NOT RUN.
- The noise model is a hand-parameterised depolarizing/leakage stand-in built from published Helios spec figures, not Quantinuum's calibrated QSystemErrorModel, which is not in the open-source package.
- The `leakage_only` rate is an upper-bound stress setting, not an estimate of Helios: it charges the whole published two-qubit infidelity to the leakage channel. Quantinuum publishes no Helios leakage rate, so the leakage columns bound the decomposition rather than predicting the device.
- Single deterministic compilation per arm; no transpiler-seed distribution. The heavy-hex multiplier is therefore a point estimate.
- The implemented Dicke construction is the 2019 LNN-optimal one. The all-to-all-optimal constructions (arXiv:2207.09998, arXiv:2505.15413) are NOT implemented and NOT measured here.
- The emulated circuits reach Selene through a generated Guppy program, not through pytket's QIR export, which Selene's validator rejects. The emitter is checked statistically per point rather than proved.
- Statevector verification stops at n=16; the noise arm stops at n=12. Nothing beyond those points is extrapolated.

## Reproduce

```
python -m quantum.characterise --n 4 6 8 10 12 14 16 --k-mode all --p 1 --shots 1000 --selene-max-n 12 --max-statevector-n 16
```

`result.json` alongside this file carries every measured quantity, including the full Hamming-weight histogram per point, per-arm compile times, the exact error-model parameters, and the package versions used.

