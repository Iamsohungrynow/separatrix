from __future__ import annotations

import json
import unittest
from unittest.mock import AsyncMock, patch, MagicMock

import httpx

from agent.models import Signal
from agent.scoring.llm_scorer import (
    PROMPT_TEMPLATE,
    MAX_ITEMS_PER_BATCH,
    MAX_BATCHES_PER_CYCLE,
    score_items,
    _parse_scores,
    _build_prompt,
)
from agent.scoring.signal_generator import generate_signals, MAX_SIGNALS_PER_CYCLE
from agent.scoring.signal_validator import validate_signal, MAX_POSITION_SIZE_USDC


# ---------------------------------------------------------------------------
# LLM scorer
# ---------------------------------------------------------------------------

def _mock_groq_response(scores_json: list[dict]) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {
        "choices": [{"message": {"content": json.dumps(scores_json)}}]
    }
    return resp


class LlmScorerPromptTestCase(unittest.TestCase):
    def test_prompt_template_contains_json_instruction(self) -> None:
        self.assertIn("strict JSON only", PROMPT_TEMPLATE)

    def test_build_prompt_includes_items_and_assets(self) -> None:
        items = [{"title": "Test Paper", "content": "About Solana.", "source": "arxiv"}]
        prompt = _build_prompt(items, ["SOL", "RNDR"])
        self.assertIn("Test Paper", prompt)
        self.assertIn("SOL, RNDR", prompt)
        self.assertIn("[0]", prompt)

    def test_build_prompt_truncates_long_content(self) -> None:
        items = [{"title": "Long", "content": "x" * 1000, "source": "test"}]
        prompt = _build_prompt(items, ["SOL"])
        # Content truncated to 500 chars; prompt overhead is ~700 chars
        self.assertNotIn("x" * 501, prompt)


class ParseScoresTestCase(unittest.TestCase):
    def test_parses_valid_json_array(self) -> None:
        raw = json.dumps([
            {"item_index": 0, "asset": "SOL", "sentiment": 0.8, "confidence": 0.9, "reasoning": "bullish"},
        ])
        result = _parse_scores(raw, item_count=1)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["asset"], "SOL")
        self.assertAlmostEqual(result[0]["sentiment"], 0.8)

    def test_strips_markdown_fences(self) -> None:
        raw = '```json\n[{"item_index": 0, "asset": "SOL", "sentiment": 0.5, "confidence": 0.5, "reasoning": "ok"}]\n```'
        result = _parse_scores(raw, item_count=1)
        self.assertEqual(len(result), 1)

    def test_clamps_out_of_range_values(self) -> None:
        raw = json.dumps([
            {"item_index": 0, "asset": "SOL", "sentiment": 5.0, "confidence": -2.0, "reasoning": "extreme"},
        ])
        result = _parse_scores(raw, item_count=1)
        self.assertAlmostEqual(result[0]["sentiment"], 1.0)
        self.assertAlmostEqual(result[0]["confidence"], 0.0)

    def test_rejects_out_of_range_index(self) -> None:
        raw = json.dumps([
            {"item_index": 99, "asset": "SOL", "sentiment": 0.5, "confidence": 0.5, "reasoning": "ok"},
        ])
        result = _parse_scores(raw, item_count=1)
        self.assertEqual(len(result), 0)

    def test_unparseable_json_returns_empty(self) -> None:
        result = _parse_scores("this is not json", item_count=1)
        self.assertEqual(result, [])

    def test_non_array_json_returns_empty(self) -> None:
        result = _parse_scores('{"not": "an array"}', item_count=1)
        self.assertEqual(result, [])

    def test_malformed_entries_skipped(self) -> None:
        raw = json.dumps([
            {"item_index": 0, "asset": "SOL", "sentiment": 0.5, "confidence": 0.5, "reasoning": "ok"},
            "not a dict",
            {"item_index": "bad", "asset": "SOL"},  # bad index type
        ])
        result = _parse_scores(raw, item_count=1)
        # Only the first valid entry survives
        self.assertEqual(len(result), 1)


class ScoreItemsTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_no_items_returns_empty(self) -> None:
        result = await score_items(items=[], groq_api_key="test-key")
        self.assertEqual(result, [])

    async def test_no_api_key_returns_empty(self) -> None:
        items = [{"title": "test", "content": "test"}]
        result = await score_items(items=items, groq_api_key="")
        self.assertEqual(result, [])

    @patch("agent.scoring.llm_scorer.httpx.AsyncClient")
    async def test_scores_single_batch(self, mock_client_cls: MagicMock) -> None:
        scores_json = [
            {"item_index": 0, "asset": "SOL", "sentiment": 0.7, "confidence": 0.85, "reasoning": "good"},
        ]
        mock_client = AsyncMock()
        mock_client.post.return_value = _mock_groq_response(scores_json)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        items = [{"title": "Test", "content": "Solana news", "source": "arxiv"}]
        result = await score_items(items=items, groq_api_key="test-key")

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["asset"], "SOL")
        self.assertIn("model", result[0])
        self.assertIn("scored_at", result[0])

    @patch("agent.scoring.llm_scorer.httpx.AsyncClient")
    async def test_respects_batch_limits(self, mock_client_cls: MagicMock) -> None:
        """Items beyond MAX_ITEMS_PER_BATCH * MAX_BATCHES_PER_CYCLE are dropped."""
        mock_client = AsyncMock()
        mock_client.post.return_value = _mock_groq_response([])
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        many_items = [{"title": f"item {i}", "content": "c"} for i in range(50)]
        await score_items(items=many_items, groq_api_key="test-key")

        # Should make at most MAX_BATCHES_PER_CYCLE API calls
        self.assertLessEqual(mock_client.post.call_count, MAX_BATCHES_PER_CYCLE)

    @patch("agent.scoring.llm_scorer.httpx.AsyncClient")
    async def test_http_error_skips_batch(self, mock_client_cls: MagicMock) -> None:
        mock_client = AsyncMock()
        mock_client.post.side_effect = httpx.HTTPStatusError(
            "rate limited", request=MagicMock(), response=MagicMock(status_code=429)
        )
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        items = [{"title": "test", "content": "test"}]
        result = await score_items(items=items, groq_api_key="test-key")

        self.assertEqual(result, [])


# ---------------------------------------------------------------------------
# Signal generator
# ---------------------------------------------------------------------------

class SignalGeneratorTestCase(unittest.TestCase):
    def test_empty_scores_returns_empty(self) -> None:
        self.assertEqual(generate_signals(scores=[]), [])

    def test_none_scores_returns_empty(self) -> None:
        self.assertEqual(generate_signals(scores=None), [])

    def test_generates_buy_signal_from_positive_sentiment(self) -> None:
        scores = [
            {"asset": "SOL", "sentiment": 0.8, "confidence": 0.9, "reasoning": "bullish", "model": "test"},
        ]
        signals = generate_signals(
            scores=scores,
            sentiment_threshold=0.6,
            confidence_threshold=0.7,
        )
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].action, "BUY")
        self.assertEqual(signals[0].asset, "SOL")
        self.assertFalse(signals[0].validated)  # must pass validation first

    def test_generates_sell_signal_from_negative_sentiment(self) -> None:
        scores = [
            {"asset": "RNDR", "sentiment": -0.75, "confidence": 0.8, "reasoning": "bearish", "model": "test"},
        ]
        signals = generate_signals(scores=scores, sentiment_threshold=0.6, confidence_threshold=0.7)
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].action, "SELL")

    def test_filters_below_threshold(self) -> None:
        scores = [
            {"asset": "SOL", "sentiment": 0.3, "confidence": 0.9, "reasoning": "weak"},  # low sentiment
            {"asset": "RNDR", "sentiment": 0.8, "confidence": 0.4, "reasoning": "low conf"},  # low confidence
        ]
        signals = generate_signals(scores=scores, sentiment_threshold=0.6, confidence_threshold=0.7)
        self.assertEqual(len(signals), 0)

    def test_keeps_best_score_per_asset(self) -> None:
        scores = [
            {"asset": "SOL", "sentiment": 0.7, "confidence": 0.75, "reasoning": "ok", "model": "test"},
            {"asset": "SOL", "sentiment": 0.9, "confidence": 0.95, "reasoning": "better", "model": "test"},
        ]
        signals = generate_signals(scores=scores, sentiment_threshold=0.6, confidence_threshold=0.7)
        self.assertEqual(len(signals), 1)
        self.assertAlmostEqual(signals[0].confidence, 0.95)

    def test_caps_at_max_signals(self) -> None:
        scores = [
            {"asset": f"ASSET{i}", "sentiment": 0.8, "confidence": 0.9, "reasoning": "x", "model": "t"}
            for i in range(10)
        ]
        signals = generate_signals(
            scores=scores,
            tracked_assets=[f"ASSET{i}" for i in range(10)],
            sentiment_threshold=0.6,
            confidence_threshold=0.7,
        )
        self.assertLessEqual(len(signals), MAX_SIGNALS_PER_CYCLE)

    def test_position_size_clamped_to_limit(self) -> None:
        scores = [
            {"asset": "SOL", "sentiment": 0.9, "confidence": 1.0, "reasoning": "max", "model": "test"},
        ]
        signals = generate_signals(
            scores=scores,
            sentiment_threshold=0.6,
            confidence_threshold=0.7,
            base_trade_amount_usdc=100.0,
            per_trade_buy_limit_usdc=5.0,
        )
        self.assertEqual(len(signals), 1)
        self.assertLessEqual(signals[0].position_size_usdc, 5.0)

    def test_ignores_untracked_assets(self) -> None:
        scores = [
            {"asset": "UNKNOWN", "sentiment": 0.9, "confidence": 0.9, "reasoning": "x", "model": "t"},
        ]
        signals = generate_signals(
            scores=scores,
            tracked_assets=["SOL"],
            sentiment_threshold=0.6,
            confidence_threshold=0.7,
        )
        self.assertEqual(len(signals), 0)


# ---------------------------------------------------------------------------
# Signal validator
# ---------------------------------------------------------------------------

class SignalValidatorTestCase(unittest.TestCase):
    def test_none_signal_returns_empty_dict(self) -> None:
        self.assertEqual(validate_signal(signal=None), {})

    def test_valid_buy_signal_passes(self) -> None:
        signal = Signal(
            asset="SOL", action="BUY", sentiment=0.8, confidence=0.9,
            position_size_usdc=5.0, reasoning="test",
        )
        result = validate_signal(
            signal=signal,
            current_cash_usdc=100.0,
            portfolio_value_usdc=1000.0,
        )
        self.assertTrue(result["valid"])
        self.assertTrue(result["checks"]["valid_action"])
        self.assertTrue(result["checks"]["sufficient_cash"])

    def test_valid_sell_signal_passes(self) -> None:
        signal = Signal(
            asset="SOL", action="SELL", sentiment=-0.7, confidence=0.8,
            position_size_usdc=5.0, reasoning="test",
        )
        result = validate_signal(signal=signal, current_cash_usdc=100.0)
        self.assertTrue(result["valid"])

    def test_rejects_invalid_action(self) -> None:
        signal = Signal(
            asset="SOL", action="HOLD", sentiment=0.5, confidence=0.5,
            position_size_usdc=5.0, reasoning="test",
        )
        result = validate_signal(signal=signal)
        self.assertFalse(result["valid"])
        self.assertFalse(result["checks"]["valid_action"])

    def test_rejects_insufficient_cash(self) -> None:
        signal = Signal(
            asset="SOL", action="BUY", sentiment=0.8, confidence=0.9,
            position_size_usdc=50.0, reasoning="test",
        )
        result = validate_signal(signal=signal, current_cash_usdc=10.0)
        self.assertFalse(result["valid"])
        self.assertFalse(result["checks"]["sufficient_cash"])

    def test_rejects_oversized_position(self) -> None:
        signal = Signal(
            asset="SOL", action="BUY", sentiment=0.8, confidence=0.9,
            position_size_usdc=MAX_POSITION_SIZE_USDC + 1,
            reasoning="test",
        )
        result = validate_signal(signal=signal, current_cash_usdc=1000.0)
        self.assertFalse(result["valid"])
        self.assertFalse(result["checks"]["size_within_cap"])

    def test_rejects_zero_position_size(self) -> None:
        signal = Signal(
            asset="SOL", action="BUY", sentiment=0.8, confidence=0.9,
            position_size_usdc=0, reasoning="test",
        )
        result = validate_signal(signal=signal, current_cash_usdc=1000.0)
        self.assertFalse(result["valid"])

    def test_rejects_low_confidence(self) -> None:
        signal = Signal(
            asset="SOL", action="BUY", sentiment=0.8, confidence=0.05,
            position_size_usdc=5.0, reasoning="test",
        )
        result = validate_signal(signal=signal, current_cash_usdc=100.0)
        self.assertFalse(result["valid"])
        self.assertFalse(result["checks"]["confidence_above_min"])

    def test_rejects_sentiment_action_mismatch(self) -> None:
        signal = Signal(
            asset="SOL", action="BUY", sentiment=-0.8, confidence=0.9,
            position_size_usdc=5.0, reasoning="contradictory",
        )
        result = validate_signal(signal=signal, current_cash_usdc=100.0)
        self.assertFalse(result["valid"])
        self.assertFalse(result["checks"]["sentiment_action_consistent"])

    def test_rejects_concentration_breach(self) -> None:
        signal = Signal(
            asset="SOL", action="BUY", sentiment=0.8, confidence=0.9,
            position_size_usdc=30.0, reasoning="big position",
        )
        result = validate_signal(
            signal=signal,
            current_cash_usdc=100.0,
            portfolio_value_usdc=100.0,
            max_position_pct=0.20,
        )
        self.assertFalse(result["valid"])
        self.assertFalse(result["checks"]["within_concentration_limit"])

    def test_all_checks_are_explicit(self) -> None:
        """Every check result should be a boolean in the checks dict."""
        signal = Signal(
            asset="SOL", action="BUY", sentiment=0.8, confidence=0.9,
            position_size_usdc=5.0, reasoning="test",
        )
        result = validate_signal(
            signal=signal,
            current_cash_usdc=100.0,
            portfolio_value_usdc=1000.0,
        )
        for key, value in result["checks"].items():
            self.assertIsInstance(value, bool, f"check '{key}' is not a bool")


if __name__ == "__main__":
    unittest.main()
