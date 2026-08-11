from __future__ import annotations

import contextlib
import io
import json
import logging
import math
import re
import shutil
import unittest
from datetime import date, timedelta
from unittest.mock import patch

from agent.db.database import Database
from agent.ingestion.binance_klines import BINANCE_SYMBOLS
from agent.workbench.__main__ import (
    DEFAULT_DASHBOARD_PATH,
    build_parser,
    default_universe,
    main,
    resolve_universe,
)
from agent.workbench.baselines import default_baselines
from agent.workbench.bridge import DEFAULT_MAX_EXACT_SUBSETS
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


def _small_run(fail_calls: set[int] = frozenset(), **config_overrides):
    data = build_price_data(synthetic_series(ASSETS8, 120, START, seed=7))
    kwargs = dict(
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
    kwargs.update(config_overrides)
    config = WalkForwardConfig(**kwargs)
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

    def test_records_the_knobs_that_decide_every_solver_number(self) -> None:
        # Defaults: nothing was sent, so the report must say the solver CLI's
        # own cap applied rather than leaving the claim unreproducible.
        result, data = _small_run()
        config = build_report(result, data)["config"]
        self.assertIsNone(config["max_exact_subsets"])
        self.assertEqual(config["max_exact_subsets_source"], "solver-cli-default")
        self.assertEqual(
            config["max_exact_subsets_effective"], DEFAULT_MAX_EXACT_SUBSETS
        )
        self.assertIsNone(config["budget"])
        self.assertEqual(config["budget_source"], "solver-cli-default")

        # Raised cap + explicit budget: the effective values are recorded.
        budget = {"sa_sweeps": 4000, "sa_restarts": 16}
        result, data = _small_run(max_exact_subsets=60_000_000, budget=budget)
        config = build_report(result, data)["config"]
        self.assertEqual(config["max_exact_subsets"], 60_000_000)
        self.assertEqual(config["max_exact_subsets_effective"], 60_000_000)
        self.assertEqual(config["max_exact_subsets_source"], "study")
        self.assertEqual(config["budget"], budget)
        self.assertEqual(config["budget_source"], "study")

    def test_asset_count_means_assets_with_data(self) -> None:
        # NODATA is configured but never backfilled: the count the report
        # labels "with data" must not include it.
        series = synthetic_series(ASSETS8, 120, START, seed=7)
        series["NODATA"] = {}
        data = build_price_data(series)
        result, _ = _small_run()

        report = build_report(
            result, data, configured_universe=ASSETS8 + ["NODATA"]
        )

        self.assertEqual(report["data"]["assets"], len(ASSETS8))
        self.assertEqual(report["data"]["assets_configured"], len(ASSETS8) + 1)
        self.assertEqual(report["data"]["assets_without_data"], ["NODATA"])
        self.assertIn(f"{len(ASSETS8)} with data", render_markdown(report))

    def test_configured_and_effective_universes_are_both_recorded(self) -> None:
        result, data = _small_run()
        dropped = [{"ticker": "RENDER", "reason": "no observations in the database"}]
        report = build_report(
            result, data,
            configured_universe=ASSETS8 + ["RENDER"],
            universe_dropped=dropped,
        )

        self.assertEqual(report["config"]["universe"], ASSETS8)
        self.assertEqual(report["config"]["universe_configured"], ASSETS8 + ["RENDER"])
        self.assertEqual(report["config"]["universe_dropped"], dropped)
        self.assertIn("dropped **RENDER**", render_markdown(report))

    def test_cost_drag_reference_level_is_recorded_and_never_implicit(self) -> None:
        result, data = _small_run()
        report = build_report(result, data)
        self.assertEqual(report["config"]["cost_drag_reference_bps"], 0.0)
        for entry in report["strategies"].values():
            self.assertEqual(entry["cost_drag_reference_bps"], 0.0)
        self.assertIn("Cost drag vs 0 bps", render_markdown(report))

        # A --bps list that omits zero: the metric is measured against the
        # cheapest level priced, and says so instead of redefining itself.
        result, data = _small_run(bps_levels=(10.0, 30.0))
        report = build_report(result, data)
        self.assertEqual(report["config"]["cost_drag_reference_bps"], 10.0)
        for entry in report["strategies"].values():
            self.assertEqual(entry["cost_drag_reference_bps"], 10.0)
            self.assertEqual(set(entry["cost_drag"]), {"30"})
        self.assertIn("Cost drag vs 10 bps", render_markdown(report))

    def test_too_large_rebalances_keep_solvers_and_report_no_gaps(self) -> None:
        result, data = _small_run(max_exact_subsets=1)
        report = build_report(result, data)

        self.assertEqual(report["rebalances"]["executed"], 12)
        self.assertEqual(report["exact"]["available"], 0)
        self.assertEqual(report["exact"]["too_large"], 12)
        self.assertEqual(report["exact"]["max_subsets_seen"], 28)  # C(8,2)
        sa = report["solvers"]["sa"]
        self.assertEqual(sa["rebalances"], 12)
        self.assertEqual(sa["gaps_available"], 0)
        self.assertTrue(math.isnan(sa["gap_rel_mean"]))
        self.assertEqual(report["strategies"]["separatrix-sa"]["rebalances"], 12)
        self.assertIn("null gaps", render_markdown(report))

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

    def test_default_universe_keeps_every_ticker_including_aliases(self) -> None:
        universe = default_universe()
        self.assertEqual(universe, list(BINANCE_SYMBOLS))
        self.assertGreaterEqual(len(universe), 35)
        # Both aliases of RENDERUSDT survive here: which one carries closes is
        # a fact about the database, settled in resolve_universe().
        self.assertIn("RENDER", universe)
        self.assertIn("RNDR", universe)

    def test_dashboard_publishing_is_opt_in_with_an_explicit_destination(self) -> None:
        args = build_parser().parse_args(["--start", "2024-01-01", "--end", "2025-01-01"])
        self.assertFalse(args.publish_dashboard)
        self.assertEqual(args.dashboard_path, str(DEFAULT_DASHBOARD_PATH))

    def test_bad_dates_fail_fast(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(main(["--start", "not-a-date", "--end", "2025-01-01"]), 2)
            self.assertEqual(main(["--start", "2025-01-01", "--end", "2024-01-01"]), 2)
        self.assertIn("error:", stderr.getvalue())


class UniverseResolutionTestCase(unittest.TestCase):
    """A configured ticker with no rows must be dropped loudly, never kept in
    preference to an alias that actually carries the series."""

    def test_unbackfilled_alias_is_dropped_and_the_one_with_data_survives(self) -> None:
        series = synthetic_series(["BTC", "RNDR"], 30, START, seed=3)
        series["RENDER"] = {}  # aliases RENDERUSDT, never backfilled
        data = build_price_data(series)

        effective, dropped = resolve_universe(["BTC", "RENDER", "RNDR"], data)

        self.assertEqual(effective, ["BTC", "RNDR"])
        self.assertEqual([d["ticker"] for d in dropped], ["RENDER"])
        self.assertIn("no observations", dropped[0]["reason"])

    def test_two_backfilled_aliases_are_not_double_counted(self) -> None:
        data = build_price_data(synthetic_series(["RENDER", "RNDR"], 30, START, seed=3))

        effective, dropped = resolve_universe(["RENDER", "RNDR"], data)

        self.assertEqual(effective, ["RENDER"])
        self.assertEqual([d["ticker"] for d in dropped], ["RNDR"])
        self.assertIn("alias of RENDER", dropped[0]["reason"])

    def test_unmapped_tickers_pass_through(self) -> None:
        data = build_price_data(synthetic_series(ASSETS8, 30, START, seed=3))
        effective, dropped = resolve_universe(ASSETS8, data)
        self.assertEqual(effective, ASSETS8)
        self.assertEqual(dropped, [])


class MainEndToEndTestCase(unittest.TestCase):
    @staticmethod
    def _synthetic_db(case_dir, assets=ASSETS8, n_days: int = 320):
        db_path = case_dir / "wb.db"
        series = synthetic_series(assets, n_days, START, seed=13)
        database = Database(db_path)
        database.initialize()
        with database.transaction():
            for offset in range(n_days):
                day = START + timedelta(days=offset)
                prices = {asset: series[asset][day] for asset in assets}
                database.record_prices(
                    prices, source="binance", recorded_at=f"{day.isoformat()}T00:00:00Z"
                )
        database.close()
        return db_path

    def test_full_run_against_a_synthetic_database(self) -> None:
        case_dir = make_case_dir("wb_main_e2e")
        db_path = self._synthetic_db(case_dir)

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

    def test_run_never_touches_the_published_dashboard_report(self) -> None:
        # dashboard/workbench-report.json is a committed, published artifact.
        # An ordinary run — and therefore this suite — must leave it alone.
        published = DEFAULT_DASHBOARD_PATH
        before = published.read_bytes() if published.exists() else None

        case_dir = make_case_dir("wb_main_no_publish")
        db_path = self._synthetic_db(case_dir)
        argv = [
            "--start", "2024-01-01",
            "--end", "2024-11-15",
            "--k", "3",
            "--universe", ",".join(ASSETS8),
            "--solvers", "sa,exact",
            "--db", str(db_path),
            "--env-file", str(case_dir / "missing.env"),
            "--reports-dir", str(case_dir / "reports"),
        ]
        with patch("agent.workbench.__main__.SeparatrixCli", return_value=StubBridge()):
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(main(argv), 0)

        after = published.read_bytes() if published.exists() else None
        self.assertEqual(before, after)
        self.assertNotIn("published to", stdout.getvalue())
        shutil.rmtree(case_dir, ignore_errors=True)

    def test_publishing_is_opt_in_and_honours_the_given_destination(self) -> None:
        case_dir = make_case_dir("wb_main_publish")
        db_path = self._synthetic_db(case_dir)
        destination = case_dir / "site" / "workbench-report.json"
        argv = [
            "--start", "2024-01-01",
            "--end", "2024-11-15",
            "--k", "3",
            "--universe", ",".join(ASSETS8),
            "--solvers", "sa,exact",
            "--db", str(db_path),
            "--env-file", str(case_dir / "missing.env"),
            "--reports-dir", str(case_dir / "reports"),
            "--publish-dashboard",
            "--dashboard-path", str(destination),
        ]
        with patch("agent.workbench.__main__.SeparatrixCli", return_value=StubBridge()):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(argv), 0)

        run_dirs = list((case_dir / "reports").iterdir())
        self.assertTrue(destination.exists())
        self.assertEqual(
            destination.read_text(encoding="utf-8"),
            (run_dirs[0] / "report.json").read_text(encoding="utf-8"),
        )
        shutil.rmtree(case_dir, ignore_errors=True)

    def test_tickers_without_rows_are_dropped_from_the_study_universe(self) -> None:
        # NODATA is configured but never backfilled — the report must show it
        # dropped by name instead of silently carrying a dead column.
        case_dir = make_case_dir("wb_main_universe")
        db_path = self._synthetic_db(case_dir)
        argv = [
            "--start", "2024-01-01",
            "--end", "2024-11-15",
            "--k", "3",
            "--universe", ",".join(ASSETS8 + ["NODATA"]),
            "--solvers", "sa,exact",
            "--db", str(db_path),
            "--env-file", str(case_dir / "missing.env"),
            "--reports-dir", str(case_dir / "reports"),
        ]
        with patch("agent.workbench.__main__.SeparatrixCli", return_value=StubBridge()):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(argv), 0)

        run_dirs = list((case_dir / "reports").iterdir())
        report = json.loads((run_dirs[0] / "report.json").read_text(encoding="utf-8"))

        self.assertEqual(report["config"]["universe"], ASSETS8)
        self.assertEqual(
            report["config"]["universe_configured"], ASSETS8 + ["NODATA"]
        )
        self.assertEqual(
            [d["ticker"] for d in report["config"]["universe_dropped"]], ["NODATA"]
        )
        self.assertEqual(report["data"]["assets"], len(ASSETS8))
        self.assertEqual(report["data"]["assets_configured"], len(ASSETS8) + 1)
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
