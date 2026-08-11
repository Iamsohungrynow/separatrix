from __future__ import annotations

from datetime import date, timedelta
from typing import Iterable

from agent.workbench.data import PriceData

MIN_HISTORY_CLOSES = 252
MAX_STALENESS_DAYS = 3


def eligible(
    data: PriceData,
    day: date,
    assets: Iterable[str] | None = None,
    min_history: int = MIN_HISTORY_CLOSES,
    max_staleness_days: int = MAX_STALENESS_DAYS,
) -> list[str]:
    """Point-in-time universe at ``day``, using only data at-or-before it.

    An asset qualifies when it has at least ``min_history`` *real* closes
    recorded at-or-before ``day`` and its most recent close is within
    ``max_staleness_days`` of ``day`` (still trading). Order follows
    ``data.assets`` for determinism.
    """
    if day < data.dates[0]:
        return []

    wanted = list(assets) if assets is not None else list(data.assets)
    # Rows at-or-before `day` (clamped to the calendar end: a day beyond the
    # calendar just means "everything observed so far").
    t_pos = min((day - data.dates[0]).days, len(data.dates) - 1)
    freshness_floor = day - timedelta(days=max_staleness_days)

    result: list[str] = []
    for asset in wanted:
        j = data.asset_index.get(asset)
        if j is None:
            continue
        column = data.observed[: t_pos + 1, j]
        count = int(column.sum())
        if count < min_history:
            continue
        last_obs_pos = int(column.nonzero()[0][-1])
        if data.dates[last_obs_pos] < freshness_floor:
            continue
        result.append(asset)
    return result
