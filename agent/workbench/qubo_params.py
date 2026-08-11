from __future__ import annotations

from bisect import bisect_right
from datetime import date

import numpy as np

from agent.workbench.data import PriceData

MU_WINDOW_DAYS = 90
SIGMA_WINDOW_DAYS = 180
SHRINKAGE_DELTA = 0.3

# Minimum usable observations before we trust the estimates. The contract
# does not pin these; they exist so a thin window skips the rebalance instead
# of producing garbage parameters (fail-closed, logged by the caller).
MIN_MU_OBSERVATIONS = 20
MIN_SIGMA_OBSERVATIONS = 40


class InsufficientDataError(ValueError):
    """Raised when a rebalance date lacks enough usable return history."""


def mu_sigma(
    data: PriceData,
    returns: np.ndarray,
    universe: list[str],
    day: date,
    mu_window: int = MU_WINDOW_DAYS,
    sigma_window: int = SIGMA_WINDOW_DAYS,
    delta: float = SHRINKAGE_DELTA,
    min_mu_obs: int = MIN_MU_OBSERVATIONS,
    min_sigma_obs: int = MIN_SIGMA_OBSERVATIONS,
) -> tuple[np.ndarray, np.ndarray]:
    """QUBO inputs at ``day`` from data strictly at-or-before it.

    - ``mu``: per-asset mean daily log-return over the trailing ``mu_window``
      calendar days (NaN days dropped per asset).
    - ``sigma``: sample covariance (ddof=1) over the trailing ``sigma_window``
      calendar days using rows where *every* universe asset has a return
      (listwise deletion keeps the matrix PSD-consistent), then diagonal
      shrinkage ``(1-delta)*S + delta*diag(S)``.
    """
    t_pos = bisect_right(data.dates, day) - 1
    if t_pos < 0:
        raise InsufficientDataError(f"no data at-or-before {day.isoformat()}")

    cols = []
    for asset in universe:
        j = data.asset_index.get(asset)
        if j is None:
            raise InsufficientDataError(f"unknown asset {asset!r}")
        cols.append(j)

    mu_rows = returns[max(0, t_pos - mu_window + 1) : t_pos + 1][:, cols]
    valid_counts = np.sum(~np.isnan(mu_rows), axis=0)
    if np.any(valid_counts < min_mu_obs):
        thin = universe[int(np.argmin(valid_counts))]
        raise InsufficientDataError(
            f"{thin}: only {int(valid_counts.min())} return observations in the "
            f"{mu_window}d mu window at {day.isoformat()} (need {min_mu_obs})"
        )
    with np.errstate(invalid="ignore"):
        mu = np.nanmean(mu_rows, axis=0)

    sigma_rows = returns[max(0, t_pos - sigma_window + 1) : t_pos + 1][:, cols]
    complete = sigma_rows[~np.isnan(sigma_rows).any(axis=1)]
    if complete.shape[0] < max(min_sigma_obs, 2):
        raise InsufficientDataError(
            f"only {complete.shape[0]} complete rows in the {sigma_window}d "
            f"covariance window at {day.isoformat()} (need {min_sigma_obs})"
        )
    cov = np.atleast_2d(np.cov(complete, rowvar=False, ddof=1))
    shrunk = (1.0 - delta) * cov + delta * np.diag(np.diag(cov))
    shrunk = 0.5 * (shrunk + shrunk.T)

    if not (np.all(np.isfinite(mu)) and np.all(np.isfinite(shrunk))):
        raise InsufficientDataError(f"non-finite mu/sigma at {day.isoformat()}")
    return mu, shrunk
