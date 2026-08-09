from __future__ import annotations

import io
import shutil
import unittest
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from agent.db.database import Database
from agent.ingestion.binance_klines import (
    BINANCE_SYMBOLS,
    backfill,
    symbols_for,
    build_parser,
    fetch_month,
    month_range,
    parse_klines_csv,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

# Two daily bars in MILLIseconds (2024-01-01, 2024-01-02), real dump shape:
# open_time, open, high, low, close, volume, close_time, quote_volume,
# trades, taker_buy_base, taker_buy_quote, ignore.
SAMPLE_CSV_MS = (
    "1704067200000,101.72,109.93,101.44,109.91,4403310.37,1704153599999,464763783.10,563530,2246699.81,237204677.83,0\n"
    "1704153600000,109.93,116.95,106.02,106.73,7831366.05,1704239999999,872701826.11,1029366,4008477.70,446827198.45,0\n"
)

# Same two days but open_time/close_time in MICROseconds (newer dumps).
SAMPLE_CSV_US = (
    "1704067200000000,101.72,109.93,101.44,109.91,4403310.37,1704153599999999,464763783.10,563530,2246699.81,237204677.83,0\n"
    "1704153600000000,109.93,116.95,106.02,106.73,7831366.05,1704239999999999,872701826.11,1029366,4008477.70,446827198.45,0\n"
)

SAMPLE_CSV_WITH_HEADER = (
    "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n"
    + SAMPLE_CSV_MS
)

EXPECTED_BARS = [
    ("2024-01-01T00:00:00Z", 109.91),
    ("2024-01-02T00:00:00Z", 106.73),
]


def make_klines_zip(csv_text: str, name: str = "SOLUSDT-1d-2024-01.csv") -> bytes:
    """Build an in-memory zip holding one klines CSV, like the real dumps."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, csv_text)
    return buffer.getvalue()


def _mock_zip_response(payload: bytes) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.content = payload
    return resp


def _http_status_error(status_code: int) -> httpx.HTTPStatusError:
    return httpx.HTTPStatusError(
        f"HTTP {status_code}",
        request=MagicMock(),
        response=MagicMock(status_code=status_code),
    )


# ---------------------------------------------------------------------------
# CSV parsing
# ---------------------------------------------------------------------------

class ParseKlinesCsvTestCase(unittest.TestCase):
    def test_parses_millisecond_bars(self) -> None:
        bars = parse_klines_csv(SAMPLE_CSV_MS.encode("utf-8"))
        self.assertEqual(bars, EXPECTED_BARS)

    def test_normalizes_microsecond_bars(self) -> None:
        """Newer dumps use microsecond open_time — detected by magnitude."""
        bars = parse_klines_csv(SAMPLE_CSV_US.encode("utf-8"))
        self.assertEqual(bars, EXPECTED_BARS)

    def test_skips_header_row(self) -> None:
        bars = parse_klines_csv(SAMPLE_CSV_WITH_HEADER.encode("utf-8"))
        self.assertEqual(bars, EXPECTED_BARS)

    def test_empty_csv_returns_empty(self) -> None:
        self.assertEqual(parse_klines_csv(b""), [])


# ---------------------------------------------------------------------------
# fetch_month (HTTP mocked)
# ---------------------------------------------------------------------------

class FetchMonthTestCase(unittest.IsolatedAsyncioTestCase):
    @patch("agent.ingestion.binance_klines.httpx.AsyncClient")
    async def test_downloads_and_parses_month(self, mock_client_cls: MagicMock) -> None:
        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_zip_response(make_klines_zip(SAMPLE_CSV_MS))
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        bars = await fetch_month("SOLUSDT", 2024, 1)

        self.assertEqual(bars, EXPECTED_BARS)
        requested_url = mock_client.get.call_args.args[0]
        self.assertEqual(
            requested_url,
            "https://data.binance.vision/data/spot/monthly/klines/SOLUSDT/1d/SOLUSDT-1d-2024-01.zip",
        )

    @patch("agent.ingestion.binance_klines.httpx.AsyncClient")
    async def test_zero_pads_month_in_url(self, mock_client_cls: MagicMock) -> None:
        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_zip_response(make_klines_zip(SAMPLE_CSV_MS))
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        await fetch_month("BTCUSDT", 2023, 7)

        requested_url = mock_client.get.call_args.args[0]
        self.assertIn("/BTCUSDT/1d/BTCUSDT-1d-2023-07.zip", requested_url)

    @patch("agent.ingestion.binance_klines.httpx.AsyncClient")
    async def test_404_propagates(self, mock_client_cls: MagicMock) -> None:
        """fetch_month raises on missing months; backfill handles the skip."""
        resp = MagicMock()
        resp.raise_for_status = MagicMock(side_effect=_http_status_error(404))

        mock_client = AsyncMock()
        mock_client.get.return_value = resp
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        with self.assertRaises(httpx.HTTPStatusError):
            await fetch_month("JUPUSDT", 2023, 1)


# ---------------------------------------------------------------------------
# month_range
# ---------------------------------------------------------------------------

class MonthRangeTestCase(unittest.TestCase):
    def test_single_month(self) -> None:
        self.assertEqual(month_range("2024-01", "2024-01"), [(2024, 1)])

    def test_spans_year_boundary(self) -> None:
        self.assertEqual(
            month_range("2023-11", "2024-02"),
            [(2023, 11), (2023, 12), (2024, 1), (2024, 2)],
        )

    def test_start_after_end_raises(self) -> None:
        with self.assertRaises(ValueError):
            month_range("2024-05", "2024-01")

    def test_invalid_format_raises(self) -> None:
        with self.assertRaises(ValueError):
            month_range("2024", "2024-02")
        with self.assertRaises(ValueError):
            month_range("2024-13", "2024-12")


# ---------------------------------------------------------------------------
# backfill (fetch_month mocked, real SQLite)
# ---------------------------------------------------------------------------

class BackfillTestCase(unittest.IsolatedAsyncioTestCase):
    def _make_db(self, case_name: str) -> tuple[Database, Path]:
        case_dir = Path(".tmp-tests") / case_name
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)
        database = Database(case_dir / "state.db")
        database.initialize()
        return database, case_dir

    @patch("agent.ingestion.binance_klines.fetch_month")
    async def test_backfills_and_is_idempotent(self, mock_fetch: AsyncMock) -> None:
        database, case_dir = self._make_db("test_backfill_basic")
        mock_fetch.return_value = list(EXPECTED_BARS)

        inserted = await backfill(database, ["SOL"], start="2024-01", end="2024-01")
        again = await backfill(database, ["SOL"], start="2024-01", end="2024-01")

        history = database.price_history("SOL")
        matrix = database.price_matrix(["SOL"], source="binance")
        database.close()

        self.assertEqual(inserted, 2)
        self.assertEqual(again, 0)  # UNIQUE(asset, recorded_at, source) dedupe
        self.assertEqual(len(history), 2)
        self.assertTrue(all(row["source"] == "binance" for row in history))
        self.assertEqual(matrix["SOL"], EXPECTED_BARS)
        mock_fetch.assert_any_await("SOLUSDT", 2024, 1)

        shutil.rmtree(case_dir, ignore_errors=True)

    @patch("agent.ingestion.binance_klines.fetch_month")
    async def test_missing_month_404_is_skipped(self, mock_fetch: AsyncMock) -> None:
        """A 404 month is logged and skipped; later months still land."""
        database, case_dir = self._make_db("test_backfill_404")
        mock_fetch.side_effect = [
            _http_status_error(404),  # 2024-01 missing (pre-listing)
            list(EXPECTED_BARS),  # 2024-02 present
        ]

        inserted = await backfill(database, ["JUP"], start="2024-01", end="2024-02")

        history = database.price_history("JUP")
        database.close()

        self.assertEqual(inserted, 2)
        self.assertEqual(len(history), 2)
        self.assertEqual(mock_fetch.await_count, 2)

        shutil.rmtree(case_dir, ignore_errors=True)

    @patch("agent.ingestion.binance_klines.fetch_month")
    async def test_network_error_is_skipped_not_fatal(self, mock_fetch: AsyncMock) -> None:
        database, case_dir = self._make_db("test_backfill_neterr")
        mock_fetch.side_effect = [
            httpx.ConnectError("boom", request=MagicMock()),
            list(EXPECTED_BARS),
        ]

        inserted = await backfill(database, ["SOL"], start="2024-01", end="2024-02")
        database.close()

        self.assertEqual(inserted, 2)

        shutil.rmtree(case_dir, ignore_errors=True)

    @patch("agent.ingestion.binance_klines.fetch_month")
    async def test_unknown_ticker_is_skipped(self, mock_fetch: AsyncMock) -> None:
        database, case_dir = self._make_db("test_backfill_unknown")
        mock_fetch.return_value = list(EXPECTED_BARS)

        inserted = await backfill(
            database, ["DOESNOTEXIST", "SOL"], start="2024-01", end="2024-01"
        )
        database.close()

        self.assertEqual(inserted, 2)  # only SOL fetched
        self.assertEqual(mock_fetch.await_count, 1)
        mock_fetch.assert_awaited_with("SOLUSDT", 2024, 1)

        shutil.rmtree(case_dir, ignore_errors=True)

    @patch("agent.ingestion.binance_klines.fetch_month")
    async def test_rndr_fetches_both_rebrand_symbols(self, mock_fetch: AsyncMock) -> None:
        """RNDR history spans the rebrand: both RENDERUSDT and the pre-rebrand
        RNDRUSDT dumps are fetched, and overlap months dedupe."""
        database, case_dir = self._make_db("test_backfill_rndr")
        mock_fetch.return_value = list(EXPECTED_BARS)

        inserted = await backfill(database, ["RNDR"], start="2024-01", end="2024-01")

        history = database.price_history("RNDR")
        database.close()

        # Both symbols returned the same bars; UNIQUE constraint keeps 2 rows.
        self.assertEqual(inserted, 2)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["asset"], "RNDR")  # stored under the ticker
        mock_fetch.assert_any_await("RENDERUSDT", 2024, 1)
        mock_fetch.assert_any_await("RNDRUSDT", 2024, 1)

        shutil.rmtree(case_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Symbol universe + CLI parser
# ---------------------------------------------------------------------------

class SymbolUniverseTestCase(unittest.TestCase):
    def test_universe_is_widened_and_well_formed(self) -> None:
        self.assertGreaterEqual(len(BINANCE_SYMBOLS), 35)
        for ticker, symbol in BINANCE_SYMBOLS.items():
            self.assertEqual(ticker, ticker.upper())
            self.assertTrue(symbol.endswith("USDT"), f"{ticker} -> {symbol}")

    def test_demo_default_assets_are_covered(self) -> None:
        """Every TRACKED_ASSETS demo default has a Binance mapping."""
        for ticker in ["SOL", "RNDR", "IO", "PYTH"]:
            self.assertIn(ticker, BINANCE_SYMBOLS)

    def test_render_rebrand(self) -> None:
        self.assertEqual(BINANCE_SYMBOLS["RENDER"], "RENDERUSDT")
        self.assertEqual(BINANCE_SYMBOLS["RNDR"], "RENDERUSDT")
        # Pre-rebrand dumps (2021-11..2024-07) only exist under RNDRUSDT.
        self.assertEqual(symbols_for("RNDR"), ("RENDERUSDT", "RNDRUSDT"))
        self.assertEqual(symbols_for("RENDER"), ("RENDERUSDT", "RNDRUSDT"))
        self.assertEqual(symbols_for("SOL"), ("SOLUSDT",))
        self.assertEqual(symbols_for("DOESNOTEXIST"), ())


class CliParserTestCase(unittest.TestCase):
    def test_parses_required_and_optional_args(self) -> None:
        args = build_parser().parse_args(
            ["--assets", "SOL,PYTH", "--start", "2023-01", "--end", "2026-07", "--db", "x.db"]
        )
        self.assertEqual(args.assets, "SOL,PYTH")
        self.assertEqual(args.start, "2023-01")
        self.assertEqual(args.end, "2026-07")
        self.assertEqual(args.db, "x.db")
        self.assertEqual(args.env_file, ".env")

    def test_db_defaults_to_none(self) -> None:
        args = build_parser().parse_args(
            ["--assets", "SOL", "--start", "2024-01", "--end", "2024-02"]
        )
        self.assertIsNone(args.db)


if __name__ == "__main__":
    unittest.main()
