from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from agent.models import Position, Signal, utc_now_iso


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path, check_same_thread=False)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.row_factory = sqlite3.Row

    def initialize(self) -> None:
        schema_path = Path(__file__).with_name("schema.sql")
        self.connection.executescript(schema_path.read_text(encoding="utf-8"))
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def _set_meta(self, key: str, value: str) -> None:
        self.connection.execute(
            """
            INSERT INTO metadata (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )
        self.connection.commit()

    def _get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self.connection.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def ensure_cash(self, starting_cash_usdc: float) -> None:
        if self._get_meta("paper_cash_usdc") is None:
            self._set_meta("paper_cash_usdc", f"{starting_cash_usdc:.6f}")

        if self._get_meta("next_trade_sequence") is None:
            self._set_meta("next_trade_sequence", "1")

    def get_cash(self, starting_cash_usdc: float | None = None) -> float:
        raw = self._get_meta("paper_cash_usdc")
        if raw is None:
            return starting_cash_usdc if starting_cash_usdc is not None else 0.0
        return float(raw)

    def set_cash(self, value: float) -> None:
        self._set_meta("paper_cash_usdc", f"{value:.6f}")

    def get_next_trade_sequence(self) -> int:
        return int(self._get_meta("next_trade_sequence", "1"))

    def set_next_trade_sequence(self, value: int) -> None:
        self._set_meta("next_trade_sequence", str(value))

    def record_state(self, status: str) -> None:
        self._set_meta("agent_status", status)
        self._set_meta("last_cycle_at", utc_now_iso())

    def get_position(self, asset: str) -> Position:
        row = self.connection.execute(
            "SELECT asset, quantity, avg_cost FROM positions WHERE asset = ?",
            (asset,),
        ).fetchone()
        if not row:
            return Position(asset=asset, quantity=0.0, avg_cost=0.0)
        return Position(asset=row["asset"], quantity=row["quantity"], avg_cost=row["avg_cost"])

    def upsert_position(self, position: Position) -> None:
        self.connection.execute(
            """
            INSERT INTO positions (asset, quantity, avg_cost, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(asset) DO UPDATE
            SET quantity = excluded.quantity,
                avg_cost = excluded.avg_cost,
                updated_at = excluded.updated_at
            """,
            (position.asset, position.quantity, position.avg_cost, utc_now_iso()),
        )
        self.connection.commit()

    def list_positions(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT asset, quantity, avg_cost, updated_at FROM positions ORDER BY asset"
        ).fetchall()
        return [dict(row) for row in rows]

    def insert_signal(self, signal: Signal, devnet_tx: str | None = None) -> int:
        cursor = self.connection.execute(
            """
            INSERT INTO signals (
                asset,
                action,
                sentiment,
                confidence,
                position_size_usdc,
                reasoning,
                sources,
                validated,
                validation_details,
                devnet_tx,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                signal.asset,
                signal.action,
                signal.sentiment,
                signal.confidence,
                signal.position_size_usdc,
                signal.reasoning,
                json.dumps(signal.sources),
                int(signal.validated),
                json.dumps(signal.validation_details),
                devnet_tx,
                signal.timestamp,
            ),
        )
        self.connection.commit()
        return int(cursor.lastrowid)

    def record_trade(
        self,
        signal_id: int,
        asset: str,
        action: str,
        amount_usdc: float,
        price_usdc: float,
        quantity: float,
        tx_signature: str | None,
        realized_pnl: float = 0.0,
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO trades (
                signal_id,
                asset,
                action,
                amount_usdc,
                price_usdc,
                quantity,
                realized_pnl,
                tx_signature,
                executed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                signal_id,
                asset,
                action,
                amount_usdc,
                price_usdc,
                quantity,
                realized_pnl,
                tx_signature,
                utc_now_iso(),
            ),
        )
        self.connection.commit()

    def record_pnl(self, total_value_usdc: float, unrealized_pnl: float, realized_pnl: float) -> None:
        self.connection.execute(
            """
            INSERT INTO pnl_snapshots (total_value_usdc, unrealized_pnl, realized_pnl, recorded_at)
            VALUES (?, ?, ?, ?)
            """,
            (total_value_usdc, unrealized_pnl, realized_pnl, utc_now_iso()),
        )
        self.connection.commit()

    def latest_pnl(self, starting_cash_usdc: float) -> dict[str, Any]:
        row = self.connection.execute(
            """
            SELECT total_value_usdc, unrealized_pnl, realized_pnl, recorded_at
            FROM pnl_snapshots
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()
        cash = self.get_cash(starting_cash_usdc)
        if not row:
            return {
                "cash_usdc": cash,
                "total_value_usdc": cash,
                "unrealized_pnl": 0.0,
                "realized_pnl": 0.0,
                "recorded_at": None,
            }
        result = dict(row)
        result["cash_usdc"] = cash
        return result

    def latest_signal(self) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM signals ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return self._decode_signal_row(row) if row else None

    def signal_history(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM signals ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [self._decode_signal_row(row) for row in rows]

    def health_snapshot(self, network: str, policy_mode: str) -> dict[str, Any]:
        return {
            "status": self._get_meta("agent_status", "idle"),
            "last_cycle_at": self._get_meta("last_cycle_at"),
            "network": network,
            "policy_mode": policy_mode,
            "next_trade_sequence": self.get_next_trade_sequence(),
        }

    def _decode_signal_row(self, row: sqlite3.Row) -> dict[str, Any]:
        payload = dict(row)
        payload["sources"] = json.loads(payload["sources"])
        payload["validation_details"] = json.loads(payload["validation_details"])
        payload["validated"] = bool(payload["validated"])
        return payload
