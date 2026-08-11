"""gap_norm: the gap as a fraction of the achievable objective spread.

gap_rel divides by the optimum's own objective, which passes through zero on
real data and makes the ratio explode; gap_norm divides by (worst − best) and
therefore stays in [0, 1]. These tests pin the plumbing and the property.
"""
from __future__ import annotations

import json
import subprocess
import unittest

from agent.workbench.bridge import SeparatrixCli, _parse_solver_result

BINARY = SeparatrixCli().binary


def _entry(**overrides):
    entry = {
        "solver": "sa",
        "bits": [1, 0, 1, 0],
        "weights": [0.5, 0.0, 0.5, 0.0],
        "objective_int": "-100",
        "portfolio_objective_int": "-40",
        "feasible_raw": True,
        "repaired": False,
        "gap_int": "10",
        "gap_rel": 0.25,
        "gap_norm": 0.1,
        "runtime_ms": 1.5,
    }
    entry.update(overrides)
    return entry


class ParseGapNormTestCase(unittest.TestCase):
    def test_parses_gap_norm(self) -> None:
        result = _parse_solver_result(_entry(), n=4)
        self.assertAlmostEqual(result.gap_norm, 0.1)

    def test_absent_gap_norm_is_none_not_an_error(self) -> None:
        entry = _entry()
        del entry["gap_norm"]
        self.assertIsNone(_parse_solver_result(entry, n=4).gap_norm)

    def test_null_gap_norm_survives_the_no_ground_truth_path(self) -> None:
        result = _parse_solver_result(
            _entry(gap_int=None, gap_rel=None, gap_norm=None), n=4
        )
        self.assertIsNone(result.gap_norm)
        self.assertIsNone(result.gap_int)

    def test_non_numeric_gap_norm_is_rejected(self) -> None:
        from agent.workbench.bridge import BridgeError

        with self.assertRaises(BridgeError):
            _parse_solver_result(_entry(gap_norm="not-a-number"), n=4)


@unittest.skipUnless(BINARY, "separatrix-cli binary not built")
class RealBinaryGapNormTestCase(unittest.TestCase):
    """The property that makes gap_norm worth having, against the real solver."""

    def test_gap_norm_is_bounded_and_consistent(self) -> None:
        n = 12
        mu = [0.001 * ((i % 5) - 2) for i in range(n)]
        sigma = [
            [0.002 if i == j else 0.0004 * (((i * 7 + j) % 3) - 1) for j in range(n)]
            for i in range(n)
        ]
        request = {
            "mu": mu,
            "sigma": sigma,
            "risk_aversion": 0.5,
            "k": 4,
            "solvers": ["bsb", "dsb", "sa", "pt", "exact"],
            "seed": 11,
        }
        proc = subprocess.run(
            [str(BINARY)],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout.strip().splitlines()[-1])

        spread = int(out["exact"]["objective_range_int"])
        self.assertGreater(spread, 0)
        best = int(out["exact"]["objective_int"])
        worst = int(out["exact"]["worst_objective_int"])
        self.assertEqual(worst - best, spread)

        for result in out["results"]:
            with self.subTest(solver=result["solver"]):
                gap_norm = result["gap_norm"]
                self.assertGreaterEqual(gap_norm, 0.0)
                self.assertLessEqual(gap_norm, 1.0)
                self.assertAlmostEqual(
                    gap_norm, int(result["gap_int"]) / spread, places=12
                )


if __name__ == "__main__":
    unittest.main()
