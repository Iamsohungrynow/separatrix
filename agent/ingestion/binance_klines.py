from __future__ import annotations

import argparse
import asyncio
import csv
import io
import logging
import zipfile
from datetime import datetime, timezone

import httpx

logger = logging.getLogger("leash.ingestion.binance_klines")

# Binance public bulk market-data dumps — no key, no auth, generous limits.
# One zip per symbol per month, containing a single CSV of daily klines.
BULK_KLINES_URL = (
    "https://data.binance.vision/data/spot/monthly/klines/"
    "{symbol}/1d/{symbol}-1d-{year:04d}-{month:02d}.zip"
)

# Map ticker -> current Binance spot symbol for the widened portfolio
# universe: majors plus the top Solana-ecosystem tokens. All pairs verified
# against data.binance.vision. Missing months 404 and are skipped — but note
# that a 404 does not always mean "pre-listing": renamed symbols keep their
# older dumps under the previous name (see BINANCE_SYMBOL_HISTORY).
BINANCE_SYMBOLS: dict[str, str] = {
    # Majors / L1s
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
    "BNB": "BNBUSDT",
    "SOL": "SOLUSDT",
    "XRP": "XRPUSDT",
    "ADA": "ADAUSDT",
    "DOGE": "DOGEUSDT",
    "AVAX": "AVAXUSDT",
    "LINK": "LINKUSDT",
    "DOT": "DOTUSDT",
    "LTC": "LTCUSDT",
    "BCH": "BCHUSDT",
    "UNI": "UNIUSDT",
    "ATOM": "ATOMUSDT",
    "FIL": "FILUSDT",
    "NEAR": "NEARUSDT",
    "ALGO": "ALGOUSDT",
    "HBAR": "HBARUSDT",
    "ICP": "ICPUSDT",
    "ETC": "ETCUSDT",
    "XLM": "XLMUSDT",
    "TRX": "TRXUSDT",
    "TAO": "TAOUSDT",
    # L2s / newer L1s
    "APT": "APTUSDT",
    "ARB": "ARBUSDT",
    "OP": "OPUSDT",
    "SUI": "SUIUSDT",
    "SEI": "SEIUSDT",
    "INJ": "INJUSDT",
    "TIA": "TIAUSDT",
    # AI / DePIN
    "FET": "FETUSDT",
    "RENDER": "RENDERUSDT",  # RNDR was rebranded to RENDER on Binance 2024-07
    "RNDR": "RENDERUSDT",  # alias so the demo-default ticker backfills too
    "IO": "IOUSDT",
    # Solana ecosystem
    "PYTH": "PYTHUSDT",
    "JUP": "JUPUSDT",
    "JTO": "JTOUSDT",
    "RAY": "RAYUSDT",
    "BONK": "BONKUSDT",
    "WIF": "WIFUSDT",
}

# Renamed symbols keep their pre-rename history under the old symbol name:
# RENDERUSDT dumps only exist from 2024-07, while 2021-11..2024-07 lives under
# RNDRUSDT. A full backfill must fetch every name the listing ever had; the
# UNIQUE(asset, recorded_at, source) constraint dedupes any overlap month.
BINANCE_SYMBOL_HISTORY: dict[str, tuple[str, ...]] = {
    "RENDER": ("RENDERUSDT", "RNDRUSDT"),
    "RNDR": ("RENDERUSDT", "RNDRUSDT"),
}


def symbols_for(asset: str) -> tuple[str, ...]:
    """Every Binance symbol whose dumps hold history for this ticker."""
    if asset in BINANCE_SYMBOL_HISTORY:
        return BINANCE_SYMBOL_HISTORY[asset]
    symbol = BINANCE_SYMBOLS.get(asset)
    return (symbol,) if symbol else ()


REQUEST_TIMEOUT = 30.0

# Daily-kline open_time is epoch milliseconds in older dumps but epoch
# MICROseconds in newer ones (observed from ~2025 onward). Milliseconds for
# current dates are ~1.7e12 and microseconds ~1.7e15, so anything above this
# threshold must be microseconds.
_MICROSECONDS_THRESHOLD = 1e14


def parse_klines_csv(data: bytes) -> list[tuple[str, float]]:
    """Parse one daily-klines CSV into ``[(midnight_utc_iso, close), ...]``.

    Columns: open_time, open, high, low, close, volume, close_time,
    quote_volume, trades, taker_buy_base, taker_buy_quote, ignore.
    A header row (present in some newer dumps) is detected and skipped.
    """
    rows: list[tuple[str, float]] = []
    for record in csv.reader(io.StringIO(data.decode("utf-8"))):
        if not record:
            continue
        try:
            open_time = int(record[0])
        except ValueError:
            # Header row ("open_time,open,...") — skip it.
            continue
        if open_time > _MICROSECONDS_THRESHOLD:
            open_time //= 1000  # microseconds -> milliseconds
        bar_date = datetime.fromtimestamp(open_time / 1000.0, tz=timezone.utc).date()
        date_iso = f"{bar_date.isoformat()}T00:00:00Z"
        rows.append((date_iso, float(record[4])))
    return rows


async def fetch_month(symbol: str, year: int, month: int) -> list[tuple[str, float]]:
    """Download one month of daily klines for a Binance spot symbol.

    Returns ``[(date_iso, close), ...]`` where ``date_iso`` is the bar's UTC
    date at midnight (e.g. ``"2024-01-01T00:00:00Z"``). Raises
    ``httpx.HTTPStatusError`` on non-200 responses (404 = month not published,
    typically because the symbol was not listed yet).
    """
    url = BULK_KLINES_URL.format(symbol=symbol, year=year, month=month)
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.get(url)
        response.raise_for_status()

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        if not names:
            logger.warning("empty zip archive for %s %04d-%02d", symbol, year, month)
            return []
        data = archive.read(names[0])

    rows = parse_klines_csv(data)
    logger.debug("fetched %d daily bars for %s %04d-%02d", len(rows), symbol, year, month)
    return rows


def _parse_month(value: str) -> tuple[int, int]:
    try:
        year_str, month_str = value.split("-", 1)
        year, month = int(year_str), int(month_str)
    except ValueError as exc:
        raise ValueError(f"invalid month {value!r}, expected YYYY-MM") from exc
    if not 1 <= month <= 12:
        raise ValueError(f"invalid month {value!r}, expected YYYY-MM")
    return year, month


def month_range(start: str, end: str) -> list[tuple[int, int]]:
    """Inclusive list of (year, month) tuples from start to end ('YYYY-MM')."""
    start_year, start_month = _parse_month(start)
    end_year, end_month = _parse_month(end)
    if (start_year, start_month) > (end_year, end_month):
        raise ValueError(f"start month {start} is after end month {end}")

    months: list[tuple[int, int]] = []
    year, month = start_year, start_month
    while (year, month) <= (end_year, end_month):
        months.append((year, month))
        month += 1
        if month > 12:
            year, month = year + 1, 1
    return months


async def backfill(db, assets: list[str], start: str, end: str) -> int:
    """Backfill daily closes into price_history for the given tickers.

    Iterates every month from ``start`` to ``end`` (inclusive, 'YYYY-MM') per
    asset and records closes via ``db.record_prices(..., source="binance")``
    with ``recorded_at`` set to the bar's UTC date at midnight. Unknown tickers
    and missing months (HTTP 404) are logged and skipped, never fatal.
    Returns the total number of newly inserted rows.
    """
    months = month_range(start, end)
    total_inserted = 0

    for asset in assets:
        symbols = symbols_for(asset)
        if not symbols:
            logger.warning("no Binance symbol for ticker %s — skipping", asset)
            continue

        asset_inserted = 0
        for symbol in symbols:
            for year, month in months:
                try:
                    bars = await fetch_month(symbol, year, month)
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 404:
                        logger.info(
                            "no dump for %s %04d-%02d (404) — skipping", symbol, year, month
                        )
                    else:
                        logger.warning(
                            "fetch failed for %s %04d-%02d: %s — skipping",
                            symbol, year, month, exc,
                        )
                    continue
                except httpx.HTTPError as exc:
                    logger.warning(
                        "fetch failed for %s %04d-%02d: %s — skipping", symbol, year, month, exc
                    )
                    continue

                with db.transaction():
                    for date_iso, close in bars:
                        asset_inserted += db.record_prices(
                            {asset: close}, source="binance", recorded_at=date_iso
                        )

        logger.info("backfilled %s (%s): %d new rows", asset, "+".join(symbols), asset_inserted)
        total_inserted += asset_inserted

    return total_inserted


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m agent.ingestion.binance_klines",
        description="Backfill daily closes from Binance public bulk kline dumps into price_history",
    )
    parser.add_argument("--assets", required=True, help="Comma-separated tickers, e.g. SOL,PYTH")
    parser.add_argument("--start", required=True, help="First month to fetch, YYYY-MM")
    parser.add_argument("--end", required=True, help="Last month to fetch (inclusive), YYYY-MM")
    parser.add_argument("--db", default=None, help="SQLite path (default: SQLITE_PATH from .env)")
    parser.add_argument("--env-file", default=".env", help="Path to .env file")
    return parser


def main() -> None:
    from pathlib import Path

    from agent.config import Settings
    from agent.db.database import Database

    args = build_parser().parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    settings = Settings.from_env(args.env_file)
    db_path = Path(args.db) if args.db else settings.database_path
    assets = [part.strip().upper() for part in args.assets.split(",") if part.strip()]

    db = Database(db_path)
    try:
        db.initialize()
        inserted = asyncio.run(backfill(db, assets, start=args.start, end=args.end))
        logger.info("backfill complete: %d new price rows in %s", inserted, db_path)
    finally:
        db.close()


if __name__ == "__main__":
    main()
