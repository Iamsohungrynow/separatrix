from __future__ import annotations

import shutil
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.db.database import Database
from agent.main import build_parser, main


class MainEntryPointTestCase(unittest.TestCase):
    def test_build_parser_defaults(self) -> None:
        args = build_parser().parse_args([])

        self.assertEqual(args.env_file, ".env")
        self.assertFalse(args.init_db)
        self.assertFalse(args.once)
        self.assertEqual(args.demo_price, 11.25)

    def test_main_init_db_only_initializes_state(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_init"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(f"SQLITE_PATH={db_path}\n", encoding="utf-8")

            with patch.object(sys, "argv", ["agent.main", "--env-file", str(env_path), "--init-db"]):
                main()

            database = Database(db_path)
            latest_signal = database.latest_signal()
            health = database.health_snapshot(network="devnet", policy_mode="local-simulator")
            cash = database.get_cash()
            database.close()

        self.assertIsNone(latest_signal)
        self.assertEqual(health["status"], "idle")
        self.assertEqual(health["next_trade_sequence"], 1)
        self.assertAlmostEqual(cash, 1000.0)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_main_without_once_does_not_create_trade(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_ready"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(f"SQLITE_PATH={db_path}\n", encoding="utf-8")

            with patch.object(sys, "argv", ["agent.main", "--env-file", str(env_path)]):
                main()

            database = Database(db_path)
            latest_signal = database.latest_signal()
            next_sequence = database.get_next_trade_sequence()
            database.close()

        self.assertIsNone(latest_signal)
        self.assertEqual(next_sequence, 1)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_main_once_executes_demo_trade(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_once"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(f"SQLITE_PATH={db_path}\n", encoding="utf-8")

            with patch.object(
                sys,
                "argv",
                ["agent.main", "--env-file", str(env_path), "--init-db", "--once", "--demo-price", "12.5"],
            ):
                main()

            database = Database(db_path)
            latest_signal = database.latest_signal()
            pnl = database.latest_pnl(1000.0)
            cash = database.get_cash()
            next_sequence = database.get_next_trade_sequence()
            database.close()

        self.assertIsNotNone(latest_signal)
        assert latest_signal is not None
        self.assertEqual(latest_signal["asset"], "RNDR")
        self.assertEqual(latest_signal["devnet_tx"], "LOCAL-000001")
        self.assertAlmostEqual(cash, 995.0)
        self.assertAlmostEqual(pnl["total_value_usdc"], 1000.0)
        self.assertEqual(next_sequence, 2)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_main_devnet_once_fails_fast_with_clear_message(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_devnet_once"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(
                "\n".join(
                    [
                        f"SQLITE_PATH={db_path}",
                        "ENABLE_DEVNET_POLICY=true",
                    ]
                ),
                encoding="utf-8",
            )

            with patch.object(sys, "argv", ["agent.main", "--env-file", str(env_path), "--once"]):
                with self.assertRaises(SystemExit) as exc:
                    main()

            database = Database(db_path)
            latest_signal = database.latest_signal()
            next_sequence = database.get_next_trade_sequence()
            database.close()

        self.assertIn("not wired yet", str(exc.exception))
        self.assertIsNone(latest_signal)
        self.assertEqual(next_sequence, 1)

        shutil.rmtree(case_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
