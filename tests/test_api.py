from __future__ import annotations

import shutil
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
                        "ENABLE_X402=true",
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

            client = TestClient(create_app(settings, database))  # type: ignore[misc]
            health = client.get("/health")
            pnl = client.get("/pnl")
            latest = client.get("/signal/latest")
            history = client.get("/signal/history", params={"limit": 1})
            database.close()

        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["policy_mode"], "local-simulator")
        self.assertEqual(pnl.status_code, 200)
        self.assertEqual(pnl.json()["cash_usdc"], 1000.0)
        self.assertEqual(latest.status_code, 200)
        self.assertTrue(latest.json()["x402_enabled"])
        self.assertEqual(latest.json()["signal"]["asset"], "RNDR")
        self.assertEqual(history.status_code, 200)
        self.assertEqual(len(history.json()["signals"]), 1)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_api_returns_empty_defaults_and_devnet_policy_mode(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_api_empty"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        f"SQLITE_PATH={case_dir / 'state.db'}",
                        "ENABLE_DEVNET_POLICY=true",
                    ]
                ),
                encoding="utf-8",
            )

            settings = Settings.from_env(env_path)
            database = Database(settings.database_path)
            database.initialize()
            database.record_state("idle")

            client = TestClient(create_app(settings, database))  # type: ignore[misc]
            health = client.get("/health")
            pnl = client.get("/pnl")
            latest = client.get("/signal/latest")
            history = client.get("/signal/history")
            database.close()

        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["policy_mode"], "devnet-anchor")
        self.assertEqual(pnl.status_code, 200)
        self.assertEqual(pnl.json()["positions"], [])
        self.assertEqual(latest.status_code, 200)
        self.assertIsNone(latest.json()["signal"])
        self.assertFalse(latest.json()["x402_enabled"])
        self.assertEqual(history.status_code, 200)
        self.assertEqual(history.json()["signals"], [])

        shutil.rmtree(case_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
