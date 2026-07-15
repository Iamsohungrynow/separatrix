from __future__ import annotations

import unittest
from unittest.mock import patch
import subprocess

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
    def test_anchor_client_invokes_devnet_submit_bridge(self) -> None:
        client = AnchorPolicyClient(
            rpc_url="https://api.devnet.solana.com",
            program_id="Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG",
            wallet_path="keys/agent-devnet.json",
        )

        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"approved":true,"reason":"APPROVED","tx_signature":"devnet-sig"}\n',
            stderr="",
        )
        with patch("agent.trading.policy_client.subprocess.run", return_value=completed) as run:
            decision = client.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=1.0, sequence=1))

        self.assertTrue(decision.approved)
        self.assertEqual(decision.reason, "APPROVED")
        self.assertEqual(decision.tx_signature, "devnet-sig")

        kwargs = run.call_args.kwargs
        self.assertEqual(kwargs["env"]["SOLANA_RPC_URL"], "https://api.devnet.solana.com")
        self.assertEqual(kwargs["env"]["POLICY_CONTROLLER_PROGRAM_ID"], "Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG")
        self.assertEqual(kwargs["env"]["AGENT_WALLET_PATH"], "keys/agent-devnet.json")
        command = run.call_args.args[0]
        self.assertIn("devnet:submit", command)
        self.assertIn("BUY", command)
        self.assertIn("1.000000", command)
        self.assertIn("1", command)

    def test_anchor_client_fails_closed_on_bridge_failure(self) -> None:
        client = AnchorPolicyClient(
            rpc_url="https://api.devnet.solana.com",
            program_id="Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG",
            wallet_path="keys/agent-devnet.json",
        )

        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="program not found")
        with patch("agent.trading.policy_client.subprocess.run", return_value=completed):
            decision = client.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=1.0, sequence=1))

        self.assertFalse(decision.approved)
        self.assertTrue(decision.reason.startswith("ANCHOR_SUBMISSION_FAILED:"))

    def test_anchor_client_fails_closed_on_malformed_output(self) -> None:
        client = AnchorPolicyClient(
            rpc_url="https://api.devnet.solana.com",
            program_id="Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG",
            wallet_path="keys/agent-devnet.json",
        )

        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="not json\n", stderr="")
        with patch("agent.trading.policy_client.subprocess.run", return_value=completed):
            decision = client.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=1.0, sequence=1))

        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "ANCHOR_SUBMISSION_MALFORMED_OUTPUT")

    def test_anchor_client_returns_policy_rejection_from_bridge_json(self) -> None:
        client = AnchorPolicyClient(
            rpc_url="https://api.devnet.solana.com",
            program_id="Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG",
            wallet_path="keys/agent-devnet.json",
        )

        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"approved":false,"reason":"TRADE_TOO_BIG","tx_signature":null}\n',
            stderr="",
        )
        with patch("agent.trading.policy_client.subprocess.run", return_value=completed):
            decision = client.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=100.0, sequence=1))

        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "TRADE_TOO_BIG")
        self.assertIsNone(decision.tx_signature)

    def test_anchor_client_timeout_fails_closed(self) -> None:
        client = AnchorPolicyClient(
            rpc_url="https://api.devnet.solana.com",
            program_id="Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG",
            wallet_path="keys/agent-devnet.json",
        )

        with patch("agent.trading.policy_client.subprocess.run", side_effect=subprocess.TimeoutExpired([], 60)):
            decision = client.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=1.0, sequence=1))

        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "ANCHOR_SUBMISSION_TIMEOUT")

    def test_anchor_client_rejects_invalid_request_before_subprocess(self) -> None:
        client = AnchorPolicyClient(
            rpc_url="https://api.devnet.solana.com",
            program_id="Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG",
            wallet_path="keys/agent-devnet.json",
        )

        with patch("agent.trading.policy_client.subprocess.run") as run:
            bad_side = client.submit_trade(TradeRequest(asset="SOL", side="HOLD", amount_usdc=1.0, sequence=1))
            bad_amount = client.submit_trade(TradeRequest(asset="SOL", side="BUY", amount_usdc=0.0, sequence=1))

        self.assertFalse(bad_side.approved)
        self.assertEqual(bad_side.reason, "UNSUPPORTED_SIDE:HOLD")
        self.assertFalse(bad_amount.approved)
        self.assertEqual(bad_amount.reason, "INVALID_TRADE_AMOUNT")
        run.assert_not_called()

    def test_anchor_client_policy_status_uses_status_bridge(self) -> None:
        client = AnchorPolicyClient(
            rpc_url="https://api.devnet.solana.com",
            program_id="Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG",
            wallet_path="keys/agent-devnet.json",
        )

        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"available":true,"initialized":true,"next_trade_seq":"3"}\n',
            stderr="",
        )
        with patch("agent.trading.policy_client.subprocess.run", return_value=completed) as run:
            status = client.policy_status()

        self.assertTrue(status["available"])
        self.assertEqual(status["next_trade_seq"], "3")
        command = run.call_args.args[0]
        self.assertIn("devnet:policy-status-json", command)
        kwargs = run.call_args.kwargs
        self.assertEqual(kwargs["env"]["SOLANA_RPC_URL"], "https://api.devnet.solana.com")
        self.assertEqual(kwargs["env"]["POLICY_CONTROLLER_PROGRAM_ID"], "Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG")
        self.assertEqual(kwargs["env"]["AGENT_WALLET_PATH"], "keys/agent-devnet.json")

    def test_anchor_client_policy_status_failure_is_structured(self) -> None:
        client = AnchorPolicyClient(
            rpc_url="https://api.devnet.solana.com",
            program_id="Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG",
            wallet_path="keys/agent-devnet.json",
        )

        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="idl missing")
        with patch("agent.trading.policy_client.subprocess.run", return_value=completed):
            status = client.policy_status()

        self.assertFalse(status["available"])
        self.assertTrue(str(status["reason"]).startswith("ANCHOR_STATUS_FAILED:"))


if __name__ == "__main__":
    unittest.main()
