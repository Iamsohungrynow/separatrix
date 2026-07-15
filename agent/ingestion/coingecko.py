from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger("leash.ingestion.coingecko")

# CoinGecko free API — no key required, ~30 req/min rate limit.
COINGECKO_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price"

# Map human-readable ticker → CoinGecko asset id.
COINGECKO_IDS: dict[str, str] = {
    "SOL": "solana",
    "RNDR": "render-token",
    "IO": "io-net",
    "PYTH": "pyth-network",
}

REQUEST_TIMEOUT = 10.0


async def fetch_fallback_prices(
    assets: list[str] | None = None,
    extra_ids: dict[str, str] | None = None,
) -> dict[str, float]:
    """Fetch USD prices from CoinGecko as a fallback source.

    Parameters
    ----------
    assets:
        Ticker symbols to look up (e.g. ``["SOL", "RNDR"]``).  When *None*,
        all tickers in ``COINGECKO_IDS`` are queried.
    extra_ids:
        Additional ``{ticker: coingecko_id}`` pairs to merge into the lookup
        table for this call.

    Returns
    -------
    dict[str, float]
        ``{ticker: price_usd}`` for every asset that CoinGecko returned a
        price for.  Assets with missing data are silently skipped.
    """
    ids = dict(COINGECKO_IDS)
    if extra_ids:
        ids.update(extra_ids)

    if assets is None:
        assets = list(ids.keys())

    # Build coingecko_id→ticker reverse map.
    cg_to_ticker: dict[str, str] = {}
    cg_ids: list[str] = []
    for ticker in assets:
        cg_id = ids.get(ticker)
        if cg_id is None:
            logger.warning("no CoinGecko id for ticker %s — skipping", ticker)
            continue
        cg_to_ticker[cg_id] = ticker
        cg_ids.append(cg_id)

    if not cg_ids:
        return {}

    params = {
        "ids": ",".join(cg_ids),
        "vs_currencies": "usd",
    }

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.get(COINGECKO_PRICE_URL, params=params)
        response.raise_for_status()
        body: dict[str, Any] = response.json()

    prices: dict[str, float] = {}

    for cg_id, ticker in cg_to_ticker.items():
        entry = body.get(cg_id)
        if entry is None:
            logger.debug("coingecko returned no entry for %s (%s)", ticker, cg_id)
            continue
        raw_price = entry.get("usd")
        if raw_price is None:
            logger.debug("coingecko returned null usd price for %s", ticker)
            continue
        try:
            prices[ticker] = float(raw_price)
        except (TypeError, ValueError):
            logger.warning("invalid price value for %s: %r", ticker, raw_price)

    logger.info("fetched %d/%d fallback prices from CoinGecko", len(prices), len(cg_ids))
    return prices
