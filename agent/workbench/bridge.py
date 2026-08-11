from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np

DEFAULT_SOLVERS: tuple[str, ...] = ("bsb", "dsb", "sa", "pt", "exact")

# What separatrix-cli caps C(N,K) at when the request omits max_exact_subsets.
# Recorded in reports so a study that never sent the knob is still explicit
# about the bound its "exact ground truth" claim was made under.
DEFAULT_MAX_EXACT_SUBSETS = 20_000_000

# Relative to the project root, tried in order after the SEPARATRIX_CLI env var.
_BINARY_CANDIDATES = (
    Path("separatrix") / "target" / "release" / "separatrix-cli.exe",
    Path("separatrix") / "target" / "release" / "separatrix-cli",
)


class BridgeError(RuntimeError):
    """Any failure talking to separatrix-cli. The caller must skip, never guess."""


def discover_binary(project_root: str | Path = ".") -> Path | None:
    """SEPARATRIX_CLI env var first, then the release-build paths (.exe first)."""
    env = os.environ.get("SEPARATRIX_CLI")
    if env:
        return Path(env)
    root = Path(project_root)
    for candidate in _BINARY_CANDIDATES:
        path = root / candidate
        if path.exists():
            return path
    return None


@dataclass(slots=True)
class SolverResult:
    solver: str
    bits: list[int]
    weights: list[float]
    objective_int: int
    feasible_raw: bool
    repaired: bool
    gap_int: int | None
    gap_rel: float | None
    runtime_ms: float
    # objective_int + objective_offset_int: the portfolio objective without
    # the constant P·K² the penalized QUBO carries. None on older binaries.
    portfolio_objective_int: int | None = None
    # Gap as a fraction of the full achievable objective spread (worst − best).
    # Stable where gap_rel is not: it stays in [0, 1] even when the optimum
    # sits near zero. None on binaries that predate the field.
    gap_norm: float | None = None


@dataclass(slots=True)
class ExactResult:
    bits: list[int] | None
    objective_int: int | None
    runtime_ms: float | None
    error: str | None = None
    subsets: int | None = None
    portfolio_objective_int: int | None = None


@dataclass(slots=True)
class BridgeResponse:
    n: int
    k: int
    scale: float
    exact: ExactResult | None
    results: list[SolverResult]
    # Quantized P·K² constant the penalized QUBO drops on the feasible set.
    objective_offset_int: int | None = None


@dataclass(slots=True)
class SeparatrixCli:
    """Runs the Rust solver CLI over stdin/stdout JSON, per docs/workbench.md.

    Fail-closed: every failure mode (missing binary, spawn error, timeout,
    non-zero exit, unparseable or malformed output) raises BridgeError. The
    walk-forward loop catches it and skips the rebalance — results are never
    fabricated.
    """

    binary: Path | None = None
    timeout_seconds: float = 600.0
    project_root: str | Path = "."

    def __post_init__(self) -> None:
        if self.binary is None:
            self.binary = discover_binary(self.project_root)
        elif not isinstance(self.binary, Path):
            self.binary = Path(self.binary)

    def solve(
        self,
        mu: Sequence[float] | np.ndarray,
        sigma: Sequence[Sequence[float]] | np.ndarray,
        k: int,
        *,
        risk_aversion: float = 0.5,
        solvers: Sequence[str] = DEFAULT_SOLVERS,
        seed: int = 42,
        penalty: float | None = None,
        budget: dict[str, int] | None = None,
        max_exact_subsets: int | None = None,
    ) -> BridgeResponse:
        mu_arr = np.asarray(mu, dtype=float)
        sigma_arr = np.asarray(sigma, dtype=float)
        n = mu_arr.shape[0]
        if mu_arr.ndim != 1 or sigma_arr.shape != (n, n):
            raise BridgeError(
                f"shape mismatch: mu {mu_arr.shape}, sigma {sigma_arr.shape}"
            )
        if not (np.all(np.isfinite(mu_arr)) and np.all(np.isfinite(sigma_arr))):
            raise BridgeError("non-finite values in mu/sigma")
        if not 1 <= int(k) <= n:
            raise BridgeError(f"k={k} out of range for n={n}")
        sigma_arr = 0.5 * (sigma_arr + sigma_arr.T)  # protocol requires symmetric

        request: dict[str, Any] = {
            "mu": mu_arr.tolist(),
            "sigma": sigma_arr.tolist(),
            "risk_aversion": float(risk_aversion),
            "k": int(k),
            "solvers": list(solvers),
            "seed": int(seed),
        }
        if penalty is not None:
            request["penalty"] = float(penalty)
        if budget is not None:
            request["budget"] = dict(budget)
        if max_exact_subsets is not None:
            request["max_exact_subsets"] = int(max_exact_subsets)

        if self.binary is None:
            raise BridgeError(
                "separatrix-cli not found: set SEPARATRIX_CLI or build "
                "separatrix/target/release/separatrix-cli"
            )

        try:
            payload = json.dumps(request, allow_nan=False)
        except ValueError as exc:
            raise BridgeError(f"unserializable request: {exc}") from exc

        try:
            completed = subprocess.run(
                [str(self.binary)],
                input=payload,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except FileNotFoundError as exc:
            raise BridgeError(f"binary not runnable: {exc}") from exc
        except subprocess.TimeoutExpired as exc:
            raise BridgeError(f"solver timed out after {self.timeout_seconds}s") from exc
        except OSError as exc:
            raise BridgeError(f"failed to spawn solver: {exc}") from exc

        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "no output").strip()
            raise BridgeError(
                f"solver exited {completed.returncode}: {detail[:400]}"
            )

        response = _parse_json_line(completed.stdout)
        if response is None:
            raise BridgeError("no JSON object line on solver stdout")
        return _parse_response(response, expected_n=n)


def _parse_json_line(stdout: str) -> dict[str, Any] | None:
    """The protocol is one JSON line; tolerate stray log lines around it."""
    for line in reversed(stdout.splitlines()):
        text = line.strip()
        if not text.startswith("{"):
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return None


def _parse_response(payload: dict[str, Any], expected_n: int) -> BridgeResponse:
    n = _require_int(payload, "n")
    k = _require_int(payload, "k")
    if n != expected_n:
        raise BridgeError(f"response n={n} does not match request n={expected_n}")

    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
        raise BridgeError("response missing 'results' list")

    results = [_parse_solver_result(entry, n) for entry in raw_results]
    exact = _parse_exact(payload.get("exact"), n)

    scale = payload.get("scale", 0.0)
    if not isinstance(scale, (int, float)):
        raise BridgeError(f"bad scale: {scale!r}")

    offset = _parse_big_int(
        payload.get("objective_offset_int"), "objective_offset_int", optional=True
    )

    return BridgeResponse(
        n=n,
        k=k,
        scale=float(scale),
        exact=exact,
        results=results,
        objective_offset_int=offset,
    )


def _parse_solver_result(entry: Any, n: int) -> SolverResult:
    if not isinstance(entry, dict):
        raise BridgeError(f"result entry is not an object: {entry!r}")
    solver = entry.get("solver")
    if not isinstance(solver, str) or not solver:
        raise BridgeError(f"result missing solver name: {entry!r}")
    bits = _parse_bits(entry.get("bits"), n, context=solver)
    objective_int = _parse_big_int(entry.get("objective_int"), f"{solver}.objective_int")
    if objective_int is None:
        raise BridgeError(f"{solver}: missing objective_int")

    gap_int = _parse_big_int(entry.get("gap_int"), f"{solver}.gap_int", optional=True)
    gap_rel = entry.get("gap_rel")
    if gap_rel is not None and not isinstance(gap_rel, (int, float)):
        raise BridgeError(f"{solver}: bad gap_rel {gap_rel!r}")
    gap_norm = entry.get("gap_norm")
    if gap_norm is not None and not isinstance(gap_norm, (int, float)):
        raise BridgeError(f"{solver}: bad gap_norm {gap_norm!r}")

    weights_raw = entry.get("weights")
    if weights_raw is None:
        ones = sum(bits)
        weights = [bit / ones if ones else 0.0 for bit in bits]
    else:
        if not isinstance(weights_raw, list) or len(weights_raw) != n:
            raise BridgeError(f"{solver}: bad weights vector")
        weights = [float(w) for w in weights_raw]

    runtime_ms = entry.get("runtime_ms")
    if not isinstance(runtime_ms, (int, float)) or isinstance(runtime_ms, bool):
        raise BridgeError(f"{solver}: bad runtime_ms {runtime_ms!r}")

    portfolio_objective_int = _parse_big_int(
        entry.get("portfolio_objective_int"),
        f"{solver}.portfolio_objective_int",
        optional=True,
    )

    return SolverResult(
        solver=solver,
        bits=bits,
        weights=weights,
        objective_int=objective_int,
        feasible_raw=bool(entry.get("feasible_raw", False)),
        repaired=bool(entry.get("repaired", False)),
        gap_int=gap_int,
        gap_rel=None if gap_rel is None else float(gap_rel),
        gap_norm=None if gap_norm is None else float(gap_norm),
        runtime_ms=float(runtime_ms),
        portfolio_objective_int=portfolio_objective_int,
    )


def _parse_exact(raw: Any, n: int) -> ExactResult | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise BridgeError(f"bad exact block: {raw!r}")
    if "error" in raw:
        # Documented degradation (TOO_LARGE): the solvers still answered, they
        # just have no proven optimum to be scored against. Never fatal — the
        # caller keeps every selection and reports null gaps.
        return ExactResult(
            bits=None,
            objective_int=None,
            runtime_ms=None,
            error=str(raw["error"]),
            subsets=_parse_subsets(raw.get("subsets")),
        )
    bits = _parse_bits(raw.get("bits"), n, context="exact")
    objective_int = _parse_big_int(raw.get("objective_int"), "exact.objective_int")
    if objective_int is None:
        raise BridgeError("exact: missing objective_int")
    runtime_ms = raw.get("runtime_ms")
    if not isinstance(runtime_ms, (int, float)) or isinstance(runtime_ms, bool):
        raise BridgeError(f"exact: bad runtime_ms {runtime_ms!r}")
    return ExactResult(
        bits=bits,
        objective_int=objective_int,
        runtime_ms=float(runtime_ms),
        portfolio_objective_int=_parse_big_int(
            raw.get("portfolio_objective_int"),
            "exact.portfolio_objective_int",
            optional=True,
        ),
    )


def _parse_subsets(raw: Any) -> int | None:
    """C(N,K) reported alongside a TOO_LARGE exact block, as a JSON number.

    Purely informational, so an unreadable value is dropped rather than
    raised: losing the count must never cost the rebalance its solver results.
    """
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float) and raw.is_integer():
        return int(raw)
    if isinstance(raw, str):
        try:
            return int(raw.strip(), 10)
        except ValueError:
            return None
    return None


def _parse_bits(raw: Any, n: int, context: str) -> list[int]:
    if not isinstance(raw, list) or len(raw) != n:
        raise BridgeError(f"{context}: bits must be a length-{n} list")
    bits: list[int] = []
    for value in raw:
        if value not in (0, 1):
            raise BridgeError(f"{context}: non-binary bit {value!r}")
        bits.append(int(value))
    return bits


def _parse_big_int(raw: Any, context: str, optional: bool = False) -> int | None:
    """objective_int/gap_int are decimal strings (i128 exceeds JSON-safe ints).

    Plain JSON integers are accepted too, defensively.
    """
    if raw is None:
        if optional:
            return None
        raise BridgeError(f"{context}: missing")
    if isinstance(raw, bool):
        raise BridgeError(f"{context}: bad integer {raw!r}")
    if isinstance(raw, int):
        return raw
    if isinstance(raw, str):
        try:
            return int(raw.strip(), 10)
        except ValueError as exc:
            raise BridgeError(f"{context}: bad decimal string {raw!r}") from exc
    raise BridgeError(f"{context}: bad integer {raw!r}")


def _require_int(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise BridgeError(f"response missing integer '{key}'")
    return value
