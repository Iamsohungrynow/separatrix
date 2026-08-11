from __future__ import annotations

from typing import TYPE_CHECKING, Callable

import numpy as np

if TYPE_CHECKING:  # pragma: no cover - typing only
    from agent.workbench.walkforward import RebalanceContext

# A baseline selector maps a rebalance context to {ticker: weight}. Returning
# an empty dict means "no trade this week" (previous holdings persist).
Selector = Callable[["RebalanceContext"], dict[str, float]]


# ---------------------------------------------------------------------------
# Simple baselines
# ---------------------------------------------------------------------------

def one_over_n(ctx: "RebalanceContext") -> dict[str, float]:
    """Equal weight over the whole eligible universe, weekly."""
    if not ctx.universe:
        return {}
    weight = 1.0 / len(ctx.universe)
    return {asset: weight for asset in ctx.universe}


def buy_and_hold(asset: str) -> Selector:
    """Hold one asset. Re-selecting the sole holding weekly is turnover-free,
    so this is exactly buy-and-hold under the shared cost model."""

    def _select(ctx: "RebalanceContext") -> dict[str, float]:
        if asset not in ctx.universe:
            return {}
        return {asset: 1.0}

    return _select


def momentum_select(mu: np.ndarray, k: int) -> list[int]:
    """Indices of the top-k assets by trailing mean daily log-return.

    Stable tie-break: earlier universe position wins.
    """
    order = np.argsort(-np.asarray(mu, dtype=float), kind="stable")
    return sorted(int(i) for i in order[:k])


def momentum_k(ctx: "RebalanceContext") -> dict[str, float]:
    """Top K by trailing 90-day return (ranked by the same trailing-90d mean
    daily log-return used for mu), equal weight."""
    k = min(ctx.config.k, len(ctx.universe))
    if k == 0:
        return {}
    picked = momentum_select(ctx.mu, k)
    return {ctx.universe[i]: 1.0 / k for i in picked}


def minvar_greedy_select(sigma: np.ndarray, k: int) -> list[int]:
    """Greedy add minimizing the equal-weight variance (1/s²)·xᵀΣ'x.

    At each step every candidate set has the same size, so the argmin of the
    quadratic form decides; ties break toward the lower index.
    """
    sigma = np.asarray(sigma, dtype=float)
    n = sigma.shape[0]
    k = min(k, n)
    chosen: list[int] = []
    for _ in range(k):
        best_j, best_quad = -1, np.inf
        for j in range(n):
            if j in chosen:
                continue
            members = chosen + [j]
            sub = sigma[np.ix_(members, members)]
            quad = float(sub.sum())
            if quad < best_quad - 1e-15:
                best_j, best_quad = j, quad
        chosen.append(best_j)
    return sorted(chosen)


def minvar_greedy_k(ctx: "RebalanceContext") -> dict[str, float]:
    k = min(ctx.config.k, len(ctx.universe))
    if k == 0:
        return {}
    picked = minvar_greedy_select(ctx.sigma, k)
    return {ctx.universe[i]: 1.0 / k for i in picked}


# ---------------------------------------------------------------------------
# HRP (hierarchical risk parity), numpy only
# ---------------------------------------------------------------------------

def correlation_from_covariance(sigma: np.ndarray) -> np.ndarray:
    sigma = np.asarray(sigma, dtype=float)
    std = np.sqrt(np.diag(sigma))
    with np.errstate(invalid="ignore", divide="ignore"):
        corr = sigma / np.outer(std, std)
    corr[~np.isfinite(corr)] = 0.0
    np.fill_diagonal(corr, 1.0)
    return np.clip(corr, -1.0, 1.0)


def hrp_order(sigma: np.ndarray) -> list[int]:
    """Leaf order from single-linkage clustering on correlation distance.

    Distance d_ij = sqrt(0.5·(1 − ρ_ij)). Naive O(n³) agglomeration is fine
    for a few dozen assets; concatenating merged clusters in merge order gives
    the quasi-diagonal seriation HRP needs. Ties break toward the pair with
    the smallest indices (deterministic).
    """
    corr = correlation_from_covariance(sigma)
    dist = np.sqrt(np.clip(0.5 * (1.0 - corr), 0.0, None))
    n = dist.shape[0]
    clusters: list[list[int]] = [[i] for i in range(n)]

    while len(clusters) > 1:
        best = (0, 1)
        best_dist = np.inf
        for a in range(len(clusters)):
            for b in range(a + 1, len(clusters)):
                # single linkage: min pairwise distance across the clusters
                d = min(dist[i, j] for i in clusters[a] for j in clusters[b])
                if d < best_dist - 1e-15:
                    best_dist = d
                    best = (a, b)
        a, b = best
        clusters[a] = clusters[a] + clusters[b]
        del clusters[b]
    return clusters[0]


def _cluster_variance(sigma: np.ndarray, members: list[int]) -> float:
    """Variance of the inverse-variance-weighted portfolio of ``members``."""
    sub = sigma[np.ix_(members, members)]
    inv_var = 1.0 / np.diag(sub)
    weights = inv_var / inv_var.sum()
    return float(weights @ sub @ weights)


def hrp_weights(sigma: np.ndarray, order: list[int] | None = None) -> np.ndarray:
    """Recursive-bisection HRP weights (López de Prado), summing to 1."""
    sigma = np.asarray(sigma, dtype=float)
    n = sigma.shape[0]
    if order is None:
        order = hrp_order(sigma)
    weights = np.ones(n, dtype=float)
    stack: list[list[int]] = [list(order)]
    while stack:
        members = stack.pop()
        if len(members) < 2:
            continue
        split = len(members) // 2
        left, right = members[:split], members[split:]
        var_left = _cluster_variance(sigma, left)
        var_right = _cluster_variance(sigma, right)
        alpha = 1.0 - var_left / (var_left + var_right)
        weights[left] *= alpha
        weights[right] *= 1.0 - alpha
        stack.append(left)
        stack.append(right)
    return weights / weights.sum()


def hrp(ctx: "RebalanceContext") -> dict[str, float]:
    """HRP over the whole eligible universe, on the same shrunk Σ' as the QUBO.

    Shrinkage scales every off-diagonal by (1−δ), which rescales all
    correlations uniformly — the clustering order is unchanged versus the raw
    covariance; only the bisection allocations shift slightly.
    """
    if not ctx.universe:
        return {}
    if len(ctx.universe) == 1:
        return {ctx.universe[0]: 1.0}
    weights = hrp_weights(ctx.sigma)
    return {asset: float(weights[i]) for i, asset in enumerate(ctx.universe)}


def default_baselines(k: int, tickers: list[str]) -> dict[str, Selector]:
    """The contract's baseline set, keyed by strategy name."""
    baselines: dict[str, Selector] = {"one-over-n": one_over_n}
    if "BTC" in tickers:
        baselines["bh-btc"] = buy_and_hold("BTC")
    if "SOL" in tickers:
        baselines["bh-sol"] = buy_and_hold("SOL")
    baselines[f"momentum-{k}"] = momentum_k
    baselines[f"minvar-greedy-{k}"] = minvar_greedy_k
    baselines["hrp"] = hrp
    return baselines
