from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from agent.api.server import create_app
    FASTAPI_AVAILABLE = True
except ModuleNotFoundError:
    TestClient = None  # type: ignore[assignment]
    create_app = None  # type: ignore[assignment]
    FASTAPI_AVAILABLE = False

from agent.config import Settings
from agent.db.database import Database
from agent.models import Signal


@unittest.skipUnless(FASTAPI_AVAILABLE, "fastapi is not installed in the current environment")
class ApiTestCase(unittest.TestCase):
    def test_api_endpoints_return_expected_payloads(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_api"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        f"SQLITE_PATH={case_dir / 'state.db'}",
                    ]
                ),
                encoding="utf-8",
            )

            settings = Settings.from_env(env_path)
            database = Database(settings.database_path)
            database.initialize()
            database.ensure_cash(settings.starting_paper_cash_usdc)
            database.record_state("idle")
            database.insert_signal(
                Signal(
                    asset="RNDR",
                    action="BUY",
                    sentiment=0.8,
                    confidence=0.9,
                    position_size_usdc=5.0,
                    reasoning="api test",
                    sources=["local://api"],
                ),
                devnet_tx="LOCAL-000001",
            )
            database.record_pnl(total_value_usdc=1000.0, unrealized_pnl=0.0, realized_pnl=0.0)

            signal_id = database.insert_signal(
                Signal(
                    asset="SOL",
                    action="BUY",
                    sentiment=0.6,
                    confidence=0.8,
                    position_size_usdc=3.0,
                    reasoning="trade api seed",
                    sources=["local://api2"],
                ),
                devnet_tx="LOCAL-000002",
            )
            database.record_trade(
                signal_id=signal_id,
                asset="SOL",
                action="BUY",
                amount_usdc=3.0,
                price_usdc=12.0,
                quantity=0.25,
                tx_signature="LOCAL-000002",
            )

            client = TestClient(create_app(settings, database))  # type: ignore[misc]
            health = client.get("/health")
            pnl = client.get("/pnl")
            latest = client.get("/signal/latest")
            history = client.get("/signal/history", params={"limit": 1})
            trades = client.get("/trades", params={"limit": 5})
            leash = client.get("/leash")
            database.close()

        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["policy_mode"], "local-simulator")
        self.assertEqual(pnl.status_code, 200)
        self.assertEqual(pnl.json()["cash_usdc"], 1000.0)
        self.assertEqual(latest.status_code, 200)
        self.assertEqual(latest.json()["signal"]["asset"], "SOL")
        self.assertEqual(history.status_code, 200)
        self.assertEqual(len(history.json()["signals"]), 1)
        self.assertEqual(trades.status_code, 200)
        trades_payload = trades.json()
        self.assertEqual(len(trades_payload["trades"]), 1)
        self.assertEqual(trades_payload["trades"][0]["asset"], "SOL")
        self.assertEqual(trades_payload["trades"][0]["tx_signature"], "LOCAL-000002")
        self.assertIsNone(trades_payload["trades"][0]["explorer_url"])
        self.assertAlmostEqual(trades_payload["trades"][0]["amount_usdc"], 3.0)
        self.assertEqual(leash.status_code, 200)
        self.assertEqual(leash.json()["leash_mode"], "local-simulator")
        self.assertIsNone(leash.json()["on_chain"])

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_api_returns_empty_defaults_and_devnet_leash_mode(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_api_empty"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        f"SQLITE_PATH={case_dir / 'state.db'}",
                        "ENABLE_DEVNET_LEASH=true",
                    ]
                ),
                encoding="utf-8",
            )

            settings = Settings.from_env(env_path)
            database = Database(settings.database_path)
            database.initialize()
            database.record_state("idle")

            status_payload = {
                "available": True,
                "initialized": True,
                "program_id": settings.leash_program_id,
                "leash_pda": "LeashPda1111111111111111111111111111111111",
                "leash_explorer_url": "https://explorer.solana.com/address/LeashPda1111111111111111111111111111111111?cluster=devnet",
                "spend_count": "7",
                "halted": False,
            }
            completed = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=f"{json.dumps(status_payload)}\n",
                stderr="",
            )

            client = TestClient(create_app(settings, database))  # type: ignore[misc]
            with patch("agent.trading.leash_client.subprocess.run", return_value=completed) as run:
                health = client.get("/health")
                run.assert_not_called()
                leash = client.get("/leash")
                run.assert_called_once()
                pnl = client.get("/pnl")
                latest = client.get("/signal/latest")
                history = client.get("/signal/history")
                trades = client.get("/trades")
            database.close()

        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["policy_mode"], "devnet-anchor")
        self.assertEqual(health.json()["leash_program_id"], settings.leash_program_id)
        self.assertEqual(leash.status_code, 200)
        self.assertTrue(leash.json()["devnet_leash_enabled"])
        self.assertTrue(leash.json()["on_chain"]["available"])
        self.assertEqual(leash.json()["on_chain"]["spend_count"], "7")
        self.assertEqual(pnl.status_code, 200)
        self.assertEqual(pnl.json()["positions"], [])
        self.assertEqual(latest.status_code, 200)
        self.assertIsNone(latest.json()["signal"])
        self.assertEqual(history.status_code, 200)
        self.assertEqual(history.json()["signals"], [])
        self.assertEqual(trades.status_code, 200)
        self.assertEqual(trades.json()["trades"], [])

        shutil.rmtree(case_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
