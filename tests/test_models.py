from __future__ import annotations

import unittest

from agent.models import ExecutionResult, Signal, SpendDecision, utc_now_iso


class ModelsTestCase(unittest.TestCase):
    def test_utc_timestamp_uses_z_suffix(self) -> None:
        timestamp = utc_now_iso()

        self.assertTrue(timestamp.endswith("Z"))
        self.assertNotIn(".", timestamp)

    def test_signal_defaults_are_initialized(self) -> None:
        signal = Signal(
            asset="SOL",
            action="BUY",
            sentiment=0.7,
            confidence=0.8,
            position_size_usdc=5.0,
            reasoning="model defaults",
        )

        self.assertEqual(signal.sources, [])
        self.assertTrue(signal.validated)
        self.assertEqual(signal.validation_details, {})
        self.assertTrue(signal.timestamp.endswith("Z"))

    def test_trade_result_defaults_are_zeroed(self) -> None:
        decision = SpendDecision(approved=True, reason="APPROVED")
        result = ExecutionResult(approved=False, reason="REJECTED")

        self.assertIsNone(decision.tx_signature)
        self.assertIsNone(result.tx_signature)
        self.assertEqual(result.quantity, 0.0)
        self.assertEqual(result.realized_pnl, 0.0)


if __name__ == "__main__":
    unittest.main()
