from __future__ import annotations

import shutil
import unittest
from pathlib import Path

from agent.db.database import Database
from agent.models import Signal
from agent.trading.executor import PaperTradeExecutor
from agent.trading.policy_client import LocalPolicyClient


class ExecutorTestCase(unittest.TestCase):
    def test_buy_trade_updates_cash_and_position(self) -> None:
        case_dir = Path(".tmp-tests") / "test_executor"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        database.ensure_cash(1000.0)

        executor = PaperTradeExecutor(
            db=database,
            policy_client=LocalPolicyClient(
                daily_buy_limit_usdc=10.0,
                per_trade_buy_limit_usdc=5.0,
                starting_sequence=database.get_next_trade_sequence(),
            ),
            starting_cash_usdc=1000.0,
        )

        result = executor.execute(
            Signal(
                asset="RNDR",
                action="BUY",
                sentiment=0.8,
                confidence=0.75,
                position_size_usdc=5.0,
                reasoning="test",
            ),
            price_usdc=10.0,
        )

        position = database.get_position("RNDR")
        cash = database.get_cash(1000.0)
        database.close()

        self.assertTrue(result.approved)
        self.assertAlmostEqual(position.quantity, 0.5)
        self.assertAlmostEqual(position.avg_cost, 10.0)
        self.assertAlmostEqual(cash, 995.0)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_sell_trade_realizes_pnl_and_reduces_position(self) -> None:
        case_dir = Path(".tmp-tests") / "test_executor_sell"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        database.ensure_cash(1000.0)

        executor = PaperTradeExecutor(
            db=database,
            policy_client=LocalPolicyClient(
                daily_buy_limit_usdc=20.0,
                per_trade_buy_limit_usdc=10.0,
                starting_sequence=database.get_next_trade_sequence(),
            ),
            starting_cash_usdc=1000.0,
        )

        buy_result = executor.execute(
            Signal(
                asset="RNDR",
                action="BUY",
                sentiment=0.8,
                confidence=0.8,
                position_size_usdc=10.0,
                reasoning="buy",
            ),
            price_usdc=10.0,
        )
        sell_result = executor.execute(
            Signal(
                asset="RNDR",
                action="SELL",
                sentiment=-0.8,
                confidence=0.8,
                position_size_usdc=6.0,
                reasoning="sell",
            ),
            price_usdc=12.0,
        )

        position = database.get_position("RNDR")
        pnl = database.latest_pnl(1000.0)
        cash = database.get_cash(1000.0)
        database.close()

        self.assertTrue(buy_result.approved)
        self.assertTrue(sell_result.approved)
        self.assertAlmostEqual(position.quantity, 0.5)
        self.assertAlmostEqual(position.avg_cost, 10.0)
        self.assertAlmostEqual(cash, 996.0)
        self.assertAlmostEqual(sell_result.realized_pnl, 1.0)
        self.assertAlmostEqual(pnl["realized_pnl"], 1.0)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_precheck_rejections_do_not_consume_sequence(self) -> None:
        case_dir = Path(".tmp-tests") / "test_executor_prechecks"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        database.ensure_cash(5.0)
        policy = LocalPolicyClient(
            daily_buy_limit_usdc=10.0,
            per_trade_buy_limit_usdc=5.0,
            starting_sequence=database.get_next_trade_sequence(),
        )
        executor = PaperTradeExecutor(db=database, policy_client=policy, starting_cash_usdc=5.0)

        insufficient_cash = executor.execute(
            Signal(
                asset="SOL",
                action="BUY",
                sentiment=0.8,
                confidence=0.8,
                position_size_usdc=6.0,
                reasoning="too large for cash",
            ),
            price_usdc=10.0,
        )
        unsupported = executor.execute(
            Signal(
                asset="SOL",
                action="HOLD",
                sentiment=0.0,
                confidence=1.0,
                position_size_usdc=1.0,
                reasoning="unsupported",
            ),
            price_usdc=10.0,
        )
        no_position = executor.execute(
            Signal(
                asset="SOL",
                action="SELL",
                sentiment=-0.7,
                confidence=0.8,
                position_size_usdc=1.0,
                reasoning="no position",
            ),
            price_usdc=10.0,
        )
        invalid_price = executor.execute(
            Signal(
                asset="SOL",
                action="BUY",
                sentiment=0.7,
                confidence=0.8,
                position_size_usdc=1.0,
                reasoning="bad price",
            ),
            price_usdc=0.0,
        )
        follow_up = executor.execute(
            Signal(
                asset="SOL",
                action="BUY",
                sentiment=0.7,
                confidence=0.8,
                position_size_usdc=5.0,
                reasoning="valid",
            ),
            price_usdc=10.0,
        )

        database.close()

        self.assertEqual(insufficient_cash.reason, "INSUFFICIENT_CASH")
        self.assertEqual(unsupported.reason, "UNSUPPORTED_ACTION:HOLD")
        self.assertEqual(no_position.reason, "NO_POSITION")
        self.assertEqual(invalid_price.reason, "INVALID_PRICE")
        self.assertTrue(follow_up.approved)
        self.assertEqual(follow_up.tx_signature, "LOCAL-000001")

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_policy_rejection_does_not_consume_sequence(self) -> None:
        case_dir = Path(".tmp-tests") / "test_executor_policy_rejection"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        database.ensure_cash(100.0)
        executor = PaperTradeExecutor(
            db=database,
            policy_client=LocalPolicyClient(
                daily_buy_limit_usdc=10.0,
                per_trade_buy_limit_usdc=5.0,
                starting_sequence=database.get_next_trade_sequence(),
            ),
            starting_cash_usdc=100.0,
        )

        rejected = executor.execute(
            Signal(
                asset="SOL",
                action="BUY",
                sentiment=0.9,
                confidence=0.9,
                position_size_usdc=6.0,
                reasoning="too large for policy",
            ),
            price_usdc=10.0,
        )
        approved = executor.execute(
            Signal(
                asset="SOL",
                action="BUY",
                sentiment=0.7,
                confidence=0.8,
                position_size_usdc=5.0,
                reasoning="fits policy",
            ),
            price_usdc=10.0,
        )
        next_sequence = database.get_next_trade_sequence()
        database.close()

        self.assertEqual(rejected.reason, "TRADE_TOO_BIG")
        self.assertTrue(approved.approved)
        self.assertEqual(approved.tx_signature, "LOCAL-000001")
        self.assertEqual(next_sequence, 2)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_invalid_trade_amount_is_rejected_before_policy_submission(self) -> None:
        case_dir = Path(".tmp-tests") / "test_executor_invalid_amount"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        database.ensure_cash(100.0)
        executor = PaperTradeExecutor(
            db=database,
            policy_client=LocalPolicyClient(
                daily_buy_limit_usdc=10.0,
                per_trade_buy_limit_usdc=5.0,
                starting_sequence=database.get_next_trade_sequence(),
            ),
            starting_cash_usdc=100.0,
        )

        invalid = executor.execute(
            Signal(
                asset="SOL",
                action="BUY",
                sentiment=0.5,
                confidence=0.7,
                position_size_usdc=0.0,
                reasoning="invalid amount",
            ),
            price_usdc=10.0,
        )
        follow_up = executor.execute(
            Signal(
                asset="SOL",
                action="BUY",
                sentiment=0.7,
                confidence=0.8,
                position_size_usdc=5.0,
                reasoning="valid",
            ),
            price_usdc=10.0,
        )
        database.close()

        self.assertEqual(invalid.reason, "INVALID_TRADE_AMOUNT")
        self.assertTrue(follow_up.approved)
        self.assertEqual(follow_up.tx_signature, "LOCAL-000001")

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_sell_clamps_to_available_position(self) -> None:
        case_dir = Path(".tmp-tests") / "test_executor_sell_clamp"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        database = Database(case_dir / "state.db")
        database.initialize()
        database.ensure_cash(1000.0)
        executor = PaperTradeExecutor(
            db=database,
            policy_client=LocalPolicyClient(
                daily_buy_limit_usdc=20.0,
                per_trade_buy_limit_usdc=10.0,
                starting_sequence=database.get_next_trade_sequence(),
            ),
            starting_cash_usdc=1000.0,
        )

        executor.execute(
            Signal(
                asset="RNDR",
                action="BUY",
                sentiment=0.8,
                confidence=0.8,
                position_size_usdc=5.0,
                reasoning="seed",
            ),
            price_usdc=10.0,
        )
        sell = executor.execute(
            Signal(
                asset="RNDR",
                action="SELL",
                sentiment=-0.7,
                confidence=0.8,
                position_size_usdc=100.0,
                reasoning="oversized sell request",
            ),
            price_usdc=10.0,
        )

        position = database.get_position("RNDR")
        cash = database.get_cash(1000.0)
        database.close()

        self.assertTrue(sell.approved)
        self.assertAlmostEqual(sell.quantity, 0.5)
        self.assertAlmostEqual(position.quantity, 0.0)
        self.assertAlmostEqual(cash, 1000.0)

        shutil.rmtree(case_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
