from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np

# Gaps in a close series are forward-filled at most this many days past the
# last real close; anything staler stays NaN. Kept equal to the eligibility
# staleness bound in universe.py so an eligible asset always has a usable
# (possibly filled) close on its rebalance date.
MAX_FFILL_DAYS = 3


@dataclass(slots=True)
class PriceData:
    """Daily close panel on a contiguous calendar.

    - ``dates``: every calendar day from the first to the last observed close.
    - ``closes``: (T, N) float array, forward-filled up to ``MAX_FFILL_DAYS``
      past the last real close, NaN elsewhere.
    - ``observed``: (T, N) bool array, True only where a real close was
      recorded (never True on filled days). Point-in-time eligibility counts
      use this, not ``closes``.
    """

    dates: list[date]
    assets: list[str]
    closes: np.ndarray
    observed: np.ndarray
    date_index: dict[date, int] = field(default_factory=dict)
    asset_index: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.date_index:
            self.date_index = {day: i for i, day in enumerate(self.dates)}
        if not self.asset_index:
            self.asset_index = {asset: j for j, asset in enumerate(self.assets)}


def build_price_data(series: dict[str, dict[date, float]]) -> PriceData:
    """Build an aligned, forward-filled close panel from per-asset series.

    ``series`` maps ticker -> {date: close}. Assets keep the given key order
    (Python dicts preserve insertion order). Assets with no observations stay
    as all-NaN columns so weight vectors align with the configured universe.
    """
    assets = list(series.keys())
    all_dates = [day for per_asset in series.values() for day in per_asset]
    if not all_dates:
        raise ValueError("no price observations for any requested asset")

    first, last = min(all_dates), max(all_dates)
    n_days = (last - first).days + 1
    dates = [first + timedelta(days=i) for i in range(n_days)]
    date_index = {day: i for i, day in enumerate(dates)}

    closes = np.full((n_days, len(assets)), np.nan, dtype=float)
    observed = np.zeros((n_days, len(assets)), dtype=bool)

    for j, asset in enumerate(assets):
        for day, price in series[asset].items():
            i = date_index[day]
            closes[i, j] = float(price)
            observed[i, j] = True

    _forward_fill_inplace(closes, observed, MAX_FFILL_DAYS)

    return PriceData(
        dates=dates,
        assets=assets,
        closes=closes,
        observed=observed,
        date_index=date_index,
    )


def _forward_fill_inplace(closes: np.ndarray, observed: np.ndarray, limit: int) -> None:
    """Fill NaN closes from the last real close, at most ``limit`` days out."""
    n_days, n_assets = closes.shape
    for j in range(n_assets):
        last_obs: int | None = None
        for i in range(n_days):
            if observed[i, j]:
                last_obs = i
            elif last_obs is not None and (i - last_obs) <= limit:
                closes[i, j] = closes[last_obs, j]
            # else: stays NaN (never observed yet, or too stale)


def load_price_data(db, assets: list[str], source: str = "binance") -> PriceData:
    """Load a close panel from ``Database.price_matrix`` for one source.

    ``recorded_at`` values are ISO timestamps ("YYYY-MM-DDTHH:MM:SSZ"); the
    UTC date part identifies the daily bar. If several rows share a date the
    latest ``recorded_at`` wins (rows arrive oldest-first).
    """
    matrix = db.price_matrix(list(assets), source=source)
    series: dict[str, dict[date, float]] = {}
    for asset in assets:
        per_day: dict[date, float] = {}
        for recorded_at, price in matrix.get(asset, []):
            per_day[date.fromisoformat(recorded_at[:10])] = float(price)
        series[asset] = per_day
    return build_price_data(series)


def log_returns(data: PriceData) -> np.ndarray:
    """(T, N) daily log-returns from the (forward-filled) close panel.

    Row 0 is NaN; any day where either close is NaN yields NaN. Filled days
    produce zero returns followed by a catch-up jump — a consequence of the
    bounded forward-fill, accepted by the contract.
    """
    closes = data.closes
    returns = np.full_like(closes, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        returns[1:] = np.log(closes[1:] / closes[:-1])
    returns[~np.isfinite(returns)] = np.nan
    return returns
