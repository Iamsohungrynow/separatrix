from __future__ import annotations

import math
import unittest
from datetime import date, timedelta

import numpy as np

from agent.workbench.data import build_price_data, log_returns
from agent.workbench.qubo_params import InsufficientDataError, mu_sigma

D0 = date(2024, 1, 1)


def _day(offset: int) -> date:
    return D0 + timedelta(days=offset)


def _series_from_returns(returns_by_asset: dict[str, list[float]], base: float = 100.0):
    """Build price series whose log-returns are exactly the given values."""
    out: dict[str, dict[date, float]] = {}
    for asset, rets in returns_by_asset.items():
        prices = [base]
        for r in rets:
            prices.append(prices[-1] * math.exp(r))
        out[asset] = {_day(i): p for i, p in enumerate(prices)}
    return out


class MuTestCase(unittest.TestCase):
    def test_constant_returns_give_exact_mu(self) -> None:
        n = 14
        series = _series_from_returns({"AAA": [0.01] * n, "BBB": [0.02] * n})
        data = build_price_data(series)
        returns = log_returns(data)

        mu, _ = mu_sigma(
            data, returns, ["AAA", "BBB"], _day(n),
            mu_window=5, sigma_window=10, min_mu_obs=3, min_sigma_obs=5,
        )
        np.testing.assert_allclose(mu, [0.01, 0.02], atol=1e-12)

    def test_mu_uses_only_the_trailing_window(self) -> None:
        # 0.05 returns before the window, 0.01 inside it: mu must be 0.01.
        rets = [0.05] * 10 + [0.01] * 5
        series = _series_from_returns({"AAA": rets, "BBB": rets})
        data = build_price_data(series)
        returns = log_returns(data)

        mu, _ = mu_sigma(
            data, returns, ["AAA", "BBB"], _day(15),
            mu_window=5, sigma_window=12, min_mu_obs=3, min_sigma_obs=5,
        )
        np.testing.assert_allclose(mu, [0.01, 0.01], atol=1e-12)


class SigmaTestCase(unittest.TestCase):
    def test_hand_checked_covariance_and_shrinkage(self) -> None:
        # Alternating +-a returns for A; B = 2*A exactly. Over an even window
        # the sample means are zero, so with 8 rows and ddof=1:
        #   var(A) = 8a²/7, var(B) = 32a²/7, cov(A,B) = 16a²/7.
        # delta=0.3 shrinkage keeps the diagonal and scales cov by 0.7.
        a = 0.01
        rets_a = [a * (-1) ** (i + 1) for i in range(1, 12)]  # rows 1..11
        rets_b = [2 * r for r in rets_a]
        series = _series_from_returns({"AAA": rets_a, "BBB": rets_b})
        data = build_price_data(series)
        returns = log_returns(data)

        _, sigma = mu_sigma(
            data, returns, ["AAA", "BBB"], _day(11),
            mu_window=4, sigma_window=8, delta=0.3, min_mu_obs=2, min_sigma_obs=5,
        )

        var_a = 8 * a**2 / 7
        np.testing.assert_allclose(sigma[0, 0], var_a, rtol=1e-9)
        np.testing.assert_allclose(sigma[1, 1], 4 * var_a, rtol=1e-9)
        np.testing.assert_allclose(sigma[0, 1], 0.7 * 2 * var_a, rtol=1e-9)
        np.testing.assert_allclose(sigma, sigma.T)

    def test_diagonal_unchanged_by_shrinkage(self) -> None:
        rng = np.random.default_rng(11)
        rets = rng.normal(0.0, 0.02, size=(40, 3))
        series = _series_from_returns(
            {f"A{i}": rets[:, i].tolist() for i in range(3)}
        )
        data = build_price_data(series)
        returns = log_returns(data)

        _, sigma_no_shrink = mu_sigma(
            data, returns, ["A0", "A1", "A2"], _day(40),
            mu_window=10, sigma_window=30, delta=0.0, min_mu_obs=5, min_sigma_obs=10,
        )
        _, sigma_shrunk = mu_sigma(
            data, returns, ["A0", "A1", "A2"], _day(40),
            mu_window=10, sigma_window=30, delta=0.3, min_mu_obs=5, min_sigma_obs=10,
        )
        np.testing.assert_allclose(
            np.diag(sigma_shrunk), np.diag(sigma_no_shrink), rtol=1e-12
        )
        off = sigma_no_shrink[0, 1]
        np.testing.assert_allclose(sigma_shrunk[0, 1], 0.7 * off, rtol=1e-12)


class PointInTimeTestCase(unittest.TestCase):
    def test_strictly_at_or_before_the_rebalance_date(self) -> None:
        rng = np.random.default_rng(3)
        rets = rng.normal(0.001, 0.02, size=(30, 2))
        base = {f"A{i}": rets[:, i].tolist() for i in range(2)}
        series = _series_from_returns(base)
        data = build_price_data(series)
        returns = log_returns(data)
        day = _day(20)

        mu_before, sigma_before = mu_sigma(
            data, returns, ["A0", "A1"], day,
            mu_window=8, sigma_window=15, min_mu_obs=4, min_sigma_obs=8,
        )

        # Perturb every price strictly after `day` and recompute.
        perturbed = {
            asset: {
                d: (price * 1.7 if d > day else price)
                for d, price in per_asset.items()
            }
            for asset, per_asset in series.items()
        }
        data2 = build_price_data(perturbed)
        returns2 = log_returns(data2)
        mu_after, sigma_after = mu_sigma(
            data2, returns2, ["A0", "A1"], day,
            mu_window=8, sigma_window=15, min_mu_obs=4, min_sigma_obs=8,
        )

        np.testing.assert_array_equal(mu_before, mu_after)
        np.testing.assert_array_equal(sigma_before, sigma_after)


class InsufficientDataTestCase(unittest.TestCase):
    def test_too_few_covariance_rows_raises(self) -> None:
        series = _series_from_returns({"AAA": [0.01] * 5, "BBB": [0.02] * 5})
        data = build_price_data(series)
        returns = log_returns(data)

        with self.assertRaises(InsufficientDataError):
            mu_sigma(
                data, returns, ["AAA", "BBB"], _day(5),
                mu_window=4, sigma_window=10, min_mu_obs=2, min_sigma_obs=20,
            )

    def test_too_few_mu_observations_raises(self) -> None:
        series = _series_from_returns({"AAA": [0.01] * 5})
        data = build_price_data(series)
        returns = log_returns(data)

        with self.assertRaises(InsufficientDataError):
            mu_sigma(
                data, returns, ["AAA"], _day(5),
                mu_window=4, sigma_window=5, min_mu_obs=10, min_sigma_obs=2,
            )

    def test_unknown_asset_raises(self) -> None:
        series = _series_from_returns({"AAA": [0.01] * 5})
        data = build_price_data(series)
        returns = log_returns(data)

        with self.assertRaises(InsufficientDataError):
            mu_sigma(data, returns, ["NOPE"], _day(5))

    def test_day_before_calendar_raises(self) -> None:
        series = _series_from_returns({"AAA": [0.01] * 5})
        data = build_price_data(series)
        returns = log_returns(data)

        with self.assertRaises(InsufficientDataError):
            mu_sigma(data, returns, ["AAA"], _day(-1))

    def test_nan_gap_rows_are_dropped_listwise(self) -> None:
        # GAPPY has a 5-day hole: days 16-17 stay NaN, so those rows drop out
        # of the covariance window while DENSE's mu is unaffected.
        dense = {_day(i): 100.0 * math.exp(0.01 * i) for i in range(30)}
        gappy = {
            _day(i): 100.0 for i in range(30) if not 13 <= i <= 17
        }
        data = build_price_data({"DENSE": dense, "GAPPY": gappy})
        returns = log_returns(data)

        mu, sigma = mu_sigma(
            data, returns, ["DENSE", "GAPPY"], _day(29),
            mu_window=10, sigma_window=25, min_mu_obs=5, min_sigma_obs=10,
        )
        self.assertTrue(np.all(np.isfinite(mu)))
        self.assertTrue(np.all(np.isfinite(sigma)))
        np.testing.assert_allclose(mu[0], 0.01, atol=1e-12)


if __name__ == "__main__":
    unittest.main()
