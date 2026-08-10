from __future__ import annotations

from contextlib import contextmanager
import json
import sqlite3
from pathlib import Path
from typing import Any, Iterator

from agent.models import Position, Signal, utc_now_iso


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path, check_same_thread=False)
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.row_factory = sqlite3.Row
        self._transaction_depth = 0

    def initialize(self) -> None:
        schema_path = Path(__file__).with_name("schema.sql")
        self.connection.executescript(schema_path.read_text(encoding="utf-8"))
        self._commit()

    def close(self) -> None:
        self.connection.close()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        is_outer = self._transaction_depth == 0
        self._transaction_depth += 1
        try:
            yield
        except Exception:
            self._transaction_depth -= 1
            if is_outer:
                self.connection.rollback()
            raise
        else:
            self._transaction_depth -= 1
            if is_outer:
                self.connection.commit()

    def _commit(self) -> None:
        if self._transaction_depth == 0:
            self.connection.commit()

    def _set_meta(self, key: str, value: str) -> None:
        self.connection.execute(
            """
            INSERT INTO metadata (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )
        self._commit()

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
        self._commit()

    def list_positions(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT asset, quantity, avg_cost, updated_at FROM positions ORDER BY asset"
        ).fetchall()
        return [dict(row) for row in rows]

    def upsert_raw_item(self, item: dict[str, Any]) -> int:
        self.connection.execute(
            """
            INSERT INTO raw_items (
                source,
                url,
                url_hash,
                title,
                content,
                published_at,
                fetched_at,
                metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url_hash) DO UPDATE SET
                source = excluded.source,
                url = excluded.url,
                title = excluded.title,
                content = excluded.content,
                published_at = excluded.published_at,
                fetched_at = excluded.fetched_at,
                metadata = excluded.metadata
            """,
            (
                item["source"],
                item["url"],
                item["url_hash"],
                item["title"],
                item.get("content", ""),
                item.get("published_at", ""),
                item["fetched_at"],
                item.get("metadata", "{}"),
            ),
        )
        self._commit()
        row = self.connection.execute(
            "SELECT id FROM raw_items WHERE url_hash = ?",
            (item["url_hash"],),
        ).fetchone()
        if row is None:
            raise RuntimeError("raw item upsert did not return a row")
        return int(row["id"])

    def upsert_raw_items(self, items: list[dict[str, Any]]) -> list[int]:
        return [self.upsert_raw_item(item) for item in items]

    def insert_score(self, raw_item_id: int, score: dict[str, Any]) -> int:
        cursor = self.connection.execute(
            """
            INSERT INTO scores (
                raw_item_id,
                asset,
                sentiment,
                confidence,
                reasoning,
                model,
                scored_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                raw_item_id,
                str(score.get("asset", "")),
                float(score.get("sentiment", 0.0)),
                float(score.get("confidence", 0.0)),
                str(score.get("reasoning", "")),
                str(score.get("model", "unknown")),
                str(score.get("scored_at", utc_now_iso())),
            ),
        )
        self._commit()
        return int(cursor.lastrowid)

    def insert_scores(self, raw_item_ids: list[int], scores: list[dict[str, Any]]) -> list[int]:
        score_ids: list[int] = []
        for score in scores:
            try:
                item_index = int(score.get("item_index", -1))
            except (TypeError, ValueError):
                continue
            if 0 <= item_index < len(raw_item_ids):
                score_ids.append(self.insert_score(raw_item_id=raw_item_ids[item_index], score=score))
        return score_ids

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
        self._commit()
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
        self._commit()

    def record_pnl(self, total_value_usdc: float, unrealized_pnl: float, realized_pnl: float) -> None:
        self.connection.execute(
            """
            INSERT INTO pnl_snapshots (total_value_usdc, unrealized_pnl, realized_pnl, recorded_at)
            VALUES (?, ?, ?, ?)
            """,
            (total_value_usdc, unrealized_pnl, realized_pnl, utc_now_iso()),
        )
        self._commit()

    def record_prices(
        self,
        prices: dict[str, float],
        source: str,
        recorded_at: str | None = None,
    ) -> int:
        """Record a batch of asset prices, ignoring duplicates.

        The UNIQUE(asset, recorded_at, source) constraint plus INSERT OR IGNORE
        makes repeated backfills idempotent. Returns the number of rows actually
        inserted (duplicates are silently skipped).
        """
        timestamp = recorded_at if recorded_at is not None else utc_now_iso()
        inserted = 0
        for asset, price in prices.items():
            cursor = self.connection.execute(
                """
                INSERT OR IGNORE INTO price_history (asset, price_usdc, source, recorded_at)
                VALUES (?, ?, ?, ?)
                """,
                (asset, float(price), source, timestamp),
            )
            inserted += cursor.rowcount
        self._commit()
        return inserted

    def price_history(
        self,
        asset: str,
        limit: int = 500,
        source: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return the most recent price rows for an asset, newest first."""
        if source is None:
            rows = self.connection.execute(
                """
                SELECT id, asset, price_usdc, source, recorded_at
                FROM price_history
                WHERE asset = ?
                ORDER BY recorded_at DESC, id DESC
                LIMIT ?
                """,
                (asset, limit),
            ).fetchall()
        else:
            rows = self.connection.execute(
                """
                SELECT id, asset, price_usdc, source, recorded_at
                FROM price_history
                WHERE asset = ? AND source = ?
                ORDER BY recorded_at DESC, id DESC
                LIMIT ?
                """,
                (asset, source, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def price_matrix(
        self,
        assets: list[str],
        source: str | None = None,
    ) -> dict[str, list[tuple[str, float]]]:
        """Return {asset: [(recorded_at, price_usdc), ...]} oldest-first.

        Every requested asset is present in the result, with an empty list when
        no history exists. Intended as the raw input for returns/covariance work.
        """
        matrix: dict[str, list[tuple[str, float]]] = {}
        for asset in assets:
            if source is None:
                rows = self.connection.execute(
                    """
                    SELECT recorded_at, price_usdc
                    FROM price_history
                    WHERE asset = ?
                    ORDER BY recorded_at ASC, id ASC
                    """,
                    (asset,),
                ).fetchall()
            else:
                rows = self.connection.execute(
                    """
                    SELECT recorded_at, price_usdc
                    FROM price_history
                    WHERE asset = ? AND source = ?
                    ORDER BY recorded_at ASC, id ASC
                    """,
                    (asset, source),
                ).fetchall()
            matrix[asset] = [(row["recorded_at"], row["price_usdc"]) for row in rows]
        return matrix

    def latest_prices(self, assets: list[str] | None = None) -> dict[str, float]:
        """The most recently recorded price per asset (any source).

        "Most recent" means the newest recorded_at, not the newest row id, so
        historical backfills inserted after live ticks never shadow them.
        """
        rows = self.connection.execute(
            """
            SELECT asset, price_usdc FROM (
                SELECT asset, price_usdc,
                       ROW_NUMBER() OVER (
                           PARTITION BY asset
                           ORDER BY recorded_at DESC, id DESC
                       ) AS rn
                FROM price_history
            )
            WHERE rn = 1
            """
        ).fetchall()
        prices = {row["asset"]: row["price_usdc"] for row in rows}
        if assets is not None:
            wanted = set(assets)
            prices = {asset: price for asset, price in prices.items() if asset in wanted}
        return prices

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

    def trade_history(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """
            SELECT id, signal_id, asset, action, amount_usdc, price_usdc,
                   quantity, realized_pnl, tx_signature, executed_at
            FROM trades
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]

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
