from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass(slots=True)
class Signal:
    asset: str
    action: str
    sentiment: float
    confidence: float
    position_size_usdc: float
    reasoning: str
    sources: list[str] = field(default_factory=list)
    validated: bool = True
    validation_details: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=utc_now_iso)


@dataclass(slots=True)
class Position:
    asset: str
    quantity: float
    avg_cost: float


@dataclass(slots=True)
class SpendRequest:
    amount_sol: float
    recipient: str | None = None


@dataclass(slots=True)
class SpendDecision:
    approved: bool
    reason: str
    tx_signature: str | None = None


@dataclass(slots=True)
class ExecutionResult:
    approved: bool
    reason: str
    tx_signature: str | None = None
    quantity: float = 0.0
    realized_pnl: float = 0.0
