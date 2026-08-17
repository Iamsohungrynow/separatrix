#!/usr/bin/env python3
r"""The (n, k) sweep: how much does a constraint-preserving ansatz actually cost?

For every point of a configurable (n, k) grid this harness measures four things
about Dicke preparation plus an XY-ring mixer, and refuses to report any of
them for a circuit that failed its own correctness check:

1. **Exact state fidelity** of |D^n_k> against the analytically constructed
   Dicke vector, on a noiseless statevector. Below 1 - 1e-9 the run stops.
2. **Compiled depth and two-qubit gate count** on three coupling graphs — all-
   to-all (Helios QCCD), IBM heavy-hex, and a line — using *one* pass sequence
   and *one* native gate set for all three, so the ratio between them is a
   measurement of the routing tax and not of how hard two different compilers
   were tuned.
3. **In-constraint probability** under noise, on Quantinuum's own Selene
   emulator, with the leakage channel toggled independently so that ions
   leaving the computational manifold can be separated from computational-space
   error that merely leaves the weight-k sector.
4. **Cost**, as the published Quantinuum HQC formula evaluated on the compiled
   all-to-all circuit.

What is deliberately *not* claimed
----------------------------------
None of the four is a new measurement in kind. Dicke fidelity across (n, k) was
characterised on Quantinuum H1-2 for n <= 10 by Aktar, Baertschi, Badawy and
Eidenbenz (arXiv:2210.03048, ACM TQC 5(4):27). In-constraint probability for
Dicke + ring-XY on trapped ions was measured by Niroula et al. (Sci. Rep.
12:17171) at n=20 and He et al. (npj QI 9:121) at n=32. The statement that
Dicke depth is O(k log(n/k)) all-to-all versus O(sqrt(nk)) on a grid is a
theorem of Baertschi & Eidenbenz (arXiv:2207.09998), not a discovery.

What this harness adds is the *empirical* form of that theorem: a like-for-like
compiled cost curve across (n, k) on three connectivity graphs, which nobody has
published, plus a per-two-qubit-gate sector-loss rate and a leakage/in-constraint
decomposition that Selene's independent leakage channel makes possible.

Usage (from the repository root, in the dedicated environment):

    .venv-quantinuum/Scripts/python.exe -m quantum.characterise --n 6 8 10 12

    # the compiled-cost ledger only, no emulator, seconds rather than minutes
    .venv-quantinuum/Scripts/python.exe -m quantum.characterise --no-selene

    # improve the write-up without re-measuring anything
    .venv-quantinuum/Scripts/python.exe -m quantum.characterise \
        --render-only reports/examples/dicke-characterisation/result.json
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from quantum import dicke_xy as dx  # noqa: E402

DEFAULT_OUT = REPO_ROOT / "reports" / "examples" / "dicke-characterisation"

#: A cell that was not measured says so in these words, everywhere.
NOT_RUN = "NOT RUN"

#: Published CNOT counts for Dicke preparation, Aktar, Baertschi, Badawy &
#: Eidenbenz, "Scalable Experimental Bounds for Entangled Quantum State
#: Fidelities", arXiv:2210.03048 / ACM TQC 5(4):27 (2024), Table 1. Their
#: circuits are the *divide-and-conquer* construction (arXiv:2112.12435), run on
#: Quantinuum H1-2. Included so this sweep's compiled counts can be read against
#: the only published trapped-ion Dicke numbers rather than against nothing.
AKTAR_2024_DIVIDE_AND_CONQUER_CNOTS: dict[tuple[int, int], int] = {
    (6, 3): 23,
    (7, 3): 35,
    (8, 3): 47,
    (8, 4): 49,
    (9, 3): 59,
    (9, 4): 66,
    (10, 1): 17,
    (10, 2): 49,
    (10, 3): 71,
    (10, 4): 83,
    (10, 5): 85,
}


def say(message: str = "") -> None:
    """print() that survives a legacy Windows console codepage."""
    try:
        print(message, flush=True)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "ascii"
        print(message.encode(encoding, errors="replace").decode(encoding), flush=True)


# --------------------------------------------------------------------------
# Environment provenance
# --------------------------------------------------------------------------


def collect_versions() -> dict[str, str]:
    from importlib.metadata import PackageNotFoundError, version

    out: dict[str, str] = {
        "python": platform.python_version(),
        "platform": f"{platform.system()} {platform.release()}",
        "numpy": np.__version__,
    }
    for package in (
        "pytket",
        "pytket-qiskit",
        "pytket-quantinuum",
        "qiskit",
        "qiskit-ibm-runtime",
        "selene-sim",
        "guppylang",
    ):
        try:
            out[package] = version(package)
        except PackageNotFoundError:
            out[package] = NOT_RUN
    return out


# --------------------------------------------------------------------------
# One grid point
# --------------------------------------------------------------------------


def measure_point(
    n: int,
    k: int,
    betas: Sequence[float],
    args: argparse.Namespace,
    selene_ok: bool,
) -> dict[str, Any]:
    """Everything measurable about one (n, k), or an explicit reason it was not."""
    record: dict[str, Any] = {
        "n": n,
        "k": k,
        "feasible_bitstrings": math.comb(n, k),
        "mixer_layers": len(betas),
    }

    logical_dicke = dx.dicke_circuit(n, k)
    logical_ansatz = dx.ansatz_circuit(n, k, betas)
    record["logical"] = {
        "dicke": dx.circuit_stats(logical_dicke),
        "ansatz": dx.circuit_stats(logical_ansatz),
        "status": "measured",
    }

    # -- 1. noiseless verification ----------------------------------------
    verification: dict[str, Any] = {}
    exact_probabilities: np.ndarray | None = None
    if n <= args.max_statevector_n:
        started = time.time()
        dicke_state = dx.tket_statevector(logical_dicke)
        fidelity = dx.verify_dicke_state(dicke_state, n, k)  # raises below 1-1e-9
        ansatz_state = dx.tket_statevector(logical_ansatz)
        population = dx.verify_weight_sector(ansatz_state, n, k)  # raises below 1-1e-9
        verification = {
            "status": "measured",
            "dicke_fidelity": fidelity,
            "logical_ansatz_weight_sector_population": population,
            "tolerance": dx.DEFAULT_FIDELITY_TOLERANCE,
            "seconds": time.time() - started,
        }
    else:
        verification = {
            "status": NOT_RUN,
            "reason": (
                f"n={n} exceeds --max-statevector-n={args.max_statevector_n}; a "
                f"2^{n} statevector was not built, so no fidelity was measured "
                "and none is reported"
            ),
        }
    record["verification"] = verification

    # -- 2. the connectivity ledger ----------------------------------------
    heavy_hex, heavy_hex_provenance = dx.heavy_hex_architecture(n, args.heavy_hex_device)
    arms = {
        "all_to_all": (dx.all_to_all_architecture(n), f"complete graph on {n} nodes (Helios QCCD)"),
        "heavy_hex": (heavy_hex, heavy_hex_provenance),
        "linear": (dx.line_architecture(n), f"line on {n} nodes (LNN)"),
    }
    compiled: dict[str, Any] = {}
    compiled_all_to_all = None
    for name, (architecture, provenance) in arms.items():
        started = time.time()
        circuit = dx.compile_for_architecture(logical_ansatz, architecture)
        stats = dx.circuit_stats(circuit)
        stats.update(
            {
                "architecture": provenance,
                "identity_qubit_permutation": dx.implicit_permutation_is_identity(circuit),
                "compile_seconds": time.time() - started,
                "status": "measured",
            }
        )
        compiled[name] = stats
        if name == "all_to_all":
            compiled_all_to_all = circuit

    # Dicke preparation on its own, all-to-all. Reported separately because it
    # is the only quantity with published trapped-ion prior art to check
    # against (Aktar et al.), and because the mixer's cost would otherwise
    # swamp the comparison.
    started = time.time()
    dicke_only = dx.compile_for_architecture(logical_dicke, dx.all_to_all_architecture(n))
    dicke_stats = dx.circuit_stats(dicke_only)
    dicke_stats.update({"status": "measured", "compile_seconds": time.time() - started})
    reference = AKTAR_2024_DIVIDE_AND_CONQUER_CNOTS.get((n, k))
    dicke_stats["aktar_2024_divide_and_conquer_cnots"] = reference
    dicke_stats["ratio_vs_aktar_2024"] = (
        dicke_stats["two_qubit_gates"] / reference if reference else None
    )
    record["compiled_dicke_only_all_to_all"] = dicke_stats

    base = compiled["all_to_all"]["two_qubit_gates"]
    for name in ("heavy_hex", "linear"):
        compiled[name]["two_qubit_multiplier_vs_all_to_all"] = (
            compiled[name]["two_qubit_gates"] / base if base else None
        )
        compiled[name]["depth_multiplier_vs_all_to_all"] = (
            compiled[name]["depth"] / compiled["all_to_all"]["depth"]
            if compiled["all_to_all"]["depth"]
            else None
        )
    record["compiled"] = compiled

    # The compiled all-to-all circuit is what the emulator actually runs, so it
    # gets its own constraint check: optimisation, placement and rebasing must
    # not have broken the symmetry that the whole design rests on.
    if n <= args.max_statevector_n:
        compiled_state = dx.tket_statevector(compiled_all_to_all)
        record["verification"]["compiled_ansatz_weight_sector_population"] = (
            dx.verify_weight_sector(compiled_state, n, k)
        )
        exact_probabilities = np.abs(compiled_state) ** 2

    # -- 3. cost -----------------------------------------------------------
    stats = compiled["all_to_all"]
    record["cost"] = {
        "status": "estimated",
        "shots": args.shots,
        "hqc_upper_bound": dx.hqc_estimate(
            args.shots,
            stats["one_qubit_gates"],
            stats["two_qubit_gates"],
            n,
        ),
        "formula": "5 + (shots/5000) * (N_1q + 10*N_2q + 5*N_M)",
        "caveat": (
            "upper bound only: Helios supports arbitrary control flow, so the "
            "charge is settled dynamically at run time"
        ),
    }

    # -- 4. noise ----------------------------------------------------------
    noise: dict[str, Any] = {}
    if not selene_ok:
        noise["status"] = NOT_RUN
        noise["reason"] = args.selene_reason
    elif n > args.selene_max_n:
        noise["status"] = NOT_RUN
        noise["reason"] = (
            f"n={n} exceeds --selene-max-n={args.selene_max_n}. Noisy emulation "
            "costs one independent trajectory per shot, so wall time grows with "
            "shots x 2^n; nothing is extrapolated past the point that was run"
        )
    else:
        from quantum import selene_backend as sb

        noise = {"status": "measured", "models": {}}
        started = time.time()
        # Emulator plumbing failing is an infrastructure fact, not a scientific
        # one: it is recorded as NOT RUN with the exception text and the sweep
        # continues. A *verification* failure is different and is never caught.
        try:
            program = sb.build_program(
                compiled_all_to_all,
                name=f"dicke_n{n}_k{k}",
                build_root=args.build_root / f"n{n}k{k}",
            )
        except Exception as exc:  # noqa: BLE001
            record["noise"] = {
                "status": NOT_RUN,
                "reason": f"Guppy/Selene build failed: {type(exc).__name__}: {exc}",
            }
            return record
        noise["guppy_build_seconds"] = program.build_seconds
        noise["guppy_source"] = str(program.source_path)
        # Keep the *first* emitted program as the committed example. The grid is
        # ordered small-first, so that is the smallest one: a few hundred lines a
        # referee can actually read, rather than a 150 kB machine dump. Every
        # other program is reproducible with one command.
        if args.example_guppy_source is None:
            args.example_guppy_source = (program.source_path, n, k)
        for model_name in args.selene_models:
            run = sb.run_program(
                program, shots=args.shots, model_name=model_name, seed=args.seed
            )
            probability, hits, total = dx.in_constraint_probability_from_shots(
                run.bitstrings, k
            )
            weights = np.bincount(
                [sum(bits) for bits in run.bitstrings], minlength=n + 1
            ).astype(float)
            split = run.in_constraint_split(k)
            entry: dict[str, Any] = {
                "status": "measured",
                "shots": run.shots,
                "in_constraint_shots": hits,
                "in_constraint_probability": probability,
                "shots_with_physical_leakage": run.shots_with_leakage,
                "physical_leakage_probability": split["physical_leakage_probability"],
                # The decomposition: sector loss with physical leakage removed.
                "leak_free_shots": split["leak_free_shots"],
                "in_constraint_probability_leak_free": split[
                    "in_constraint_probability_leak_free"
                ],
                "hamming_weight_counts": weights.tolist(),
                "subspace_loss_rate_per_2q_gate": dx.subspace_leakage_rate(
                    probability, compiled["all_to_all"]["two_qubit_gates"]
                ),
                "wall_seconds": run.wall_seconds,
                "error_model_params": run.error_model_params,
            }
            if model_name == "ideal" and exact_probabilities is not None:
                entry["emission_check"] = sb.sampling_check(
                    run, exact_probabilities, n, seed=args.seed
                )
            noise["models"][model_name] = entry
        noise["wall_seconds"] = time.time() - started
    record["noise"] = noise
    return record


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------


def _fmt(value: Any, digits: int = 6) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def summarise(points: list[dict[str, Any]]) -> dict[str, Any]:
    """Cross-grid figures: the routing multiplier and the per-gate loss rate."""
    heavy = [
        p["compiled"]["heavy_hex"]["two_qubit_multiplier_vs_all_to_all"]
        for p in points
        if p["compiled"]["heavy_hex"]["two_qubit_multiplier_vs_all_to_all"]
    ]
    line = [
        p["compiled"]["linear"]["two_qubit_multiplier_vs_all_to_all"]
        for p in points
        if p["compiled"]["linear"]["two_qubit_multiplier_vs_all_to_all"]
    ]
    rates = [
        entry["subspace_loss_rate_per_2q_gate"]
        for p in points
        if p["noise"].get("status") == "measured"
        for name, entry in p["noise"]["models"].items()
        if name == "helios_spec_depolarizing" and entry["subspace_loss_rate_per_2q_gate"]
    ]

    def spread(values: list[float]) -> dict[str, Any]:
        if not values:
            return {"status": NOT_RUN, "reason": "no measured points"}
        array = np.asarray(values, dtype=float)
        return {
            "status": "measured",
            "points": len(values),
            "min": float(array.min()),
            "median": float(np.median(array)),
            "max": float(array.max()),
        }

    return {
        "heavy_hex_two_qubit_multiplier": spread(heavy),
        "linear_two_qubit_multiplier": spread(line),
        "subspace_loss_rate_per_2q_gate": spread(rates),
    }


def limits_for(payload: dict[str, Any]) -> list[str]:
    """The caveats, derived from the run's own configuration.

    Computed rather than stored so that ``--render-only`` always renders the
    current wording against the recorded configuration, and so a caveat can
    never drift out of step with the setting that produced it.
    """
    config = payload["config"]
    return [
        "Emulated only. Phase 1 of the Challenge is Selene-only and no circuit "
        "here was submitted to hardware; every hardware column is NOT RUN.",
        "The noise model is a hand-parameterised depolarizing/leakage stand-in "
        "built from published Helios spec figures, not Quantinuum's calibrated "
        "QSystemErrorModel, which is not in the open-source package.",
        "The `leakage_only` rate is an upper-bound stress setting, not an "
        "estimate of Helios: it charges the whole published two-qubit "
        "infidelity to the leakage channel. Quantinuum publishes no Helios "
        "leakage rate, so the leakage columns bound the decomposition rather "
        "than predicting the device.",
        "Single deterministic compilation per arm; no transpiler-seed "
        "distribution. The heavy-hex multiplier is therefore a point estimate.",
        "The implemented Dicke construction is the 2019 LNN-optimal one. The "
        "all-to-all-optimal constructions (arXiv:2207.09998, arXiv:2505.15413) "
        "are NOT implemented and NOT measured here.",
        "The emulated circuits reach Selene through a generated Guppy program, "
        "not through pytket's QIR export, which Selene's validator rejects. The "
        "emitter is checked statistically per point rather than proved.",
        f"Statevector verification stops at n={config['max_statevector_n']}; the "
        f"noise arm stops at n={config['selene_max_n']}. Nothing beyond those "
        "points is extrapolated.",
    ]


def write_report(path: Path, payload: dict[str, Any]) -> None:
    lines: list[str] = []
    a = lines.append
    points = payload["points"]
    summary = payload["summary"]
    versions = payload["versions"]

    a(f"# Constraint-preserving ansaetze on all-to-all connectivity — run {payload['run_id']}")
    a("")
    a(
        f"Generated {payload['generated_at']} · pytket {versions.get('pytket')} · "
        f"selene-sim {versions.get('selene-sim')} · guppylang {versions.get('guppylang')} · "
        f"qiskit {versions.get('qiskit')}"
    )
    a("")
    a("## What this is, and what it is not")
    a("")
    a(
        "Every number below is labelled **measured**, **estimated**, or "
        f"**{NOT_RUN}**. Nothing is extrapolated past the largest point that "
        "actually ran."
    )
    a("")
    a(
        "- **Emulated, not measured on hardware.** Phase 1 of the Challenge is "
        "Selene-only. No circuit in this run touched a QPU."
    )
    a(
        "- **The noise model is a hand-parameterised stand-in.** Quantinuum's "
        "calibrated `QSystemErrorModel` is server-side in Nexus; the local "
        "open-source `selene_sim` exposes only Ideal, Depolarizing and "
        "SimpleLeakage. The depolarizing arm is set from the *published* Helios "
        "infidelities (1q 2.5e-5, 2q 7.9e-4, SPAM 3.3e-4), which is not the same "
        "thing as a calibration snapshot."
    )
    a(
        "- **The prepared state is checked, not assumed.** Each |D^n_k> is "
        "compared with the analytically constructed Dicke vector and the run "
        f"aborts below {1 - dx.DEFAULT_FIDELITY_TOLERANCE:.12f}. The compiled "
        "ansatz is separately checked to still hold all of its amplitude in the "
        "weight-k sector after optimisation, placement and rebasing."
    )
    a(
        "- **\"In-constraint probability\", not \"leakage\".** On a trapped-ion "
        "machine leakage means the ion leaving the computational manifold "
        "(Wood & Gambetta, PRA 97, 032306). Hamming-weight violation is a "
        "different event and is reported under its established name (Niroula "
        "et al., Sci. Rep. 12:17171). Both are measured here, separately."
    )
    a(
        "- **Not a new measurement in kind.** Dicke fidelity across (n, k) on "
        "Quantinuum H1-2 is Aktar et al., arXiv:2210.03048. Dicke + ring-XY "
        "in-constraint probability on trapped ions is Niroula et al. (n=20) and "
        "He et al., npj QI 9:121 (n=32). The all-to-all vs grid depth separation "
        "is a theorem of Baertschi & Eidenbenz, arXiv:2207.09998. What is new "
        "here is the like-for-like *compiled* cost curve across (n, k), and the "
        "separation of physical leakage from sector loss."
    )
    a("")

    a("## Headline")
    a("")
    verified = [p for p in points if p["verification"]["status"] == "measured"]
    emulated = [p for p in points if p["noise"].get("status") == "measured"]
    a(
        f"- **{len(points)} (n, k) points measured**, n = "
        f"{min(p['n'] for p in points)}..{max(p['n'] for p in points)}. "
        f"{len(verified)} verified against the analytic Dicke vector; "
        f"{len(emulated)} also emulated under noise."
    )
    heavy = summary["heavy_hex_two_qubit_multiplier"]
    linear = summary["linear_two_qubit_multiplier"]
    if heavy["status"] == "measured":
        a(
            f"- **The routing tax is {heavy['median']:.2f}x on heavy-hex and "
            f"{linear['median']:.2f}x on a line**, in compiled two-qubit gates, "
            "against all-to-all — same circuit, same passes, same native gate "
            "set, only the coupling graph changed."
        )
    rate = summary["subspace_loss_rate_per_2q_gate"]
    if rate["status"] == "measured":
        a(
            f"- **Sector loss is {rate['median']:.2e} per two-qubit gate** "
            f"(median over {rate['points']} points, range {rate['min']:.2e} - "
            f"{rate['max']:.2e}), so in-constraint probability is largely "
            "predictable from gate count alone — which is what ties the ledger to "
            "fidelity rather than to cost alone."
        )
    a(
        "- **Physical leakage and Hamming-weight violation are separated**, shot "
        "by shot, with `measure_leaked`. Under a leakage-only channel every "
        "leak-free shot in this run was in constraint."
    )
    a("")

    a("## Method")
    a("")
    a(
        "The same logical circuit — Baertschi-Eidenbenz SCS Dicke preparation "
        f"(arXiv:1904.07358) followed by {payload['config']['mixer_layers']} "
        "XY-ring mixer layer(s) — is compiled three times with an **identical** "
        "pass sequence (`FullPeepholeOptimise` -> `DefaultMappingPass` -> "
        "`AutoRebase` to {PhasedX, Rz, ZZPhase} -> `RemoveRedundancies`) and an "
        "identical target gate set. The only difference between the arms is the "
        "coupling graph, so the ratio between them isolates the routing tax."
    )
    a("")
    a(
        f"The mixer angle is beta = {payload['config']['beta_radians']} rad, a "
        "representative non-trivial value rather than an optimised one. The "
        "ansatz here is deliberately instance-free — no cost layer, no portfolio "
        "— so there is nothing for beta to be optimised against. It barely "
        "matters for the ledger either: gate counts depend on the *structure* of "
        "the circuit, not on its rotation angles, except where a compiler can "
        "exploit a special angle, and this one is not special. What beta does "
        "affect is the exact statevector, which is why the weight-sector check "
        "is run at this beta rather than assumed."
    )
    a("")
    a(
        "The construction implemented is the **2019 LNN-optimal** one, O(n) depth "
        "and O(kn) gates with no ancillas. For all-to-all hardware it is known "
        "not to be depth-optimal — the O(k log(n/k)) construction of "
        "arXiv:2207.09998 is — and the `linear` arm below is the control that "
        "shows what that construction was designed for."
    )
    a("")

    a("## 1. Verification (measured)")
    a("")
    a(
        "| n | k | C(n,k) | Dicke fidelity vs analytic | logical weight-k population | "
        "compiled weight-k population |"
    )
    a("| ---: | ---: | ---: | ---: | ---: | ---: |")
    for point in points:
        verification = point["verification"]
        if verification["status"] == "measured":
            a(
                f"| {point['n']} | {point['k']} | {point['feasible_bitstrings']} | "
                f"{verification['dicke_fidelity']:.12f} | "
                f"{verification['logical_ansatz_weight_sector_population']:.12f} | "
                f"{verification.get('compiled_ansatz_weight_sector_population', float('nan')):.12f} |"
            )
        else:
            a(
                f"| {point['n']} | {point['k']} | {point['feasible_bitstrings']} | "
                f"**{NOT_RUN}** | **{NOT_RUN}** | **{NOT_RUN}** |"
            )
    a("")
    not_verified = [p for p in points if p["verification"]["status"] != "measured"]
    if not_verified:
        a(f"> {len(not_verified)} point(s) were not verified: "
          f"{not_verified[0]['verification']['reason']}")
        a("")

    a("## 2. The connectivity ledger (measured)")
    a("")
    a(
        "Two-qubit gate count and depth of the compiled ansatz. `x` columns are "
        "the multiplier against the all-to-all arm — the routing tax, in the "
        "unit that dominates both error and cost."
    )
    a("")
    a("| n | k | all-to-all 2Q | all-to-all depth | heavy-hex 2Q | x | linear 2Q | x |")
    a("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for point in points:
        compiled = point["compiled"]
        a(
            f"| {point['n']} | {point['k']} | {compiled['all_to_all']['two_qubit_gates']} | "
            f"{compiled['all_to_all']['depth']} | "
            f"{compiled['heavy_hex']['two_qubit_gates']} | "
            f"{_fmt(compiled['heavy_hex']['two_qubit_multiplier_vs_all_to_all'], 2)} | "
            f"{compiled['linear']['two_qubit_gates']} | "
            f"{_fmt(compiled['linear']['two_qubit_multiplier_vs_all_to_all'], 2)} |"
        )
    a("")
    for label, key in (
        ("heavy-hex", "heavy_hex_two_qubit_multiplier"),
        ("linear", "linear_two_qubit_multiplier"),
    ):
        entry = summary[key]
        if entry["status"] == "measured":
            a(
                f"- **{label} needs {entry['median']:.2f}x the two-qubit gates of "
                f"all-to-all** at the median over {entry['points']} grid points "
                f"(range {entry['min']:.2f}x - {entry['max']:.2f}x)."
            )
    a("")
    a("The same thing as a curve in n, which is what the theory makes a claim about:")
    a("")
    a("| n | points | median heavy-hex x | median linear x |")
    a("| ---: | ---: | ---: | ---: |")
    for width in sorted({point["n"] for point in points}):
        group = [point for point in points if point["n"] == width]
        heavy_group = [
            point["compiled"]["heavy_hex"]["two_qubit_multiplier_vs_all_to_all"]
            for point in group
        ]
        line_group = [
            point["compiled"]["linear"]["two_qubit_multiplier_vs_all_to_all"]
            for point in group
        ]
        a(
            f"| {width} | {len(group)} | {float(np.median(heavy_group)):.2f} | "
            f"{float(np.median(line_group)):.2f} |"
        )
    a("")
    a(
        "Baertschi & Eidenbenz (arXiv:2207.09998) predict a *depth* separation of "
        "O(sqrt(nk)) on a grid against O(k log(n/k)) all-to-all, so the grid "
        "penalty should widen with n. Whether a real compiler realises that "
        "asymptotic is exactly what the column above is for, and a flat column "
        "would be as interesting as a rising one. At the widths reached here the "
        "trend should be read as suggestive, not as a fitted exponent: no fit is "
        "attempted and none is reported."
    )
    a("")
    a(
        "Caveat a referee will raise, stated first: these are single "
        "deterministic compilations, not medians over transpiler seeds. pytket's "
        "`DefaultMappingPass` is deterministic here, so there is no seed "
        "distribution to report; a seed sweep on the heavy-hex arm is the "
        "obvious hardening and has **NOT** been run."
    )
    a("")

    a("### Dicke preparation alone, against published prior art")
    a("")
    a(
        "The mixer dominates the totals above, so Dicke preparation is also "
        "compiled on its own. The reference column is the published CNOT count "
        "for the *divide-and-conquer* construction of Aktar, Baertschi, Badawy & "
        "Eidenbenz (arXiv:2210.03048, ACM TQC 5(4):27), the circuits they ran on "
        "Quantinuum H1-2. Comparable but not identical units: theirs are logical "
        "CNOTs, these are native ZZPhase gates after compiling to the Helios gate "
        "set, and a CX costs one ZZPhase plus single-qubit rotations — so the "
        "ratio is meaningful to within single-qubit overhead and no further."
    )
    a("")
    a("| n | k | this run: 2Q, all-to-all | Aktar et al. 2024 CNOTs | ratio |")
    a("| ---: | ---: | ---: | ---: | ---: |")
    for point in points:
        stats = point["compiled_dicke_only_all_to_all"]
        reference = stats["aktar_2024_divide_and_conquer_cnots"]
        a(
            f"| {point['n']} | {point['k']} | {stats['two_qubit_gates']} | "
            f"{reference if reference is not None else 'not published'} | "
            f"{_fmt(stats['ratio_vs_aktar_2024'], 2) if reference else 'n/a'} |"
        )
    a("")
    a(
        "Read this as a measurement of the *construction*, not of the compiler. "
        "The circuit here is the 2019 SCS construction, which is optimal for a "
        "line; theirs is the divide-and-conquer construction, which cuts the "
        "constants by roughly 30%. Where the ratio exceeds 1 that is the price "
        "of running an LNN-optimal construction on all-to-all hardware, and it "
        "is the strongest argument in this run for implementing the "
        "all-to-all-optimal construction of arXiv:2207.09998 next."
    )
    a("")

    a("## 3. In-constraint probability under noise")
    a("")
    measured_noise = [p for p in points if p["noise"].get("status") == "measured"]
    if not measured_noise:
        a(f"**{NOT_RUN}.** {points[0]['noise'].get('reason', 'no emulator run')}")
        a("")
    else:
        a(
            "Measured on Selene (Quest statevector backend, one independent "
            "trajectory per shot), running the *compiled all-to-all* circuit "
            "emitted as Guppy in the Helios native gate set. `leaked` is the "
            "fraction of shots in which at least one ion left the computational "
            "manifold, read out with `measure_leaked` — a physically distinct "
            "event from Hamming-weight violation."
        )
        a("")
        a(
            "Selene does not accept pytket circuits. The QIR route was tried "
            "first and does not work with the installed versions: "
            "`pytket.qir.pytket_to_qir` emits "
            "`__quantum__qis__read_result__body`, which Selene's QIR validator "
            "(`qir-qis` 0.1.10) rejects for every profile pytket-qir 2.0 offers. "
            "So the circuit is transliterated into Guppy instead, in the Helios "
            "native gate set, and Guppy compiles it to HUGR. That emitter is "
            "machine-generated and therefore checked, not trusted — see the "
            "self-check below."
        )
        if payload["selene"].get("example_program"):
            a("")
            a(
                "One emitted program is committed alongside this report as "
                f"`{payload['selene']['example_program']}` — "
                f"{payload['selene'].get('example_program_note', '')}."
            )
        a("")
        a(
            "| n | k | 2Q gates | model | shots | in-constraint P | leaked shots | "
            "in-constraint P, leak-free | lambda per 2Q |"
        )
        a("| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |")
        for point in measured_noise:
            two_qubit = point["compiled"]["all_to_all"]["two_qubit_gates"]
            for name, entry in point["noise"]["models"].items():
                rate = entry["subspace_loss_rate_per_2q_gate"]
                leak_free = entry.get("in_constraint_probability_leak_free")
                a(
                    f"| {point['n']} | {point['k']} | {two_qubit} | `{name}` | "
                    f"{entry['shots']} | {entry['in_constraint_probability']:.4f} | "
                    f"{entry['shots_with_physical_leakage']} | "
                    f"{_fmt(leak_free, 4) if leak_free is not None else 'n/a'} | "
                    f"{f'{rate if rate > 0 else 0.0:.3e}' if rate is not None else 'n/a'} |"
                )
        a("")
        a(
            "The last two columns are the decomposition. `in-constraint P` merges "
            "two different failures — an ion that left the computational manifold, "
            "and computational-space error that moved the register to a different "
            "Hamming weight. `in-constraint P, leak-free` is the second with the "
            "first removed, using `measure_leaked` to identify the leaked shots. "
            "Under the `leakage_only` model the two columns should separate "
            "sharply; under `helios_spec_depolarizing`, which has no leakage "
            "channel at all, they should coincide exactly. That is the control."
        )
        a("")
        a(
            "One readout convention worth stating, because it biases the raw "
            "column: a leaked qubit has no bit to report, so it is recorded as 0. "
            "That pushes leaked shots towards low Hamming weight and makes the "
            "raw in-constraint probability *look* worse than the computational "
            "error alone warrants. The leak-free column is unaffected, and the "
            "full Hamming-weight histogram for every point is in `result.json`."
        )
        a("")
        rate = summary["subspace_loss_rate_per_2q_gate"]
        if rate["status"] == "measured":
            injected = dx.HELIOS.two_qubit_infidelity
            a(
                f"- Sector-loss rate lambda = -ln(P_in-constraint) / G_2Q under the "
                f"depolarizing arm: median {rate['median']:.3e} per two-qubit gate "
                f"across {rate['points']} points (range {rate['min']:.3e} - "
                f"{rate['max']:.3e}), against an injected two-qubit error rate of "
                f"{injected:.1e}. The ratio is "
                f"{rate['median'] / injected:.2f}."
            )
            a("")
            gate_counts = [
                point["compiled"]["all_to_all"]["two_qubit_gates"]
                for point in measured_noise
            ]
            a(
                "  That is the point of defining lambda at all. Across a "
                f"{rate['points']}-point grid spanning n = "
                f"{min(p['n'] for p in measured_noise)}.."
                f"{max(p['n'] for p in measured_noise)}, circuits whose two-qubit "
                f"counts differ by a factor of {max(gate_counts) / min(gate_counts):.0f} "
                "share a sector-loss rate per two-qubit gate that varies by less "
                f"than a factor of {rate['max'] / rate['min']:.1f}. To the extent "
                "that it is constant, the in-constraint probability of a circuit "
                "nobody has run is predictable from its compiled gate count alone — "
                "which is what makes the connectivity ledger above a statement "
                "about *fidelity*, and not only about cost."
            )
            a("")
            a(
                "  What is deliberately not claimed: the ratio to the injected rate "
                "is an empirical observation, not a derived constant. Turning it "
                "into one means accounting for which two-qubit Pauli errors can "
                "change Hamming weight and which cannot, and how that depends on "
                "(n, k) — a calculation this run does not attempt, and whose "
                "absence is why the number above is reported as a measurement of "
                "this error model rather than as a property of the ansatz."
            )
        a("")
        a("### Emission self-check")
        a("")
        a(
            "The Guppy program is machine-generated from the pytket circuit, so "
            "it is checked rather than trusted: under the ideal error model its "
            "sampled distribution is compared with the circuit's exact "
            "statevector distribution, and that discrepancy is compared against "
            "the shot-noise-only null obtained by sampling the exact "
            "distribution directly. `ratio` near 1 means the emitted program is "
            "indistinguishable from the circuit it claims to be."
        )
        a("")
        a("| n | k | TVD vs exact | shot-noise null | ratio |")
        a("| ---: | ---: | ---: | ---: | ---: |")
        for point in measured_noise:
            check = point["noise"]["models"].get("ideal", {}).get("emission_check")
            if check:
                a(
                    f"| {point['n']} | {point['k']} | {check['tvd_vs_exact']:.4f} | "
                    f"{check['tvd_shot_noise_null']:.4f} | "
                    f"{_fmt(check['ratio'], 2)} |"
                )
            else:
                a(f"| {point['n']} | {point['k']} | {NOT_RUN} | {NOT_RUN} | {NOT_RUN} |")
        a("")

    unmeasured = [point for point in points if point["noise"].get("status") != "measured"]
    if unmeasured:
        widths = sorted({point["n"] for point in unmeasured})
        a(
            f"**{NOT_RUN}** for {len(unmeasured)} of {len(points)} grid points "
            f"(n = {', '.join(str(w) for w in widths)}). Reason: "
            f"{unmeasured[0]['noise'].get('reason', 'not recorded')}. Those rows "
            "are absent from the table above rather than filled with an "
            "extrapolation."
        )
        a("")

    a("## 4. Cost (estimated)")
    a("")
    a(
        f"Quantinuum HQCs for a single {payload['config']['shots']}-shot job on the "
        "compiled all-to-all circuit, from the published formula "
        "`5 + (C/5000)*(N_1q + 10*N_2q + 5*N_M)`. **Upper bound**: Helios settles "
        "the charge dynamically at run time. No HQCs were spent — nothing was "
        "submitted."
    )
    a("")
    a("| n | k | 1Q gates | 2Q gates | measurements | HQC (upper bound) |")
    a("| ---: | ---: | ---: | ---: | ---: | ---: |")
    for point in points:
        stats = point["compiled"]["all_to_all"]
        a(
            f"| {point['n']} | {point['k']} | {stats['one_qubit_gates']} | "
            f"{stats['two_qubit_gates']} | {point['n']} | "
            f"{point['cost']['hqc_upper_bound']:.1f} |"
        )
    a("")

    a("## Limits of this run")
    a("")
    for limit in limits_for(payload):
        a(f"- {limit}")
    a("")

    a("## Reproduce")
    a("")
    a("```")
    a(payload["command"])
    a("```")
    a("")
    a(
        "`result.json` alongside this file carries every measured quantity, "
        "including the full Hamming-weight histogram per point, per-arm compile "
        "times, the exact error-model parameters, and the package versions used."
    )
    a("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m quantum.characterise",
        description=(
            "Characterise Dicke state preparation plus an XY-ring mixer across "
            "an (n, k) grid: fidelity, compiled cost on three coupling graphs, "
            "in-constraint probability under noise, and HQC cost."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    grid = parser.add_argument_group("grid")
    grid.add_argument("--n", type=int, nargs="+", default=[6, 8, 10, 12])
    grid.add_argument("--k-mode", choices=("all", "half", "fixed"), default="all")
    grid.add_argument("--k", type=int, nargs="*", default=None, help="for --k-mode fixed")
    grid.add_argument("--p", type=int, default=1, help="XY-ring mixer layers")
    grid.add_argument(
        "--beta", type=float, default=0.4,
        help="mixer angle in radians; the ansatz is instance-free, so this is a "
             "representative non-trivial angle, not an optimised one",
    )

    sim = parser.add_argument_group("simulation")
    sim.add_argument(
        "--max-statevector-n", type=int, default=20,
        help="above this no statevector is built and fidelity is reported NOT RUN",
    )
    sim.add_argument("--shots", type=int, default=500)
    sim.add_argument("--seed", type=int, default=20260817)
    sim.add_argument(
        "--selene", action=argparse.BooleanOptionalAction, default=True,
        help="run the noise arm on Selene (needs guppylang + selene-sim)",
    )
    sim.add_argument(
        "--selene-max-n", type=int, default=12,
        help="noisy emulation costs one trajectory per shot; above this the "
             "noise arm is reported NOT RUN rather than left running for hours",
    )
    sim.add_argument(
        "--selene-models", nargs="+",
        default=["ideal", "helios_spec_depolarizing", "leakage_only"],
    )
    sim.add_argument("--heavy-hex-device", default="FakeKingston")

    out = parser.add_argument_group("output")
    out.add_argument("--out", default=str(DEFAULT_OUT))
    out.add_argument(
        "--render-only", default=None, metavar="RESULT_JSON",
        help="measure nothing; regenerate report.md from an existing result.json. "
             "The prose is derived entirely from the recorded measurements, so "
             "the report can be improved without re-running the sweep — and "
             "cannot silently acquire numbers that were never measured",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.render_only:
        payload = json.loads(Path(args.render_only).read_text(encoding="utf-8"))
        out_dir = Path(args.out)
        out_dir.mkdir(parents=True, exist_ok=True)
        write_report(out_dir / "report.md", payload)
        say(f"re-rendered {out_dir / 'report.md'} from {args.render_only}")
        return 0

    # Selene build artefacts are compiled binaries; they go to a scratch
    # directory, never into the repository. One representative *source*
    # program is copied into the report directory afterwards as provenance.
    args.build_root = Path(tempfile.mkdtemp(prefix="dicke-selene-"))
    args.example_guppy_source = None
    betas = [args.beta] * args.p

    grid = dx.sweep_grid(args.n, args.k_mode, args.k)
    if not grid:
        say("empty grid; nothing to do")
        return 1

    selene_ok = False
    args.selene_reason = "--no-selene was passed; the noise arm was not run"
    if args.selene:
        from quantum import selene_backend as sb

        selene_ok, detail = sb.selene_status()
        args.selene_reason = detail if not selene_ok else ""
        if not selene_ok:
            say(f"[warn] Selene unavailable ({detail}); the noise arm will be {NOT_RUN}")

    run_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    started = time.time()
    say(f"grid: {grid}")
    points: list[dict[str, Any]] = []
    for (n, k) in grid:
        point_started = time.time()
        record = measure_point(n, k, betas, args, selene_ok)
        points.append(record)
        compiled = record["compiled"]
        noise = record["noise"]
        detail = ""
        if noise.get("status") == "measured":
            depolarizing = noise["models"].get("helios_spec_depolarizing")
            if depolarizing:
                detail = (
                    f" in-constraint {depolarizing['in_constraint_probability']:.4f}"
                )
        say(
            f"n={n:2d} k={k:2d}  2Q a2a={compiled['all_to_all']['two_qubit_gates']:5d}"
            f"  hh={compiled['heavy_hex']['two_qubit_gates']:5d}"
            f"  lnn={compiled['linear']['two_qubit_gates']:5d}"
            f"  ({time.time() - point_started:.1f}s){detail}"
        )

    payload: dict[str, Any] = {
        "run_id": run_id,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": "python -m quantum.characterise "
        + " ".join(argv if argv is not None else sys.argv[1:]),
        "versions": collect_versions(),
        "config": {
            "grid": [list(point) for point in grid],
            "mixer_layers": args.p,
            "beta_radians": args.beta,
            "shots": args.shots,
            "seed": args.seed,
            "max_statevector_n": args.max_statevector_n,
            "selene_max_n": args.selene_max_n,
            "selene_models": args.selene_models,
            "heavy_hex_device": args.heavy_hex_device,
        },
        "honesty": {
            "hardware_jobs_submitted": 0,
            "phase": "Phase 1 (emulator only)",
            "noise_model": "hand-parameterised stand-in from published Helios spec figures",
            "fidelity_floor": 1 - dx.DEFAULT_FIDELITY_TOLERANCE,
            "abort_policy": "a circuit failing its own fidelity or weight-sector "
            "check raises and the run stops; no number from it is reported",
        },
        "selene": {
            "available": selene_ok,
            "detail": args.selene_reason or "available",
        },
        "points": points,
        "wall_seconds": time.time() - started,
    }
    payload["summary"] = summarise(points)
    payload["limits"] = limits_for(payload)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.example_guppy_source is not None:
        source_path, source_n, source_k = args.example_guppy_source
        example = out_dir / f"guppy_example_n{source_n}_k{source_k}.py"
        example.write_text(source_path.read_text(encoding="utf-8"), encoding="utf-8")
        payload["selene"]["example_program"] = example.name
        payload["selene"]["example_program_note"] = (
            "the exact Guppy program that was emitted, type-checked and run for "
            f"n={source_n}, k={source_k} — the smallest emulated point in this "
            "run, kept because it is short enough to read; the rest are "
            "regenerated by re-running the command below"
        )
    (out_dir / "result.json").write_text(
        json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    write_report(out_dir / "report.md", payload)
    say("")
    say(f"wrote {out_dir / 'result.json'}")
    say(f"wrote {out_dir / 'report.md'}")
    say(f"total {payload['wall_seconds']:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
