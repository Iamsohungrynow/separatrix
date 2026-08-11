from __future__ import annotations

import unittest
from datetime import date, timedelta

from agent.workbench.data import build_price_data
from agent.workbench.universe import eligible

D0 = date(2024, 1, 1)


def _day(offset: int) -> date:
    return D0 + timedelta(days=offset)


def _range_series(first: int, last: int, price: float = 100.0) -> dict[date, float]:
    return {_day(i): price for i in range(first, last + 1)}


class EligibleTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.data = build_price_data(
            {
                "FULL": _range_series(0, 15),      # always fresh, 16 closes
                "SHORT": _range_series(0, 2),      # 3 closes, goes stale after day 5
                "LATE": _range_series(7, 15),      # starts trading late
                "FUTURE": _range_series(12, 15),   # only exists after early dates
            }
        )

    def test_history_and_staleness_rules(self) -> None:
        # At day 9 with min_history=3: SHORT's last close (day 2) is 7 days
        # stale, LATE has 3 closes and is fresh, FUTURE has none yet.
        result = eligible(self.data, _day(9), min_history=3, max_staleness_days=3)
        self.assertEqual(result, ["FULL", "LATE"])

    def test_staleness_boundary_is_inclusive(self) -> None:
        # SHORT's last close is day 2; at day 5 that is exactly 3 days old.
        result = eligible(self.data, _day(5), min_history=3, max_staleness_days=3)
        self.assertIn("SHORT", result)
        result = eligible(self.data, _day(6), min_history=3, max_staleness_days=3)
        self.assertNotIn("SHORT", result)

    def test_uses_only_data_at_or_before_the_date(self) -> None:
        # FUTURE has 4 closes overall but none at-or-before day 9.
        result = eligible(self.data, _day(9), min_history=1, max_staleness_days=3)
        self.assertNotIn("FUTURE", result)
        # ...and it becomes eligible once its data exists.
        result = eligible(self.data, _day(13), min_history=1, max_staleness_days=3)
        self.assertIn("FUTURE", result)

    def test_min_history_counts_real_closes_not_filled_days(self) -> None:
        data = build_price_data(
            {
                "GAPPY": {**_range_series(0, 3), **_range_series(6, 8)},  # 7 real closes
                "DENSE": _range_series(0, 8),  # 9 real closes
            }
        )
        # Days 4-5 are forward-filled for GAPPY but must not count as closes.
        result = eligible(data, _day(8), min_history=8, max_staleness_days=3)
        self.assertEqual(result, ["DENSE"])

    def test_day_before_calendar_start_is_empty(self) -> None:
        self.assertEqual(
            eligible(self.data, _day(-1), min_history=1, max_staleness_days=3), []
        )

    def test_order_follows_data_assets(self) -> None:
        result = eligible(self.data, _day(15), min_history=1, max_staleness_days=3)
        self.assertEqual(result, ["FULL", "LATE", "FUTURE"])

    def test_default_252_close_requirement(self) -> None:
        data = build_price_data({"AAA": _range_series(0, 251)})  # exactly 252 closes
        self.assertEqual(eligible(data, _day(251)), ["AAA"])
        self.assertEqual(eligible(data, _day(250)), [])  # only 251 at-or-before

    def test_unknown_assets_filter(self) -> None:
        result = eligible(
            self.data, _day(9), assets=["FULL", "NOPE"], min_history=3,
            max_staleness_days=3,
        )
        self.assertEqual(result, ["FULL"])


if __name__ == "__main__":
    unittest.main()
