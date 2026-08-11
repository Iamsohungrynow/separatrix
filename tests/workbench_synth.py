"""Shared synthetic fixtures for the workbench test suite.

Not named test_*.py, so unittest discovery never collects it directly.
Everything here is deterministic: geometric walks come from seeded
``numpy.random.default_rng`` and never touch the network or a real solver.
"""
from __future__ import annotations

import math
import shutil
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from agent.workbench.bridge import (
    BridgeError,
    BridgeResponse,
    ExactResult,
    SolverResult,
)

ASSETS8 = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"]


def make_case_dir(case_name: str) -> Path:
    case_dir = Path(".tmp-tests") / case_name
    shutil.rmtree(case_dir, ignore_errors=True)
    case_dir.mkdir(parents=True, exist_ok=True)
    return case_dir


def synthetic_series(
    assets: list[str],
    n_days: int,
    start_day: date = date(2024, 1, 1),
    seed: int = 7,
    base_price: float = 100.0,
) -> dict[str, dict[date, float]]:
    """Deterministic geometric walks, one per asset, daily closes."""
    rng = np.random.default_rng(seed)
    series: dict[str, dict[date, float]] = {}
    for asset in assets:
        drift = rng.normal(0.0005, 0.0015)
        vol = 0.01 + 0.02 * rng.random()
        shocks = rng.normal(drift, vol, n_days - 1)
        log_path = np.concatenate([[0.0], np.cumsum(shocks)])
        prices = base_price * np.exp(log_path)
        series[asset] = {
            start_day + timedelta(days=i): float(prices[i]) for i in range(n_days)
        }
    return series


def flat_series(
    assets: list[str],
    n_days: int,
    start_day: date = date(2024, 1, 1),
    price: float = 100.0,
) -> dict[str, dict[date, float]]:
    return {
        asset: {start_day + timedelta(days=i): price for i in range(n_days)}
        for asset in assets
    }


def top_k_bits(mu: np.ndarray, k: int) -> list[int]:
    order = np.argsort(-np.asarray(mu, dtype=float), kind="stable")
    bits = [0] * len(mu)
    for i in order[:k]:
        bits[int(i)] = 1
    return bits


class StubBridge:
    """Deterministic in-process stand-in for SeparatrixCli.

    Selection is top-k by mu (a pure function of the inputs), unless
    ``scripted_bits`` provides an explicit bits vector per call index.
    ``fail_calls`` raises BridgeError on those call indices (0-based) to
    exercise the fail-closed skip path. ``max_exact_subsets`` is honoured the
    way the real CLI honours it: when C(N,K) exceeds the cap, exact degrades
    to a TOO_LARGE block and every solver gap is null. Every call is recorded
    with copies of its inputs, which the lookahead test compares across runs.
    """

    # Quantized P·K² constant, as the real CLI reports it.
    OFFSET_INT = 3_644_735_687

    def __init__(
        self,
        fail_calls: set[int] | frozenset[int] = frozenset(),
        scripted_bits: list[list[int]] | None = None,
        gap_int: int = 0,
    ) -> None:
        self.fail_calls = set(fail_calls)
        self.scripted_bits = scripted_bits
        self.gap_int = gap_int
        self.calls: list[dict] = []
        self.binary = Path("stub-separatrix-cli")

    def solve(
        self,
        mu,
        sigma,
        k,
        *,
        risk_aversion=0.5,
        solvers=("bsb", "dsb", "sa", "pt", "exact"),
        seed=42,
        penalty=None,
        budget=None,
        max_exact_subsets=None,
    ) -> BridgeResponse:
        index = len(self.calls)
        self.calls.append(
            {
                "mu": np.array(mu, dtype=float, copy=True),
                "sigma": np.array(sigma, dtype=float, copy=True),
                "k": int(k),
                "seed": int(seed),
                "solvers": list(solvers),
            }
        )
        if index in self.fail_calls:
            raise BridgeError(f"stub failure on call {index}")

        if self.scripted_bits is not None:
            bits = list(self.scripted_bits[index % len(self.scripted_bits)])
        else:
            bits = top_k_bits(np.asarray(mu), int(k))
        n = len(bits)
        ones = sum(bits)
        weights = [bit / ones if ones else 0.0 for bit in bits]
        exact_objective = -1_000_000 - index
        subsets = math.comb(n, int(k))
        too_large = max_exact_subsets is not None and subsets > int(max_exact_subsets)

        results = [
            SolverResult(
                solver=solver,
                bits=list(bits),
                weights=list(weights),
                objective_int=exact_objective + self.gap_int,
                feasible_raw=True,
                repaired=False,
                gap_int=None if too_large else self.gap_int,
                gap_rel=None if too_large else (
                    float(self.gap_int) / max(1, abs(exact_objective + self.OFFSET_INT))
                ),
                runtime_ms=1.0,
                portfolio_objective_int=exact_objective + self.gap_int + self.OFFSET_INT,
            )
            for solver in solvers
            if solver != "exact"
        ]
        exact = None
        if "exact" in solvers:
            exact = ExactResult(
                bits=None if too_large else list(bits),
                objective_int=None if too_large else exact_objective,
                runtime_ms=None if too_large else 0.5,
                error="TOO_LARGE" if too_large else None,
                subsets=subsets if too_large else None,
                portfolio_objective_int=(
                    None if too_large else exact_objective + self.OFFSET_INT
                ),
            )
        return BridgeResponse(
            n=n,
            k=int(k),
            scale=1.0,
            exact=exact,
            results=results,
            objective_offset_int=self.OFFSET_INT,
        )
