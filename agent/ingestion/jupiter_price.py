from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger("leash.ingestion.jupiter")

# Jupiter Price API v2 — free, no key required.
JUPITER_PRICE_URL = "https://api.jup.ag/price/v2"

# Map human-readable ticker → Solana token mint address.
# These are the canonical SPL mints on mainnet (Jupiter resolves them for
# price quotes even when the caller is only paper-trading on devnet).
TOKEN_MINTS: dict[str, str] = {
    "SOL": "So11111111111111111111111111111111111111112",
    "RNDR": "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
    "IO": "BZLbGTNCSFfoth2GYDtwr7e4imWzpR5jqcUuGEwr646K",
    "PYTH": "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
}

REQUEST_TIMEOUT = 10.0


async def fetch_prices(
    assets: list[str] | None = None,
    extra_mints: dict[str, str] | None = None,
) -> dict[str, float]:
    """Fetch USD prices from Jupiter for the requested assets.

    Parameters
    ----------
    assets:
        Ticker symbols to look up (e.g. ``["SOL", "RNDR"]``).  When *None*,
        all tickers in ``TOKEN_MINTS`` are queried.
    extra_mints:
        Additional ``{ticker: mint_address}`` pairs to merge into the lookup
        table for this call.  Useful for tokens not in the built-in map.

    Returns
    -------
    dict[str, float]
        ``{ticker: price_usd}`` for every asset that Jupiter returned a
        price for.  Assets with missing or null prices are silently skipped.
    """
    mints = dict(TOKEN_MINTS)
    if extra_mints:
        mints.update(extra_mints)

    if assets is None:
        assets = list(mints.keys())

    # Build mint→ticker reverse map and the comma-separated ids param.
    mint_to_ticker: dict[str, str] = {}
    ids_parts: list[str] = []
    for ticker in assets:
        mint = mints.get(ticker)
        if mint is None:
            logger.warning("no mint address for ticker %s — skipping", ticker)
            continue
        mint_to_ticker[mint] = ticker
        ids_parts.append(mint)

    if not ids_parts:
        return {}

    params = {"ids": ",".join(ids_parts)}

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.get(JUPITER_PRICE_URL, params=params)
        response.raise_for_status()
        body: dict[str, Any] = response.json()

    data: dict[str, Any] = body.get("data", {})
    prices: dict[str, float] = {}

    for mint_addr, ticker in mint_to_ticker.items():
        entry = data.get(mint_addr)
        if entry is None:
            logger.debug("jupiter returned no entry for %s (%s)", ticker, mint_addr)
            continue
        raw_price = entry.get("price")
        if raw_price is None:
            logger.debug("jupiter returned null price for %s", ticker)
            continue
        try:
            prices[ticker] = float(raw_price)
        except (TypeError, ValueError):
            logger.warning("invalid price value for %s: %r", ticker, raw_price)

    logger.info("fetched %d/%d prices from Jupiter", len(prices), len(ids_parts))
    return prices
