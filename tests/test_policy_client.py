from __future__ import annotations

import unittest
from unittest.mock import patch

from agent.models import TradeRequest
from agent.trading.policy_client import AnchorPolicyClient, LocalPolicyClient


class LocalPolicyClientTestCase(unittest.TestCase):
    def test_enforces_per_trade_limit_daily_limit_and_sequence(self) -> None:
        policy = LocalPolicyClient(daily_buy_limit_usdc=10.0, per_trade_buy_limit_usdc=5.0, starting_sequence=1)

        approved = policy.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=5.0, sequence=1))
        too_big = policy.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=6.0, sequence=2))
        daily_limit = policy.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=5.1, sequence=2))
        bad_sequence = policy.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=1.0, sequence=9))

        self.assertTrue(approved.approved)
        self.assertEqual(too_big.reason, "TRADE_TOO_BIG")
        self.assertEqual(daily_limit.reason, "TRADE_TOO_BIG")
        self.assertEqual(bad_sequence.reason, "INVALID_TRADE_SEQUENCE")

    def test_enforces_daily_limit_after_multiple_approved_buys(self) -> None:
        policy = LocalPolicyClient(daily_buy_limit_usdc=10.0, per_trade_buy_limit_usdc=6.0, starting_sequence=1)

        first = policy.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=6.0, sequence=1))
        second = policy.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=5.0, sequence=2))

        self.assertTrue(first.approved)
        self.assertEqual(second.reason, "DAILY_LIMIT_EXCEEDED")

    def test_halt_and_sell_behavior(self) -> None:
        policy = LocalPolicyClient(daily_buy_limit_usdc=10.0, per_trade_buy_limit_usdc=5.0, starting_sequence=3)

        policy.set_halt(True)
        halted = policy.submit_trade(TradeRequest(asset="RNDR", side="BUY", amount_usdc=1.0, sequence=3))
        policy.set_halt(False)
        sell = policy.submit_trade(TradeRequest(asset="RNDR", side="SELL", amount_usdc=50.0, sequence=3))

        self.assertEqual(halted.reason, "POLICY_HALTED")
        self.assertTrue(sell.approved)
        self.assertEqual(sell.tx_signature, "LOCAL-000003")

    def test_rolls_day_in_utc(self) -> None:
        policy = LocalPolicyClient(daily_buy_limit_usdc=10.0, per_trade_buy_limit_usdc=10.0, starting_sequence=1)

        first = policy.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=10.0, sequence=1))
        with patch("agent.trading.policy_client._utc_day_index", return_value=policy._day_index + 1):
            second = policy.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=10.0, sequence=2))

        self.assertTrue(first.approved)
        self.assertTrue(second.approved)

    def test_rejection_does_not_advance_sequence(self) -> None:
        policy = LocalPolicyClient(daily_buy_limit_usdc=10.0, per_trade_buy_limit_usdc=5.0, starting_sequence=1)

        rejected = policy.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=6.0, sequence=1))
        approved = policy.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=5.0, sequence=1))

        self.assertEqual(rejected.reason, "TRADE_TOO_BIG")
        self.assertTrue(approved.approved)
        self.assertEqual(approved.tx_signature, "LOCAL-000001")

    def test_sell_requires_valid_sequence(self) -> None:
        policy = LocalPolicyClient(daily_buy_limit_usdc=10.0, per_trade_buy_limit_usdc=5.0, starting_sequence=3)

        rejected = policy.submit_trade(TradeRequest(asset="RNDR", side="SELL", amount_usdc=1.0, sequence=2))
        approved = policy.submit_trade(TradeRequest(asset="RNDR", side="SELL", amount_usdc=1.0, sequence=3))

        self.assertEqual(rejected.reason, "INVALID_TRADE_SEQUENCE")
        self.assertTrue(approved.approved)
        self.assertEqual(approved.tx_signature, "LOCAL-000003")


class AnchorPolicyClientTestCase(unittest.TestCase):
    def test_anchor_client_is_explicitly_not_implemented_yet(self) -> None:
        client = AnchorPolicyClient(
            rpc_url="https://api.devnet.solana.com",
            program_id="Fg6PaFpoGXkYsidMpWxTWqk6W2BeZ7FEfcYkgMQHgZP",
            wallet_path="keys/agent-devnet.json",
        )

        with self.assertRaises(NotImplementedError):
            client.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=1.0, sequence=1))


if __name__ == "__main__":
    unittest.main()
