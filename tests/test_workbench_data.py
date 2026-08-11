from __future__ import annotations

import math
import shutil
import unittest
from datetime import date, timedelta

import numpy as np

from agent.db.database import Database
from agent.workbench.data import build_price_data, load_price_data, log_returns

from tests.workbench_synth import make_case_dir

D0 = date(2024, 1, 1)


def _day(offset: int) -> date:
    return D0 + timedelta(days=offset)


class BuildPriceDataTestCase(unittest.TestCase):
    def test_calendar_is_contiguous_union_of_asset_ranges(self) -> None:
        series = {
            "AAA": {_day(0): 100.0, _day(2): 102.0},
            "BBB": {_day(5): 50.0, _day(9): 55.0},
        }
        data = build_price_data(series)

        self.assertEqual(data.dates[0], _day(0))
        self.assertEqual(data.dates[-1], _day(9))
        self.assertEqual(len(data.dates), 10)
        self.assertEqual(data.assets, ["AAA", "BBB"])
        # calendar days are consecutive
        for prev, curr in zip(data.dates, data.dates[1:]):
            self.assertEqual((curr - prev).days, 1)

    def test_observed_marks_only_real_closes(self) -> None:
        series = {"AAA": {_day(0): 100.0, _day(2): 102.0}}
        data = build_price_data(series)

        self.assertTrue(data.observed[0, 0])
        self.assertFalse(data.observed[1, 0])  # filled, not observed
        self.assertTrue(data.observed[2, 0])
        self.assertEqual(data.closes[1, 0], 100.0)  # forward-filled

    def test_forward_fill_bounded_at_three_days(self) -> None:
        # Observations at day 0 and day 6: days 1-3 filled, days 4-5 stay NaN.
        series = {"AAA": {_day(0): 100.0, _day(6): 106.0}}
        data = build_price_data(series)

        column = data.closes[:, 0]
        self.assertEqual(list(column[:4]), [100.0, 100.0, 100.0, 100.0])
        self.assertTrue(math.isnan(column[4]))
        self.assertTrue(math.isnan(column[5]))
        self.assertEqual(column[6], 106.0)

    def test_short_gap_fully_filled(self) -> None:
        series = {"AAA": {_day(0): 100.0, _day(3): 103.0}}
        data = build_price_data(series)
        self.assertEqual(list(data.closes[:, 0]), [100.0, 100.0, 100.0, 103.0])

    def test_leading_days_stay_nan(self) -> None:
        series = {
            "AAA": {_day(0): 100.0, _day(4): 104.0},
            "BBB": {_day(3): 50.0, _day(4): 51.0},
        }
        data = build_price_data(series)
        j = data.asset_index["BBB"]
        self.assertTrue(np.isnan(data.closes[0, j]))
        self.assertTrue(np.isnan(data.closes[2, j]))
        self.assertEqual(data.closes[3, j], 50.0)

    def test_asset_without_data_is_all_nan_column(self) -> None:
        series = {"AAA": {_day(0): 100.0, _day(1): 101.0}, "ZZZ": {}}
        data = build_price_data(series)
        self.assertIn("ZZZ", data.asset_index)
        self.assertTrue(np.isnan(data.closes[:, data.asset_index["ZZZ"]]).all())

    def test_empty_series_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_price_data({"AAA": {}})


class LogReturnsTestCase(unittest.TestCase):
    def test_hand_checked_log_returns(self) -> None:
        series = {"AAA": {_day(0): 100.0, _day(1): 110.0, _day(2): 99.0}}
        data = build_price_data(series)
        returns = log_returns(data)

        self.assertTrue(np.isnan(returns[0, 0]))
        self.assertAlmostEqual(returns[1, 0], math.log(1.1), places=12)
        self.assertAlmostEqual(returns[2, 0], math.log(99.0 / 110.0), places=12)

    def test_nan_propagates_through_gaps(self) -> None:
        # Gap of 5: days 1-3 filled (zero returns), 4-5 NaN, catch-up at 6,
        # whose return is also NaN because day 5 has no usable close.
        series = {"AAA": {_day(0): 100.0, _day(6): 106.0}}
        data = build_price_data(series)
        returns = log_returns(data)

        self.assertEqual(returns[1, 0], 0.0)
        self.assertEqual(returns[3, 0], 0.0)
        self.assertTrue(np.isnan(returns[4, 0]))
        self.assertTrue(np.isnan(returns[5, 0]))
        self.assertTrue(np.isnan(returns[6, 0]))


class LoadPriceDataTestCase(unittest.TestCase):
    def _make_db(self, case_name: str) -> tuple[Database, object]:
        case_dir = make_case_dir(case_name)
        database = Database(case_dir / "state.db")
        database.initialize()
        return database, case_dir

    def test_loads_only_the_requested_source(self) -> None:
        database, case_dir = self._make_db("wb_data_source_filter")
        database.record_prices({"SOL": 100.0}, source="binance", recorded_at="2024-01-01T00:00:00Z")
        database.record_prices({"SOL": 999.0}, source="coingecko", recorded_at="2024-01-01T06:00:00Z")
        database.record_prices({"SOL": 101.0}, source="binance", recorded_at="2024-01-02T00:00:00Z")

        data = load_price_data(database, ["SOL"])
        database.close()

        self.assertEqual(list(data.closes[:, 0]), [100.0, 101.0])
        shutil.rmtree(case_dir, ignore_errors=True)

    def test_latest_row_wins_within_a_date(self) -> None:
        database, case_dir = self._make_db("wb_data_last_wins")
        database.record_prices({"SOL": 100.0}, source="binance", recorded_at="2024-01-01T00:00:00Z")
        database.record_prices({"SOL": 105.0}, source="binance", recorded_at="2024-01-01T12:00:00Z")
        database.record_prices({"SOL": 101.0}, source="binance", recorded_at="2024-01-02T00:00:00Z")

        data = load_price_data(database, ["SOL"])
        database.close()

        self.assertEqual(data.closes[0, 0], 105.0)
        shutil.rmtree(case_dir, ignore_errors=True)

    def test_no_binance_rows_raises(self) -> None:
        database, case_dir = self._make_db("wb_data_empty")
        database.record_prices({"SOL": 100.0}, source="coingecko", recorded_at="2024-01-01T00:00:00Z")

        with self.assertRaises(ValueError):
            load_price_data(database, ["SOL"])
        database.close()
        shutil.rmtree(case_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
