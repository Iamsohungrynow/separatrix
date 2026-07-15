from __future__ import annotations

from dataclasses import dataclass

from agent.db.database import Database
from agent.models import ExecutionResult, Position, Signal, SpendDecision, SpendRequest


@dataclass(slots=True)
class PaperTradeExecutor:
    """Paper-trades signals, but every BUY must clear the leash first.

    The leash client meters real devnet SOL out of the guarded vault: a BUY of
    N paper-USDC requests a spend of N * sol_per_usdc_budget SOL. If the
    on-chain policy blocks the spend, the paper trade does not happen either.
    SELLs release no vault funds, so they need no on-chain approval.
    """

    db: Database
    leash_client: object
    starting_cash_usdc: float
    sol_per_usdc_budget: float = 0.001
    spend_recipient: str | None = None

    def execute(self, signal: Signal, price_usdc: float) -> ExecutionResult:
        self.db.ensure_cash(self.starting_cash_usdc)
        precheck_failure = self._precheck(signal, price_usdc)
        if precheck_failure is not None:
            return ExecutionResult(approved=False, reason=precheck_failure)

        if signal.action == "BUY":
            decision = self.leash_client.request_spend(
                SpendRequest(
                    amount_sol=signal.position_size_usdc * self.sol_per_usdc_budget,
                    recipient=self.spend_recipient,
                )
            )
        else:
            decision = SpendDecision(approved=True, reason="NO_ONCHAIN_SPEND")

        if not decision.approved:
            return ExecutionResult(approved=False, reason=decision.reason, tx_signature=decision.tx_signature)

        sequence = self.db.get_next_trade_sequence()
        with self.db.transaction():
            if signal.action == "BUY":
                result = self._execute_buy(signal, price_usdc, decision.tx_signature)
            else:
                result = self._execute_sell(signal, price_usdc, decision.tx_signature)

            if result.approved:
                self.db.set_next_trade_sequence(sequence + 1)

        return result

    def _precheck(self, signal: Signal, price_usdc: float) -> str | None:
        if signal.action not in {"BUY", "SELL"}:
            return f"UNSUPPORTED_ACTION:{signal.action}"

        if signal.position_size_usdc <= 0:
            return "INVALID_TRADE_AMOUNT"

        if price_usdc <= 0:
            return "INVALID_PRICE"

        if signal.action == "BUY":
            cash = self.db.get_cash(self.starting_cash_usdc)
            if signal.position_size_usdc > cash:
                return "INSUFFICIENT_CASH"
            return None

        position = self.db.get_position(signal.asset)
        if position.quantity <= 0:
            return "NO_POSITION"
        return None

    def _execute_buy(self, signal: Signal, price_usdc: float, tx_signature: str | None) -> ExecutionResult:
        cash = self.db.get_cash(self.starting_cash_usdc)
        amount = signal.position_size_usdc

        quantity = amount / price_usdc
        position = self.db.get_position(signal.asset)
        total_cost = (position.quantity * position.avg_cost) + amount
        total_quantity = position.quantity + quantity
        average_cost = total_cost / total_quantity if total_quantity else 0.0

        signal_id = self.db.insert_signal(signal, devnet_tx=tx_signature)
        self.db.record_trade(
            signal_id=signal_id,
            asset=signal.asset,
            action="BUY",
            amount_usdc=amount,
            price_usdc=price_usdc,
            quantity=quantity,
            tx_signature=tx_signature,
        )
        self.db.set_cash(cash - amount)
        self.db.upsert_position(Position(asset=signal.asset, quantity=total_quantity, avg_cost=average_cost))
        self._record_pnl(price_usdc, realized_delta=0.0, asset=signal.asset)

        return ExecutionResult(
            approved=True,
            reason="EXECUTED",
            tx_signature=tx_signature,
            quantity=quantity,
        )

    def _execute_sell(self, signal: Signal, price_usdc: float, tx_signature: str | None) -> ExecutionResult:
        position = self.db.get_position(signal.asset)
        requested_quantity = signal.position_size_usdc / price_usdc
        quantity = min(position.quantity, requested_quantity)
        proceeds = quantity * price_usdc
        realized_pnl = quantity * (price_usdc - position.avg_cost)
        remaining_quantity = position.quantity - quantity
        remaining_avg_cost = position.avg_cost if remaining_quantity > 0 else 0.0

        signal_id = self.db.insert_signal(signal, devnet_tx=tx_signature)
        self.db.record_trade(
            signal_id=signal_id,
            asset=signal.asset,
            action="SELL",
            amount_usdc=proceeds,
            price_usdc=price_usdc,
            quantity=quantity,
            tx_signature=tx_signature,
            realized_pnl=realized_pnl,
        )
        self.db.set_cash(self.db.get_cash(self.starting_cash_usdc) + proceeds)
        self.db.upsert_position(
            Position(asset=signal.asset, quantity=remaining_quantity, avg_cost=remaining_avg_cost)
        )
        self._record_pnl(price_usdc, realized_delta=realized_pnl, asset=signal.asset)

        return ExecutionResult(
            approved=True,
            reason="EXECUTED",
            tx_signature=tx_signature,
            quantity=quantity,
            realized_pnl=realized_pnl,
        )

    def _record_pnl(self, market_price_usdc: float, realized_delta: float, asset: str = "") -> None:
        cash = self.db.get_cash(self.starting_cash_usdc)
        positions = self.db.list_positions()
        market_value = 0.0
        unrealized_pnl = 0.0
        for p in positions:
            if p["asset"] == asset:
                market_value += p["quantity"] * market_price_usdc
                unrealized_pnl += p["quantity"] * (market_price_usdc - p["avg_cost"])
            else:
                market_value += p["quantity"] * p["avg_cost"]
        total_value = cash + market_value
        realized_pnl = 0.0
        latest = self.db.latest_pnl(self.starting_cash_usdc)
        if latest["recorded_at"] is not None:
            realized_pnl = latest["realized_pnl"]
        self.db.record_pnl(
            total_value_usdc=total_value,
            unrealized_pnl=unrealized_pnl,
            realized_pnl=realized_pnl + realized_delta,
        )
