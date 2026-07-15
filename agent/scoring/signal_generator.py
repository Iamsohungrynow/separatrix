from __future__ import annotations

import logging
from typing import Any

from agent.models import Signal

logger = logging.getLogger("qubitalpha.scoring.signal_generator")

# Hard limits on generated signals per cycle.
MAX_SIGNALS_PER_CYCLE = 3


def generate_signals(
    scores: list[dict[str, Any]] | None = None,
    tracked_assets: list[str] | None = None,
    sentiment_threshold: float = 0.6,
    confidence_threshold: float = 0.7,
    base_trade_amount_usdc: float = 5.0,
    per_trade_buy_limit_usdc: float = 5.0,
) -> list[Signal]:
    """Aggregate LLM scores into actionable trade signals.

    For each tracked asset, the best score (highest confidence above thresholds)
    becomes a signal.  Signals are capped at ``MAX_SIGNALS_PER_CYCLE``.

    Parameters
    ----------
    scores:
        Output from ``score_items()`` — dicts with ``asset``, ``sentiment``,
        ``confidence``, ``reasoning``.
    tracked_assets:
        Restrict signals to these tickers only.
    sentiment_threshold:
        Minimum absolute sentiment to consider a signal actionable.
    confidence_threshold:
        Minimum confidence to consider a signal actionable.
    base_trade_amount_usdc:
        Default position size before clamping.
    per_trade_buy_limit_usdc:
        Maximum USDC per trade (from policy config).

    Returns
    -------
    list[Signal]
        At most ``MAX_SIGNALS_PER_CYCLE`` signals, sorted by confidence desc.
    """
    if not scores:
        return []

    if tracked_assets is None:
        tracked_assets = ["SOL", "RNDR", "IO", "PYTH"]

    tracked_set = set(tracked_assets)

    # Group scores by asset; keep only the highest-confidence score per asset.
    best_per_asset: dict[str, dict[str, Any]] = {}
    for score in scores:
        asset = score.get("asset", "")
        if asset not in tracked_set:
            continue

        confidence = score.get("confidence", 0.0)
        sentiment = score.get("sentiment", 0.0)

        # Filter: must exceed both thresholds.
        if confidence < confidence_threshold:
            continue
        if abs(sentiment) < sentiment_threshold:
            continue

        existing = best_per_asset.get(asset)
        if existing is None or confidence > existing.get("confidence", 0.0):
            best_per_asset[asset] = score

    # Convert to Signal objects.
    signals: list[Signal] = []
    for asset, score in best_per_asset.items():
        sentiment = score["sentiment"]
        confidence = score["confidence"]
        reasoning = score.get("reasoning", "")

        action = "BUY" if sentiment > 0 else "SELL"

        # Scale position size by confidence, clamp to policy limit.
        raw_size = base_trade_amount_usdc * confidence
        position_size = min(raw_size, per_trade_buy_limit_usdc)
        position_size = max(0.01, position_size)  # floor at 1 cent

        sources: list[str] = []
        model = score.get("model", "")
        if model:
            sources.append(f"groq://{model}")

        signals.append(Signal(
            asset=asset,
            action=action,
            sentiment=sentiment,
            confidence=confidence,
            position_size_usdc=round(position_size, 2),
            reasoning=reasoning,
            sources=sources,
            validated=False,  # must pass validation before execution
        ))

    # Sort by confidence descending, cap output.
    signals.sort(key=lambda s: s.confidence, reverse=True)
    if len(signals) > MAX_SIGNALS_PER_CYCLE:
        logger.info("capping signals from %d to %d", len(signals), MAX_SIGNALS_PER_CYCLE)
        signals = signals[:MAX_SIGNALS_PER_CYCLE]

    logger.info(
        "generated %d signals from %d scores (%d assets above threshold)",
        len(signals),
        len(scores),
        len(best_per_asset),
    )
    return signals
