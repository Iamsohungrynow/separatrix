from __future__ import annotations

import unittest
from unittest.mock import patch
import subprocess

from agent.models import SpendRequest
from agent.trading.leash_client import AnchorLeashClient, LocalLeashClient


class LocalLeashClientTestCase(unittest.TestCase):
    def test_enforces_per_tx_and_daily_caps(self) -> None:
        leash = LocalLeashClient(per_tx_cap_sol=0.05, daily_cap_sol=0.1)

        approved = leash.request_spend(SpendRequest(amount_sol=0.05))
        too_big = leash.request_spend(SpendRequest(amount_sol=0.06))
        second = leash.request_spend(SpendRequest(amount_sol=0.05))
        daily_exceeded = leash.request_spend(SpendRequest(amount_sol=0.01))

        self.assertTrue(approved.approved)
        self.assertEqual(too_big.reason, "PER_TX_CAP_EXCEEDED")
        self.assertTrue(second.approved)
        self.assertEqual(daily_exceeded.reason, "DAILY_CAP_EXCEEDED")

    def test_halt_blocks_all_spending(self) -> None:
        leash = LocalLeashClient(per_tx_cap_sol=0.05, daily_cap_sol=0.2)

        leash.set_halt(True)
        halted = leash.request_spend(SpendRequest(amount_sol=0.01))
        leash.set_halt(False)
        resumed = leash.request_spend(SpendRequest(amount_sol=0.01))

        self.assertEqual(halted.reason, "LEASH_HALTED")
        self.assertTrue(resumed.approved)
        self.assertEqual(resumed.tx_signature, "LOCAL-000001")

    def test_rejects_invalid_amount(self) -> None:
        leash = LocalLeashClient(per_tx_cap_sol=0.05, daily_cap_sol=0.2)

        zero = leash.request_spend(SpendRequest(amount_sol=0.0))
        negative = leash.request_spend(SpendRequest(amount_sol=-1.0))

        self.assertEqual(zero.reason, "INVALID_AMOUNT")
        self.assertEqual(negative.reason, "INVALID_AMOUNT")

    def test_rolls_day_in_utc(self) -> None:
        leash = LocalLeashClient(per_tx_cap_sol=0.1, daily_cap_sol=0.1)

        first = leash.request_spend(SpendRequest(amount_sol=0.1))
        with patch("agent.trading.leash_client._utc_day_index", return_value=leash._day_index + 1):
            second = leash.request_spend(SpendRequest(amount_sol=0.1))

        self.assertTrue(first.approved)
        self.assertTrue(second.approved)

    def test_rejection_does_not_consume_daily_budget(self) -> None:
        leash = LocalLeashClient(per_tx_cap_sol=0.05, daily_cap_sol=0.05)

        rejected = leash.request_spend(SpendRequest(amount_sol=0.06))
        approved = leash.request_spend(SpendRequest(amount_sol=0.05))

        self.assertEqual(rejected.reason, "PER_TX_CAP_EXCEEDED")
        self.assertTrue(approved.approved)
        self.assertEqual(approved.tx_signature, "LOCAL-000001")


def _client() -> AnchorLeashClient:
    return AnchorLeashClient(
        rpc_url="https://api.devnet.solana.com",
        program_id="EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV",
        wallet_path="keys/agent-devnet.json",
    )


class AnchorLeashClientTestCase(unittest.TestCase):
    def test_invokes_devnet_spend_bridge(self) -> None:
        client = _client()

        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"approved":true,"reason":"APPROVED","tx_signature":"devnet-sig"}\n',
            stderr="",
        )
        with patch("agent.trading.leash_client.subprocess.run", return_value=completed) as run:
            decision = client.request_spend(SpendRequest(amount_sol=0.01))

        self.assertTrue(decision.approved)
        self.assertEqual(decision.reason, "APPROVED")
        self.assertEqual(decision.tx_signature, "devnet-sig")

        kwargs = run.call_args.kwargs
        self.assertEqual(kwargs["env"]["SOLANA_RPC_URL"], "https://api.devnet.solana.com")
        self.assertEqual(kwargs["env"]["LEASH_PROGRAM_ID"], "EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV")
        self.assertEqual(kwargs["env"]["AGENT_WALLET_PATH"], "keys/agent-devnet.json")
        command = run.call_args.args[0]
        self.assertIn("devnet:spend", command)
        self.assertIn("0.010000000", command)

    def test_passes_recipient_when_provided(self) -> None:
        client = _client()

        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"approved":true,"reason":"APPROVED","tx_signature":"sig"}\n',
            stderr="",
        )
        with patch("agent.trading.leash_client.subprocess.run", return_value=completed) as run:
            client.request_spend(SpendRequest(amount_sol=0.01, recipient="Recipient1111111111111111111111111111111111"))

        command = run.call_args.args[0]
        self.assertIn("Recipient1111111111111111111111111111111111", command)

    def test_fails_closed_on_bridge_failure(self) -> None:
        client = _client()

        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="program not found")
        with patch("agent.trading.leash_client.subprocess.run", return_value=completed):
            decision = client.request_spend(SpendRequest(amount_sol=0.01))

        self.assertFalse(decision.approved)
        self.assertTrue(decision.reason.startswith("LEASH_SUBMISSION_FAILED:"))

    def test_fails_closed_on_malformed_output(self) -> None:
        client = _client()

        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="not json\n", stderr="")
        with patch("agent.trading.leash_client.subprocess.run", return_value=completed):
            decision = client.request_spend(SpendRequest(amount_sol=0.01))

        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "LEASH_SUBMISSION_MALFORMED_OUTPUT")

    def test_returns_onchain_rejection_from_bridge_json(self) -> None:
        client = _client()

        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"approved":false,"reason":"PER_TX_CAP_EXCEEDED","tx_signature":null}\n',
            stderr="",
        )
        with patch("agent.trading.leash_client.subprocess.run", return_value=completed):
            decision = client.request_spend(SpendRequest(amount_sol=100.0))

        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "PER_TX_CAP_EXCEEDED")
        self.assertIsNone(decision.tx_signature)

    def test_timeout_fails_closed(self) -> None:
        client = _client()

        with patch("agent.trading.leash_client.subprocess.run", side_effect=subprocess.TimeoutExpired([], 60)):
            decision = client.request_spend(SpendRequest(amount_sol=0.01))

        self.assertFalse(decision.approved)
        self.assertEqual(decision.reason, "LEASH_SUBMISSION_TIMEOUT")

    def test_rejects_invalid_amount_before_subprocess(self) -> None:
        client = _client()

        with patch("agent.trading.leash_client.subprocess.run") as run:
            zero = client.request_spend(SpendRequest(amount_sol=0.0))
            negative = client.request_spend(SpendRequest(amount_sol=-5.0))

        self.assertFalse(zero.approved)
        self.assertEqual(zero.reason, "INVALID_AMOUNT")
        self.assertFalse(negative.approved)
        self.assertEqual(negative.reason, "INVALID_AMOUNT")
        run.assert_not_called()

    def test_leash_status_uses_status_bridge(self) -> None:
        client = _client()

        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"available":true,"initialized":true,"spend_count":"3"}\n',
            stderr="",
        )
        with patch("agent.trading.leash_client.subprocess.run", return_value=completed) as run:
            status = client.leash_status()

        self.assertTrue(status["available"])
        self.assertEqual(status["spend_count"], "3")
        command = run.call_args.args[0]
        self.assertIn("devnet:status-json", command)
        kwargs = run.call_args.kwargs
        self.assertEqual(kwargs["env"]["SOLANA_RPC_URL"], "https://api.devnet.solana.com")
        self.assertEqual(kwargs["env"]["LEASH_PROGRAM_ID"], "EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV")
        self.assertEqual(kwargs["env"]["AGENT_WALLET_PATH"], "keys/agent-devnet.json")

    def test_leash_status_failure_is_structured(self) -> None:
        client = _client()

        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="idl missing")
        with patch("agent.trading.leash_client.subprocess.run", return_value=completed):
            status = client.leash_status()

        self.assertFalse(status["available"])
        self.assertTrue(str(status["reason"]).startswith("LEASH_STATUS_FAILED:"))


if __name__ == "__main__":
    unittest.main()
