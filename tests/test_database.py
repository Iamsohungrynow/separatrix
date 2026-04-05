from __future__ import annotations

import shutil
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
