#!/usr/bin/env python3
"""QAOA on a real cardinality-constrained portfolio instance — the one place in
this repository where actual quantum hardware is (optionally) used.

Everything else in Separatrix is quantum-*inspired* and classical: simulated
bifurcation is a classical ODE integrator, SA and PT are classical Monte Carlo,
and `exact` is a DFS. This script is the exception, and it is deliberately
built to be embarrassing rather than flattering:

  * Parameters are optimized **in noiseless simulation only**. No variational
    loop ever touches the QPU.
  * Exactly **one** circuit — the final, optimized one — is submitted, as a
    single job.
  * The result is scored with the **same canonical integer objective** the Rust
    CLI, the workbench, and the Solana program use, and reported as
    `gap_norm` against the *proven* optimum from exhaustive enumeration.
  * A uniform-random feasible-portfolio baseline with the same shot budget is
    always reported. If the quantum result cannot beat random guessing, the
    artifact says so in those words.
  * `--dry-run` defaults to **on**. Nothing is submitted without an explicit
    `--no-dry-run` and a working IBM Quantum credential.

At n=10, k=3 there are C(10,3) = 120 feasible portfolios. Exact enumeration
solves this instance in microseconds. There is **no** speedup and **no**
advantage here, and none is claimed. The point of the artifact is a truthful
measurement of what a 2026-era superconducting QPU does on a real instance
from this repo's own study, reported on the repo's own metric.

Install deps (kept out of requirements.txt on purpose):

    python -m pip install -r requirements-quantum.txt

Typical use:

    # 1. Simulation only (no credentials needed). This is TASK 3.
    python scripts/heron_qaoa.py

    # 2. Look at what would be sent to a specific device, still not sending it.
    python scripts/heron_qaoa.py --backend ibm_kingston

    # 3. Actually submit (requires IBM_QUANTUM_TOKEN; see docs/quantum.md).
    python scripts/heron_qaoa.py --backend ibm_kingston --no-dry-run

    # 4. Post-process a job that finished after the queue drained.
    python scripts/heron_qaoa.py --fetch-job <job-id> --backend ibm_kingston
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import platform
import sqlite3
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import numpy as np

# --------------------------------------------------------------------------
# Repo wiring
# --------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Discovery order matches agent/workbench/bridge.py so this script and the
# workbench always talk to the same binary.
_CLI_CANDIDATES = (
    Path("separatrix") / "target" / "release" / "separatrix-cli.exe",
    Path("separatrix") / "target" / "release" / "separatrix-cli",
)

DEFAULT_DB = REPO_ROOT / "data" / "leash.db"
REPORTS_ROOT = REPO_ROOT / "reports" / "heron"

# The repo's formulation constants (docs/workbench.md, v1). Mirrored here
# rather than imported so the script still runs if agent/ is unavailable; the
# repo-data path below imports the real estimators and would fail loudly.
MU_WINDOW_DAYS = 90
SIGMA_WINDOW_DAYS = 180
SHRINKAGE_DELTA = 0.3
DEFAULT_RISK_AVERSION = 0.5


class PipelineError(RuntimeError):
    """Any hard failure. Never degrades into a fabricated number."""


def say(message: str = "") -> None:
    """print() that survives a legacy console codepage.

    Reports are written as UTF-8 and keep their typography; the terminal gets
    an ASCII-folded copy rather than a UnicodeEncodeError mid-run.
    """
    try:
        print(message)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "ascii"
        print(message.encode(encoding, errors="replace").decode(encoding))


# --------------------------------------------------------------------------
# 1. Instance construction
# --------------------------------------------------------------------------


@dataclass(slots=True)
class Instance:
    """A single cardinality-constrained portfolio instance."""

    n: int
    k: int
    risk_aversion: float
    assets: list[str]
    mu: np.ndarray
    sigma: np.ndarray
    source: str
    as_of: str | None
    detail: dict[str, Any] = field(default_factory=dict)


def synthetic_instance(n: int, k: int, seed: int, risk_aversion: float) -> Instance:
    """Deterministic fallback instance.

    Uses the same LCG and the same magnitudes as `toy_spec` in
    separatrix/src/portfolio.rs, so the numbers land in the range the Rust
    tests exercise. Reproducible from (n, seed) alone on any platform.
    """
    state = seed & 0xFFFF_FFFF_FFFF_FFFF

    def nxt() -> float:
        nonlocal state
        state = (state * 6364136223846793005 + 1442695040888963407) & 0xFFFF_FFFF_FFFF_FFFF
        return (state >> 33) / float(1 << 31)

    mu = np.array([(nxt() - 0.5) * 0.01 for _ in range(n)], dtype=float)
    sigma = np.zeros((n, n), dtype=float)
    for i in range(n):
        for j in range(i, n):
            value = 0.0005 + nxt() * 0.002 if i == j else (nxt() - 0.5) * 0.0008
            sigma[i, j] = value
            sigma[j, i] = value
    return Instance(
        n=n,
        k=k,
        risk_aversion=risk_aversion,
        assets=[f"A{i:02d}" for i in range(n)],
        mu=mu,
        sigma=sigma,
        source="synthetic",
        as_of=None,
        detail={"seed": seed, "generator": "LCG mirroring separatrix portfolio::tests::toy_spec"},
    )


class _SqliteShim:
    """Minimal stand-in for agent.db.Database exposing only `price_matrix`.

    Avoids pulling agent.config/Settings (and its .env handling) into a script
    whose only interest in the database is the binance close series.
    """

    def __init__(self, path: Path) -> None:
        self._conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self._conn.row_factory = sqlite3.Row

    def price_matrix(
        self, assets: list[str], source: str | None = None
    ) -> dict[str, list[tuple[str, float]]]:
        out: dict[str, list[tuple[str, float]]] = {}
        for asset in assets:
            if source is None:
                rows = self._conn.execute(
                    "SELECT recorded_at, price_usdc FROM price_history "
                    "WHERE asset = ? ORDER BY recorded_at ASC, id ASC",
                    (asset,),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT recorded_at, price_usdc FROM price_history "
                    "WHERE asset = ? AND source = ? ORDER BY recorded_at ASC, id ASC",
                    (asset, source),
                ).fetchall()
            out[asset] = [(r["recorded_at"], float(r["price_usdc"])) for r in rows]
        return out

    def close(self) -> None:
        self._conn.close()


def repo_instance(
    db_path: Path,
    n: int,
    k: int,
    risk_aversion: float,
    as_of: str | None,
    universe_override: list[str] | None,
) -> Instance:
    """Build the instance from data/leash.db using the repo's own estimators.

    Imports agent.workbench.{data,qubo_params,universe} so mu/sigma are the
    *identical* quantities the published walk-forward study feeds the solvers
    (90d mean log-return, 180d shrunk covariance, binance closes only).
    """
    from agent.workbench.data import load_price_data, log_returns
    from agent.workbench.qubo_params import mu_sigma
    from agent.workbench.universe import eligible

    if not db_path.exists():
        raise PipelineError(f"database not found: {db_path}")

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        tickers = [
            row[0]
            for row in conn.execute(
                "SELECT DISTINCT asset FROM price_history WHERE source = 'binance' "
                "ORDER BY asset ASC"
            ).fetchall()
        ]
    finally:
        conn.close()
    if not tickers:
        raise PipelineError(f"no binance price history in {db_path}")

    shim = _SqliteShim(db_path)
    try:
        data = load_price_data(shim, tickers, source="binance")
    finally:
        shim.close()
    returns = log_returns(data)

    day = date.fromisoformat(as_of) if as_of else data.dates[-1]
    pool = eligible(data, day)
    if universe_override:
        missing = [t for t in universe_override if t not in pool]
        if missing:
            raise PipelineError(
                f"requested tickers not eligible at {day.isoformat()}: {', '.join(missing)}"
            )
        universe = list(universe_override)
    else:
        if len(pool) < n:
            raise PipelineError(
                f"only {len(pool)} eligible tickers at {day.isoformat()}, need n={n}"
            )
        # Deterministic: eligibility order follows data.assets, which is the
        # alphabetical DISTINCT query above. No look-ahead, no cherry-picking.
        universe = pool[:n]

    mu, sigma = mu_sigma(data, returns, universe, day)
    return Instance(
        n=len(universe),
        k=k,
        risk_aversion=risk_aversion,
        assets=universe,
        mu=np.asarray(mu, dtype=float),
        sigma=np.asarray(sigma, dtype=float),
        source="repo:data/leash.db",
        as_of=day.isoformat(),
        detail={
            "db": str(db_path),
            "price_source": "binance",
            "mu_window_days": MU_WINDOW_DAYS,
            "sigma_window_days": SIGMA_WINDOW_DAYS,
            "shrinkage_delta": SHRINKAGE_DELTA,
            "eligible_count": len(pool),
            "selection_rule": "first n eligible tickers in alphabetical order",
        },
    )


# --------------------------------------------------------------------------
# 2. separatrix-cli bridge (with emit_qubo)
# --------------------------------------------------------------------------


def discover_cli() -> Path:
    env = os.environ.get("SEPARATRIX_CLI")
    if env:
        return Path(env)
    for candidate in _CLI_CANDIDATES:
        path = REPO_ROOT / candidate
        if path.exists():
            return path
    raise PipelineError(
        "separatrix-cli not found: set SEPARATRIX_CLI or run "
        "`cargo build --release` in separatrix/"
    )


def run_cli(
    instance: Instance,
    solvers: Sequence[str],
    seed: int,
    max_exact_subsets: int,
    timeout: float = 600.0,
) -> dict[str, Any]:
    """One JSON request in, one JSON line out (docs/workbench.md). Fail-closed."""
    binary = discover_cli()
    request = {
        "mu": instance.mu.tolist(),
        "sigma": instance.sigma.tolist(),
        "risk_aversion": float(instance.risk_aversion),
        "k": int(instance.k),
        "solvers": list(solvers),
        "seed": int(seed),
        "max_exact_subsets": int(max_exact_subsets),
        "emit_qubo": True,
    }
    try:
        proc = subprocess.run(
            [str(binary)],
            input=json.dumps(request, allow_nan=False),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except OSError as exc:
        raise PipelineError(f"failed to spawn {binary}: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise PipelineError(f"separatrix-cli timed out after {timeout}s") from exc
    if proc.returncode != 0:
        raise PipelineError(
            f"separatrix-cli exited {proc.returncode}: "
            f"{(proc.stderr or proc.stdout or 'no output').strip()[:400]}"
        )
    for line in reversed(proc.stdout.splitlines()):
        text = line.strip()
        if text.startswith("{"):
            return json.loads(text)
    raise PipelineError("no JSON object on separatrix-cli stdout")


def triangular_index(n: int, i: int, j: int) -> int:
    """Row-major upper-triangular index, matching separatrix-cli and the
    Solana program's `triangular_index`. The three must agree exactly."""
    if i > j:
        i, j = j, i
    return i * n - i * max(i - 1, 0) // 2 + (j - i)


def qubo_matrix_from_export(export: dict[str, Any]) -> np.ndarray:
    """Rebuild the dense integer upper-triangular Q from the CLI's export."""
    n = int(export["n"])
    coeffs = export["coefficients"]
    if len(coeffs) != n * (n + 1) // 2:
        raise PipelineError("qubo export term_count mismatch")
    q = np.zeros((n, n), dtype=object)
    for i in range(n):
        for j in range(i, n):
            q[i, j] = int(coeffs[triangular_index(n, i, j)])
    return q


def canonical_objective(q: np.ndarray, bits: Sequence[int]) -> int:
    """The canonical integer objective, in exact Python integers.

    Identical arithmetic to QuantizedQubo::objective in Rust (i128 there,
    arbitrary precision here — both exact, so they agree bit for bit)."""
    n = len(bits)
    total = 0
    for i in range(n):
        if not bits[i]:
            continue
        total += q[i, i]
        for j in range(i + 1, n):
            if bits[j]:
                total += q[i, j]
    return int(total)


# --------------------------------------------------------------------------
# 3. Feasible-set ground truth
# --------------------------------------------------------------------------


@dataclass(slots=True)
class FeasibleSet:
    """Every weight-k bitstring with its canonical integer objective."""

    n: int
    k: int
    supports: list[tuple[int, ...]]
    objectives: list[int]
    sorted_objectives: list[int]
    best: int
    worst: int
    spread: int
    index_by_state: dict[int, int]

    def gap_norm(self, objective: int) -> float:
        return (objective - self.best) / float(max(self.spread, 1))

    def rank(self, objective: int) -> int:
        """1 = the proven optimum. Ties share the best available rank."""
        lo, hi = 0, len(self.sorted_objectives)
        while lo < hi:
            mid = (lo + hi) // 2
            if self.sorted_objectives[mid] < objective:
                lo = mid + 1
            else:
                hi = mid
        return lo + 1


def enumerate_feasible(q: np.ndarray, n: int, k: int) -> FeasibleSet:
    supports: list[tuple[int, ...]] = []
    objectives: list[int] = []
    index_by_state: dict[int, int] = {}
    for combo in itertools.combinations(range(n), k):
        bits = [0] * n
        for i in combo:
            bits[i] = 1
        supports.append(combo)
        objectives.append(canonical_objective(q, bits))
        index_by_state[sum(1 << i for i in combo)] = len(supports) - 1
    ordered = sorted(objectives)
    return FeasibleSet(
        n=n,
        k=k,
        supports=supports,
        objectives=objectives,
        sorted_objectives=ordered,
        best=ordered[0],
        worst=ordered[-1],
        spread=ordered[-1] - ordered[0],
        index_by_state=index_by_state,
    )


# --------------------------------------------------------------------------
# 4. Ising mapping and QAOA circuits
# --------------------------------------------------------------------------


def portfolio_qubo(instance: Instance) -> tuple[np.ndarray, np.ndarray]:
    """The **penalty-free** selection QUBO in float units.

        c_i  = (1/k²)·Σ_ii − (λ/k)·μ_i
        p_ij = (2/k²)·Σ_ij            (i < j)

    This is `build_selection_qubo` minus the cardinality penalty, which is
    exactly the right cost operator for a Hamming-weight-preserving mixer:
    the penalty is identically zero on the feasible set, so dropping it leaves
    the ordering of every feasible portfolio untouched while removing
    coefficients ~10x larger than the signal from the rotation angles.
    The caller proves this equivalence numerically on every feasible
    portfolio, against the canonical integer objective, before any gate is
    laid down.
    """
    k = instance.k
    sym = 0.5 * (instance.sigma + instance.sigma.T)
    inv_k2 = 1.0 / (k * k)
    diag = inv_k2 * np.diag(sym) - (instance.risk_aversion / k) * instance.mu
    pairs = 2.0 * inv_k2 * sym
    np.fill_diagonal(pairs, 0.0)
    pairs = np.triu(pairs, 1)
    return diag.astype(float), pairs.astype(float)


def qubo_to_ising(diag: np.ndarray, pairs: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """QUBO -> Ising with x_i = (1 − Z_i)/2, so |0> ↦ x=0 and |1> ↦ x=1.

    Returns (h, J, offset) with C(x) = offset + Σ h_i Z_i + Σ_{i<j} J_ij Z_i Z_j.
    """
    full = pairs + pairs.T
    h = -0.5 * diag - 0.25 * full.sum(axis=1)
    j = 0.25 * pairs
    offset = 0.5 * diag.sum() + 0.25 * pairs.sum()
    return h, j, float(offset)


def cost_diagonal(diag: np.ndarray, pairs: np.ndarray, n: int) -> np.ndarray:
    """C(x) for every one of the 2^n computational basis states.

    Index convention: basis index `s` has qubit i set iff `s >> i & 1`, which
    is qiskit's little-endian statevector ordering.
    """
    values = np.zeros(1 << n, dtype=float)
    for s in range(1 << n):
        bits = [(s >> i) & 1 for i in range(n)]
        total = 0.0
        for i in range(n):
            if not bits[i]:
                continue
            total += diag[i]
            for jj in range(i + 1, n):
                if bits[jj]:
                    total += pairs[i, jj]
        values[s] = total
    return values


def build_dicke_circuit(n: int, k: int):
    """Deterministic Dicke state |D^n_k> (Bärtschi & Eidenbenz, arXiv:1904.07358).

    |D^n_k> is the uniform superposition over all C(n,k) bitstrings of Hamming
    weight k — i.e. exactly the feasible set of "choose exactly k of n assets",
    and nothing else. Combined with an XY mixer (which commutes with the total
    number operator) the whole computation stays inside the feasible subspace:
    the cardinality constraint is enforced by the *symmetry of the circuit*
    rather than by a penalty term, so no shot can ever pick 2 or 4 assets.

    Construction: start from |1^k 0^{n-k}> (k X gates), then apply
    SCS_{l, min(k, l-1)} for l = n, n-1, ..., 2. Each SCS block is
    CX · (multi-)controlled-Ry(−2·arccos(√(i/l))) · CX.
    `verify_dicke` checks the resulting state against the analytic vector.
    """
    from qiskit import QuantumCircuit
    from qiskit.circuit.library import RYGate

    circ = QuantumCircuit(n, name=f"D^{n}_{k}")
    for q in range(n - k, n):
        circ.x(q)
    for width in range(n, 1, -1):
        for i in range(1, min(k, width - 1) + 1):
            theta = -2.0 * math.acos(math.sqrt(i / width))
            top = width - 1
            low = top - i
            circ.cx(top, low)
            if i == 1:
                circ.cry(theta, low, top)
            else:
                circ.append(RYGate(theta).control(2), [low, width - i, top])
            circ.cx(top, low)
    return circ


def verify_dicke(circ, n: int, k: int) -> float:
    """Fidelity of the prepared state against the analytic |D^n_k>."""
    from qiskit.quantum_info import Statevector

    reference = np.zeros(1 << n, dtype=complex)
    for combo in itertools.combinations(range(n), k):
        reference[sum(1 << q for q in combo)] = 1.0
    reference /= np.linalg.norm(reference)
    produced = Statevector.from_instruction(circ).data
    return float(abs(np.vdot(reference, produced)) ** 2)


def ring_edges(n: int) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """Ring edges split into two commuting colour classes (n even => exact)."""
    even = [(i, i + 1) for i in range(0, n - 1, 2)]
    odd = [(i, i + 1) for i in range(1, n - 1, 2)]
    if n > 2:
        odd.append((n - 1, 0))
    return even, odd


def build_qaoa_circuit(
    n: int,
    k: int,
    h: np.ndarray,
    j_mat: np.ndarray,
    p: int,
    mixer: str,
    gammas: Sequence[Any],
    betas: Sequence[Any],
):
    """The QAOA ansatz. Parameters may be floats or qiskit Parameters."""
    from qiskit import QuantumCircuit

    circ = QuantumCircuit(n, name=f"qaoa_p{p}_{mixer}")
    if mixer == "xy":
        circ.compose(build_dicke_circuit(n, k), inplace=True)
    else:
        circ.h(range(n))
    circ.barrier()

    even, odd = ring_edges(n)
    for layer in range(p):
        gamma = gammas[layer]
        for i in range(n):
            if abs(float(h[i])) > 1e-12:
                circ.rz(2.0 * gamma * float(h[i]), i)
        for a in range(n):
            for b in range(a + 1, n):
                coeff = float(j_mat[a, b])
                if abs(coeff) > 1e-12:
                    circ.rzz(2.0 * gamma * coeff, a, b)
        circ.barrier()
        beta = betas[layer]
        if mixer == "xy":
            # exp(-i·β·(XX+YY)/2) per edge = RXX(β)·RYY(β); the two colour
            # classes commute internally, so each class is exact and only the
            # split between classes is a Trotter approximation.
            for group in (even, odd):
                for (a, b) in group:
                    circ.rxx(beta, a, b)
                    circ.ryy(beta, a, b)
        else:
            circ.rx(2.0 * beta, range(n))
        circ.barrier()
    return circ


# --------------------------------------------------------------------------
# 5. Local, noiseless parameter optimization
# --------------------------------------------------------------------------


def nelder_mead(
    fn: Callable[[np.ndarray], float],
    x0: np.ndarray,
    step: float,
    max_iter: int,
    tol: float = 1e-8,
) -> tuple[np.ndarray, float, int]:
    """Deterministic Nelder-Mead. Hand-rolled so the run is reproducible and
    the script needs no optimizer dependency."""
    dim = x0.size
    simplex = [np.array(x0, dtype=float)]
    for i in range(dim):
        point = np.array(x0, dtype=float)
        point[i] += step
        simplex.append(point)
    values = [fn(pt) for pt in simplex]
    evals = len(values)

    alpha, gamma_c, rho, sigma_c = 1.0, 2.0, 0.5, 0.5
    for _ in range(max_iter):
        order = np.argsort(values)
        simplex = [simplex[i] for i in order]
        values = [values[i] for i in order]
        if abs(values[-1] - values[0]) <= tol * (abs(values[0]) + tol):
            break
        centroid = np.mean(simplex[:-1], axis=0)
        reflected = centroid + alpha * (centroid - simplex[-1])
        f_ref = fn(reflected)
        evals += 1
        if f_ref < values[0]:
            expanded = centroid + gamma_c * (reflected - centroid)
            f_exp = fn(expanded)
            evals += 1
            if f_exp < f_ref:
                simplex[-1], values[-1] = expanded, f_exp
            else:
                simplex[-1], values[-1] = reflected, f_ref
        elif f_ref < values[-2]:
            simplex[-1], values[-1] = reflected, f_ref
        else:
            contracted = centroid + rho * (simplex[-1] - centroid)
            f_con = fn(contracted)
            evals += 1
            if f_con < values[-1]:
                simplex[-1], values[-1] = contracted, f_con
            else:
                best = simplex[0]
                for i in range(1, len(simplex)):
                    simplex[i] = best + sigma_c * (simplex[i] - best)
                    values[i] = fn(simplex[i])
                    evals += 1
    order = np.argsort(values)
    return simplex[order[0]], float(values[order[0]]), evals


def cvar_of(probabilities: np.ndarray, values: np.ndarray, alpha: float) -> float:
    """CVaR_alpha (mean of the best alpha-tail). alpha=1 is the plain mean."""
    if alpha >= 1.0:
        return float(np.dot(probabilities, values))
    order = np.argsort(values)
    cum = 0.0
    acc = 0.0
    for idx in order:
        take = min(probabilities[idx], alpha - cum)
        if take <= 0.0:
            break
        acc += take * values[idx]
        cum += take
        if cum >= alpha:
            break
    return float(acc / alpha) if cum > 0 else float(values[order[0]])


# --------------------------------------------------------------------------
# 6. Measurement post-processing
# --------------------------------------------------------------------------


def bitstring_to_state(bitstring: str) -> int:
    """qiskit prints counts big-endian (leftmost char = highest qubit)."""
    clean = bitstring.replace(" ", "")
    return int(clean, 2)


def state_to_bits(state: int, n: int) -> list[int]:
    return [(state >> i) & 1 for i in range(n)]


@dataclass(slots=True)
class ShotAnalysis:
    shots: int
    feasible_shots: int
    feasible_fraction: float
    distinct_feasible: int
    best_objective: int | None
    best_bits: list[int] | None
    best_assets: list[str] | None
    gap_int: int | None
    gap_norm: float | None
    rank: int | None
    found_optimum: bool
    optimum_shots: int
    optimum_probability: float
    mean_gap_norm_per_shot: float | None
    median_gap_norm_per_shot: float | None


def analyse_counts(
    counts: dict[str, int], q: np.ndarray, feasible: FeasibleSet, assets: list[str]
) -> ShotAnalysis:
    n, k = feasible.n, feasible.k
    total = sum(counts.values())
    feasible_shots = 0
    optimum_shots = 0
    best_obj: int | None = None
    best_state: int | None = None
    per_shot_gaps: list[float] = []
    weights: list[int] = []
    distinct = 0
    for bitstring, count in counts.items():
        state = bitstring_to_state(bitstring)
        bits = state_to_bits(state, n)
        if sum(bits) != k:
            continue
        distinct += 1
        feasible_shots += count
        objective = canonical_objective(q, bits)
        if best_obj is None or objective < best_obj:
            best_obj, best_state = objective, state
        if objective == feasible.best:
            optimum_shots += count
        per_shot_gaps.append(feasible.gap_norm(objective))
        weights.append(count)

    if best_obj is None or best_state is None:
        return ShotAnalysis(
            shots=total,
            feasible_shots=0,
            feasible_fraction=0.0,
            distinct_feasible=0,
            best_objective=None,
            best_bits=None,
            best_assets=None,
            gap_int=None,
            gap_norm=None,
            rank=None,
            found_optimum=False,
            optimum_shots=0,
            optimum_probability=0.0,
            mean_gap_norm_per_shot=None,
            median_gap_norm_per_shot=None,
        )

    gaps = np.array(per_shot_gaps, dtype=float)
    w = np.array(weights, dtype=float)
    mean_gap = float(np.dot(gaps, w) / w.sum())
    order = np.argsort(gaps)
    cumulative = np.cumsum(w[order]) / w.sum()
    median_gap = float(gaps[order][int(np.searchsorted(cumulative, 0.5))])

    bits = state_to_bits(best_state, n)
    return ShotAnalysis(
        shots=total,
        feasible_shots=feasible_shots,
        feasible_fraction=feasible_shots / total if total else 0.0,
        distinct_feasible=distinct,
        best_objective=best_obj,
        best_bits=bits,
        best_assets=[assets[i] for i in range(n) if bits[i]],
        gap_int=best_obj - feasible.best,
        gap_norm=feasible.gap_norm(best_obj),
        rank=feasible.rank(best_obj),
        found_optimum=best_obj == feasible.best,
        optimum_shots=optimum_shots,
        optimum_probability=optimum_shots / total if total else 0.0,
        mean_gap_norm_per_shot=mean_gap,
        median_gap_norm_per_shot=median_gap,
    )


def random_baseline(feasible: FeasibleSet, draws: int, seed: int) -> dict[str, Any]:
    """Uniform random feasible portfolios — the bar any quantum result must clear.

    Two figures, both exact rather than estimated:
      * `single_draw_mean_gap_norm`: expected quality of ONE random portfolio.
      * `best_of_m_expected_gap_norm`: expected quality of the BEST of `draws`
        random portfolios, from the order statistic
        E[min] = Σ_r o_(r)·[((M−r+1)/M)^m − ((M−r)/M)^m].
    The second is the fair comparison against a shot-based quantum result,
    which is also a best-of-m selection.
    """
    ordered = feasible.sorted_objectives
    m_total = len(ordered)
    spread = float(max(feasible.spread, 1))

    single_mean = (float(np.mean(ordered)) - feasible.best) / spread
    single_median = (float(np.median(ordered)) - feasible.best) / spread

    expected_min = 0.0
    if draws > 0:
        for r in range(1, m_total + 1):
            hi = ((m_total - r + 1) / m_total) ** draws
            lo = ((m_total - r) / m_total) ** draws
            expected_min += ordered[r - 1] * (hi - lo)
    else:
        expected_min = float(ordered[-1])
    best_of_m_gap = (expected_min - feasible.best) / spread

    n_optimal = sum(1 for value in ordered if value == feasible.best)
    p_hit = 1.0 - ((m_total - n_optimal) / m_total) ** draws if draws > 0 else 0.0

    rng = np.random.default_rng(seed)
    picks = rng.integers(0, m_total, size=max(draws, 1))
    empirical = min(feasible.objectives[int(i)] for i in picks)
    return {
        "feasible_portfolios": m_total,
        "draws": draws,
        "single_draw_mean_gap_norm": single_mean,
        "single_draw_median_gap_norm": single_median,
        "single_draw_optimum_probability": n_optimal / m_total,
        "best_of_m_expected_gap_norm": best_of_m_gap,
        "best_of_m_probability_of_optimum": p_hit,
        # When best-of-m random already finds the optimum essentially always,
        # "did the quantum result find the optimum" is not a discriminating
        # question and the per-shot distribution is the only honest comparison.
        "best_of_m_saturated": p_hit > 0.99,
        "empirical_best_of_m_gap_norm": (empirical - feasible.best) / spread,
        "empirical_seed": seed,
    }


def build_verdict(label: str, analysis: dict[str, Any], rnd: dict[str, Any]) -> str:
    """State plainly whether `analysis` beat uniform random guessing.

    Two comparisons, because only one of them is usually informative:

    * **best-of-m** — the headline `gap_norm`. At small `C(n,k)` a random
      sampler with a few thousand shots finds the optimum with probability
      ~1, so this comparison *saturates* and proves nothing. When it does,
      the text says so instead of quietly banking a tie as a win.
    * **per-shot** — the mean `gap_norm` of a single sample and the
      probability that one shot lands on the proven optimum. This is where a
      QAOA distribution either is or is not biased towards good portfolios,
      and it is the number that would still mean something at a size where
      enumeration is impossible.
    """
    gap = analysis.get("gap_norm")
    if gap is None:
        return (
            f"**{label} produced no feasible sample at all** "
            f"({analysis.get('shots')} shots, "
            f"{analysis.get('feasible_shots', 0)} feasible). "
            "There is no portfolio to score and nothing to compare against "
            "random guessing."
        )

    rand_best = rnd["best_of_m_expected_gap_norm"]
    per_shot = analysis.get("mean_gap_norm_per_shot")
    rand_per_shot = rnd["single_draw_mean_gap_norm"]
    p_opt = analysis.get("optimum_probability") or 0.0
    rand_p_opt = rnd["single_draw_optimum_probability"]

    # 1e-6 of the objective spread: below this the two are the same answer and
    # calling either one a "win" would be noise-mining.
    tie = 1e-6
    if gap < rand_best - tie:
        head = (
            f"{label} beat the same-budget random baseline on the headline "
            f"metric: `gap_norm` {fmt_gap(gap)} vs an expected "
            f"{fmt_gap(rand_best)} for the best of {rnd['draws']} uniform "
            "feasible draws."
        )
    elif abs(gap - rand_best) <= tie:
        head = (
            f"{label} **tied** the random baseline on the headline metric "
            f"(both `gap_norm` {fmt_gap(gap)})."
        )
    else:
        head = (
            f"**{label} did NOT beat random guessing** on the headline metric: "
            f"`gap_norm` {fmt_gap(gap)} vs an expected {fmt_gap(rand_best)} for "
            f"the best of {rnd['draws']} uniform feasible draws."
        )

    if rnd["best_of_m_saturated"]:
        head += (
            f" That comparison is **saturated and therefore uninformative**: with "
            f"only {rnd['feasible_portfolios']} feasible portfolios, "
            f"{rnd['draws']} uniform draws find the optimum with probability "
            f"{rnd['best_of_m_probability_of_optimum']:.3f}. Random guessing wins "
            "this instance too. Read the per-shot line instead."
        )

    if per_shot is None:
        return head

    ratio = (rand_per_shot / per_shot) if per_shot > 0 else float("inf")
    lift = (p_opt / rand_p_opt) if rand_p_opt > 0 else float("inf")
    numbers = (
        f"mean `gap_norm` {fmt_gap(per_shot)} vs {fmt_gap(rand_per_shot)} for a "
        f"uniform draw ({ratio:.2f}x), and P(optimum) {p_opt:.4f} vs "
        f"{rand_p_opt:.4f} ({lift:.1f}x)"
    )
    feasible_fraction = analysis.get("feasible_fraction")
    leaked = ""
    if feasible_fraction is not None and feasible_fraction < 0.999:
        leaked = (
            f" Only {feasible_fraction * 100:.1f}% of shots satisfied the "
            f"cardinality constraint at all; the rest were discarded before scoring."
        )

    # Both figures must improve, and the mean by a margin worth naming, before
    # this is allowed to read as a win.
    if ratio >= 1.05 and lift >= 1.0:
        tail = (
            f" Per shot the distribution is genuinely biased towards good "
            f"portfolios: {numbers}. That bias is the only thing the circuit "
            "can be credited with — it is not a speedup, and exact enumeration "
            "still solved this instance in microseconds."
        )
    elif ratio <= 1.0 and lift <= 1.0:
        tail = (
            f" Per shot it is **no better than picking a feasible portfolio at "
            f"random**: {numbers}. The output distribution carries no usable "
            "structure."
        )
    else:
        tail = (
            f" Per shot the picture is **mixed and not a win**: {numbers}. A "
            "sampler that improves one of those figures while degrading the "
            "other has not learned the objective."
        )
    return head + tail + leaked


# --------------------------------------------------------------------------
# 7. Hardware
# --------------------------------------------------------------------------

TOKEN_ENV_VARS = ("IBM_QUANTUM_TOKEN", "QISKIT_IBM_TOKEN")
INSTANCE_ENV_VARS = ("IBM_QUANTUM_INSTANCE", "QISKIT_IBM_INSTANCE")


def _first_env(names: Iterable[str]) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value.strip()
    return None


def open_service():
    """QiskitRuntimeService on the current IBM Quantum Platform channel.

    Falls back to a saved account (~/.qiskit/qiskit-ibm.json) when no token is
    in the environment. Raises PipelineError with an actionable message rather
    than a stack trace.
    """
    try:
        from qiskit_ibm_runtime import QiskitRuntimeService
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise PipelineError(
            "qiskit-ibm-runtime is not installed; "
            "pip install -r requirements-quantum.txt"
        ) from exc

    token = _first_env(TOKEN_ENV_VARS)
    crn = _first_env(INSTANCE_ENV_VARS)
    kwargs: dict[str, Any] = {"channel": "ibm_quantum_platform"}
    if token:
        kwargs["token"] = token
    if crn:
        kwargs["instance"] = crn
    try:
        return QiskitRuntimeService(**kwargs)
    except Exception as exc:  # noqa: BLE001 - surface the provider's message
        raise PipelineError(
            f"could not open QiskitRuntimeService ({type(exc).__name__}: {exc}). "
            f"Set {TOKEN_ENV_VARS[0]} to an IBM Quantum Platform API key, or run "
            "QiskitRuntimeService.save_account(...) once. See docs/quantum.md."
        ) from exc


def transpile_for(circuit, backend, optimization_level: int, seed: int):
    from qiskit.transpiler.preset_passmanagers import generate_preset_pass_manager

    pm = generate_preset_pass_manager(
        backend=backend, optimization_level=optimization_level, seed_transpiler=seed
    )
    return pm.run(circuit)


def circuit_stats(circuit) -> dict[str, Any]:
    ops = {str(name): int(count) for name, count in circuit.count_ops().items()}
    two_qubit = 0
    for instruction in circuit.data:
        if len(instruction.qubits) == 2 and instruction.operation.name != "barrier":
            two_qubit += 1
    return {
        "num_qubits": int(circuit.num_qubits),
        "depth": int(circuit.depth()),
        "size": int(circuit.size()),
        "two_qubit_gates": two_qubit,
        "ops": ops,
    }


def _job_backend_name(job) -> str | None:
    """Backend name of a runtime job, across the several shapes it has taken."""
    getter = getattr(job, "backend", None)
    backend = getter() if callable(getter) else getter
    if backend is None:
        return None
    return str(getattr(backend, "name", backend))


def counts_from_pub(pub_result) -> dict[str, int]:
    """Extract counts from a SamplerV2 PubResult across register namings."""
    data = pub_result.data
    for attr in ("meas", "c", "cr"):
        if hasattr(data, attr):
            return dict(getattr(data, attr).get_counts())
    try:
        fields = dict(data.items())
    except Exception as exc:  # noqa: BLE001
        raise PipelineError(f"cannot read counts from PubResult: {exc}") from exc
    if not fields:
        raise PipelineError("PubResult carried no classical registers")
    return dict(next(iter(fields.values())).get_counts())


# --------------------------------------------------------------------------
# 8. Reporting
# --------------------------------------------------------------------------


def fmt_gap(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.6f}"


def write_markdown(path: Path, payload: dict[str, Any]) -> None:
    inst = payload["instance"]
    exact = payload["exact"]
    sim = payload["simulation"]
    rnd = payload["baselines"]["random"]
    hw = payload["hardware"]
    lines: list[str] = []
    a = lines.append

    a(f"# QAOA on a Separatrix portfolio instance — run {payload['run_id']}")
    a("")
    a(f"Generated {payload['generated_at']} · "
      f"qiskit {payload['versions'].get('qiskit')} · "
      f"qiskit-ibm-runtime {payload['versions'].get('qiskit_ibm_runtime')}")
    a("")
    a("## What this is, and what it is not")
    a("")
    a("This is the only genuinely quantum step in the project. Everything else "
      "(bSB, dSB, SA, PT) is classical and quantum-*inspired*.")
    a("")
    a("- **No quantum advantage is claimed.** At "
      f"n={inst['n']}, k={inst['k']} there are {exact['feasible_portfolios']} feasible "
      "portfolios and exact enumeration proves the optimum in "
      f"{exact['runtime_ms']} ms. Nothing here beats that.")
    a("- QAOA parameters were optimized **in noiseless simulation**. The QPU, if "
      "used at all, ran exactly one circuit, once.")
    a("- The score is the repo's canonical **integer** objective and the headline "
      "metric is `gap_norm = (objective − best) / (worst − best)`, 0 = optimal, "
      "1 = the worst portfolio available.")
    a("")

    a("## Instance")
    a("")
    a(f"- Source: `{inst['source']}`" + (f" as of **{inst['as_of']}**" if inst["as_of"] else ""))
    a(f"- n = {inst['n']}, k = {inst['k']}, λ = {inst['risk_aversion']}")
    a(f"- Universe: {', '.join(inst['assets'])}")
    a(f"- Quantized QUBO digest (`q_hash`): `{payload['qubo']['q_hash']}`")
    a(f"- Quantization scale: {payload['qubo']['scale']:.6e}")
    a("")

    a("## Ground truth (separatrix-cli `exact`)")
    a("")
    a(f"- Optimal portfolio: **{', '.join(exact['best_assets'])}**")
    a(f"- Optimal objective (integer): `{exact['best_objective']}`")
    a(f"- Worst feasible objective: `{exact['worst_objective']}`")
    a(f"- Achievable spread: `{exact['spread']}`")
    a("")

    a("## QAOA in simulation (noiseless statevector)")
    a("")
    a(f"- Mixer: **{sim['mixer_description']}**")
    a(f"- Layers p = {sim['p']}, parameters = {2 * sim['p']}, "
      f"optimizer = Nelder-Mead ×{sim['restarts']} restarts "
      f"({sim['function_evaluations']} evaluations)")
    if sim.get("dicke_fidelity") is not None:
        a(f"- Dicke state |D^{inst['n']}_{inst['k']}⟩ fidelity: "
          f"{sim['dicke_fidelity']:.12f}")
        a(f"- Feasible-subspace leakage in the final state: {sim['leakage']:.3e}")
    a(f"- Shots drawn from the exact final state: {sim['shots']}")
    a("")
    a("| Quantity | Value |")
    a("| --- | ---: |")
    a(f"| Best feasible portfolio found | {', '.join(sim['analysis']['best_assets'] or [])} |")
    a(f"| `gap_int` | {sim['analysis']['gap_int']} |")
    a(f"| **`gap_norm`** | **{fmt_gap(sim['analysis']['gap_norm'])}** |")
    a(f"| Rank among {exact['feasible_portfolios']} feasible portfolios | "
      f"{sim['analysis']['rank']} |")
    a(f"| Found the proven optimum? | {'yes' if sim['analysis']['found_optimum'] else 'no'} |")
    a(f"| P(optimum) per shot | {sim['analysis']['optimum_probability']:.4f} |")
    a(f"| Mean `gap_norm` per shot | {fmt_gap(sim['analysis']['mean_gap_norm_per_shot'])} |")
    a(f"| Feasible shots | {sim['analysis']['feasible_shots']} / {sim['analysis']['shots']} "
      f"({sim['analysis']['feasible_fraction'] * 100:.2f}%) |")
    a("")

    a("## Comparison")
    a("")
    a("| Method | `gap_norm` | Optimal? | Runtime |")
    a("| --- | ---: | :---: | ---: |")
    a(f"| exact (proven optimum) | 0.000000 | yes | {exact['runtime_ms']} ms |")
    for row in payload["baselines"]["separatrix"]:
        a(f"| {row['solver']} | {fmt_gap(row['gap_norm'])} | "
          f"{'yes' if row['gap_int'] == 0 else 'no'} | {row['runtime_ms']} ms |")
    a(f"| QAOA p={sim['p']} (simulated, noiseless) | "
      f"{fmt_gap(sim['analysis']['gap_norm'])} | "
      f"{'yes' if sim['analysis']['found_optimum'] else 'no'} | "
      f"{sim['wall_seconds']:.1f} s (optimization) |")
    if hw["executed"]:
        a(f"| QAOA p={sim['p']} (**{hw['backend']} hardware**) | "
          f"{fmt_gap(hw['analysis']['gap_norm'])} | "
          f"{'yes' if hw['analysis']['found_optimum'] else 'no'} | "
          f"{hw.get('usage_seconds', 'n/a')} s QPU |")
    else:
        a(f"| QAOA p={sim['p']} (hardware) | **NOT RUN** | — | — |")
    a(f"| random feasible guess, 1 draw | "
      f"{fmt_gap(rnd['single_draw_mean_gap_norm'])} (expected) | no | — |")
    a(f"| random feasible guess, best of {rnd['draws']} draws | "
      f"{fmt_gap(rnd['best_of_m_expected_gap_norm'])} (expected) | "
      f"P={rnd['best_of_m_probability_of_optimum']:.3f} | — |")
    a("")
    if rnd["best_of_m_saturated"]:
        a(f"> **The best-of-{rnd['draws']} column above is saturated.** With only "
          f"{rnd['feasible_portfolios']} feasible portfolios, {rnd['draws']} uniform "
          f"random draws already contain the optimum with probability "
          f"{rnd['best_of_m_probability_of_optimum']:.3f}. \"Found the optimum\" is "
          "therefore not evidence of anything at this size. The table below is the "
          "comparison that carries information.")
        a("")

    a("### Per-shot distribution quality")
    a("")
    a("What one sample is worth, before any best-of-m selection. This is the "
      "only figure that would still mean something at a size where enumeration "
      "is impossible.")
    a("")
    a("| Sampler | Mean `gap_norm` per shot | P(optimum) per shot |")
    a("| --- | ---: | ---: |")
    a(f"| uniform random feasible portfolio | "
      f"{fmt_gap(rnd['single_draw_mean_gap_norm'])} | "
      f"{rnd['single_draw_optimum_probability']:.4f} |")
    a(f"| QAOA p={sim['p']} (simulated, noiseless) | "
      f"{fmt_gap(sim['analysis']['mean_gap_norm_per_shot'])} | "
      f"{sim['analysis']['optimum_probability']:.4f} |")
    if hw["executed"]:
        a(f"| QAOA p={sim['p']} (**{hw['backend']} hardware**) | "
          f"{fmt_gap(hw['analysis']['mean_gap_norm_per_shot'])} | "
          f"{hw['analysis']['optimum_probability']:.4f} |")
    else:
        a(f"| QAOA p={sim['p']} (hardware) | **NOT RUN** | **NOT RUN** |")
    a("")

    a("### Did it beat random?")
    a("")
    a(payload["verdict"]["simulation"])
    a("")
    a(payload["verdict"]["hardware"])
    a("")

    a("## Hardware")
    a("")
    if hw["executed"]:
        a(f"- Backend: `{hw['backend']}` ({hw.get('backend_qubits')} qubits, "
          f"processor `{hw.get('processor_type')}`)")
        a(f"- Job id: `{hw['job_id']}`")
        a(f"- Shots: {hw['shots']}")
        a(f"- Transpiled: depth {hw['transpiled']['depth']}, "
          f"{hw['transpiled']['two_qubit_gates']} two-qubit gates")
        a(f"- Feasible shots: {hw['analysis']['feasible_shots']} / "
          f"{hw['analysis']['shots']} "
          f"({hw['analysis']['feasible_fraction'] * 100:.2f}%)")
        a("")
        a("Every shot that violated the cardinality constraint was discarded "
          "before scoring; the surviving fraction above is the honest measure "
          "of how much of the symmetry the device preserved.")
    else:
        a(f"- **Status: {hw['status']}.** No circuit was submitted to any QPU, "
          "and no hardware measurement exists for this run.")
        a(f"- Reason: {hw['reason']}")
        if hw.get("transpiled"):
            a(f"- Transpiled preview for `{hw.get('backend')}`: "
              f"depth {hw['transpiled']['depth']}, "
              f"{hw['transpiled']['two_qubit_gates']} two-qubit gates "
              "(compiled, not executed)")
        a(f"- Ideal circuit as optimized: depth {hw['ideal_circuit']['depth']}, "
          f"{hw['ideal_circuit']['two_qubit_gates']} two-qubit gates on "
          f"{hw['ideal_circuit']['num_qubits']} qubits")
        preview = hw.get("compile_preview")
        if preview:
            a(f"- Offline compile preview on `{preview['backend']}` "
              f"({preview['backend_qubits']} qubits, snapshot coupling map): "
              f"depth **{preview['depth']}**, **{preview['two_qubit_gates']}** "
              "native two-qubit gates after routing. "
              "**Compiled only — not executed, no measurement.**")
        a("")
        a("To run it for real, see `docs/quantum.md`.")
    a("")

    a("## Reproduce")
    a("")
    a("```")
    a(payload["command"])
    a("```")
    a("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python scripts/heron_qaoa.py",
        description="QAOA on a Separatrix cardinality-constrained portfolio "
                    "instance: optimize in simulation, optionally run one "
                    "circuit on IBM Quantum hardware, score honestly.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    g = parser.add_argument_group("instance")
    g.add_argument("--n", type=int, default=10, help="Universe size (qubits)")
    g.add_argument("--k", type=int, default=3, help="Assets to select")
    g.add_argument("--risk-aversion", type=float, default=DEFAULT_RISK_AVERSION)
    g.add_argument("--instance-source", choices=("auto", "repo", "synthetic"), default="auto",
                   help="auto = repo data if data/leash.db is usable, else synthetic")
    g.add_argument("--db", default=str(DEFAULT_DB), help="SQLite path for the repo instance")
    g.add_argument("--as-of", default=None, help="Rebalance date YYYY-MM-DD (default: latest)")
    g.add_argument("--universe", default=None, help="Comma-separated tickers (overrides auto)")
    g.add_argument("--seed", type=int, default=42, help="Seed for solvers, restarts, sampling")

    q = parser.add_argument_group("qaoa")
    q.add_argument("--p", type=int, default=2, help="QAOA layers")
    q.add_argument("--mixer", choices=("xy", "x"), default="xy",
                   help="xy = XY-ring mixer on a Dicke state (cardinality preserved by "
                        "construction); x = standard X mixer on |+>^n with the penalty term")
    q.add_argument("--restarts", type=int, default=12, help="Nelder-Mead restarts")
    q.add_argument("--max-iter", type=int, default=400, help="Nelder-Mead iterations per restart")
    q.add_argument("--cvar", type=float, default=1.0,
                   help="CVaR alpha for the training objective (1.0 = plain expectation)")
    q.add_argument("--shots", type=int, default=4096, help="Shots (simulation and hardware)")

    h = parser.add_argument_group("hardware")
    h.add_argument("--backend", default=None, help="IBM backend name, e.g. ibm_kingston")
    h.add_argument("--dry-run", action=argparse.BooleanOptionalAction, default=True,
                   help="ON BY DEFAULT. --no-dry-run is required to submit a job")
    h.add_argument("--optimization-level", type=int, default=3, choices=(0, 1, 2, 3))
    h.add_argument("--fetch-job", default=None,
                   help="Skip submission; post-process an existing job id instead")
    h.add_argument("--fake-backend", default=None,
                   help="Offline compile-only preview against a snapshot backend "
                        "(e.g. FakeKingston). Needs no credentials, executes "
                        "nothing, and produces NO measurement — only gate counts")
    h.add_argument("--wait", action="store_true",
                   help="Block until a submitted job finishes (queues can be hours)")

    o = parser.add_argument_group("output")
    o.add_argument("--reports-dir", default=str(REPORTS_ROOT))
    o.add_argument("--max-exact-subsets", type=int, default=20_000_000)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.k < 1 or args.k >= args.n:
        raise PipelineError(f"need 1 <= k < n, got k={args.k}, n={args.n}")
    if args.n > 24:
        raise PipelineError(
            f"n={args.n} means a 2^{args.n} statevector and C(n,k) enumeration; "
            "this script is deliberately capped at 24 qubits"
        )
    if args.mixer == "xy" and args.n % 2 != 0:
        say(f"[warn] n={args.n} is odd; the XY ring mixer's two colour classes "
              "overlap, so the Trotter split is coarser. Even n is preferred.")

    run_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.reports_dir) / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    command = "python " + " ".join(
        [str(Path(sys.argv[0]).as_posix())] + list(argv if argv is not None else sys.argv[1:])
    )

    # -- instance ----------------------------------------------------------
    universe_override = (
        [t.strip().upper() for t in args.universe.split(",") if t.strip()]
        if args.universe else None
    )
    instance: Instance
    instance_fallback_reason: str | None = None
    if args.instance_source in ("auto", "repo"):
        try:
            instance = repo_instance(
                Path(args.db), args.n, args.k, args.risk_aversion,
                args.as_of, universe_override,
            )
        except Exception as exc:  # noqa: BLE001
            if args.instance_source == "repo":
                raise PipelineError(f"repo instance unavailable: {exc}") from exc
            instance_fallback_reason = f"{type(exc).__name__}: {exc}"
            say(f"[info] repo data unusable ({instance_fallback_reason}); "
                "falling back to the deterministic synthetic instance")
            instance = synthetic_instance(args.n, args.k, args.seed, args.risk_aversion)
    else:
        instance = synthetic_instance(args.n, args.k, args.seed, args.risk_aversion)

    say(f"[1/6] instance: {instance.source} n={instance.n} k={instance.k} "
          f"as_of={instance.as_of} assets={','.join(instance.assets)}")

    # -- ground truth from the Rust CLI ------------------------------------
    solvers = ["exact", "bsb", "dsb", "sa", "pt"]
    cli = run_cli(instance, solvers, args.seed, args.max_exact_subsets)
    if "qubo" not in cli or cli["qubo"] is None:
        raise PipelineError("separatrix-cli did not emit the qubo export")
    if not isinstance(cli.get("exact"), dict) or "error" in cli["exact"]:
        raise PipelineError(f"exact ground truth unavailable: {cli.get('exact')}")

    q_int = qubo_matrix_from_export(cli["qubo"])
    scale = float(cli["qubo"]["scale"])
    offset_int = int(cli["qubo"]["offset_int"])
    feasible = enumerate_feasible(q_int, instance.n, instance.k)

    cli_best = int(cli["exact"]["objective_int"])
    cli_worst = int(cli["exact"]["worst_objective_int"])
    if (feasible.best, feasible.worst) != (cli_best, cli_worst):
        raise PipelineError(
            "python re-scoring disagrees with separatrix-cli exact: "
            f"best {feasible.best} vs {cli_best}, worst {feasible.worst} vs {cli_worst}"
        )
    say(f"[2/6] exact ground truth: best={feasible.best} worst={feasible.worst} "
          f"spread={feasible.spread} over C({instance.n},{instance.k})="
          f"{len(feasible.objectives)} portfolios (python re-scoring agrees)")

    # -- cost Hamiltonian ---------------------------------------------------
    if args.mixer == "xy":
        diag_f, pairs_f = portfolio_qubo(instance)
        # Prove the float Hamiltonian ranks the feasible set identically to the
        # canonical integer objective before a single gate is laid down.
        worst_err = 0.0
        for support, objective in zip(feasible.supports, feasible.objectives):
            bits = [0] * instance.n
            for i in support:
                bits[i] = 1
            float_value = sum(diag_f[i] for i in support) + sum(
                pairs_f[a, b] for a, b in itertools.combinations(sorted(support), 2)
            )
            expected = (objective + offset_int) / scale
            worst_err = max(worst_err, abs(float_value - expected))
        tolerance = 1e-9 + abs(feasible.spread) / scale * 1e-6
        if worst_err > tolerance:
            raise PipelineError(
                f"penalty-free Hamiltonian disagrees with the canonical objective "
                f"(max abs error {worst_err:.3e} > {tolerance:.3e})"
            )
        normalizer = feasible.spread / scale
        mixer_description = (
            "XY ring mixer on a Dicke state |D^n_k> — Hamming weight, i.e. the "
            "cardinality constraint, is preserved exactly by the circuit's "
            "symmetry, so no penalty term is needed"
        )
    else:
        # Standard X mixer: the constraint is only enforced by the penalty, so
        # the cost operator must be the full penalized QUBO.
        diag_f = np.array([float(q_int[i, i]) for i in range(instance.n)])
        pairs_f = np.zeros((instance.n, instance.n))
        for i in range(instance.n):
            for j in range(i + 1, instance.n):
                pairs_f[i, j] = float(q_int[i, j])
        worst_err = 0.0
        normalizer = None
        mixer_description = (
            "standard X mixer on |+>^n with the cardinality penalty P·(Σx − k)² "
            "in the cost operator; infeasible bitstrings are possible and are "
            "discarded before scoring"
        )

    say(f"[3/6] cost Hamiltonian: {mixer_description.split(' — ')[0]}")

    from qiskit import QuantumCircuit  # noqa: F401  (import guarded here)
    from qiskit.circuit import ParameterVector
    from qiskit.quantum_info import Statevector

    raw_diagonal = cost_diagonal(diag_f, pairs_f, instance.n)
    if normalizer is None:
        span = float(raw_diagonal.max() - raw_diagonal.min())
        normalizer = span if span > 0 else 1.0
    scaled_diag = diag_f / normalizer
    scaled_pairs = pairs_f / normalizer
    h_vec, j_mat, _ising_offset = qubo_to_ising(scaled_diag, scaled_pairs)
    cost_values = cost_diagonal(scaled_diag, scaled_pairs, instance.n)

    # -- local, noiseless optimization -------------------------------------
    gammas = ParameterVector("g", args.p)
    betas = ParameterVector("b", args.p)
    ansatz = build_qaoa_circuit(
        instance.n, instance.k, h_vec, j_mat, args.p, args.mixer, gammas, betas
    )
    dicke_fidelity = None
    if args.mixer == "xy":
        dicke_fidelity = verify_dicke(build_dicke_circuit(instance.n, instance.k),
                                      instance.n, instance.k)
        if dicke_fidelity < 1 - 1e-9:
            raise PipelineError(
                f"Dicke state preparation verification failed (fidelity "
                f"{dicke_fidelity:.12f}); refusing to run a circuit whose "
                "initial state is not what it claims to be"
            )
        say(f"      Dicke |D^{instance.n}_{instance.k}> fidelity = {dicke_fidelity:.12f} (verified)")

    feasible_mask = np.zeros(1 << instance.n, dtype=bool)
    for state in feasible.index_by_state:
        feasible_mask[state] = True

    eval_count = 0

    def statevector_for(params: np.ndarray) -> np.ndarray:
        nonlocal eval_count
        eval_count += 1
        bound = ansatz.assign_parameters(
            {**{gammas[i]: float(params[i]) for i in range(args.p)},
             **{betas[i]: float(params[args.p + i]) for i in range(args.p)}}
        )
        return Statevector.from_instruction(bound).data

    def training_objective(params: np.ndarray) -> float:
        amplitudes = statevector_for(params)
        probabilities = np.abs(amplitudes) ** 2
        if args.mixer == "xy":
            # Leakage is numerically zero; renormalize defensively anyway.
            probabilities = probabilities * feasible_mask
            total = probabilities.sum()
            if total <= 0:
                return 1e9
            probabilities = probabilities / total
        return cvar_of(probabilities, cost_values, args.cvar)

    rng = np.random.default_rng(args.seed)
    starts: list[np.ndarray] = []
    # A linear ramp is the standard, non-random QAOA warm start.
    ramp = np.concatenate([
        np.linspace(0.3, 1.2, args.p) * math.pi,
        np.linspace(0.6, 0.15, args.p) * math.pi / 2.0,
    ])
    starts.append(ramp)
    for _ in range(max(args.restarts - 1, 0)):
        starts.append(
            np.concatenate([
                rng.uniform(-math.pi, math.pi, args.p),
                rng.uniform(-math.pi / 2, math.pi / 2, args.p),
            ])
        )

    started = time.perf_counter()
    best_params, best_value = None, math.inf
    for start in starts:
        params, value, _ = nelder_mead(
            training_objective, start, step=0.35, max_iter=args.max_iter
        )
        if value < best_value:
            best_params, best_value = params, value
    wall = time.perf_counter() - started
    assert best_params is not None
    say(f"[4/6] optimized p={args.p} in {wall:.1f}s over {eval_count} "
          f"statevector evaluations; training objective = {best_value:.6f}")

    final_state = statevector_for(best_params)
    probabilities = np.abs(final_state) ** 2
    leakage = float(probabilities[~feasible_mask].sum())

    sample_rng = np.random.default_rng(args.seed + 1)
    draws = sample_rng.choice(len(probabilities), size=args.shots,
                              p=probabilities / probabilities.sum())
    sim_counts: dict[str, int] = {}
    width = instance.n
    for state in draws:
        key = format(int(state), f"0{width}b")  # big-endian, like qiskit
        sim_counts[key] = sim_counts.get(key, 0) + 1
    sim_analysis = analyse_counts(sim_counts, q_int, feasible, instance.assets)

    say(f"[5/6] simulated {args.shots} shots: gap_norm="
          f"{fmt_gap(sim_analysis.gap_norm)} rank={sim_analysis.rank}/"
          f"{len(feasible.objectives)} "
          f"optimum={'FOUND' if sim_analysis.found_optimum else 'missed'}")

    baseline_draws = max(sim_analysis.feasible_shots, 1)
    rnd = random_baseline(feasible, baseline_draws, args.seed + 2)

    # -- hardware -----------------------------------------------------------
    final_circuit = ansatz.assign_parameters(
        {**{gammas[i]: float(best_params[i]) for i in range(args.p)},
         **{betas[i]: float(best_params[args.p + i]) for i in range(args.p)}}
    )
    measured = final_circuit.copy()
    measured.measure_all()

    hardware: dict[str, Any] = {
        "executed": False,
        "status": "not_run",
        "reason": "",
        "backend": args.backend,
        "job_id": None,
        "shots": args.shots,
        "ideal_circuit": circuit_stats(final_circuit),
        "transpiled": None,
        "analysis": None,
    }

    if args.fake_backend:
        # Compile-only, against a stored snapshot of a real device's coupling
        # map and basis. This is NOT an execution and produces no counts; it
        # exists so the routing cost is visible before anyone spends QPU time.
        try:
            import qiskit_ibm_runtime.fake_provider as fake_provider

            fake = getattr(fake_provider, args.fake_backend)()
            isa = transpile_for(measured, fake, args.optimization_level, args.seed)
            stats = circuit_stats(isa)
            hardware["compile_preview"] = {
                "backend": args.fake_backend,
                "backend_qubits": int(fake.num_qubits),
                "executed": False,
                "note": "coupling-map/basis compilation only; nothing was run "
                        "and no measurement exists",
                **stats,
            }
            say(f"      compile preview on {args.fake_backend} "
                f"({fake.num_qubits}q): depth {stats['depth']}, "
                f"{stats['two_qubit_gates']} two-qubit gates")
        except AttributeError as exc:
            raise PipelineError(
                f"unknown --fake-backend {args.fake_backend!r}: {exc}"
            ) from exc

    if args.fetch_job:
        try:
            service = open_service()
            job = service.job(args.fetch_job)
            result = job.result()
            hw_counts = counts_from_pub(result[0])
            hw_analysis = analyse_counts(hw_counts, q_int, feasible, instance.assets)
            hardware.update({
                "executed": True,
                "status": "completed",
                "reason": "fetched an existing job",
                "job_id": args.fetch_job,
                "backend": _job_backend_name(job) or args.backend,
                "counts": hw_counts,
                "analysis": asdict(hw_analysis),
            })
        except PipelineError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise PipelineError(f"could not fetch job {args.fetch_job}: {exc}") from exc
    elif args.dry_run:
        reason = ("--dry-run is on (the default). Nothing was submitted. "
                  "Pass --no-dry-run together with --backend to execute.")
        hardware["reason"] = reason
        if args.backend:
            try:
                service = open_service()
                backend = service.backend(args.backend)
                isa = transpile_for(measured, backend, args.optimization_level, args.seed)
                hardware["transpiled"] = circuit_stats(isa)
                hardware["backend_qubits"] = int(backend.num_qubits)
                hardware["reason"] = reason + " (circuit compiled for the backend only)"
            except PipelineError as exc:
                hardware["reason"] = reason + f" Backend preview unavailable: {exc}"
        say(f"[6/6] hardware: NOT RUN - {hardware['reason']}")
    else:
        if not args.backend:
            raise PipelineError("--no-dry-run requires --backend")
        from qiskit_ibm_runtime import SamplerV2

        service = open_service()
        backend = service.backend(args.backend)
        isa = transpile_for(measured, backend, args.optimization_level, args.seed)
        hardware["transpiled"] = circuit_stats(isa)
        hardware["backend_qubits"] = int(backend.num_qubits)
        hardware["processor_type"] = str(getattr(backend, "processor_type", None))
        sampler = SamplerV2(mode=backend)
        job = sampler.run([isa], shots=args.shots)
        hardware["job_id"] = job.job_id()
        hardware["status"] = "submitted"
        hardware["reason"] = "submitted one circuit, one job"
        say(f"[6/6] hardware: submitted job {job.job_id()} to {args.backend}")
        if args.wait:
            say("      waiting for the job to finish (queues can be hours)...")
            result = job.result()
            hw_counts = counts_from_pub(result[0])
            hw_analysis = analyse_counts(hw_counts, q_int, feasible, instance.assets)
            usage = None
            try:
                usage = float(job.usage_estimation.get("quantum_seconds"))
            except Exception:  # noqa: BLE001
                pass
            hardware.update({
                "executed": True,
                "status": "completed",
                "counts": hw_counts,
                "analysis": asdict(hw_analysis),
                "usage_seconds": usage,
            })
            say(f"      hardware gap_norm={fmt_gap(hw_analysis.gap_norm)} "
                  f"rank={hw_analysis.rank}/{len(feasible.objectives)} "
                  f"feasible={hw_analysis.feasible_fraction * 100:.1f}%")

    if not hardware["executed"] and hardware["status"] == "not_run" and not args.dry_run:
        hardware["reason"] = "job submitted but not awaited; re-run with --fetch-job"

    # -- verdicts (the part that has to stay honest) ------------------------
    sim_verdict = build_verdict("Simulated QAOA (noiseless)", asdict(sim_analysis), rnd)
    if not hardware["executed"]:
        hw_verdict = (
            "Hardware: **not run**, so there is no hardware claim to make. This "
            "section will state plainly whether the QPU beat random guessing "
            "once a job has actually executed."
        )
    else:
        hw_verdict = build_verdict(
            f"Hardware ({hardware.get('backend')})", hardware["analysis"], rnd
        )


    # -- artifact -----------------------------------------------------------
    versions: dict[str, Any] = {"python": platform.python_version()}
    try:
        import qiskit as _qk
        import qiskit_ibm_runtime as _qir
        versions["qiskit"] = _qk.__version__
        versions["qiskit_ibm_runtime"] = _qir.__version__
    except Exception:  # noqa: BLE001
        pass

    best_support = min(
        zip(feasible.objectives, feasible.supports), key=lambda pair: pair[0]
    )[1]
    payload: dict[str, Any] = {
        "run_id": run_id,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": command,
        "versions": versions,
        "honesty": {
            "parameters_optimized_on": "noiseless local statevector simulation",
            "hardware_circuits_submitted": 0 if not hardware["executed"] else 1,
            "claim": "no quantum advantage, no speedup; exact enumeration is "
                     "instant and unbeatable at this size",
            "scoring": "canonical integer objective from separatrix-cli's "
                       "quantized QUBO, identical to the workbench and the "
                       "Solana verifier",
        },
        "instance": {
            "n": instance.n,
            "k": instance.k,
            "risk_aversion": instance.risk_aversion,
            "assets": instance.assets,
            "source": instance.source,
            "as_of": instance.as_of,
            "detail": instance.detail,
            "fallback_reason": instance_fallback_reason,
            "mu": instance.mu.tolist(),
            "sigma": instance.sigma.tolist(),
        },
        "qubo": {
            "q_hash": cli["qubo"]["q_hash"],
            "scale": scale,
            "offset_int": str(offset_int),
            "term_count": cli["qubo"]["term_count"],
        },
        "exact": {
            "best_objective": str(feasible.best),
            "worst_objective": str(feasible.worst),
            "spread": str(feasible.spread),
            "best_bits": [1 if i in best_support else 0 for i in range(instance.n)],
            "best_assets": [instance.assets[i] for i in best_support],
            "feasible_portfolios": len(feasible.objectives),
            "runtime_ms": cli["exact"]["runtime_ms"],
            "python_rescoring_agrees": True,
        },
        "simulation": {
            "mixer": args.mixer,
            "mixer_description": mixer_description,
            "p": args.p,
            "restarts": args.restarts,
            "cvar_alpha": args.cvar,
            "parameters": {
                "gamma": [float(x) for x in best_params[: args.p]],
                "beta": [float(x) for x in best_params[args.p:]],
            },
            "training_objective": best_value,
            "function_evaluations": eval_count,
            "wall_seconds": wall,
            "dicke_fidelity": dicke_fidelity,
            "leakage": leakage,
            "hamiltonian_max_abs_error_vs_canonical": worst_err,
            "shots": args.shots,
            "counts": sim_counts,
            "analysis": {
                **asdict(sim_analysis),
                "best_objective": None if sim_analysis.best_objective is None
                else str(sim_analysis.best_objective),
                "gap_int": None if sim_analysis.gap_int is None
                else str(sim_analysis.gap_int),
            },
        },
        "baselines": {
            "random": rnd,
            "separatrix": [
                {
                    "solver": row["solver"],
                    "objective_int": row["objective_int"],
                    "gap_int": int(row["gap_int"]) if row.get("gap_int") is not None else None,
                    "gap_norm": row.get("gap_norm"),
                    "runtime_ms": row.get("runtime_ms"),
                    "assets": [
                        instance.assets[i] for i, b in enumerate(row["bits"]) if b
                    ],
                }
                for row in cli["results"]
            ],
        },
        "hardware": hardware,
        "verdict": {"simulation": sim_verdict, "hardware": hw_verdict},
    }

    json_path = out_dir / "result.json"
    json_path.write_text(json.dumps(payload, indent=2, sort_keys=False), encoding="utf-8")
    md_path = out_dir / "report.md"
    write_markdown(md_path, payload)

    say()
    say(sim_verdict)
    say(hw_verdict)
    say()
    say(f"artifact: {json_path}")
    say(f"report:   {md_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PipelineError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
