from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from agent.models import TradeDecision, TradeRequest


def _utc_day_index() -> int:
    return int(datetime.now(timezone.utc).timestamp() // 86_400)


@dataclass(slots=True)
class LocalPolicyClient:
    daily_buy_limit_usdc: float
    per_trade_buy_limit_usdc: float
    starting_sequence: int = 1
    _day_index: int = field(init=False, repr=False)
    _daily_buy_used_usdc: float = field(init=False, repr=False, default=0.0)
    _next_sequence: int = field(init=False, repr=False)
    _halted: bool = field(init=False, repr=False, default=False)

    def __post_init__(self) -> None:
        self._day_index = _utc_day_index()
        self._daily_buy_used_usdc = 0.0
        self._next_sequence = self.starting_sequence
        self._halted = False

    def submit_trade(self, request: TradeRequest) -> TradeDecision:
        if self._halted:
            return TradeDecision(approved=False, reason="POLICY_HALTED")

        self._roll_day_if_needed()

        if request.sequence != self._next_sequence:
            return TradeDecision(approved=False, reason="INVALID_TRADE_SEQUENCE")

        if request.side == "BUY":
            if request.amount_usdc > self.per_trade_buy_limit_usdc:
                return TradeDecision(approved=False, reason="TRADE_TOO_BIG")

            projected = self._daily_buy_used_usdc + request.amount_usdc
            if projected > self.daily_buy_limit_usdc:
                return TradeDecision(approved=False, reason="DAILY_LIMIT_EXCEEDED")

            self._daily_buy_used_usdc = projected

        self._next_sequence += 1
        return TradeDecision(
            approved=True,
            reason="APPROVED",
            tx_signature=f"LOCAL-{request.sequence:06d}",
        )

    def set_halt(self, halted: bool) -> None:
        self._halted = halted

    def _roll_day_if_needed(self) -> None:
        day_index = _utc_day_index()
        if day_index != self._day_index:
            self._day_index = day_index
            self._daily_buy_used_usdc = 0.0


@dataclass(slots=True)
class AnchorPolicyClient:
    rpc_url: str
    program_id: str
    wallet_path: str

    def submit_trade(self, request: TradeRequest) -> TradeDecision:
        raise NotImplementedError(
            "Anchor devnet submission is scaffolded but not wired yet. "
            "Use LocalPolicyClient until anchorpy integration is added."
        )
