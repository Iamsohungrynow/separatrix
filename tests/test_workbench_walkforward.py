from __future__ import annotations

import logging
import os
import unittest
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from agent.workbench import metrics
from agent.workbench.baselines import default_baselines
from agent.workbench.bridge import SeparatrixCli, discover_binary
from agent.workbench.data import build_price_data
from agent.workbench.walkforward import (
    WalkForwardConfig,
    rebalance_days,
    run_walkforward,
    simulate_schedule,
    weights_vector,
)

from tests.workbench_synth import ASSETS8, StubBridge, flat_series, synthetic_series

REPO_ROOT = Path(__file__).resolve().parents[1]

# The skip paths under test log warnings by design; keep test output clean.
logging.getLogger("leash.workbench.walkforward").setLevel(logging.CRITICAL)

START = date(2024, 1, 1)


def _day(offset: int) -> date:
    return START + timedelta(days=offset)


def small_config(**overrides) -> WalkForwardConfig:
    """Shrunk windows so 120 synthetic days exercise the full pipeline."""
    kwargs = dict(
        start=START,
        end=_day(119),
        k=2,
        solvers=("sa", "exact"),
        bps_levels=(0.0, 10.0, 30.0),
        seed=42,
        warmup_days=40,
        rebalance_interval_days=7,
        mu_window_days=20,
        sigma_window_days=30,
        min_history_days=30,
        max_staleness_days=3,
        min_universe_margin=2,
        min_mu_obs=10,
        min_sigma_obs=15,
    )
    kwargs.update(overrides)
    return WalkForwardConfig(**kwargs)


def small_data(seed: int = 7, n_days: int = 120):
    return build_price_data(synthetic_series(ASSETS8, n_days, START, seed=seed))


class RebalanceDaysTestCase(unittest.TestCase):
    def test_weekly_from_warmup_to_end(self) -> None:
        data = small_data()
        days = rebalance_days(small_config(), data)

        self.assertEqual(days[0], _day(40))
        self.assertEqual(len(days), 12)  # 2024-02-10 .. 2024-04-27
        for prev, curr in zip(days, days[1:]):
            self.assertEqual((curr - prev).days, 7)
        self.assertLessEqual(days[-1], _day(119))

    def test_capped_by_data_end(self) -> None:
        data = small_data(n_days=60)  # data ends at day 59
        days = rebalance_days(small_config(), data)
        self.assertTrue(all(day <= _day(59) for day in days))
        self.assertEqual(len(days), 3)  # days 40, 47, 54


class RunWalkForwardTestCase(unittest.TestCase):
    def test_executes_all_rebalances_and_builds_strategies(self) -> None:
        data = small_data()
        config = small_config()
        bridge = StubBridge()
        result = run_walkforward(
            data, config, bridge, default_baselines(config.k, ASSETS8)
        )

        self.assertEqual(len(result.rebalance_days), 12)
        self.assertEqual(len(result.records), 12)
        self.assertEqual(result.skips, [])
        self.assertEqual(len(bridge.calls), 12)

        expected = {
            "separatrix-sa",
            "separatrix-exact",
            "one-over-n",
            "momentum-2",
            "minvar-greedy-2",
            "hrp",
        }
        self.assertEqual(set(result.strategies), expected)
        for strategy in result.strategies.values():
            self.assertEqual(len(strategy.schedule), 12)
            self.assertEqual(set(strategy.sims), {0.0, 10.0, 30.0})
            self.assertEqual(len(strategy.turnovers), 12)

        record = result.records[0]
        self.assertEqual(record.universe, ASSETS8)
        self.assertEqual(len(record.selection["sa"]), 2)
        self.assertEqual(record.selection["exact"], record.selection["sa"])
        self.assertEqual(record.gap_int["sa"], 0)
        self.assertTrue(record.feasible_raw["sa"])
        self.assertTrue(record.exact_available)

    def test_deterministic_given_data_config_seed(self) -> None:
        data = small_data()
        config = small_config()
        result_a = run_walkforward(
            data, config, StubBridge(), default_baselines(config.k, ASSETS8)
        )
        result_b = run_walkforward(
            data, config, StubBridge(), default_baselines(config.k, ASSETS8)
        )

        for rec_a, rec_b in zip(result_a.records, result_b.records):
            self.assertEqual(rec_a, rec_b)
        for name in result_a.strategies:
            sim_a = result_a.strategies[name].sims[10.0]
            sim_b = result_b.strategies[name].sims[10.0]
            np.testing.assert_array_equal(sim_a.values, sim_b.values)

    def test_seed_and_solvers_reach_the_bridge(self) -> None:
        data = small_data()
        config = small_config(seed=99)
        bridge = StubBridge()
        run_walkforward(data, config, bridge, {})

        for call in bridge.calls:
            self.assertEqual(call["seed"], 99)
            self.assertEqual(call["solvers"], ["sa", "exact"])
            self.assertEqual(call["k"], 2)

    def test_thin_universe_skips_everyone(self) -> None:
        data = small_data()
        config = small_config(min_universe_margin=7)  # needs 9 of 8 assets
        bridge = StubBridge()
        result = run_walkforward(
            data, config, bridge, default_baselines(config.k, ASSETS8)
        )

        self.assertEqual(result.records, [])
        self.assertEqual(len(result.skips), 12)
        self.assertTrue(all(skip.scope == "all" for skip in result.skips))
        self.assertTrue(all("THIN_UNIVERSE" in skip.reason for skip in result.skips))
        self.assertEqual(len(bridge.calls), 0)
        for strategy in result.strategies.values():
            self.assertEqual(strategy.schedule, [])
            self.assertEqual(strategy.sims, {})

    def test_insufficient_data_skips_everyone(self) -> None:
        data = small_data()
        config = small_config(min_sigma_obs=500)
        result = run_walkforward(data, config, StubBridge(), {})

        self.assertEqual(result.records, [])
        self.assertEqual(len(result.skips), 12)
        self.assertTrue(all("INSUFFICIENT_DATA" in s.reason for s in result.skips))

    def test_bridge_failure_skips_only_separatrix(self) -> None:
        data = small_data()
        config = small_config()
        bridge = StubBridge(fail_calls={1})
        result = run_walkforward(
            data, config, bridge, default_baselines(config.k, ASSETS8)
        )

        self.assertEqual(len(result.records), 12)
        failed = result.records[1]
        self.assertIsNotNone(failed.bridge_error)
        self.assertEqual(failed.selection, {})

        separatrix_skips = [s for s in result.skips if s.scope == "separatrix"]
        self.assertEqual(len(separatrix_skips), 1)
        self.assertEqual(separatrix_skips[0].day, result.rebalance_days[1])
        self.assertIn("BRIDGE_ERROR", separatrix_skips[0].reason)

        # Fail-closed for the solver track only; baselines still traded.
        self.assertEqual(len(result.strategies["separatrix-sa"].schedule), 11)
        self.assertEqual(len(result.strategies["one-over-n"].schedule), 12)


class ExactTooLargeTestCase(unittest.TestCase):
    """The documented degradation: no ground truth, but the study goes on."""

    def test_capped_exact_keeps_selections_and_nulls_the_gaps(self) -> None:
        data = small_data()
        config = small_config(max_exact_subsets=1)  # C(8,2)=28 > 1 everywhere
        bridge = StubBridge()
        result = run_walkforward(
            data, config, bridge, default_baselines(config.k, ASSETS8)
        )

        self.assertEqual(len(result.records), 12)
        self.assertEqual(result.skips, [])  # never a skip, never a raise
        for record in result.records:
            self.assertIsNone(record.bridge_error)
            self.assertTrue(record.exact_too_large)
            self.assertEqual(record.exact_error, "TOO_LARGE")
            self.assertEqual(record.exact_subsets, 28)
            self.assertFalse(record.exact_available)
            self.assertEqual(set(record.selection), {"sa"})
            self.assertEqual(len(record.selection["sa"]), config.k)
            self.assertIsNone(record.gap_int["sa"])
            self.assertIsNone(record.gap_rel["sa"])
            # The penalty-free objective is still reported and recorded.
            self.assertIsNotNone(record.objective_offset_int)
            self.assertEqual(
                record.portfolio_objective_int["sa"],
                record.objective_int["sa"] + record.objective_offset_int,
            )

        # Solver track still trades every week; only "exact" has no strategy.
        self.assertEqual(len(result.strategies["separatrix-sa"].schedule), 12)
        self.assertNotIn("separatrix-exact", result.strategies)


@unittest.skipUnless(
    discover_binary(REPO_ROOT) is not None,
    "separatrix-cli binary not built; integration skipped",
)
class ExactTooLargeIntegrationTestCase(unittest.TestCase):
    """Same degradation, end to end against the real solver binary.

    This is the path the published study never exercised: a cap small enough
    that exact enumeration always refuses, driven through the real CLI and the
    real bridge parser.
    """

    def test_real_binary_walkforward_degrades_to_null_gaps(self) -> None:
        data = small_data(seed=11)
        config = small_config(
            solvers=("bsb", "sa", "exact"),
            max_exact_subsets=1,
            budget={
                "sb_steps": 100, "sb_replicas": 4,
                "sa_sweeps": 100, "sa_restarts": 2,
            },
        )
        binary = os.environ.get("SEPARATRIX_CLI") or discover_binary(REPO_ROOT)
        bridge = SeparatrixCli(binary=Path(binary), timeout_seconds=120)

        result = run_walkforward(data, config, bridge, {})

        self.assertEqual(len(result.records), 12)
        self.assertEqual([s.reason for s in result.skips], [])
        for record in result.records:
            self.assertIsNone(record.bridge_error)
            self.assertTrue(record.exact_too_large)
            self.assertEqual(record.exact_subsets, 28)  # C(8,2)
            self.assertEqual(set(record.selection), {"bsb", "sa"})
            for solver in ("bsb", "sa"):
                self.assertEqual(len(record.selection[solver]), config.k)
                self.assertIsNone(record.gap_int[solver])
                self.assertIsNone(record.gap_rel[solver])
                self.assertEqual(
                    record.portfolio_objective_int[solver],
                    record.objective_int[solver] + record.objective_offset_int,
                )
                self.assertIsInstance(record.runtime_ms[solver], float)

        for name in ("separatrix-bsb", "separatrix-sa"):
            self.assertEqual(len(result.strategies[name].schedule), 12)
            self.assertEqual(set(result.strategies[name].sims), {0.0, 10.0, 30.0})


class SimulateScheduleTestCase(unittest.TestCase):
    def test_hand_checked_turnover_and_costs_on_flat_prices(self) -> None:
        assets = ["AAA", "BBB", "CCC", "DDD"]
        data = build_price_data(flat_series(assets, 30, START))
        w_a = weights_vector(data, {"AAA": 1.0})
        w_b = weights_vector(data, {"BBB": 1.0})
        schedule = [(_day(10), w_a), (_day(17), w_b)]

        sim = simulate_schedule(data, schedule, _day(29), bps=10.0)

        # Entry pays full turnover 1; the switch pays |1-0| + |0-1| = 2.
        self.assertEqual(sim.turnovers, [1.0, 2.0])
        np.testing.assert_allclose(sim.costs, [0.001, 0.002])
        # values[0] is the capital committed, before the entry charge.
        self.assertAlmostEqual(sim.values[0], 1.0, places=12)
        self.assertAlmostEqual(sim.values[1], 0.999, places=12)
        self.assertAlmostEqual(sim.values[-1], 0.999 * 0.998, places=12)

        # Flat prices: the only non-zero daily returns are the two charges —
        # the entry cost on the first step, the switch cost at the switch.
        switch_index = (_day(17) - _day(10)).days - 1
        for i, r in enumerate(sim.daily_returns):
            if i == 0:
                self.assertAlmostEqual(r, 0.999 - 1.0, places=12)
            elif i == switch_index:
                self.assertAlmostEqual(r, 0.998 - 1.0, places=12)
            else:
                self.assertAlmostEqual(r, 0.0, places=12)

    def test_zero_bps_charges_nothing(self) -> None:
        assets = ["AAA", "BBB"]
        data = build_price_data(flat_series(assets, 20, START))
        schedule = [
            (_day(5), weights_vector(data, {"AAA": 1.0})),
            (_day(12), weights_vector(data, {"BBB": 1.0})),
        ]
        sim = simulate_schedule(data, schedule, _day(19), bps=0.0)
        np.testing.assert_allclose(sim.values, 1.0)
        self.assertEqual(sim.turnovers, [1.0, 2.0])  # turnover is bps-independent

    def test_turnover_uses_drifted_weights(self) -> None:
        # AAA doubles while BBB is flat; rebalancing back to 50/50 must charge
        # against the drifted (2/3, 1/3) weights: turnover = 2·(1/6) = 1/3.
        series = {
            "AAA": {_day(i): 100.0 * (2.0 if i >= 5 else 1.0) for i in range(15)},
            "BBB": {_day(i): 100.0 for i in range(15)},
        }
        data = build_price_data(series)
        half = weights_vector(data, {"AAA": 0.5, "BBB": 0.5})
        sim = simulate_schedule(data, [(_day(0), half), (_day(10), half)], _day(14), bps=0.0)

        self.assertAlmostEqual(sim.turnovers[0], 1.0, places=12)
        self.assertAlmostEqual(sim.turnovers[1], 1.0 / 3.0, places=12)
        self.assertAlmostEqual(sim.values[-1], 1.5, places=12)  # 0.5·2 + 0.5·1

    def test_missing_prices_freeze_the_position(self) -> None:
        # AAA trades days 0-4 at 100, disappears (days 5-7 filled, 8-9 NaN),
        # returns at 120 from day 10. Value freezes through the hole.
        series = {"AAA": {**{_day(i): 100.0 for i in range(5)},
                          **{_day(i): 120.0 for i in range(10, 15)}}}
        data = build_price_data(series)
        schedule = [(_day(2), weights_vector(data, {"AAA": 1.0}))]
        sim = simulate_schedule(data, schedule, _day(14), bps=0.0)

        by_date = dict(zip(sim.dates, sim.values))
        self.assertEqual(by_date[_day(8)], 1.0)
        self.assertEqual(by_date[_day(9)], 1.0)
        self.assertAlmostEqual(by_date[_day(10)], 1.2, places=12)
        self.assertAlmostEqual(by_date[_day(14)], 1.2, places=12)

    def test_entry_cost_survives_into_the_return_series(self) -> None:
        # Single rebalance, flat prices, 30 bps: the whole study is the entry
        # charge. Hand-computed: turnover 1 x 30bps = 0.003 of capital, so the
        # value path runs 1.0 -> 0.997 and the total return is -30 bps.
        # Booking the charge into values[0] would divide it back out and leave
        # every return-based metric reading exactly zero.
        data = build_price_data(flat_series(["AAA", "BBB"], 10, START))
        schedule = [(_day(0), weights_vector(data, {"AAA": 0.5, "BBB": 0.5}))]

        sim = simulate_schedule(data, schedule, _day(9), bps=30.0)

        self.assertEqual(sim.turnovers, [1.0])
        np.testing.assert_allclose(sim.costs, [0.003])
        self.assertAlmostEqual(sim.values[0], 1.0, places=12)
        self.assertAlmostEqual(sim.values[-1], 0.997, places=12)

        total_return = float(np.prod(1.0 + sim.daily_returns)) - 1.0
        self.assertAlmostEqual(total_return, -0.003, places=12)
        self.assertAlmostEqual(metrics.max_drawdown(sim.values), 0.003, places=12)
        self.assertLess(metrics.annualized_return(sim.daily_returns), 0.0)

    def test_schedule_entries_sharing_a_date_all_execute(self) -> None:
        # Two entries land on the same day, then a third a week later. A
        # pointer that only advances on an exact date match consumes the first
        # and stalls, freezing the strategy on AAA forever.
        series = {
            "AAA": {_day(i): 100.0 for i in range(20)},
            "BBB": {_day(i): 100.0 for i in range(20)},
            "CCC": {_day(i): 100.0 * (2.0 if i >= 12 else 1.0) for i in range(20)},
        }
        data = build_price_data(series)
        schedule = [
            (_day(0), weights_vector(data, {"AAA": 1.0})),
            (_day(0), weights_vector(data, {"BBB": 1.0})),
            (_day(7), weights_vector(data, {"CCC": 1.0})),
        ]

        sim = simulate_schedule(data, schedule, _day(19), bps=0.0)

        # One turnover per scheduled entry: entry, same-day switch, week-later
        # switch — the invariant the report's per-rebalance averages assume.
        self.assertEqual(sim.turnovers, [1.0, 2.0, 2.0])
        self.assertEqual(len(sim.turnovers), len(schedule))
        # CCC doubles on day 12; a frozen strategy would still be flat at 1.0.
        self.assertAlmostEqual(sim.values[-1], 2.0, places=12)

    def test_empty_schedule_raises(self) -> None:
        data = build_price_data(flat_series(["AAA"], 5, START))
        with self.assertRaises(ValueError):
            simulate_schedule(data, [], _day(4), bps=0.0)


class LookaheadTestCase(unittest.TestCase):
    """Mandatory: perturbing prices strictly after t must not change the
    universe, the QUBO inputs, or the selection at t."""

    def test_future_prices_do_not_leak_into_decisions(self) -> None:
        series = synthetic_series(ASSETS8, 120, START, seed=21)
        data = build_price_data(series)
        config = small_config()
        bridge = StubBridge()
        baselines = default_baselines(config.k, ASSETS8)
        result = run_walkforward(data, config, bridge, baselines)

        cut = result.rebalance_days[2]  # 2024-02-24: perturb strictly after it
        rng = np.random.default_rng(99)
        perturbed = {
            asset: {
                day: (price * float(rng.uniform(0.5, 1.5)) if day > cut else price)
                for day, price in per_asset.items()
            }
            for asset, per_asset in series.items()
        }
        data2 = build_price_data(perturbed)
        bridge2 = StubBridge()
        result2 = run_walkforward(
            data2, config, bridge2, default_baselines(config.k, ASSETS8)
        )

        # Same rebalance calendar, nothing skipped in either run.
        self.assertEqual(result.rebalance_days, result2.rebalance_days)
        n_before_cut = sum(1 for day in result.rebalance_days if day <= cut)
        self.assertEqual(n_before_cut, 3)

        for i in range(n_before_cut):
            rec_a, rec_b = result.records[i], result2.records[i]
            self.assertLessEqual(rec_a.day, cut)
            self.assertEqual(rec_a, rec_b)  # universe + selection + gaps identical
            np.testing.assert_array_equal(
                bridge.calls[i]["mu"], bridge2.calls[i]["mu"]
            )
            np.testing.assert_array_equal(
                bridge.calls[i]["sigma"], bridge2.calls[i]["sigma"]
            )
            for name in result.strategies:
                day_a, weights_a = result.strategies[name].schedule[i]
                day_b, weights_b = result2.strategies[name].schedule[i]
                self.assertEqual(day_a, day_b)
                np.testing.assert_array_equal(weights_a, weights_b)

        # Sanity: the perturbation really reached the later decisions.
        later_mu_changed = any(
            not np.array_equal(bridge.calls[i]["mu"], bridge2.calls[i]["mu"])
            for i in range(n_before_cut, len(bridge.calls))
        )
        self.assertTrue(later_mu_changed)


if __name__ == "__main__":
    unittest.main()
