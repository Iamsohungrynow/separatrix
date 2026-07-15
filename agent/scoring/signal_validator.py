from __future__ import annotations

import logging
from typing import Any

from agent.models import Signal

logger = logging.getLogger("qubitalpha.scoring.signal_validator")

# Hard limits — signals outside these bounds are rejected outright.
MAX_POSITION_SIZE_USDC = 50.0
MIN_CONFIDENCE = 0.1
MAX_SENTIMENT_MAGNITUDE = 1.0


def validate_signal(
    signal: Signal | None = None,
    current_cash_usdc: float = 0.0,
    max_position_pct: float = 0.20,
    portfolio_value_usdc: float = 0.0,
) -> dict[str, Any]:
    """Run anti-poisoning and sanity checks on a generated signal.

    This is the off-chain safety gate before a signal reaches the executor.
    The on-chain policy controller enforces BUY caps separately.

    Parameters
    ----------
    signal:
        The signal to validate.  If *None*, returns an empty dict (backward
        compat with the old placeholder).
    current_cash_usdc:
        Available paper cash for BUY feasibility check.
    max_position_pct:
        Maximum fraction of portfolio any single asset may represent.
    portfolio_value_usdc:
        Total portfolio value (cash + positions) for concentration check.

    Returns
    -------
    dict[str, Any]
        ``{"valid": bool, "reason": str, "checks": dict}`` — every check
        result is explicit so callers can audit what passed and what failed.
    """
    if signal is None:
        return {}

    checks: dict[str, bool] = {}
    reasons: list[str] = []

    # 1. Action must be BUY or SELL.
    checks["valid_action"] = signal.action in {"BUY", "SELL"}
    if not checks["valid_action"]:
        reasons.append(f"invalid action: {signal.action}")

    # 2. Sentiment magnitude must be within [-1, 1].
    magnitude = abs(signal.sentiment)
    checks["sentiment_in_range"] = magnitude <= MAX_SENTIMENT_MAGNITUDE
    if not checks["sentiment_in_range"]:
        reasons.append(f"sentiment out of range: {signal.sentiment}")

    # 3. Confidence must be positive and meaningful.
    checks["confidence_above_min"] = signal.confidence >= MIN_CONFIDENCE
    if not checks["confidence_above_min"]:
        reasons.append(f"confidence too low: {signal.confidence}")

    # 4. Position size must be positive and within hard cap.
    checks["size_positive"] = signal.position_size_usdc > 0
    checks["size_within_cap"] = signal.position_size_usdc <= MAX_POSITION_SIZE_USDC
    if not checks["size_positive"]:
        reasons.append("position size <= 0")
    if not checks["size_within_cap"]:
        reasons.append(f"position size ${signal.position_size_usdc} exceeds cap ${MAX_POSITION_SIZE_USDC}")

    # 5. BUY-specific: must have enough cash.
    if signal.action == "BUY":
        checks["sufficient_cash"] = signal.position_size_usdc <= current_cash_usdc
        if not checks["sufficient_cash"]:
            reasons.append(
                f"insufficient cash: need ${signal.position_size_usdc}, have ${current_cash_usdc}"
            )

    # 6. Concentration check: position must not exceed max_position_pct of portfolio.
    if portfolio_value_usdc > 0 and signal.action == "BUY":
        max_allowed = portfolio_value_usdc * max_position_pct
        checks["within_concentration_limit"] = signal.position_size_usdc <= max_allowed
        if not checks["within_concentration_limit"]:
            reasons.append(
                f"would exceed {max_position_pct:.0%} concentration limit "
                f"(${signal.position_size_usdc} > ${max_allowed:.2f})"
            )

    # 7. Sentiment-action consistency: BUY should have positive sentiment, SELL negative.
    if checks.get("valid_action", False):
        if signal.action == "BUY":
            checks["sentiment_action_consistent"] = signal.sentiment > 0
        else:
            checks["sentiment_action_consistent"] = signal.sentiment < 0
        if not checks["sentiment_action_consistent"]:
            reasons.append(
                f"sentiment {signal.sentiment} inconsistent with {signal.action}"
            )

    is_valid = all(checks.values())

    if not is_valid:
        logger.warning("signal rejected for %s %s: %s", signal.action, signal.asset, "; ".join(reasons))
    else:
        logger.info("signal validated: %s %s $%.2f", signal.action, signal.asset, signal.position_size_usdc)

    return {
        "valid": is_valid,
        "reason": "; ".join(reasons) if reasons else "all checks passed",
        "checks": checks,
    }
