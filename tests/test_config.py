from __future__ import annotations

import shutil
import unittest
from unittest.mock import patch
from pathlib import Path

from agent.config import Settings


class SettingsTestCase(unittest.TestCase):
    def test_loads_values_from_env_file(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_config"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "SQLITE_PATH=data/test.db",
                        "ENABLE_DEVNET_LEASH=true",
                        "TRACKED_ASSETS=SOL,RNDR",
                        "POLL_INTERVAL_SECONDS=60",
                    ]
                ),
                encoding="utf-8",
            )

            settings = Settings.from_env(env_path)

            self.assertEqual(settings.sqlite_path, "data/test.db")
            self.assertTrue(settings.enable_devnet_leash)
            self.assertEqual(settings.tracked_assets, ["SOL", "RNDR"])
            self.assertEqual(settings.poll_interval_seconds, 60)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_loads_values_from_utf8_bom_env_file(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_config_bom"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            env_path.write_text("SQLITE_PATH=.tmp-tests/bom.db\n", encoding="utf-8-sig")

            settings = Settings.from_env(env_path)

            self.assertEqual(settings.sqlite_path, ".tmp-tests/bom.db")

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_existing_environment_values_take_precedence_over_env_file(self) -> None:
        case_dir = Path(".tmp-tests") / "test_config_precedence"
        shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        env_path = case_dir / ".env"
        env_path.write_text("API_PORT=7000\nENABLE_X402=false\n", encoding="utf-8")

        with patch.dict("os.environ", {"API_PORT": "9100", "ENABLE_X402": "true"}, clear=True):
            settings = Settings.from_env(env_path)

        self.assertEqual(settings.api_port, 9100)
        self.assertTrue(settings.enable_x402)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_uses_defaults_and_creates_database_parent(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            settings = Settings.from_env(".env.does-not-exist")
            path = settings.database_path

        self.assertEqual(settings.solana_network, "devnet")
        self.assertEqual(path.name, "leash.db")
        self.assertTrue(path.parent.exists())

    def test_falsey_values_and_blank_lists_fall_back_cleanly(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "ENABLE_DEVNET_LEASH": "off",
                "ENABLE_X402": "no",
                "TRACKED_ASSETS": "",
                "POLL_INTERVAL_SECONDS": "15",
            },
            clear=True,
        ):
            settings = Settings.from_env(".env.does-not-exist")

        self.assertFalse(settings.enable_devnet_leash)
        self.assertFalse(settings.enable_x402)
        self.assertEqual(settings.tracked_assets, ["SOL", "RNDR", "IO", "PYTH"])
        self.assertEqual(settings.poll_interval_seconds, 15)


if __name__ == "__main__":
    unittest.main()
