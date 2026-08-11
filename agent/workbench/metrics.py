from __future__ import annotations

import math
from typing import Sequence

import numpy as np

# Crypto trades every calendar day; the contract annualizes on 365 days.
PERIODS_PER_YEAR = 365.0


def annualized_return(daily_returns: Sequence[float] | np.ndarray) -> float:
    """Geometric annualized return from daily simple returns."""
    r = np.asarray(daily_returns, dtype=float)
    if r.size == 0:
        return math.nan
    growth = float(np.prod(1.0 + r))
    if growth <= 0.0:
        return -1.0
    return growth ** (PERIODS_PER_YEAR / r.size) - 1.0


def annualized_volatility(daily_returns: Sequence[float] | np.ndarray) -> float:
    r = np.asarray(daily_returns, dtype=float)
    if r.size < 2:
        return math.nan
    return float(np.std(r, ddof=1) * math.sqrt(PERIODS_PER_YEAR))


def sharpe_ratio(daily_returns: Sequence[float] | np.ndarray) -> float:
    """Arithmetic Sharpe (risk-free = 0): mean/std(ddof=1)·√365."""
    r = np.asarray(daily_returns, dtype=float)
    if r.size < 2:
        return math.nan
    sd = float(np.std(r, ddof=1))
    if sd == 0.0:
        return math.nan
    return float(np.mean(r)) / sd * math.sqrt(PERIODS_PER_YEAR)


def sortino_ratio(daily_returns: Sequence[float] | np.ndarray) -> float:
    """mean / downside deviation · √365, target 0.

    Downside deviation is sqrt(mean(min(r,0)²)) over the full series. With no
    negative days the ratio is undefined and NaN is returned.
    """
    r = np.asarray(daily_returns, dtype=float)
    if r.size < 2:
        return math.nan
    downside = np.minimum(r, 0.0)
    dd = math.sqrt(float(np.mean(downside**2)))
    if dd == 0.0:
        return math.nan
    return float(np.mean(r)) / dd * math.sqrt(PERIODS_PER_YEAR)


def max_drawdown(values: Sequence[float] | np.ndarray) -> float:
    """Largest peak-to-trough loss of a value path, as a positive fraction."""
    v = np.asarray(values, dtype=float)
    if v.size == 0:
        return math.nan
    peaks = np.maximum.accumulate(v)
    with np.errstate(invalid="ignore", divide="ignore"):
        drawdowns = 1.0 - v / peaks
    return float(np.max(drawdowns))


def average_turnover(turnovers: Sequence[float]) -> float:
    """Mean one-way turnover Σ|Δw| per rebalance."""
    if not len(turnovers):
        return math.nan
    return float(np.mean(np.asarray(turnovers, dtype=float)))


def cost_drag(ann_return_zero_bps: float, ann_return_at_bps: float) -> float:
    """Annualized return given up to costs at a bps level."""
    return ann_return_zero_bps - ann_return_at_bps


def summarize(daily_returns: np.ndarray, values: np.ndarray) -> dict[str, float]:
    return {
        "annualized_return": annualized_return(daily_returns),
        "annualized_volatility": annualized_volatility(daily_returns),
        "sharpe": sharpe_ratio(daily_returns),
        "sortino": sortino_ratio(daily_returns),
        "max_drawdown": max_drawdown(values),
        "n_days": int(np.asarray(daily_returns).size),
    }
