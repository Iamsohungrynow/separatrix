from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
import os
from pathlib import Path
import subprocess

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
    project_root: str = "."
    timeout_seconds: int = 60

    def submit_trade(self, request: TradeRequest) -> TradeDecision:
        if request.side not in {"BUY", "SELL"}:
            return TradeDecision(approved=False, reason=f"UNSUPPORTED_SIDE:{request.side}")

        amount = self._format_amount(request.amount_usdc)
        if amount is None:
            return TradeDecision(approved=False, reason="INVALID_TRADE_AMOUNT")

        command = self._build_command(request.side, amount, request.sequence)
        env = os.environ.copy()
        env["SOLANA_RPC_URL"] = self.rpc_url
        env["POLICY_CONTROLLER_PROGRAM_ID"] = self.program_id
        env["AGENT_WALLET_PATH"] = self.wallet_path

        try:
            completed = subprocess.run(
                command,
                cwd=str(Path(self.project_root)),
                env=env,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except FileNotFoundError as exc:
            return TradeDecision(approved=False, reason=f"ANCHOR_SUBMISSION_UNAVAILABLE:{exc}")
        except subprocess.TimeoutExpired:
            return TradeDecision(approved=False, reason="ANCHOR_SUBMISSION_TIMEOUT")

        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "unknown error").strip()
            return TradeDecision(approved=False, reason=f"ANCHOR_SUBMISSION_FAILED:{detail[:240]}")

        payload = self._parse_submit_output(completed.stdout)
        if payload is None:
            return TradeDecision(approved=False, reason="ANCHOR_SUBMISSION_MALFORMED_OUTPUT")

        return TradeDecision(
            approved=bool(payload.get("approved", False)),
            reason=str(payload.get("reason", "APPROVED")),
            tx_signature=payload.get("tx_signature"),
        )

    def policy_status(self) -> dict[str, object]:
        command = self._build_status_command()
        env = os.environ.copy()
        env["SOLANA_RPC_URL"] = self.rpc_url
        env["POLICY_CONTROLLER_PROGRAM_ID"] = self.program_id
        env["AGENT_WALLET_PATH"] = self.wallet_path

        try:
            completed = subprocess.run(
                command,
                cwd=str(Path(self.project_root)),
                env=env,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except FileNotFoundError as exc:
            return self._unavailable_status(f"ANCHOR_STATUS_UNAVAILABLE:{exc}")
        except subprocess.TimeoutExpired:
            return self._unavailable_status("ANCHOR_STATUS_TIMEOUT")

        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "unknown error").strip()
            return self._unavailable_status(f"ANCHOR_STATUS_FAILED:{detail[:240]}")

        payload = self._parse_submit_output(completed.stdout)
        if payload is None:
            return self._unavailable_status("ANCHOR_STATUS_MALFORMED_OUTPUT")
        return payload

    @staticmethod
    def _format_amount(amount_usdc: float) -> str | None:
        try:
            amount = Decimal(str(amount_usdc))
        except InvalidOperation:
            return None

        if amount <= 0:
            return None

        return str(amount.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))

    def _build_command(self, side: str, amount: str, sequence: int) -> list[str]:
        args = ["npm", "run", "-s", "devnet:submit", "--", side, amount, str(sequence)]
        if os.name == "nt":
            return ["cmd", "/c", *args]
        return args

    def _build_status_command(self) -> list[str]:
        args = ["npm", "run", "-s", "devnet:policy-status-json"]
        if os.name == "nt":
            return ["cmd", "/c", *args]
        return args

    def _unavailable_status(self, reason: str) -> dict[str, object]:
        return {
            "available": False,
            "reason": reason,
            "rpc_url": self.rpc_url,
            "program_id": self.program_id,
        }

    @staticmethod
    def _parse_submit_output(stdout: str) -> dict[str, object] | None:
        for line in reversed(stdout.splitlines()):
            text = line.strip()
            if not text.startswith("{"):
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                return payload
        return None
