#!/usr/bin/env python3
r"""Dicke state preparation and the XY-ring mixer, for Quantinuum hardware.

This module is the primitive layer of the entry. It builds two things and
refuses to hand back either of them unverified:

1. **|D^n_k>**, the equal superposition over all C(n,k) Hamming-weight-k
   bitstrings, via the Baertschi-Eidenbenz split-and-cyclic-shift (SCS)
   construction, arXiv:1904.07358 (FCT 2019).
2. The **XY-ring mixer**, exp(-i beta (XX+YY)/2) on each edge of a ring,
   split into two commuting colour classes. It commutes with the total number
   operator, so a state that starts inside the weight-k sector stays there.

Together they are a *constraint-preserving ansatz*: the cardinality constraint
"exactly k of n" is enforced by the symmetry of the circuit, not by a penalty
term, so a shot can only ever violate it through noise.

Provenance and conventions
--------------------------
The SCS construction is ported verbatim from ``scripts/heron_qaoa.py``
(``build_dicke_circuit``), which took three attempts to get right. The
convention that makes it correct, and which is easy to get subtly wrong, is:

* start from |1^k 0^{n-k}> — X on the **top** k qubits, not the bottom k;
* apply SCS_{l, min(k, l-1)} for l = n, n-1, ..., 2 (descending);
* the controlled-Ry angle is **negated**: theta = -2*arccos(sqrt(i/l)).

Angles in this module's gate IR are in **radians**, matching the paper and the
qiskit original. pytket takes half-turns, and the conversion (divide by pi)
happens once, at the pytket boundary, in :func:`ops_to_tket`.

Qubit/index convention: **big-endian**, i.e. qubit q is bit (n-1-q) of the
statevector index, which is pytket's convention. It is chosen so that the
reference simulator's statevector can be compared amplitude-by-amplitude with
pytket's without a reversal step. Note that |D^n_k> is invariant under any
permutation of qubits, so the *Dicke fidelity* itself is convention-free; the
convention matters for the mixer's ring edges and for reading bitstrings.

Self-checks (this is the point of the module)
---------------------------------------------
* :func:`verify_dicke_state` compares the prepared state against the
  analytically constructed |D^n_k> and **raises** :class:`VerificationError`
  below ``1 - 1e-9``.
* :func:`verify_weight_sector` checks that the *whole ansatz*, including
  everything a compiler did to it, still has all of its amplitude in the
  weight-k sector, and raises below ``1 - 1e-9``.

A number from a circuit that failed either check is not reported. It is not
reported with a caveat either; the run stops.

Dependencies: numpy only. pytket, qiskit, guppy and selene are imported lazily
inside the functions that need them, so the analytic core, the reference
simulator and every metric in this file work in a bare Python environment.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

import numpy as np

__all__ = [
    "VerificationError",
    "HELIOS",
    "HeliosSpec",
    "GateOp",
    "dicke_ops",
    "xy_ring_mixer_ops",
    "ansatz_ops",
    "ring_edges",
    "simulate",
    "analytic_dicke_state",
    "weight_sector_indices",
    "project_weight_sector",
    "hamming_weight_distribution",
    "in_constraint_probability",
    "in_constraint_probability_from_shots",
    "subspace_leakage_rate",
    "hqc_estimate",
    "sweep_grid",
    "state_fidelity",
    "total_variation_distance",
    "ops_to_tket",
    "dicke_circuit",
    "ansatz_circuit",
    "tket_statevector",
    "implicit_permutation_is_identity",
    "helios_native_gates",
    "compile_for_architecture",
    "all_to_all_architecture",
    "line_architecture",
    "heavy_hex_architecture",
    "generated_heavy_hex_edges",
    "circuit_stats",
    "verify_dicke_state",
    "verify_weight_sector",
    "DEFAULT_FIDELITY_TOLERANCE",
]

# Below this, the circuit is not the thing it claims to be and nothing derived
# from it may be reported. Matches the threshold already used by
# scripts/heron_qaoa.py.
DEFAULT_FIDELITY_TOLERANCE = 1e-9


class VerificationError(RuntimeError):
    """A circuit failed its own correctness check. Never downgraded to a warning."""


# --------------------------------------------------------------------------
# Hardware constants
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class HeliosSpec:
    """Published Quantinuum Helios figures, used for cost and noise estimates.

    These are **spec-sheet numbers from public sources**, not a Quantinuum
    calibration snapshot. The calibrated model (``QSystemErrorModel`` /
    ``HeliosErrorParams``) lives server-side in Nexus; the locally installed
    ``selene_sim`` exposes only Ideal, Depolarizing and SimpleLeakage, and the
    ``HeliosErrorParams`` schema that ships with ``quantinuum_schemas`` has
    ``None`` for every default. Any noise number produced from these constants
    is therefore a hand-parameterised stand-in and is labelled as such
    everywhere it appears.
    """

    qubits: int = 98
    one_qubit_infidelity: float = 2.5e-5
    two_qubit_infidelity: float = 7.9e-4
    spam_infidelity: float = 3.3e-4
    # HQC = hqc_floor + (shots / hqc_shot_divisor) * (N_1q + w2*N_2q + wm*N_M)
    hqc_floor: float = 5.0
    hqc_shot_divisor: float = 5000.0
    hqc_two_qubit_weight: float = 10.0
    hqc_measurement_weight: float = 5.0
    source: str = (
        "https://docs.quantinuum.com/systems/user_guide/hardware_user_guide/helios.html"
        " ; https://docs.quantinuum.com/systems/trainings/helios/getting_started/costing.html"
    )


HELIOS = HeliosSpec()


# --------------------------------------------------------------------------
# Backend-free gate IR
# --------------------------------------------------------------------------

#: ``(name, params_in_radians, qubits)``. The only IR in this module.
#: Names: ``x``, ``cx``, ``cnry`` (controls..., target last), ``xxphase``,
#: ``yyphase``. Everything downstream — the reference simulator, the pytket
#: builder, the Guppy emitter — consumes exactly this.
GateOp = tuple[str, tuple[float, ...], tuple[int, ...]]


def dicke_ops(n: int, k: int) -> list[GateOp]:
    """Baertschi-Eidenbenz SCS circuit for |D^n_k>, as a list of IR ops.

    Ported verbatim from ``scripts/heron_qaoa.py::build_dicke_circuit``, which
    is the version that passes the analytic fidelity check. Do not "tidy" the
    ordering, the ``n - k`` offset or the sign of ``theta`` without re-running
    :func:`verify_dicke_state`; each of them has been wrong at least once.

    Asymptotics (arXiv:1904.07358): O(kn) gates, O(n) depth, no ancillas, and
    the bounds hold on Linear Nearest Neighbor. That last property is the
    reason this construction is *not* the depth-optimal choice for all-to-all
    hardware — the O(k log(n/k)) construction of arXiv:2207.09998 is — and
    measuring that gap is a deliberate part of the study, not an oversight.
    """
    if n < 1:
        raise ValueError(f"n must be >= 1, got {n}")
    if not 0 <= k <= n:
        raise ValueError(f"need 0 <= k <= n, got k={k}, n={n}")

    ops: list[GateOp] = []
    for q in range(n - k, n):
        ops.append(("x", (), (q,)))
    for width in range(n, 1, -1):
        for i in range(1, min(k, width - 1) + 1):
            theta = -2.0 * math.acos(math.sqrt(i / width))
            top = width - 1
            low = top - i
            ops.append(("cx", (), (top, low)))
            if i == 1:
                ops.append(("cnry", (theta,), (low, top)))
            else:
                ops.append(("cnry", (theta,), (low, width - i, top)))
            ops.append(("cx", (), (top, low)))
    return ops


def ring_edges(n: int) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """Ring edges split into two colour classes (exact split when n is even).

    Ported from ``scripts/heron_qaoa.py``. Within a class the edges are
    disjoint, so the exponentials commute and that class is exact; only the
    split *between* the two classes is a Trotter approximation.
    """
    even = [(i, i + 1) for i in range(0, n - 1, 2)]
    odd = [(i, i + 1) for i in range(1, n - 1, 2)]
    if n > 2:
        odd.append((n - 1, 0))
    return even, odd


def xy_ring_mixer_ops(n: int, beta: float) -> list[GateOp]:
    """One XY-ring mixer layer: exp(-i beta (XX+YY)/2) per ring edge.

    ``XXPhase(beta) * YYPhase(beta)`` on an edge is exactly
    exp(-i beta (XX + YY) / 2) because XX and YY commute. The operator
    commutes with the total number operator, hence preserves Hamming weight;
    :func:`verify_weight_sector` is what actually proves that for the circuit
    that gets run.
    """
    ops: list[GateOp] = []
    for group in ring_edges(n):
        for (a, b) in group:
            ops.append(("xxphase", (beta,), (a, b)))
            ops.append(("yyphase", (beta,), (a, b)))
    return ops


def ansatz_ops(n: int, k: int, betas: Sequence[float]) -> list[GateOp]:
    """Dicke preparation followed by ``len(betas)`` XY-ring mixer layers.

    This is deliberately the *bare* constraint-preserving ansatz: no cost
    layer, no problem instance. The cost layer is instance-specific and would
    make the measurement a statement about a portfolio rather than about a
    primitive. ``scripts/heron_qaoa.py`` is where the instance lives.
    """
    ops = dicke_ops(n, k)
    for beta in betas:
        ops.extend(xy_ring_mixer_ops(n, float(beta)))
    return ops


# --------------------------------------------------------------------------
# Reference simulator (numpy only)
# --------------------------------------------------------------------------


def _ry_matrix(theta: float) -> np.ndarray:
    c, s = math.cos(theta / 2.0), math.sin(theta / 2.0)
    return np.array([[c, -s], [s, c]], dtype=complex)


_X = np.array([[0.0, 1.0], [1.0, 0.0]], dtype=complex)
_Y = np.array([[0.0, -1.0j], [1.0j, 0.0]], dtype=complex)


def _op_matrix(name: str, params: Sequence[float], n_qubits: int) -> np.ndarray:
    """Dense matrix for one IR op, in the op's own qubit order."""
    if name == "x":
        return _X
    if name == "cx":
        return np.array(
            [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 1], [0, 0, 1, 0]], dtype=complex
        )
    if name == "cnry":
        dim = 1 << n_qubits
        mat = np.eye(dim, dtype=complex)
        mat[dim - 2 :, dim - 2 :] = _ry_matrix(params[0])
        return mat
    if name in ("xxphase", "yyphase"):
        pauli = _X if name == "xxphase" else _Y
        gen = np.kron(pauli, pauli)
        theta = params[0]
        return math.cos(theta / 2.0) * np.eye(4, dtype=complex) - 1j * math.sin(
            theta / 2.0
        ) * gen
    raise ValueError(f"unknown IR op {name!r}")


def _apply(state: np.ndarray, matrix: np.ndarray, targets: Sequence[int], n: int) -> np.ndarray:
    width = len(targets)
    tensor = matrix.reshape([2] * (2 * width))
    out = np.tensordot(
        tensor, state, axes=(list(range(width, 2 * width)), list(targets))
    )
    order = list(targets) + [ax for ax in range(n) if ax not in targets]
    return np.transpose(out, np.argsort(order))


def simulate(ops: Sequence[GateOp], n: int) -> np.ndarray:
    """Dense statevector for an IR circuit, in numpy, from |0...0>.

    Big-endian: qubit q is axis q of the ``(2,)*n`` tensor, so the C-order
    flattening puts qubit 0 in the most significant bit. That is pytket's
    convention, which makes the two statevectors directly comparable.

    This exists so the *construction* can be verified without trusting any
    quantum SDK. It is not fast and is not meant to be; the sweep uses pytket's
    simulator and cross-checks it against this one at small n.
    """
    state = np.zeros([2] * n, dtype=complex)
    state[(0,) * n] = 1.0
    for name, params, qubits in ops:
        matrix = _op_matrix(name, params, len(qubits))
        state = _apply(state, matrix, qubits, n)
    return state.reshape(-1)


# --------------------------------------------------------------------------
# Analytic reference and subspace metrics (numpy only)
# --------------------------------------------------------------------------


def _popcount(values: np.ndarray) -> np.ndarray:
    counter = getattr(np, "bitwise_count", None)
    if counter is not None:
        return counter(values)
    out = np.zeros_like(values)
    tmp = values.copy()
    while np.any(tmp):
        out += (tmp & 1).astype(out.dtype)
        tmp >>= 1
    return out


def weight_sector_indices(n: int, k: int) -> np.ndarray:
    """Statevector indices whose bitstring has Hamming weight exactly ``k``.

    Convention-free: the set of indices with popcount k is the same whichever
    end of the register you call qubit 0.
    """
    if n < 0 or not 0 <= k <= n:
        raise ValueError(f"need 0 <= k <= n, got k={k}, n={n}")
    all_indices = np.arange(1 << n, dtype=np.int64)
    return all_indices[_popcount(all_indices) == k]


def analytic_dicke_state(n: int, k: int) -> np.ndarray:
    """|D^n_k> built from its definition, not from a circuit.

    Uniform amplitude 1/sqrt(C(n,k)) on every weight-k basis state. This is the
    ground truth every prepared state is scored against.
    """
    vector = np.zeros(1 << n, dtype=complex)
    indices = weight_sector_indices(n, k)
    vector[indices] = 1.0 / math.sqrt(len(indices))
    return vector


def project_weight_sector(state: np.ndarray, n: int, k: int) -> np.ndarray:
    """The component of ``state`` inside the weight-k sector (unnormalised)."""
    if state.shape[0] != 1 << n:
        raise ValueError(f"state has {state.shape[0]} amplitudes, expected {1 << n}")
    out = np.zeros_like(state)
    indices = weight_sector_indices(n, k)
    out[indices] = state[indices]
    return out


def hamming_weight_distribution(probabilities: np.ndarray, n: int) -> np.ndarray:
    """P(Hamming weight = w) for w = 0..n. The full-information reporting object.

    Prior art reports a single feasible fraction; the shape of this histogram
    is what says *how* a noisy device leaves the sector, and it costs nothing
    extra to record.
    """
    probabilities = np.asarray(probabilities, dtype=float)
    if probabilities.shape[0] != 1 << n:
        raise ValueError(
            f"expected {1 << n} probabilities for n={n}, got {probabilities.shape[0]}"
        )
    weights = _popcount(np.arange(1 << n, dtype=np.int64))
    return np.bincount(weights, weights=probabilities, minlength=n + 1).astype(float)


def in_constraint_probability(probabilities: np.ndarray, n: int, k: int) -> float:
    """Probability that a sample has Hamming weight exactly k.

    Terminology, deliberately: this is the **in-constraint probability** of
    Niroula et al., Sci. Rep. 12:17171 (2022), also called the measured
    success probability (Aktar et al., arXiv:2210.03048) or post-selection
    ratio (He et al., npj QI 9:121, 2023). It is *not* "leakage": on a
    trapped-ion machine leakage means the ion leaving the computational
    manifold (Wood & Gambetta, PRA 97, 032306), which is a different physical
    event and is measured separately here via ``measure_leaked``.
    """
    probabilities = np.asarray(probabilities, dtype=float)
    indices = weight_sector_indices(n, k)
    return float(probabilities[indices].sum())


def in_constraint_probability_from_shots(
    shots: Iterable[Sequence[int]], k: int
) -> tuple[float, int, int]:
    """In-constraint probability from measured bitstrings.

    Accepts any iterable of per-shot bit sequences (list of ints, or a string
    of "0"/"1"). Returns ``(probability, in_constraint_shots, total_shots)``.
    Hamming weight is permutation-invariant, so no qubit-ordering convention is
    needed here — which is exactly why this metric survives a transpiler's
    qubit permutation, unlike anything positional.
    """
    total = 0
    hits = 0
    for shot in shots:
        bits = [int(b) for b in shot]
        total += 1
        if sum(bits) == k:
            hits += 1
    return (hits / total if total else 0.0), hits, total


def subspace_leakage_rate(
    in_constraint_probability_value: float, two_qubit_gates: int
) -> float | None:
    """Per-two-qubit-gate rate of falling out of the weight-k sector.

    ``lambda = -ln(P_in-constraint) / G_2Q``, the Hamming-weight-sector analogue
    of the Wood-Gambetta leakage rate L1. If the sector loss is dominated by
    two-qubit gate error and each gate contributes independently, this
    collapses to a single constant across (n, k) and lets you predict the
    in-constraint probability of an unrun circuit from its gate count alone.
    Whether it actually collapses is an empirical question, and reporting the
    spread across the grid is the answer.

    Returns ``None`` when it is undefined (no two-qubit gates, or the
    probability is zero or non-positive).
    """
    if two_qubit_gates <= 0:
        return None
    if not 0.0 < in_constraint_probability_value <= 1.0:
        return None
    return float(-math.log(in_constraint_probability_value) / two_qubit_gates)


def hqc_estimate(
    shots: int,
    one_qubit_gates: int,
    two_qubit_gates: int,
    measurements: int,
    spec: HeliosSpec = HELIOS,
) -> float:
    """Quantinuum HQC cost, ``5 + (C/5000) * (N_1q + 10*N_2q + 5*N_M)``.

    Always an **estimate**, and on Helios specifically an *upper bound*: Helios
    supports arbitrary control flow, so the charge is determined dynamically at
    run time rather than by a static gate count. Two-qubit gates carry ten
    times the weight of one-qubit gates, which is why the connectivity argument
    and the cost argument are the same argument.
    """
    if shots < 0:
        raise ValueError("shots must be non-negative")
    weighted = (
        one_qubit_gates
        + spec.hqc_two_qubit_weight * two_qubit_gates
        + spec.hqc_measurement_weight * measurements
    )
    return float(spec.hqc_floor + (shots / spec.hqc_shot_divisor) * weighted)


def sweep_grid(
    n_values: Sequence[int], k_mode: str = "all", k_values: Sequence[int] | None = None
) -> list[tuple[int, int]]:
    """The (n, k) points of a sweep, in a stable, reproducible order.

    ``k_mode``:

    * ``all``    — every 1 <= k <= floor(n/2). The range Aktar et al. covered on
      H1-2 for n <= 10, so the overlap is directly comparable.
    * ``half``   — only k = floor(n/2), the hardest and widest sector.
    * ``fixed``  — the explicit ``k_values``, keeping only those with k < n.

    Only k <= floor(n/2) is generated: |D^n_k> and |D^n_{n-k}> are related by a
    layer of X gates, so the upper half of the range carries no new information
    while doubling the run time.
    """
    if k_mode not in ("all", "half", "fixed"):
        raise ValueError(f"unknown k_mode {k_mode!r}")
    if k_mode == "fixed" and not k_values:
        raise ValueError("k_mode='fixed' requires k_values")
    grid: list[tuple[int, int]] = []
    for n in n_values:
        if n < 2:
            raise ValueError(f"n must be >= 2, got {n}")
        if k_mode == "all":
            ks: Sequence[int] = range(1, n // 2 + 1)
        elif k_mode == "half":
            ks = [n // 2]
        else:
            ks = [k for k in k_values if 0 < k < n]  # type: ignore[union-attr]
        for k in ks:
            if 0 < k < n:
                grid.append((n, int(k)))
    return grid


def state_fidelity(reference: np.ndarray, produced: np.ndarray) -> float:
    """|<reference|produced>|^2 for two pure states."""
    return float(abs(np.vdot(reference, produced)) ** 2)


def total_variation_distance(p: np.ndarray, q: np.ndarray) -> float:
    """TVD between two distributions over the same support."""
    p = np.asarray(p, dtype=float)
    q = np.asarray(q, dtype=float)
    return float(0.5 * np.abs(p - q).sum())


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------


def verify_dicke_state(
    state: np.ndarray, n: int, k: int, tolerance: float = DEFAULT_FIDELITY_TOLERANCE
) -> float:
    """Fidelity against the analytic |D^n_k>; raise below ``1 - tolerance``."""
    fidelity = state_fidelity(analytic_dicke_state(n, k), np.asarray(state))
    if fidelity < 1.0 - tolerance:
        raise VerificationError(
            f"|D^{n}_{k}> fidelity {fidelity:.12f} is below the {1.0 - tolerance:.12f} "
            "floor. The circuit is not the state it claims to be; nothing derived "
            "from it will be reported."
        )
    return fidelity


def verify_weight_sector(
    state: np.ndarray, n: int, k: int, tolerance: float = DEFAULT_FIDELITY_TOLERANCE
) -> float:
    """Weight-k population of a *noiseless* state; raise below ``1 - tolerance``.

    Applied to the compiled ansatz, this is the check that the constraint
    survived optimisation, routing and rebasing — not merely that it held for
    the logical circuit on paper.
    """
    probabilities = np.abs(np.asarray(state)) ** 2
    population = in_constraint_probability(probabilities, n, k)
    if population < 1.0 - tolerance:
        raise VerificationError(
            f"weight-{k} population {population:.12f} is below the "
            f"{1.0 - tolerance:.12f} floor for n={n}. The ansatz is not "
            "constraint-preserving as built; refusing to report noise numbers "
            "measured against it."
        )
    return float(population)


# --------------------------------------------------------------------------
# pytket layer (imported lazily — everything above works without it)
# --------------------------------------------------------------------------


def _tket():
    try:
        from pytket.circuit import Circuit, OpType
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise ImportError(
            "pytket is required for the circuit layer. Install the dedicated "
            "environment: .venv-quantinuum/Scripts/python.exe -m pip install -r "
            "requirements-quantinuum.txt"
        ) from exc
    return Circuit, OpType


def helios_native_gates() -> set:
    """Helios native operations: {PhasedX, Rz, ZZPhase}.

    Rz is performed *virtually* in software on the machine, i.e. it costs no
    gate time — which is why the depth and cost figures in this study lead with
    the two-qubit (ZZPhase) count.
    """
    _, OpType = _tket()
    return {OpType.PhasedX, OpType.Rz, OpType.ZZPhase}


def ops_to_tket(ops: Sequence[GateOp], n: int):
    """Materialise the IR as a pytket Circuit.

    The only place radians become half-turns. pytket's Ry(alpha) is
    exp(-i alpha pi Y / 2), so a radian angle theta is alpha = theta / pi;
    likewise XXPhase, YYPhase and CnRy.
    """
    Circuit, OpType = _tket()
    circuit = Circuit(n)
    for name, params, qubits in ops:
        if name == "x":
            circuit.X(qubits[0])
        elif name == "cx":
            circuit.CX(qubits[0], qubits[1])
        elif name == "cnry":
            circuit.add_gate(OpType.CnRy, [params[0] / math.pi], list(qubits))
        elif name == "xxphase":
            circuit.add_gate(OpType.XXPhase, [params[0] / math.pi], list(qubits))
        elif name == "yyphase":
            circuit.add_gate(OpType.YYPhase, [params[0] / math.pi], list(qubits))
        else:  # pragma: no cover - guarded by the IR builders
            raise ValueError(f"unknown IR op {name!r}")
    return circuit


def dicke_circuit(n: int, k: int):
    """|D^n_k> as a pytket Circuit. Unverified until you call verify_dicke_state."""
    return ops_to_tket(dicke_ops(n, k), n)


def ansatz_circuit(n: int, k: int, betas: Sequence[float]):
    """Dicke preparation + XY-ring mixer layers as a pytket Circuit."""
    return ops_to_tket(ansatz_ops(n, k, betas), n)


def tket_statevector(circuit, max_native_qubits: int = 11) -> np.ndarray:
    """Noiseless statevector of a pytket Circuit, in big-endian order.

    pytket's built-in simulator refuses circuits wider than about a dozen
    qubits ("Circuit to simulate has too many qubits"), so above
    ``max_native_qubits`` this converts to qiskit and uses ``Statevector``.
    qiskit is little-endian, so the result is passed through
    ``reverse_qargs()`` to restore pytket's ordering. The metrics in this
    module are all permutation-invariant and would not have noticed, which is
    precisely why the reversal is done explicitly rather than left implicit.
    """
    n = circuit.n_qubits
    if n <= max_native_qubits:
        try:
            return np.asarray(circuit.get_statevector())
        except RuntimeError:
            pass
    from pytket.extensions.qiskit import tk_to_qiskit
    from qiskit.quantum_info import Statevector

    return np.asarray(Statevector(tk_to_qiskit(circuit)).reverse_qargs().data)


def implicit_permutation_is_identity(circuit) -> bool:
    """True when the compiler did not relabel qubits behind our back.

    Routing inserts SWAPs and records the resulting permutation implicitly.
    Anything positional read off such a circuit without undoing the permutation
    is wrong — Taipale (arXiv:2606.13244) reports a transpiled XY circuit
    looking 41% feasible when it was in fact 100% feasible, purely from this.
    Hamming weight is permutation-invariant so this study is immune, but the
    fact is recorded per arm rather than assumed.
    """
    permutation = circuit.implicit_qubit_permutation()
    return all(src == dst for src, dst in permutation.items())


def all_to_all_architecture(n: int):
    """Fully connected coupling graph — the Helios QCCD topology."""
    from pytket.architecture import Architecture

    return Architecture([(i, j) for i in range(n) for j in range(i + 1, n)])


def line_architecture(n: int):
    """Linear Nearest Neighbor — the connectivity the 2019 construction targets."""
    from pytket.architecture import Architecture

    return Architecture([(i, i + 1) for i in range(n - 1)])


def generated_heavy_hex_edges(rows: int, cols: int) -> list[tuple[int, int]]:
    """A heavy-hex-shaped coupling graph, used only if no device map is available.

    Data qubits on a ``rows x cols`` grid, a degree-2 link qubit inserted on
    every edge, and vertical links only on alternating columns, offset by one
    period between successive rows. The offset is the part that matters: it is
    what keeps every vertex at degree <= 3, which is the defining property of a
    heavy-hex lattice and the reason it routes badly.

    Preferred source is a real device snapshot; see
    :func:`heavy_hex_architecture`. This exists so the study still has a
    limited-connectivity control arm when qiskit-ibm-runtime is absent, and it
    is labelled differently in the report when it is used.
    """
    if rows < 1 or cols < 1:
        raise ValueError(f"need rows >= 1 and cols >= 1, got {rows}x{cols}")
    node = 0
    ids: dict[tuple[int, int], int] = {}
    for r in range(rows):
        for c in range(cols):
            ids[(r, c)] = node
            node += 1
    edges: list[tuple[int, int]] = []
    for r in range(rows):
        for c in range(cols - 1):
            link = node
            node += 1
            edges.append((ids[(r, c)], link))
            edges.append((link, ids[(r, c + 1)]))
    for r in range(rows - 1):
        offset = 0 if r % 2 == 0 else 2
        for c in range(offset, cols, 4):
            link = node
            node += 1
            edges.append((ids[(r, c)], link))
            edges.append((link, ids[(r + 1, c)]))
    return edges


def heavy_hex_architecture(min_qubits: int, device: str = "FakeKingston"):
    """IBM heavy-hex coupling graph, from a real device snapshot when possible.

    Returns ``(architecture, provenance_string)``. The provenance is reported
    verbatim, because "heavy-hex" from a fake-backend snapshot and "heavy-hex"
    from a hand-generated lattice are not the same claim.
    """
    from pytket.architecture import Architecture

    try:
        from qiskit_ibm_runtime import fake_provider

        backend = getattr(fake_provider, device)()
        coupling = backend.coupling_map
        edges = sorted({(min(a, b), max(a, b)) for a, b in coupling.get_edges()})
        if backend.num_qubits >= min_qubits:
            return Architecture(edges), f"{device} device snapshot ({backend.num_qubits} qubits)"
    except Exception:  # noqa: BLE001 - optional dependency, fall through
        pass
    rows = 3
    cols = max(3, (min_qubits + 5) // 3)
    edges = generated_heavy_hex_edges(rows, cols)
    count = 1 + max(max(a, b) for a, b in edges)
    return Architecture(edges), f"generated heavy-hex lattice ({count} qubits, {rows}x{cols})"


def compile_for_architecture(circuit, architecture, optimise: bool = True):
    """Compile to the Helios native gate set under a given coupling graph.

    The **same** pass sequence is used for every architecture, so the only
    difference between the arms is the coupling graph. That is what makes the
    resulting two-qubit-gate ratio a measurement of the routing tax rather than
    a measurement of how hard two different compilers were tuned:

    1. ``FullPeepholeOptimise`` (connectivity-agnostic optimisation)
    2. ``DefaultMappingPass(architecture)`` (placement + routing)
    3. ``AutoRebase`` to {PhasedX, Rz, ZZPhase}
    4. ``RemoveRedundancies`` (single-qubit merges; cannot break connectivity)
    """
    from pytket.passes import (
        AutoRebase,
        DefaultMappingPass,
        FullPeepholeOptimise,
        RemoveRedundancies,
    )

    working = circuit.copy()
    if optimise:
        FullPeepholeOptimise().apply(working)
    DefaultMappingPass(architecture).apply(working)
    AutoRebase(helios_native_gates()).apply(working)
    if optimise:
        RemoveRedundancies().apply(working)
    return working


def circuit_stats(circuit) -> dict[str, Any]:
    """Depth, gate counts and the two-qubit count that drives cost and error."""
    _, OpType = _tket()
    two_qubit = 0
    one_qubit = 0
    virtual_rz = 0
    ops: dict[str, int] = {}
    for command in circuit.get_commands():
        name = command.op.type.name
        if name == "Barrier":
            continue
        ops[name] = ops.get(name, 0) + 1
        arity = len(command.qubits)
        if arity == 2:
            two_qubit += 1
        elif arity == 1:
            one_qubit += 1
            if command.op.type == OpType.Rz:
                virtual_rz += 1
    return {
        "qubits": int(circuit.n_qubits),
        "depth": int(circuit.depth()),
        "two_qubit_gates": two_qubit,
        "two_qubit_depth": int(circuit.depth_2q()),
        "one_qubit_gates": one_qubit,
        # Rz is virtual on Helios (performed in software), so it consumes no
        # gate time. Reported separately rather than folded into the 1q count.
        "virtual_rz_gates": virtual_rz,
        "total_gates": two_qubit + one_qubit,
        "ops": dict(sorted(ops.items())),
    }
