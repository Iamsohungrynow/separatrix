from __future__ import annotations

import shutil
import sqlite3
import unittest
from pathlib import Path

from agent.db.database import Database
from agent.models import Position, Signal


class DatabaseTestCase(unittest.TestCase):
    def test_empty_database_returns_safe_defaults(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database_empty"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()

        self.assertIsNone(database.latest_signal())
        self.assertEqual(database.signal_history(limit=5), [])
        self.assertEqual(database.list_positions(), [])
        pnl = database.latest_pnl(123.0)
        self.assertEqual(pnl["cash_usdc"], 123.0)
        self.assertEqual(pnl["total_value_usdc"], 123.0)
        self.assertIsNone(pnl["recorded_at"])
        self.assertEqual(database.health_snapshot(network="devnet", policy_mode="local")["next_trade_sequence"], 1)

        database.close()
        shutil.rmtree(case_dir, ignore_errors=True)

    def test_inserts_and_reads_latest_signal(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        database.ensure_cash(1000.0)
        database.insert_signal(
            Signal(
                asset="RNDR",
                action="BUY",
                sentiment=0.8,
                confidence=0.7,
                position_size_usdc=5.0,
                reasoning="test",
                sources=["local://test"],
            ),
            devnet_tx="LOCAL-000001",
        )

        latest = database.latest_signal()
        database.close()

        self.assertIsNotNone(latest)
        assert latest is not None
        self.assertEqual(latest["asset"], "RNDR")
        self.assertEqual(latest["devnet_tx"], "LOCAL-000001")

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_tracks_cash_sequence_health_and_history(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database_metadata"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        database.ensure_cash(250.0)
        database.set_cash(245.5)
        database.set_next_trade_sequence(7)
        database.record_state("idle")

        first_signal = Signal(
            asset="SOL",
            action="BUY",
            sentiment=0.7,
            confidence=0.8,
            position_size_usdc=4.0,
            reasoning="signal one",
            sources=["local://one"],
        )
        second_signal = Signal(
            asset="RNDR",
            action="SELL",
            sentiment=-0.8,
            confidence=0.9,
            position_size_usdc=5.0,
            reasoning="signal two",
            sources=["local://two"],
        )
        database.insert_signal(first_signal, devnet_tx="LOCAL-000001")
        database.insert_signal(second_signal, devnet_tx="LOCAL-000002")
        database.record_pnl(total_value_usdc=245.5, unrealized_pnl=0.0, realized_pnl=1.25)

        health = database.health_snapshot(network="devnet", policy_mode="local-simulator")
        history = database.signal_history(limit=1)
        pnl = database.latest_pnl(250.0)
        database.close()

        self.assertEqual(health["status"], "idle")
        self.assertEqual(health["next_trade_sequence"], 7)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["asset"], "RNDR")
        self.assertAlmostEqual(pnl["cash_usdc"], 245.5)
        self.assertAlmostEqual(pnl["realized_pnl"], 1.25)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_trade_history_returns_recent_trades_first(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database_trade_history"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        database.ensure_cash(1000.0)

        for i, asset in enumerate(["SOL", "RNDR", "PYTH"], start=1):
            signal_id = database.insert_signal(
                Signal(
                    asset=asset,
                    action="BUY",
                    sentiment=0.7,
                    confidence=0.8,
                    position_size_usdc=5.0,
                    reasoning=f"trade {i}",
                    sources=[f"local://{i}"],
                ),
                devnet_tx=f"LOCAL-{i:06d}",
            )
            database.record_trade(
                signal_id=signal_id,
                asset=asset,
                action="BUY",
                amount_usdc=5.0,
                price_usdc=10.0,
                quantity=0.5,
                tx_signature=f"LOCAL-{i:06d}",
            )

        all_trades = database.trade_history(limit=10)
        latest_two = database.trade_history(limit=2)
        empty_default = Database(case_dir / "empty.db")
        empty_default.initialize()
        empty_history = empty_default.trade_history()
        empty_default.close()
        database.close()

        self.assertEqual(len(all_trades), 3)
        self.assertEqual([t["asset"] for t in all_trades], ["PYTH", "RNDR", "SOL"])
        self.assertEqual(all_trades[0]["tx_signature"], "LOCAL-000003")
        self.assertEqual(all_trades[0]["action"], "BUY")
        self.assertAlmostEqual(all_trades[0]["amount_usdc"], 5.0)
        self.assertEqual(len(latest_two), 2)
        self.assertEqual(latest_two[0]["asset"], "PYTH")
        self.assertEqual(empty_history, [])

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_foreign_keys_enabled_for_scores(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database_foreign_keys"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()

        foreign_keys = database.connection.execute("PRAGMA foreign_keys").fetchone()
        assert foreign_keys is not None

        with self.assertRaises(sqlite3.IntegrityError):
            database.insert_score(
                raw_item_id=999,
                score={
                    "asset": "SOL",
                    "sentiment": 0.6,
                    "confidence": 0.8,
                    "reasoning": "missing raw item",
                    "model": "test",
                },
            )

        database.close()
        self.assertEqual(foreign_keys[0], 1)
        shutil.rmtree(case_dir, ignore_errors=True)

    def test_upserts_raw_items_and_records_scores(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database_raw_items_scores"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        raw_item = {
            "source": "arxiv",
            "url": "https://example.test/paper",
            "url_hash": "paper-hash",
            "title": "Original Title",
            "content": "Solana policy controller research.",
            "published_at": "2026-06-18T00:00:00Z",
            "fetched_at": "2026-06-18T01:00:00Z",
            "metadata": '{"kind":"paper"}',
        }

        first_id = database.upsert_raw_item(raw_item)
        second_id = database.upsert_raw_item({**raw_item, "title": "Updated Title"})
        score_id = database.insert_score(
            raw_item_id=second_id,
            score={
                "item_index": 0,
                "asset": "SOL",
                "sentiment": 0.85,
                "confidence": 0.9,
                "reasoning": "bullish policy signal",
                "model": "test",
                "scored_at": "2026-06-18T01:01:00Z",
            },
        )

        raw_count = database.connection.execute("SELECT COUNT(*) FROM raw_items").fetchone()[0]
        score_count = database.connection.execute("SELECT COUNT(*) FROM scores").fetchone()[0]
        raw_row = database.connection.execute("SELECT id, title FROM raw_items").fetchone()
        score_row = database.connection.execute(
            "SELECT id, raw_item_id, asset, reasoning FROM scores"
        ).fetchone()
        database.close()

        self.assertEqual(first_id, second_id)
        self.assertEqual(raw_count, 1)
        self.assertEqual(score_count, 1)
        assert raw_row is not None
        assert score_row is not None
        self.assertEqual(raw_row["title"], "Updated Title")
        self.assertEqual(score_id, score_row["id"])
        self.assertEqual(score_row["raw_item_id"], raw_row["id"])
        self.assertEqual(score_row["asset"], "SOL")
        self.assertEqual(score_row["reasoning"], "bullish policy signal")

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_record_prices_and_price_history_newest_first(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database_price_history"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()

        inserted_first = database.record_prices(
            {"SOL": 100.0, "PYTH": 0.30},
            source="jupiter",
            recorded_at="2026-01-01T00:00:00Z",
        )
        inserted_second = database.record_prices(
            {"SOL": 110.0},
            source="jupiter",
            recorded_at="2026-01-02T00:00:00Z",
        )
        # Same timestamp, different source → its own row.
        inserted_other_source = database.record_prices(
            {"SOL": 100.5},
            source="binance",
            recorded_at="2026-01-01T00:00:00Z",
        )
        # Default recorded_at falls back to now (just check it inserts).
        inserted_now = database.record_prices({"SOL": 111.0}, source="jupiter")

        history = database.price_history("SOL")
        jupiter_only = database.price_history("SOL", source="jupiter")
        limited = database.price_history("SOL", limit=1, source="jupiter")
        empty = database.price_history("DOESNOTEXIST")
        database.close()

        self.assertEqual(inserted_first, 2)
        self.assertEqual(inserted_second, 1)
        self.assertEqual(inserted_other_source, 1)
        self.assertEqual(inserted_now, 1)
        self.assertEqual(len(history), 4)
        # Newest first; the default-timestamp row (today) sorts newest.
        self.assertEqual(history[-1]["recorded_at"], "2026-01-01T00:00:00Z")
        self.assertEqual(len(jupiter_only), 3)
        self.assertTrue(all(row["source"] == "jupiter" for row in jupiter_only))
        self.assertEqual(len(limited), 1)
        self.assertAlmostEqual(limited[0]["price_usdc"], 111.0)
        self.assertEqual(empty, [])

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_record_prices_is_idempotent(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database_price_idempotent"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()

        first = database.record_prices(
            {"SOL": 100.0}, source="binance", recorded_at="2026-01-01T00:00:00Z"
        )
        # Re-recording the same (asset, recorded_at, source) is a no-op,
        # even with a different price — backfills stay idempotent.
        second = database.record_prices(
            {"SOL": 999.0}, source="binance", recorded_at="2026-01-01T00:00:00Z"
        )

        rows = database.price_history("SOL")
        database.close()

        self.assertEqual(first, 1)
        self.assertEqual(second, 0)
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["price_usdc"], 100.0)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_price_matrix_returns_oldest_first_per_asset(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database_price_matrix"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()

        database.record_prices({"SOL": 110.0, "PYTH": 0.35}, source="binance", recorded_at="2026-01-02T00:00:00Z")
        database.record_prices({"SOL": 100.0, "PYTH": 0.30}, source="binance", recorded_at="2026-01-01T00:00:00Z")
        database.record_prices({"SOL": 120.0}, source="jupiter", recorded_at="2026-01-03T00:00:00Z")

        matrix = database.price_matrix(["SOL", "PYTH", "MISSING"])
        binance_only = database.price_matrix(["SOL"], source="binance")
        database.close()

        self.assertEqual(
            matrix["SOL"],
            [
                ("2026-01-01T00:00:00Z", 100.0),
                ("2026-01-02T00:00:00Z", 110.0),
                ("2026-01-03T00:00:00Z", 120.0),
            ],
        )
        self.assertEqual(
            matrix["PYTH"],
            [("2026-01-01T00:00:00Z", 0.30), ("2026-01-02T00:00:00Z", 0.35)],
        )
        # Every requested asset is present, even without history.
        self.assertEqual(matrix["MISSING"], [])
        self.assertEqual(
            binance_only["SOL"],
            [("2026-01-01T00:00:00Z", 100.0), ("2026-01-02T00:00:00Z", 110.0)],
        )

    def test_latest_prices_picks_newest_recorded_at_not_newest_row(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database_latest_prices"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()

        # Live tick first, then a historical backfill row inserted LATER with
        # an older recorded_at — the live tick must still win.
        database.record_prices({"SOL": 150.0}, source="jupiter", recorded_at="2026-02-01T12:00:00Z")
        database.record_prices({"SOL": 100.0}, source="binance", recorded_at="2026-01-01T00:00:00Z")
        database.record_prices({"PYTH": 0.4}, source="binance", recorded_at="2026-01-01T00:00:00Z")

        everything = database.latest_prices()
        filtered = database.latest_prices(assets=["SOL", "MISSING"])
        database.close()

        self.assertEqual(everything, {"SOL": 150.0, "PYTH": 0.4})
        self.assertEqual(filtered, {"SOL": 150.0})

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_upsert_position_replaces_existing_row(self) -> None:
        case_dir = Path(".tmp-tests") / "test_database_positions"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        database.upsert_position(Position(asset="SOL", quantity=1.5, avg_cost=10.0))
        database.upsert_position(Position(asset="SOL", quantity=0.75, avg_cost=12.0))
        database.ensure_cash(1000.0)

        signal_id = database.insert_signal(
            Signal(
                asset="SOL",
                action="SELL",
                sentiment=-0.6,
                confidence=0.8,
                position_size_usdc=9.0,
                reasoning="position update",
                sources=["local://position"],
            ),
            devnet_tx="LOCAL-000003",
        )
        database.record_trade(
            signal_id=signal_id,
            asset="SOL",
            action="SELL",
            amount_usdc=9.0,
            price_usdc=12.0,
            quantity=0.75,
            tx_signature="LOCAL-000003",
            realized_pnl=1.5,
        )

        position = database.get_position("SOL")
        positions = database.list_positions()
        trade = database.connection.execute(
            "SELECT asset, action, quantity, realized_pnl, tx_signature FROM trades WHERE signal_id = ?",
            (signal_id,),
        ).fetchone()
        database.close()

        self.assertAlmostEqual(position.quantity, 0.75)
        self.assertAlmostEqual(position.avg_cost, 12.0)
        self.assertEqual(len(positions), 1)
        assert trade is not None
        self.assertEqual(trade["asset"], "SOL")
        self.assertEqual(trade["action"], "SELL")
        self.assertAlmostEqual(trade["quantity"], 0.75)
        self.assertAlmostEqual(trade["realized_pnl"], 1.5)
        self.assertEqual(trade["tx_signature"], "LOCAL-000003")

        shutil.rmtree(case_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
