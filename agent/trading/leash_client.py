from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
import os
from pathlib import Path
import subprocess

from agent.models import SpendDecision, SpendRequest


def _utc_day_index() -> int:
    return int(datetime.now(timezone.utc).timestamp() // 86_400)


@dataclass(slots=True)
class LocalLeashClient:
    """In-process simulator of the on-chain leash rules, for offline runs and tests."""

    per_tx_cap_sol: float
    daily_cap_sol: float
    _day_index: int = field(init=False, repr=False)
    _spent_today_sol: float = field(init=False, repr=False, default=0.0)
    _spend_count: int = field(init=False, repr=False, default=0)
    _halted: bool = field(init=False, repr=False, default=False)

    def __post_init__(self) -> None:
        self._day_index = _utc_day_index()
        self._spent_today_sol = 0.0
        self._spend_count = 0
        self._halted = False

    def request_spend(self, request: SpendRequest) -> SpendDecision:
        if self._halted:
            return SpendDecision(approved=False, reason="LEASH_HALTED")

        self._roll_day_if_needed()

        if request.amount_sol <= 0:
            return SpendDecision(approved=False, reason="INVALID_AMOUNT")

        if request.amount_sol > self.per_tx_cap_sol:
            return SpendDecision(approved=False, reason="PER_TX_CAP_EXCEEDED")

        projected = self._spent_today_sol + request.amount_sol
        if projected > self.daily_cap_sol:
            return SpendDecision(approved=False, reason="DAILY_CAP_EXCEEDED")

        self._spent_today_sol = projected
        self._spend_count += 1
        return SpendDecision(
            approved=True,
            reason="APPROVED",
            tx_signature=f"LOCAL-{self._spend_count:06d}",
        )

    def set_halt(self, halted: bool) -> None:
        self._halted = halted

    def _roll_day_if_needed(self) -> None:
        day_index = _utc_day_index()
        if day_index != self._day_index:
            self._day_index = day_index
            self._spent_today_sol = 0.0


@dataclass(slots=True)
class AnchorLeashClient:
    """Submits spends through the deployed leash program via the TypeScript bridge.

    Fails closed: any bridge error is a rejection, never a silent approval.
    """

    rpc_url: str
    program_id: str
    wallet_path: str
    project_root: str = "."
    timeout_seconds: int = 60

    def request_spend(self, request: SpendRequest) -> SpendDecision:
        amount = self._format_amount(request.amount_sol)
        if amount is None:
            return SpendDecision(approved=False, reason="INVALID_AMOUNT")

        command = self._build_spend_command(amount, request.recipient)

        try:
            completed = subprocess.run(
                command,
                cwd=str(Path(self.project_root)),
                env=self._env(),
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except FileNotFoundError as exc:
            return SpendDecision(approved=False, reason=f"LEASH_SUBMISSION_UNAVAILABLE:{exc}")
        except subprocess.TimeoutExpired:
            return SpendDecision(approved=False, reason="LEASH_SUBMISSION_TIMEOUT")

        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "unknown error").strip()
            return SpendDecision(approved=False, reason=f"LEASH_SUBMISSION_FAILED:{detail[:240]}")

        payload = self._parse_json_output(completed.stdout)
        if payload is None:
            return SpendDecision(approved=False, reason="LEASH_SUBMISSION_MALFORMED_OUTPUT")

        return SpendDecision(
            approved=bool(payload.get("approved", False)),
            reason=str(payload.get("reason", "APPROVED")),
            tx_signature=payload.get("tx_signature"),
        )

    def leash_status(self) -> dict[str, object]:
        command = self._build_status_command()

        try:
            completed = subprocess.run(
                command,
                cwd=str(Path(self.project_root)),
                env=self._env(),
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except FileNotFoundError as exc:
            return self._unavailable_status(f"LEASH_STATUS_UNAVAILABLE:{exc}")
        except subprocess.TimeoutExpired:
            return self._unavailable_status("LEASH_STATUS_TIMEOUT")

        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "unknown error").strip()
            return self._unavailable_status(f"LEASH_STATUS_FAILED:{detail[:240]}")

        payload = self._parse_json_output(completed.stdout)
        if payload is None:
            return self._unavailable_status("LEASH_STATUS_MALFORMED_OUTPUT")
        return payload

    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        env["SOLANA_RPC_URL"] = self.rpc_url
        env["LEASH_PROGRAM_ID"] = self.program_id
        env["AGENT_WALLET_PATH"] = self.wallet_path
        return env

    @staticmethod
    def _format_amount(amount_sol: float) -> str | None:
        try:
            amount = Decimal(str(amount_sol))
        except InvalidOperation:
            return None

        if amount <= 0:
            return None

        return str(amount.quantize(Decimal("0.000000001"), rounding=ROUND_HALF_UP))

    def _build_spend_command(self, amount: str, recipient: str | None) -> list[str]:
        args = ["npm", "run", "-s", "devnet:spend", "--", amount]
        if recipient:
            args.append(recipient)
        if os.name == "nt":
            return ["cmd", "/c", *args]
        return args

    def _build_status_command(self) -> list[str]:
        args = ["npm", "run", "-s", "devnet:status-json"]
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
    def _parse_json_output(stdout: str) -> dict[str, object] | None:
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
