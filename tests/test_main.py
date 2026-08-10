from __future__ import annotations

import asyncio
import shutil
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from agent.db.database import Database
from agent.main import build_parser, main
from agent.models import Signal


class MainEntryPointTestCase(unittest.TestCase):
    def test_build_parser_defaults(self) -> None:
        args = build_parser().parse_args([])

        self.assertEqual(args.env_file, ".env")
        self.assertFalse(args.init_db)
        self.assertFalse(args.once)
        self.assertFalse(args.live)
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

    def test_main_devnet_once_fails_closed_without_local_mutation(self) -> None:
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
                        "ENABLE_DEVNET_LEASH=true",
                    ]
                ),
                encoding="utf-8",
            )

            with patch.object(sys, "argv", ["agent.main", "--env-file", str(env_path), "--once"]), \
                 patch("agent.trading.leash_client.subprocess.run") as run:
                run.return_value.returncode = 1
                run.return_value.stdout = ""
                run.return_value.stderr = "leash account not initialized"
                main()

            database = Database(db_path)
            latest_signal = database.latest_signal()
            next_sequence = database.get_next_trade_sequence()
            database.close()

        self.assertIsNone(latest_signal)
        self.assertEqual(next_sequence, 1)

        shutil.rmtree(case_dir, ignore_errors=True)


    def test_main_live_requires_groq_key(self) -> None:
        """--live without GROQ_API_KEY fails fast with a clear message."""
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_live_nokey"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(f"SQLITE_PATH={db_path}\n", encoding="utf-8")

            with patch.object(sys, "argv", ["agent.main", "--env-file", str(env_path), "--live"]):
                with self.assertRaises(SystemExit) as exc:
                    main()

        self.assertIn("GROQ_API_KEY", str(exc.exception))

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_main_live_runs_pipeline(self) -> None:
        """--live with mocked ingestion/scoring runs the full pipeline."""
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_live"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(
                "\n".join([
                    f"SQLITE_PATH={db_path}",
                    "GROQ_API_KEY=test-key-fake",
                ]),
                encoding="utf-8",
            )

            # Mock all async ingestion/scoring calls.
            mock_prices = AsyncMock(return_value={"SOL": 150.0, "RNDR": 8.0})
            mock_arxiv = AsyncMock(return_value=[
                {"title": "Test Paper", "content": "About Solana.", "source": "arxiv",
                 "url": "http://test", "url_hash": "abc", "published_at": "", "fetched_at": "", "metadata": "{}"},
            ])
            mock_news = AsyncMock(return_value=[])
            mock_scores = AsyncMock(return_value=[
                {"item_index": 0, "asset": "SOL", "sentiment": 0.85, "confidence": 0.9,
                 "reasoning": "bullish test", "model": "test"},
            ])

            with patch.object(sys, "argv", ["agent.main", "--env-file", str(env_path), "--live"]), \
                 patch("agent.ingestion.jupiter_price.fetch_prices", mock_prices), \
                 patch("agent.ingestion.coingecko.fetch_fallback_prices", AsyncMock(return_value={})), \
                 patch("agent.ingestion.arxiv.fetch_arxiv", mock_arxiv), \
                 patch("agent.ingestion.news_rss.fetch_news_rss", mock_news), \
                 patch("agent.scoring.llm_scorer.score_items", mock_scores):
                main()

            database = Database(db_path)
            latest_signal = database.latest_signal()
            cash = database.get_cash()
            next_sequence = database.get_next_trade_sequence()
            raw_count = database.connection.execute("SELECT COUNT(*) AS n FROM raw_items").fetchone()["n"]
            score_count = database.connection.execute("SELECT COUNT(*) AS n FROM scores").fetchone()["n"]
            raw_row = database.connection.execute("SELECT id, source, title, url_hash FROM raw_items").fetchone()
            score_row = database.connection.execute(
                "SELECT raw_item_id, asset, reasoning FROM scores"
            ).fetchone()
            database.close()

        # Should have executed a BUY for SOL.
        self.assertIsNotNone(latest_signal)
        assert latest_signal is not None
        self.assertEqual(latest_signal["asset"], "SOL")
        self.assertEqual(latest_signal["action"], "BUY")
        self.assertTrue(latest_signal["validated"])
        self.assertLess(cash, 1000.0)  # cash decreased
        self.assertEqual(next_sequence, 2)
        self.assertEqual(raw_count, 1)
        self.assertEqual(score_count, 1)
        assert raw_row is not None
        assert score_row is not None
        self.assertEqual(raw_row["source"], "arxiv")
        self.assertEqual(raw_row["title"], "Test Paper")
        self.assertEqual(raw_row["url_hash"], "abc")
        self.assertEqual(score_row["raw_item_id"], raw_row["id"])
        self.assertEqual(score_row["asset"], "SOL")
        self.assertEqual(score_row["reasoning"], "bullish test")

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_loop_args_parse(self) -> None:
        args = build_parser().parse_args(["--loop", "--max-cycles", "3"])
        self.assertTrue(args.loop)
        self.assertEqual(args.max_cycles, 3)

    def test_main_loop_runs_max_cycles_then_exits(self) -> None:
        """--loop --max-cycles=2 should run the live cycle exactly twice."""
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_loop"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(
                "\n".join([
                    f"SQLITE_PATH={db_path}",
                    "GROQ_API_KEY=test-key-fake",
                    "POLL_INTERVAL_SECONDS=0",
                ]),
                encoding="utf-8",
            )

            mock_prices = AsyncMock(return_value={"SOL": 150.0})
            mock_arxiv = AsyncMock(return_value=[
                {"title": "Test", "content": "Solana paper.", "source": "arxiv",
                 "url": "http://test", "url_hash": "abc", "published_at": "", "fetched_at": "", "metadata": "{}"},
            ])
            mock_news = AsyncMock(return_value=[])
            mock_scores = AsyncMock(return_value=[
                {"item_index": 0, "asset": "SOL", "sentiment": 0.85, "confidence": 0.9,
                 "reasoning": "bullish", "model": "test"},
            ])
            mock_sleep = AsyncMock(return_value=None)

            with patch.object(sys, "argv",
                              ["agent.main", "--env-file", str(env_path), "--loop", "--max-cycles", "2"]), \
                 patch("agent.ingestion.jupiter_price.fetch_prices", mock_prices), \
                 patch("agent.ingestion.coingecko.fetch_fallback_prices", AsyncMock(return_value={})), \
                 patch("agent.ingestion.arxiv.fetch_arxiv", mock_arxiv), \
                 patch("agent.ingestion.news_rss.fetch_news_rss", mock_news), \
                 patch("agent.scoring.llm_scorer.score_items", mock_scores), \
                 patch("agent.main.asyncio.sleep", mock_sleep):
                main()

            database = Database(db_path)
            history = database.signal_history(limit=10)
            next_sequence = database.get_next_trade_sequence()
            raw_count = database.connection.execute("SELECT COUNT(*) AS n FROM raw_items").fetchone()["n"]
            score_count = database.connection.execute("SELECT COUNT(*) AS n FROM scores").fetchone()["n"]
            database.close()

        # Two cycles, each generating one signal that becomes a BUY.
        self.assertEqual(len(history), 2)
        self.assertEqual(next_sequence, 3)
        # Sleep happens once between the two cycles, not after the final one.
        self.assertEqual(mock_sleep.await_count, 1)
        self.assertEqual(raw_count, 1)
        self.assertEqual(score_count, 2)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_main_loop_survives_failing_cycle(self) -> None:
        """A failing cycle should not abort the loop; subsequent cycles still run."""
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_loop_resilient"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(
                "\n".join([
                    f"SQLITE_PATH={db_path}",
                    "GROQ_API_KEY=test-key-fake",
                    "POLL_INTERVAL_SECONDS=0",
                ]),
                encoding="utf-8",
            )

            # First call raises; second returns healthy data.
            mock_prices = AsyncMock(side_effect=[
                RuntimeError("network blip"),
                {"SOL": 150.0},
            ])
            mock_arxiv = AsyncMock(return_value=[
                {"title": "Test", "content": "Solana.", "source": "arxiv",
                 "url": "http://test", "url_hash": "abc", "published_at": "", "fetched_at": "", "metadata": "{}"},
            ])
            mock_news = AsyncMock(return_value=[])
            mock_scores = AsyncMock(return_value=[
                {"item_index": 0, "asset": "SOL", "sentiment": 0.85, "confidence": 0.9,
                 "reasoning": "bullish", "model": "test"},
            ])
            mock_sleep = AsyncMock(return_value=None)

            with patch.object(sys, "argv",
                              ["agent.main", "--env-file", str(env_path), "--loop", "--max-cycles", "2"]), \
                 patch("agent.ingestion.jupiter_price.fetch_prices", mock_prices), \
                 patch("agent.ingestion.coingecko.fetch_fallback_prices", AsyncMock(return_value={})), \
                 patch("agent.ingestion.arxiv.fetch_arxiv", mock_arxiv), \
                 patch("agent.ingestion.news_rss.fetch_news_rss", mock_news), \
                 patch("agent.scoring.llm_scorer.score_items", mock_scores), \
                 patch("agent.main.asyncio.sleep", mock_sleep):
                main()

            database = Database(db_path)
            history = database.signal_history(limit=10)
            health = database.health_snapshot(network="devnet", policy_mode="local-simulator")
            database.close()

        # Cycle 1 failed before any signal was inserted; cycle 2 produced one signal.
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["asset"], "SOL")
        # Loop ended cleanly with status idle.
        self.assertEqual(health["status"], "idle")
        # Both cycles attempted jupiter fetch; sleep ran once between them.
        self.assertEqual(mock_prices.await_count, 2)
        self.assertEqual(mock_sleep.await_count, 1)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_main_loop_requires_groq_key(self) -> None:
        """--loop without GROQ_API_KEY fails fast like --live does."""
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_loop_nokey"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(f"SQLITE_PATH={db_path}\n", encoding="utf-8")

            with patch.object(sys, "argv",
                              ["agent.main", "--env-file", str(env_path), "--loop"]):
                with self.assertRaises(SystemExit) as exc:
                    main()

        self.assertIn("GROQ_API_KEY", str(exc.exception))
        shutil.rmtree(case_dir, ignore_errors=True)

    def test_main_loop_devnet_leash_rejection_does_not_mutate_portfolio(self) -> None:
        """--loop with ENABLE_DEVNET_LEASH=true fails closed when chain approval is unavailable."""
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_loop_devnet"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(
                "\n".join([
                    f"SQLITE_PATH={db_path}",
                    "ENABLE_DEVNET_LEASH=true",
                    "GROQ_API_KEY=test-key-fake",
                    "POLL_INTERVAL_SECONDS=0",
                ]),
                encoding="utf-8",
            )

            mock_prices = AsyncMock(return_value={"SOL": 150.0})
            mock_arxiv = AsyncMock(return_value=[
                {"title": "Test", "content": "Solana.", "source": "arxiv",
                 "url": "http://test", "url_hash": "abc", "published_at": "", "fetched_at": "", "metadata": "{}"},
            ])
            mock_news = AsyncMock(return_value=[])
            mock_scores = AsyncMock(return_value=[
                {"item_index": 0, "asset": "SOL", "sentiment": 0.85, "confidence": 0.9,
                 "reasoning": "bullish", "model": "test"},
            ])

            with patch.object(sys, "argv",
                              ["agent.main", "--env-file", str(env_path), "--loop", "--max-cycles", "1"]), \
                 patch("agent.ingestion.jupiter_price.fetch_prices", mock_prices), \
                 patch("agent.ingestion.coingecko.fetch_fallback_prices", AsyncMock(return_value={})), \
                 patch("agent.ingestion.arxiv.fetch_arxiv", mock_arxiv), \
                 patch("agent.ingestion.news_rss.fetch_news_rss", mock_news), \
                 patch("agent.scoring.llm_scorer.score_items", mock_scores), \
                 patch("agent.trading.leash_client.subprocess.run") as run:
                run.return_value.returncode = 1
                run.return_value.stdout = ""
                run.return_value.stderr = "leash account not initialized"
                main()

            database = Database(db_path)
            latest_signal = database.latest_signal()
            next_sequence = database.get_next_trade_sequence()
            cash = database.get_cash()
            database.close()

        self.assertIsNone(latest_signal)
        self.assertEqual(next_sequence, 1)
        self.assertAlmostEqual(cash, 1000.0)
        shutil.rmtree(case_dir, ignore_errors=True)

    def test_main_live_records_jupiter_prices(self) -> None:
        """A live cycle stores the fetched prices with source='jupiter'."""
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_live_prices_jupiter"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(
                "\n".join([
                    f"SQLITE_PATH={db_path}",
                    "GROQ_API_KEY=test-key-fake",
                ]),
                encoding="utf-8",
            )

            # Prices succeed; no research items, so the cycle aborts AFTER
            # prices are recorded — scoring never runs.
            with patch.object(sys, "argv", ["agent.main", "--env-file", str(env_path), "--live"]), \
                 patch("agent.ingestion.jupiter_price.fetch_prices",
                       AsyncMock(return_value={"SOL": 150.0, "RNDR": 8.0})), \
                 patch("agent.ingestion.coingecko.fetch_fallback_prices", AsyncMock(return_value={})), \
                 patch("agent.ingestion.arxiv.fetch_arxiv", AsyncMock(return_value=[])), \
                 patch("agent.ingestion.news_rss.fetch_news_rss", AsyncMock(return_value=[])):
                main()

            database = Database(db_path)
            sol_rows = database.price_history("SOL")
            rndr_rows = database.price_history("RNDR")
            database.close()

        self.assertEqual(len(sol_rows), 1)
        self.assertEqual(sol_rows[0]["source"], "jupiter")
        self.assertAlmostEqual(sol_rows[0]["price_usdc"], 150.0)
        self.assertTrue(sol_rows[0]["recorded_at"])
        self.assertEqual(len(rndr_rows), 1)
        self.assertAlmostEqual(rndr_rows[0]["price_usdc"], 8.0)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_main_live_records_coingecko_fallback_prices(self) -> None:
        """When Jupiter fails, fallback prices are stored with source='coingecko'."""
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_live_prices_coingecko"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(
                "\n".join([
                    f"SQLITE_PATH={db_path}",
                    "GROQ_API_KEY=test-key-fake",
                ]),
                encoding="utf-8",
            )

            with patch.object(sys, "argv", ["agent.main", "--env-file", str(env_path), "--live"]), \
                 patch("agent.ingestion.jupiter_price.fetch_prices",
                       AsyncMock(side_effect=Exception("jupiter down"))), \
                 patch("agent.ingestion.coingecko.fetch_fallback_prices",
                       AsyncMock(return_value={"SOL": 149.5})), \
                 patch("agent.ingestion.arxiv.fetch_arxiv", AsyncMock(return_value=[])), \
                 patch("agent.ingestion.news_rss.fetch_news_rss", AsyncMock(return_value=[])):
                main()

            database = Database(db_path)
            sol_rows = database.price_history("SOL")
            database.close()

        self.assertEqual(len(sol_rows), 1)
        self.assertEqual(sol_rows[0]["source"], "coingecko")
        self.assertAlmostEqual(sol_rows[0]["price_usdc"], 149.5)

        shutil.rmtree(case_dir, ignore_errors=True)

    def test_main_live_no_prices_aborts_gracefully(self) -> None:
        """--live with no prices available aborts without executing."""
        with patch.dict("os.environ", {}, clear=True):
            case_dir = Path(".tmp-tests") / "test_main_live_noprice"
            shutil.rmtree(case_dir, ignore_errors=True)
            case_dir.mkdir(parents=True, exist_ok=True)

            env_path = case_dir / ".env"
            db_path = case_dir / "state.db"
            env_path.write_text(
                "\n".join([
                    f"SQLITE_PATH={db_path}",
                    "GROQ_API_KEY=test-key-fake",
                ]),
                encoding="utf-8",
            )

            # Both price sources fail.
            mock_prices = AsyncMock(side_effect=Exception("jupiter down"))
            mock_fallback = AsyncMock(side_effect=Exception("coingecko down"))

            with patch.object(sys, "argv", ["agent.main", "--env-file", str(env_path), "--live"]), \
                 patch("agent.ingestion.jupiter_price.fetch_prices", mock_prices), \
                 patch("agent.ingestion.coingecko.fetch_fallback_prices", mock_fallback):
                main()

            database = Database(db_path)
            latest_signal = database.latest_signal()
            health = database.health_snapshot(network="devnet", policy_mode="local-simulator")
            database.close()

        self.assertIsNone(latest_signal)
        self.assertEqual(health["status"], "idle")

        shutil.rmtree(case_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
