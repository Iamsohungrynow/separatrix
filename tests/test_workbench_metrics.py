from __future__ import annotations

import math
import statistics
import unittest

import numpy as np

from agent.workbench import metrics


class AnnualizedReturnTestCase(unittest.TestCase):
    def test_hand_checked_geometric_annualization(self) -> None:
        r = [0.01, -0.02, 0.03]
        growth = 1.01 * 0.98 * 1.03
        expected = growth ** (365 / 3) - 1
        self.assertAlmostEqual(metrics.annualized_return(r), expected, places=12)

    def test_flat_series_is_zero(self) -> None:
        self.assertAlmostEqual(metrics.annualized_return([0.0] * 10), 0.0, places=12)

    def test_total_wipeout_returns_minus_one(self) -> None:
        self.assertEqual(metrics.annualized_return([0.5, -1.0]), -1.0)

    def test_empty_is_nan(self) -> None:
        self.assertTrue(math.isnan(metrics.annualized_return([])))


class VolatilityAndSharpeTestCase(unittest.TestCase):
    def test_hand_checked_volatility(self) -> None:
        r = [0.01, -0.02, 0.03]
        expected = statistics.stdev(r) * math.sqrt(365)
        self.assertAlmostEqual(metrics.annualized_volatility(r), expected, places=12)

    def test_hand_checked_sharpe(self) -> None:
        r = [0.01, -0.02, 0.03]
        expected = statistics.mean(r) / statistics.stdev(r) * math.sqrt(365)
        self.assertAlmostEqual(metrics.sharpe_ratio(r), expected, places=12)

    def test_zero_variance_sharpe_is_nan(self) -> None:
        self.assertTrue(math.isnan(metrics.sharpe_ratio([0.01, 0.01, 0.01])))

    def test_single_observation_is_nan(self) -> None:
        self.assertTrue(math.isnan(metrics.annualized_volatility([0.01])))
        self.assertTrue(math.isnan(metrics.sharpe_ratio([0.01])))


class SortinoTestCase(unittest.TestCase):
    def test_hand_checked_sortino(self) -> None:
        r = [0.01, -0.02, 0.03]
        downside_dev = math.sqrt((0.0 + 0.02**2 + 0.0) / 3)
        expected = statistics.mean(r) / downside_dev * math.sqrt(365)
        self.assertAlmostEqual(metrics.sortino_ratio(r), expected, places=12)

    def test_no_negative_days_is_nan(self) -> None:
        self.assertTrue(math.isnan(metrics.sortino_ratio([0.01, 0.02, 0.0])))


class MaxDrawdownTestCase(unittest.TestCase):
    def test_hand_checked_drawdown(self) -> None:
        values = [1.0, 1.2, 0.9, 1.1]
        # Peak 1.2 -> trough 0.9 is a 25% drawdown.
        self.assertAlmostEqual(metrics.max_drawdown(values), 0.25, places=12)

    def test_monotonic_up_has_zero_drawdown(self) -> None:
        self.assertEqual(metrics.max_drawdown([1.0, 1.1, 1.2]), 0.0)

    def test_empty_is_nan(self) -> None:
        self.assertTrue(math.isnan(metrics.max_drawdown([])))


class TurnoverAndCostTestCase(unittest.TestCase):
    def test_average_turnover(self) -> None:
        self.assertAlmostEqual(metrics.average_turnover([1.0, 0.5, 0.0]), 0.5)
        self.assertTrue(math.isnan(metrics.average_turnover([])))

    def test_cost_drag(self) -> None:
        self.assertAlmostEqual(metrics.cost_drag(0.10, 0.07), 0.03, places=12)


class SummarizeTestCase(unittest.TestCase):
    def test_returns_all_metric_keys(self) -> None:
        r = np.array([0.01, -0.02, 0.03])
        values = np.array([1.0, 1.01, 0.9898, 1.019494])
        summary = metrics.summarize(r, values)
        self.assertEqual(
            set(summary),
            {
                "annualized_return",
                "annualized_volatility",
                "sharpe",
                "sortino",
                "max_drawdown",
                "n_days",
            },
        )
        self.assertEqual(summary["n_days"], 3)


if __name__ == "__main__":
    unittest.main()
