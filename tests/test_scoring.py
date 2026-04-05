from __future__ import annotations

import unittest

from agent.scoring.llm_scorer import PROMPT_TEMPLATE, score_items
from agent.scoring.signal_generator import generate_signals
from agent.scoring.signal_validator import validate_signal


class ScoringPlaceholderTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_placeholder_llm_scorer_returns_empty_scores(self) -> None:
        self.assertIn("strict JSON only", PROMPT_TEMPLATE)
        self.assertEqual(await score_items(), [])


class SignalPipelinePlaceholderTestCase(unittest.TestCase):
    def test_placeholder_signal_pipeline_returns_empty_results(self) -> None:
        self.assertEqual(generate_signals(), [])
        self.assertEqual(validate_signal(), {})


if __name__ == "__main__":
    unittest.main()
