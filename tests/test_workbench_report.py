from __future__ import annotations

import contextlib
import io
import json
import logging
import re
import shutil
import unittest
from datetime import date, timedelta
from unittest.mock import patch

from agent.db.database import Database
from agent.ingestion.binance_klines import BINANCE_SYMBOLS
from agent.workbench.__main__ import build_parser, default_universe, main
from agent.workbench.baselines import default_baselines
from agent.workbench.data import build_price_data
from agent.workbench.report import (
    LIMITATIONS,
    build_report,
    render_markdown,
    run_id,
    write_report,
)
from agent.workbench.walkforward import WalkForwardConfig, run_walkforward

from tests.workbench_synth import ASSETS8, StubBridge, make_case_dir, synthetic_series

logging.getLogger("leash.workbench.walkforward").setLevel(logging.CRITICAL)
logging.getLogger("leash.workbench").setLevel(logging.CRITICAL)

START = date(2024, 1, 1)


def _small_run(fail_calls: set[int] = frozenset()):
    data = build_price_data(synthetic_series(ASSETS8, 120, START, seed=7))
    config = WalkForwardConfig(
        start=START,
        end=START + timedelta(days=119),
        k=2,
        solvers=("sa", "exact"),
        bps_levels=(0.0, 10.0, 30.0),
        seed=42,
        warmup_days=40,
        mu_window_days=20,
        sigma_window_days=30,
        min_history_days=30,
        min_universe_margin=2,
        min_mu_obs=10,
        min_sigma_obs=15,
    )
    bridge = StubBridge(fail_calls=fail_calls)
    result = run_walkforward(data, config, bridge, default_baselines(config.k, ASSETS8))
    return result, data


class BuildReportTestCase(unittest.TestCase):
    def test_report_structure_and_counts(self) -> None:
        result, data = _small_run()
        report = build_report(result, data, meta={"db_path": "x.db"})

        self.assertRegex(report["run_id"], r"^\d{8}-\d{6}$")
        self.assertEqual(report["config"]["k"], 2)
        self.assertEqual(report["config"]["start"], "2024-01-01")
        self.assertEqual(report["rebalances"]["attempted"], 12)
        self.assertEqual(report["rebalances"]["executed"], 12)
        self.assertEqual(report["rebalances"]["skipped"], 0)
        self.assertEqual(report["meta"], {"db_path": "x.db"})

        # 6 strategies x 3 cost levels (deflated-Sharpe honesty count).
        self.assertEqual(len(report["strategies"]), 6)
        self.assertEqual(report["configurations_tried"], 18)

        for entry in report["strategies"].values():
            self.assertEqual(entry["rebalances"], 12)
            self.assertEqual(set(entry["per_bps"]), {"0", "10", "30"})
            self.assertEqual(set(entry["cost_drag"]), {"10", "30"})
            for per in entry["per_bps"].values():
                self.assertIn("annualized_return", per)
                self.assertIn("sharpe", per)
                self.assertIn("sortino", per)
                self.assertIn("max_drawdown", per)

    def test_solver_gap_and_feasibility_stats(self) -> None:
        result, data = _small_run()
        report = build_report(result, data)

        self.assertEqual(set(report["solvers"]), {"sa", "exact"})
        sa = report["solvers"]["sa"]
        self.assertEqual(sa["rebalances"], 12)
        self.assertEqual(sa["gap_rel_mean"], 0.0)
        self.assertEqual(sa["gap_rel_median"], 0.0)
        self.assertEqual(sa["pct_exact_optimum"], 100.0)
        self.assertEqual(sa["pre_repair_feasibility_pct"], 100.0)
        self.assertGreater(sa["mean_runtime_ms"], 0.0)

        self.assertEqual(report["exact"]["available"], 12)
        self.assertEqual(report["exact"]["available_pct"], 100.0)
        self.assertEqual(report["exact"]["too_large"], 0)

    def test_bridge_failures_are_counted_and_logged(self) -> None:
        result, data = _small_run(fail_calls={0, 3})
        report = build_report(result, data)

        self.assertEqual(report["rebalances"]["executed"], 10)
        self.assertEqual(report["rebalances"]["bridge_failures"], 2)
        reasons = [entry["reason"] for entry in report["rebalances"]["skip_log"]]
        self.assertTrue(any("BRIDGE_ERROR" in reason for reason in reasons))

    def test_limitations_cover_the_contract_items(self) -> None:
        result, data = _small_run()
        report = build_report(result, data)

        text = " ".join(report["limitations"])
        self.assertIn("volume/liquidity", text)
        self.assertIn("survivorship", text)
        self.assertIn("cost", text.lower())
        self.assertIn("C(N,K)", text)
        self.assertEqual(report["limitations"], list(LIMITATIONS))


class MarkdownTestCase(unittest.TestCase):
    def test_markdown_contains_required_sections(self) -> None:
        result, data = _small_run()
        report = build_report(result, data)
        markdown = render_markdown(report)

        self.assertIn("## Strategy performance", markdown)
        self.assertIn("## Solver quality", markdown)
        self.assertIn("## Limitations", markdown)
        self.assertIn("Configurations tried in this study: 18", markdown)
        self.assertIn("| separatrix-sa |", markdown)
        self.assertIn("| one-over-n |", markdown)
        self.assertIn("| sa |", markdown)
        self.assertIn("### 10 bps per one-way turnover", markdown)
        for item in LIMITATIONS:
            self.assertIn(item, markdown)


class WriteReportTestCase(unittest.TestCase):
    def test_writes_json_and_markdown_under_run_id(self) -> None:
        case_dir = make_case_dir("wb_report_write")
        result, data = _small_run()
        report = build_report(result, data)

        out_dir = write_report(report, reports_dir=case_dir / "reports")

        self.assertEqual(out_dir.name, report["run_id"])
        json_path = out_dir / "report.json"
        md_path = out_dir / "report.md"
        self.assertTrue(json_path.exists())
        self.assertTrue(md_path.exists())

        loaded = json.loads(json_path.read_text(encoding="utf-8"))  # strict JSON
        self.assertEqual(loaded["configurations_tried"], 18)
        self.assertIn("## Limitations", md_path.read_text(encoding="utf-8"))
        shutil.rmtree(case_dir, ignore_errors=True)

    def test_run_id_format(self) -> None:
        self.assertTrue(re.fullmatch(r"\d{8}-\d{6}", run_id()))


class CliParserTestCase(unittest.TestCase):
    def test_defaults_match_the_contract(self) -> None:
        args = build_parser().parse_args(["--start", "2024-01-01", "--end", "2025-01-01"])
        self.assertEqual(args.k, 8)
        self.assertEqual(args.solvers, "bsb,dsb,sa,pt,exact")
        self.assertEqual(args.bps, "0,10,30")
        self.assertEqual(args.seed, 42)
        self.assertIsNone(args.universe)
        self.assertIsNone(args.db)
        self.assertEqual(args.reports_dir, "reports")

    def test_default_universe_dedupes_symbol_aliases(self) -> None:
        universe = default_universe()
        symbols = [BINANCE_SYMBOLS[t] for t in universe]
        self.assertEqual(len(symbols), len(set(symbols)))  # no double-counting
        self.assertIn("RENDER", universe)
        self.assertNotIn("RNDR", universe)  # alias of RENDERUSDT
        self.assertGreaterEqual(len(universe), 35)

    def test_bad_dates_fail_fast(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(main(["--start", "not-a-date", "--end", "2025-01-01"]), 2)
            self.assertEqual(main(["--start", "2025-01-01", "--end", "2024-01-01"]), 2)
        self.assertIn("error:", stderr.getvalue())


class MainEndToEndTestCase(unittest.TestCase):
    def test_full_run_against_a_synthetic_database(self) -> None:
        case_dir = make_case_dir("wb_main_e2e")
        db_path = case_dir / "wb.db"

        n_days = 320
        series = synthetic_series(ASSETS8, n_days, START, seed=13)
        database = Database(db_path)
        database.initialize()
        with database.transaction():
            for offset in range(n_days):
                day = START + timedelta(days=offset)
                prices = {asset: series[asset][day] for asset in ASSETS8}
                database.record_prices(
                    prices, source="binance", recorded_at=f"{day.isoformat()}T00:00:00Z"
                )
        database.close()

        stub = StubBridge()
        argv = [
            "--start", "2024-01-01",
            "--end", "2024-11-15",
            "--k", "3",
            "--universe", ",".join(ASSETS8),
            "--solvers", "sa,exact",
            "--bps", "0,10,30",
            "--seed", "7",
            "--db", str(db_path),
            "--env-file", str(case_dir / "missing.env"),
            "--reports-dir", str(case_dir / "reports"),
        ]
        with patch("agent.workbench.__main__.SeparatrixCli", return_value=stub):
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                exit_code = main(argv)

        self.assertEqual(exit_code, 0)
        self.assertIn("report written to", stdout.getvalue())
        run_dirs = list((case_dir / "reports").iterdir())
        self.assertEqual(len(run_dirs), 1)
        report = json.loads((run_dirs[0] / "report.json").read_text(encoding="utf-8"))

        self.assertGreater(report["rebalances"]["executed"], 0)
        self.assertEqual(report["rebalances"]["attempted"], len(stub.calls))
        self.assertIn("separatrix-sa", report["strategies"])
        self.assertIn("one-over-n", report["strategies"])
        self.assertIn("hrp", report["strategies"])
        self.assertEqual(report["config"]["seed"], 7)
        self.assertTrue((run_dirs[0] / "report.md").exists())
        shutil.rmtree(case_dir, ignore_errors=True)

    def test_empty_database_fails_with_clear_error(self) -> None:
        case_dir = make_case_dir("wb_main_empty_db")
        argv = [
            "--start", "2024-01-01",
            "--end", "2024-11-15",
            "--universe", "AAA,BBB",
            "--db", str(case_dir / "empty.db"),
            "--env-file", str(case_dir / "missing.env"),
            "--reports-dir", str(case_dir / "reports"),
        ]
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(main(argv), 2)
        self.assertIn("error:", stderr.getvalue())
        shutil.rmtree(case_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
