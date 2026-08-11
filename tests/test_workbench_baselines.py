from __future__ import annotations

import unittest
from types import SimpleNamespace

import numpy as np

from agent.workbench.baselines import (
    buy_and_hold,
    correlation_from_covariance,
    default_baselines,
    hrp,
    hrp_order,
    hrp_weights,
    minvar_greedy_k,
    minvar_greedy_select,
    momentum_k,
    momentum_select,
    one_over_n,
)


def _ctx(universe, mu=None, sigma=None, k=2):
    """Selectors only touch .universe/.mu/.sigma/.config.k."""
    return SimpleNamespace(
        universe=list(universe),
        mu=None if mu is None else np.asarray(mu, dtype=float),
        sigma=None if sigma is None else np.asarray(sigma, dtype=float),
        config=SimpleNamespace(k=k),
    )


class SimpleBaselineTestCase(unittest.TestCase):
    def test_one_over_n(self) -> None:
        weights = one_over_n(_ctx(["A", "B", "C", "D"]))
        self.assertEqual(weights, {"A": 0.25, "B": 0.25, "C": 0.25, "D": 0.25})
        self.assertEqual(one_over_n(_ctx([])), {})

    def test_buy_and_hold(self) -> None:
        selector = buy_and_hold("BTC")
        self.assertEqual(selector(_ctx(["BTC", "SOL"])), {"BTC": 1.0})
        self.assertEqual(selector(_ctx(["SOL"])), {})  # not eligible -> no trade


class MomentumTestCase(unittest.TestCase):
    def test_top_k_with_stable_tie_break(self) -> None:
        mu = [0.1, 0.3, 0.3, -0.2]
        # Tie between indices 1 and 2 -> earlier universe position wins.
        self.assertEqual(momentum_select(np.array(mu), 2), [1, 2])
        self.assertEqual(momentum_select(np.array(mu), 3), [0, 1, 2])

    def test_momentum_k_weights(self) -> None:
        ctx = _ctx(["A", "B", "C", "D"], mu=[0.1, 0.3, 0.3, -0.2], k=2)
        self.assertEqual(momentum_k(ctx), {"B": 0.5, "C": 0.5})


class MinVarGreedyTestCase(unittest.TestCase):
    def test_uncorrelated_picks_lowest_variances(self) -> None:
        sigma = np.diag([1.0, 4.0, 9.0])
        self.assertEqual(minvar_greedy_select(sigma, 2), [0, 1])

    def test_correlation_changes_the_greedy_choice(self) -> None:
        # Assets 0 and 1 are highly correlated; adding 2 to 0 is cheaper:
        # {0,1}: (1 + 4 + 2*1.9)/4 = 2.2   {0,2}: (1 + 4.2)/4 = 1.3
        sigma = np.array(
            [
                [1.0, 1.9, 0.0],
                [1.9, 4.0, 0.0],
                [0.0, 0.0, 4.2],
            ]
        )
        self.assertEqual(minvar_greedy_select(sigma, 2), [0, 2])

    def test_selector_weights(self) -> None:
        ctx = _ctx(["A", "B", "C"], sigma=np.diag([1.0, 4.0, 9.0]), k=2)
        self.assertEqual(minvar_greedy_k(ctx), {"A": 0.5, "B": 0.5})


class CorrelationTestCase(unittest.TestCase):
    def test_hand_checked_correlation(self) -> None:
        sigma = np.array([[4.0, 2.0], [2.0, 9.0]])
        corr = correlation_from_covariance(sigma)
        np.testing.assert_allclose(corr, [[1.0, 2.0 / 6.0], [2.0 / 6.0, 1.0]])


def _block_sigma() -> np.ndarray:
    """Two correlated pairs {0,1} and {2,3}, independent across pairs.

    Variances 0.04, 0.01, 0.02, 0.02; within-pair correlation 0.9.
    """
    v = [0.04, 0.01, 0.02, 0.02]
    sigma = np.diag(v).astype(float)
    sigma[0, 1] = sigma[1, 0] = 0.9 * np.sqrt(v[0] * v[1])  # 0.018
    sigma[2, 3] = sigma[3, 2] = 0.9 * np.sqrt(v[2] * v[3])  # 0.018
    return sigma


class HrpTestCase(unittest.TestCase):
    def test_order_groups_correlated_blocks(self) -> None:
        self.assertEqual(hrp_order(_block_sigma()), [0, 1, 2, 3])

    def test_order_groups_blocks_even_when_interleaved(self) -> None:
        # Assets ordered A, C, B, D where (A,B) and (C,D) are the pairs.
        sigma = _block_sigma()
        perm = [0, 2, 1, 3]
        sigma_perm = sigma[np.ix_(perm, perm)]
        order = hrp_order(sigma_perm)
        # Positions 0 (A) and 2 (B) must be adjacent, as must 1 (C) and 3 (D).
        self.assertEqual(order, [0, 2, 1, 3])

    def test_hand_checked_recursive_bisection_weights(self) -> None:
        sigma = _block_sigma()

        # Left cluster {0,1}: inverse-variance weights (0.2, 0.8),
        # var = 0.2²·0.04 + 0.8²·0.01 + 2·0.2·0.8·0.018 = 0.01376
        var_left = 0.2**2 * 0.04 + 0.8**2 * 0.01 + 2 * 0.2 * 0.8 * 0.018
        # Right cluster {2,3}: weights (0.5, 0.5),
        # var = 0.25·0.02 + 0.25·0.02 + 2·0.25·0.018 = 0.019
        var_right = 0.25 * 0.02 + 0.25 * 0.02 + 2 * 0.25 * 0.018
        alpha = 1.0 - var_left / (var_left + var_right)

        # Within-left split {0}|{1}: alpha0 = 1 - 0.04/(0.04+0.01) = 0.2
        # Within-right split {2}|{3}: alpha2 = 1 - 0.02/(0.02+0.02) = 0.5
        expected = np.array(
            [alpha * 0.2, alpha * 0.8, (1 - alpha) * 0.5, (1 - alpha) * 0.5]
        )

        weights = hrp_weights(sigma, order=[0, 1, 2, 3])
        np.testing.assert_allclose(weights, expected, rtol=1e-12)
        self.assertAlmostEqual(weights.sum(), 1.0, places=12)

    def test_weights_positive_and_normalized_on_random_cov(self) -> None:
        rng = np.random.default_rng(5)
        chol = rng.normal(0.0, 0.1, (6, 6))
        sigma = chol @ chol.T + np.eye(6) * 0.01
        weights = hrp_weights(sigma)
        self.assertAlmostEqual(weights.sum(), 1.0, places=12)
        self.assertTrue(np.all(weights > 0))

    def test_selector_maps_weights_to_tickers(self) -> None:
        sigma = _block_sigma()
        ctx = _ctx(["A", "B", "C", "D"], sigma=sigma)
        weights = hrp(ctx)
        expected = hrp_weights(sigma)
        for i, name in enumerate(["A", "B", "C", "D"]):
            self.assertAlmostEqual(weights[name], expected[i], places=12)

    def test_single_asset_universe(self) -> None:
        self.assertEqual(hrp(_ctx(["A"], sigma=np.array([[1.0]]))), {"A": 1.0})


class DefaultBaselinesTestCase(unittest.TestCase):
    def test_includes_contract_baselines(self) -> None:
        baselines = default_baselines(8, ["BTC", "SOL", "ETH"])
        self.assertEqual(
            set(baselines),
            {"one-over-n", "bh-btc", "bh-sol", "momentum-8", "minvar-greedy-8", "hrp"},
        )

    def test_buy_and_holds_require_the_ticker(self) -> None:
        baselines = default_baselines(4, ["AAA", "BBB"])
        self.assertNotIn("bh-btc", baselines)
        self.assertNotIn("bh-sol", baselines)


if __name__ == "__main__":
    unittest.main()
