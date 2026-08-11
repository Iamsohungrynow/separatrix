from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np

from agent.workbench.baselines import Selector
from agent.workbench.bridge import BridgeError, BridgeResponse, SeparatrixCli
from agent.workbench.data import PriceData, log_returns
from agent.workbench.qubo_params import (
    MIN_MU_OBSERVATIONS,
    MIN_SIGMA_OBSERVATIONS,
    MU_WINDOW_DAYS,
    SHRINKAGE_DELTA,
    SIGMA_WINDOW_DAYS,
    InsufficientDataError,
    mu_sigma,
)
from agent.workbench.universe import MAX_STALENESS_DAYS, MIN_HISTORY_CLOSES, eligible

logger = logging.getLogger("leash.workbench.walkforward")


@dataclass(slots=True)
class WalkForwardConfig:
    start: date
    end: date
    k: int = 8
    risk_aversion: float = 0.5
    solvers: tuple[str, ...] = ("bsb", "dsb", "sa", "pt", "exact")
    bps_levels: tuple[float, ...] = (0.0, 10.0, 30.0)
    seed: int = 42
    warmup_days: int = 252
    rebalance_interval_days: int = 7
    mu_window_days: int = MU_WINDOW_DAYS
    sigma_window_days: int = SIGMA_WINDOW_DAYS
    shrinkage_delta: float = SHRINKAGE_DELTA
    min_history_days: int = MIN_HISTORY_CLOSES
    max_staleness_days: int = MAX_STALENESS_DAYS
    min_universe_margin: int = 5  # need >= k + margin eligible assets
    min_mu_obs: int = MIN_MU_OBSERVATIONS
    min_sigma_obs: int = MIN_SIGMA_OBSERVATIONS
    budget: dict[str, int] | None = None
    max_exact_subsets: int | None = None


@dataclass(slots=True)
class RebalanceContext:
    """Everything a selector may look at — all computed from data <= day."""

    data: PriceData
    returns: np.ndarray
    day: date
    day_index: int
    universe: list[str]
    mu: np.ndarray
    sigma: np.ndarray
    config: WalkForwardConfig


@dataclass(slots=True)
class SkippedRebalance:
    day: date
    reason: str
    scope: str  # "all" (nobody trades) or "separatrix" (baselines still trade)


@dataclass(slots=True)
class RebalanceRecord:
    day: date
    universe: list[str]
    bridge_error: str | None = None
    selection: dict[str, list[str]] = field(default_factory=dict)
    objective_int: dict[str, int] = field(default_factory=dict)
    # objective_int free of the cardinality-penalty constant; None when the
    # solver CLI did not report it.
    portfolio_objective_int: dict[str, int | None] = field(default_factory=dict)
    gap_int: dict[str, int | None] = field(default_factory=dict)
    gap_rel: dict[str, float | None] = field(default_factory=dict)
    gap_norm: dict[str, float | None] = field(default_factory=dict)
    feasible_raw: dict[str, bool] = field(default_factory=dict)
    repaired: dict[str, bool] = field(default_factory=dict)
    runtime_ms: dict[str, float] = field(default_factory=dict)
    objective_offset_int: int | None = None
    exact_available: bool = False
    exact_error: str | None = None
    exact_too_large: bool = False
    exact_subsets: int | None = None
    exact_runtime_ms: float | None = None


@dataclass(slots=True)
class SimResult:
    dates: list[date]
    values: np.ndarray        # portfolio value path, starts at 1.0 pre-cost
    daily_returns: np.ndarray  # simple returns of the value path
    turnovers: list[float]     # one-way turnover Σ|Δw| per executed rebalance
    costs: list[float]         # fraction of value charged per rebalance


@dataclass(slots=True)
class StrategyResult:
    name: str
    schedule: list[tuple[date, np.ndarray]]  # weight vector over data.assets
    sims: dict[float, SimResult]             # bps level -> simulation
    turnovers: list[float]                   # bps-independent


@dataclass(slots=True)
class WalkForwardResult:
    config: WalkForwardConfig
    tickers: list[str]
    rebalance_days: list[date]
    records: list[RebalanceRecord]
    skips: list[SkippedRebalance]
    strategies: dict[str, StrategyResult]


def rebalance_days(config: WalkForwardConfig, data: PriceData) -> list[date]:
    """Every ``rebalance_interval_days`` from start+warmup to end (data-capped)."""
    first = config.start + timedelta(days=config.warmup_days)
    last = min(config.end, data.dates[-1])
    days: list[date] = []
    day = first
    while day <= last:
        days.append(day)
        day += timedelta(days=config.rebalance_interval_days)
    return days


def weights_vector(data: PriceData, weights: dict[str, float]) -> np.ndarray:
    vec = np.zeros(len(data.assets), dtype=float)
    for asset, weight in weights.items():
        vec[data.asset_index[asset]] = float(weight)
    return vec


def simulate_schedule(
    data: PriceData,
    schedule: list[tuple[date, np.ndarray]],
    end: date,
    bps: float,
) -> SimResult:
    """Buy-and-hold between rebalances; one-way-turnover costs at each one.

    At a rebalance the portfolio is marked to market, the one-way turnover
    Σ|w_new − w_drift| against the drifted previous weights is charged at
    ``bps`` of portfolio value (the first rebalance pays the full entry:
    prior weights are zero, so turnover is Σw_new = 1), and shares are reset.
    Between rebalances shares are fixed; a missing close freezes the asset at
    its last known price (the bounded forward-fill already covers <=3 days).

    ``values[0]`` is the capital committed on the first rebalance date, i.e.
    1.0 **before** the entry charge: booking the entry cost into ``values[0]``
    would divide it straight back out of ``values[1:]/values[:-1] − 1`` and
    hide it from every return-based metric.
    """
    if not schedule:
        raise ValueError("empty schedule")
    n = len(data.assets)
    fee = float(bps) / 10_000.0
    # Sorted by date so the pointer below only ever moves forward; several
    # entries may share a date, and each is a trade in its own right.
    events = sorted(
        ((data.date_index[day], vec) for day, vec in schedule),
        key=lambda event: event[0],
    )
    start_idx = events[0][0]
    end_idx = min(data.date_index.get(end, len(data.dates) - 1), len(data.dates) - 1)
    if end_idx < start_idx:
        raise ValueError(f"simulation end {end} precedes first rebalance")

    value = 1.0
    shares = np.zeros(n)
    last_price = np.full(n, np.nan)
    values: list[float] = []
    out_dates: list[date] = []
    turnovers: list[float] = []
    costs: list[float] = []
    next_event = 0

    for idx in range(start_idx, end_idx + 1):
        row = data.closes[idx]
        fresh = ~np.isnan(row)
        last_price[fresh] = row[fresh]

        if idx > start_idx:
            value = float(np.sum(np.where(shares != 0.0, shares * last_price, 0.0)))
        opening_value = value

        # `<=`, not `==`: two schedule entries sharing a date would otherwise
        # stall the pointer forever and freeze the strategy on its first
        # selection. Coincident entries are applied in schedule order, each
        # charging the turnover it actually implies.
        while next_event < len(events) and events[next_event][0] <= idx:
            target = events[next_event][1]
            next_event += 1

            drift = np.zeros(n)
            if value > 0.0 and np.any(shares != 0.0):
                drift = np.where(shares != 0.0, shares * last_price, 0.0) / value
            turnover = float(np.abs(target - drift).sum())
            cost_fraction = turnover * fee
            value *= 1.0 - cost_fraction

            held = target > 0.0
            if np.any(held & (~np.isfinite(last_price) | (last_price <= 0.0))):
                bad = [data.assets[j] for j in np.nonzero(held)[0]
                       if not np.isfinite(last_price[j]) or last_price[j] <= 0.0]
                raise ValueError(
                    f"no usable price for {bad} at {data.dates[idx].isoformat()}"
                )
            shares = np.where(held, target * value / last_price, 0.0)
            turnovers.append(turnover)
            costs.append(cost_fraction)

        out_dates.append(data.dates[idx])
        values.append(opening_value if idx == start_idx else value)

    values_arr = np.asarray(values, dtype=float)
    daily_returns = values_arr[1:] / values_arr[:-1] - 1.0
    return SimResult(
        dates=out_dates,
        values=values_arr,
        daily_returns=daily_returns,
        turnovers=turnovers,
        costs=costs,
    )


def run_walkforward(
    data: PriceData,
    config: WalkForwardConfig,
    bridge: SeparatrixCli,
    baselines: dict[str, Selector] | None = None,
) -> WalkForwardResult:
    """The weekly loop from docs/workbench.md.

    Deterministic given (data, config, seed): the same seed goes to every
    bridge call and every Python-side decision is tie-broken stably.
    """
    baselines = baselines or {}
    returns = log_returns(data)
    days = rebalance_days(config, data)

    schedules: dict[str, list[tuple[date, np.ndarray]]] = {name: [] for name in baselines}
    records: list[RebalanceRecord] = []
    skips: list[SkippedRebalance] = []

    for day in days:
        universe = eligible(
            data,
            day,
            min_history=config.min_history_days,
            max_staleness_days=config.max_staleness_days,
        )
        required = config.k + config.min_universe_margin
        if len(universe) < required:
            reason = f"THIN_UNIVERSE:eligible={len(universe)},required={required}"
            logger.warning("%s skipped: %s", day.isoformat(), reason)
            skips.append(SkippedRebalance(day=day, reason=reason, scope="all"))
            continue

        try:
            mu, sigma = mu_sigma(
                data,
                returns,
                universe,
                day,
                mu_window=config.mu_window_days,
                sigma_window=config.sigma_window_days,
                delta=config.shrinkage_delta,
                min_mu_obs=config.min_mu_obs,
                min_sigma_obs=config.min_sigma_obs,
            )
        except InsufficientDataError as exc:
            reason = f"INSUFFICIENT_DATA:{exc}"
            logger.warning("%s skipped: %s", day.isoformat(), reason)
            skips.append(SkippedRebalance(day=day, reason=reason, scope="all"))
            continue

        ctx = RebalanceContext(
            data=data,
            returns=returns,
            day=day,
            day_index=data.date_index[day],
            universe=universe,
            mu=mu,
            sigma=sigma,
            config=config,
        )

        for name, selector in baselines.items():
            weights = selector(ctx)
            if weights:
                schedules[name].append((day, weights_vector(data, weights)))

        try:
            response = bridge.solve(
                mu,
                sigma,
                config.k,
                risk_aversion=config.risk_aversion,
                solvers=list(config.solvers),
                seed=config.seed,
                budget=config.budget,
                max_exact_subsets=config.max_exact_subsets,
            )
        except BridgeError as exc:
            reason = f"BRIDGE_ERROR:{exc}"
            logger.warning("%s separatrix skipped: %s", day.isoformat(), reason)
            skips.append(SkippedRebalance(day=day, reason=reason, scope="separatrix"))
            records.append(
                RebalanceRecord(day=day, universe=universe, bridge_error=str(exc))
            )
            continue

        record = _record_response(day, universe, response, config, schedules, data)
        records.append(record)

    strategies: dict[str, StrategyResult] = {}
    sim_end = min(config.end, data.dates[-1])
    for name, schedule in schedules.items():
        if not schedule:
            strategies[name] = StrategyResult(name=name, schedule=[], sims={}, turnovers=[])
            continue
        sims = {
            bps: simulate_schedule(data, schedule, sim_end, bps)
            for bps in config.bps_levels
        }
        reference = sims[config.bps_levels[0]] if config.bps_levels else None
        strategies[name] = StrategyResult(
            name=name,
            schedule=schedule,
            sims=sims,
            turnovers=list(reference.turnovers) if reference else [],
        )

    return WalkForwardResult(
        config=config,
        tickers=list(data.assets),
        rebalance_days=days,
        records=records,
        skips=skips,
        strategies=strategies,
    )


def _record_response(
    day: date,
    universe: list[str],
    response: BridgeResponse,
    config: WalkForwardConfig,
    schedules: dict[str, list[tuple[date, np.ndarray]]],
    data: PriceData,
) -> RebalanceRecord:
    record = RebalanceRecord(
        day=day, universe=universe, objective_offset_int=response.objective_offset_int
    )

    entries = list(response.results)
    solver_names = {entry.solver for entry in entries}
    if response.exact is not None:
        if response.exact.error is not None:
            # Documented degradation: keep every solver selection, report null
            # gaps, and record why the ground truth is missing.
            record.exact_error = response.exact.error
            record.exact_too_large = response.exact.error == "TOO_LARGE"
            record.exact_subsets = response.exact.subsets
            logger.warning(
                "%s exact ground truth unavailable (%s%s) — solver gaps are null",
                day.isoformat(),
                response.exact.error,
                f", subsets={response.exact.subsets}"
                if response.exact.subsets is not None else "",
            )
        else:
            record.exact_available = True
            record.exact_runtime_ms = response.exact.runtime_ms
            # Surface the exact portfolio as its own strategy when requested
            # and the CLI did not already include it in `results`.
            if "exact" in config.solvers and "exact" not in solver_names:
                bits = response.exact.bits or []
                if sum(bits) == config.k:
                    _append_selection(
                        record, "exact", bits, universe, config, schedules, data, day
                    )
                    record.objective_int["exact"] = response.exact.objective_int or 0
                    record.portfolio_objective_int["exact"] = (
                        response.exact.portfolio_objective_int
                    )
                    record.gap_int["exact"] = 0
                    record.gap_rel["exact"] = 0.0
                    record.gap_norm["exact"] = 0.0
                    record.feasible_raw["exact"] = True
                    record.repaired["exact"] = False
                    record.runtime_ms["exact"] = response.exact.runtime_ms or 0.0

    for entry in entries:
        if sum(entry.bits) != config.k:
            logger.warning(
                "%s %s returned %d selected bits (want k=%d) — solver skipped",
                day.isoformat(), entry.solver, sum(entry.bits), config.k,
            )
            continue
        _append_selection(
            record, entry.solver, entry.bits, universe, config, schedules, data, day
        )
        record.objective_int[entry.solver] = entry.objective_int
        record.portfolio_objective_int[entry.solver] = entry.portfolio_objective_int
        record.gap_int[entry.solver] = entry.gap_int
        record.gap_rel[entry.solver] = entry.gap_rel
        record.gap_norm[entry.solver] = entry.gap_norm
        record.feasible_raw[entry.solver] = entry.feasible_raw
        record.repaired[entry.solver] = entry.repaired
        record.runtime_ms[entry.solver] = entry.runtime_ms

    return record


def _append_selection(
    record: RebalanceRecord,
    solver: str,
    bits: list[int],
    universe: list[str],
    config: WalkForwardConfig,
    schedules: dict[str, list[tuple[date, np.ndarray]]],
    data: PriceData,
    day: date,
) -> None:
    selected = [universe[i] for i, bit in enumerate(bits) if bit]
    record.selection[solver] = selected
    weights = {asset: 1.0 / config.k for asset in selected}
    name = f"separatrix-{solver}"
    schedules.setdefault(name, []).append((day, weights_vector(data, weights)))
