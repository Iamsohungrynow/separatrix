from __future__ import annotations

import json
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from agent.workbench.bridge import (
    BridgeError,
    SeparatrixCli,
    discover_binary,
)

from tests.workbench_synth import make_case_dir

REPO_ROOT = Path(__file__).resolve().parents[1]

MU3 = [0.001, 0.002, -0.001]
SIGMA3 = [
    [4e-4, 1e-4, 0.0],
    [1e-4, 5e-4, 2e-5],
    [0.0, 2e-5, 6e-4],
]


def _cli() -> SeparatrixCli:
    return SeparatrixCli(binary=Path("fake-separatrix-cli"))


def _ok_payload(**overrides) -> dict:
    payload = {
        "n": 3,
        "k": 2,
        "scale": 12345.6,
        "exact": {
            "bits": [1, 1, 0],
            "objective_int": "-123456789012345678901",  # beyond i64/f64-safe
            "runtime_ms": 41,
        },
        "results": [
            {
                "solver": "sa",
                "bits": [1, 1, 0],
                "weights": [0.5, 0.5, 0.0],
                "objective_int": "-123456789012345678892",
                "feasible_raw": True,
                "repaired": False,
                "gap_int": "9",
                "gap_rel": 7.3e-8,
                "runtime_ms": 18,
            }
        ],
    }
    payload.update(overrides)
    return payload


def _completed(payload, returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess:
    stdout = payload if isinstance(payload, str) else json.dumps(payload) + "\n"
    return subprocess.CompletedProcess(
        args=[], returncode=returncode, stdout=stdout, stderr=stderr
    )


class SolveParsingTestCase(unittest.TestCase):
    def test_parses_success_response_with_decimal_string_ints(self) -> None:
        with patch(
            "agent.workbench.bridge.subprocess.run", return_value=_completed(_ok_payload())
        ):
            response = _cli().solve(MU3, SIGMA3, k=2, solvers=["sa", "exact"])

        self.assertEqual(response.n, 3)
        self.assertEqual(response.k, 2)
        self.assertAlmostEqual(response.scale, 12345.6)

        self.assertIsNotNone(response.exact)
        self.assertEqual(response.exact.bits, [1, 1, 0])
        self.assertEqual(response.exact.objective_int, -123456789012345678901)
        self.assertIsNone(response.exact.error)

        [result] = response.results
        self.assertEqual(result.solver, "sa")
        self.assertEqual(result.objective_int, -123456789012345678892)
        self.assertEqual(result.gap_int, 9)
        self.assertAlmostEqual(result.gap_rel, 7.3e-8)
        self.assertTrue(result.feasible_raw)
        self.assertFalse(result.repaired)
        self.assertEqual(result.weights, [0.5, 0.5, 0.0])
        self.assertEqual(result.runtime_ms, 18.0)

    def test_builds_protocol_request(self) -> None:
        with patch(
            "agent.workbench.bridge.subprocess.run", return_value=_completed(_ok_payload())
        ) as run:
            _cli().solve(
                MU3, SIGMA3, k=2,
                risk_aversion=0.5, solvers=["sa", "exact"], seed=42,
                budget={"sa_sweeps": 100}, max_exact_subsets=1000,
            )

        self.assertEqual(run.call_args.args[0], [str(Path("fake-separatrix-cli"))])
        request = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(request["k"], 2)
        self.assertEqual(request["seed"], 42)
        self.assertEqual(request["risk_aversion"], 0.5)
        self.assertEqual(request["solvers"], ["sa", "exact"])
        self.assertEqual(request["budget"], {"sa_sweeps": 100})
        self.assertEqual(request["max_exact_subsets"], 1000)
        self.assertNotIn("penalty", request)  # optional, omitted when None
        np.testing.assert_allclose(request["mu"], MU3)
        sigma = np.array(request["sigma"])
        np.testing.assert_allclose(sigma, sigma.T)  # symmetric on the wire

    def test_asymmetric_sigma_is_symmetrized(self) -> None:
        asym = [
            [4e-4, 2e-4, 0.0],
            [0.0, 5e-4, 0.0],
            [0.0, 0.0, 6e-4],
        ]
        with patch(
            "agent.workbench.bridge.subprocess.run", return_value=_completed(_ok_payload())
        ) as run:
            _cli().solve(MU3, asym, k=2)
        sigma = np.array(json.loads(run.call_args.kwargs["input"])["sigma"])
        np.testing.assert_allclose(sigma[0, 1], 1e-4)
        np.testing.assert_allclose(sigma[1, 0], 1e-4)

    def test_accepts_plain_integer_objectives(self) -> None:
        payload = _ok_payload()
        payload["results"][0]["objective_int"] = -100
        payload["results"][0]["gap_int"] = 0
        payload["exact"]["objective_int"] = -100
        with patch(
            "agent.workbench.bridge.subprocess.run", return_value=_completed(payload)
        ):
            response = _cli().solve(MU3, SIGMA3, k=2)
        self.assertEqual(response.results[0].objective_int, -100)
        self.assertEqual(response.results[0].gap_int, 0)

    def test_exact_too_large_yields_error_and_null_gaps(self) -> None:
        payload = _ok_payload(
            exact={"error": "TOO_LARGE", "subsets": 137846528820}
        )
        payload["results"][0]["gap_int"] = None
        payload["results"][0]["gap_rel"] = None
        with patch(
            "agent.workbench.bridge.subprocess.run", return_value=_completed(payload)
        ):
            response = _cli().solve(MU3, SIGMA3, k=2)

        self.assertEqual(response.exact.error, "TOO_LARGE")
        self.assertEqual(response.exact.subsets, 137846528820)
        self.assertIsNone(response.exact.bits)
        self.assertIsNone(response.results[0].gap_int)
        self.assertIsNone(response.results[0].gap_rel)

    def test_tolerates_log_noise_around_the_json_line(self) -> None:
        stdout = "INFO solver starting\n" + json.dumps(_ok_payload()) + "\n"
        with patch(
            "agent.workbench.bridge.subprocess.run", return_value=_completed(stdout)
        ):
            response = _cli().solve(MU3, SIGMA3, k=2)
        self.assertEqual(response.n, 3)

    def test_missing_weights_are_derived_from_bits(self) -> None:
        payload = _ok_payload()
        del payload["results"][0]["weights"]
        with patch(
            "agent.workbench.bridge.subprocess.run", return_value=_completed(payload)
        ):
            response = _cli().solve(MU3, SIGMA3, k=2)
        self.assertEqual(response.results[0].weights, [0.5, 0.5, 0.0])


class FailClosedTestCase(unittest.TestCase):
    def test_nonzero_exit_raises(self) -> None:
        with patch(
            "agent.workbench.bridge.subprocess.run",
            return_value=_completed("", returncode=3, stderr="panicked"),
        ):
            with self.assertRaisesRegex(BridgeError, "panicked"):
                _cli().solve(MU3, SIGMA3, k=2)

    def test_unparseable_stdout_raises(self) -> None:
        with patch(
            "agent.workbench.bridge.subprocess.run",
            return_value=_completed("not json at all\n"),
        ):
            with self.assertRaises(BridgeError):
                _cli().solve(MU3, SIGMA3, k=2)

    def test_timeout_raises(self) -> None:
        with patch(
            "agent.workbench.bridge.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="x", timeout=1),
        ):
            with self.assertRaisesRegex(BridgeError, "timed out"):
                _cli().solve(MU3, SIGMA3, k=2)

    def test_missing_binary_file_raises(self) -> None:
        with patch(
            "agent.workbench.bridge.subprocess.run",
            side_effect=FileNotFoundError("no such file"),
        ):
            with self.assertRaises(BridgeError):
                _cli().solve(MU3, SIGMA3, k=2)

    def test_undiscovered_binary_raises_without_spawning(self) -> None:
        case_dir = make_case_dir("wb_bridge_no_binary")
        with patch.dict(os.environ, {}, clear=True):
            cli = SeparatrixCli(project_root=case_dir)
        with patch("agent.workbench.bridge.subprocess.run") as run:
            with self.assertRaisesRegex(BridgeError, "not found"):
                cli.solve(MU3, SIGMA3, k=2)
        run.assert_not_called()

    def test_bits_length_mismatch_raises(self) -> None:
        payload = _ok_payload()
        payload["results"][0]["bits"] = [1, 1]
        with patch(
            "agent.workbench.bridge.subprocess.run", return_value=_completed(payload)
        ):
            with self.assertRaises(BridgeError):
                _cli().solve(MU3, SIGMA3, k=2)

    def test_non_binary_bit_raises(self) -> None:
        payload = _ok_payload()
        payload["results"][0]["bits"] = [1, 2, 0]
        with patch(
            "agent.workbench.bridge.subprocess.run", return_value=_completed(payload)
        ):
            with self.assertRaises(BridgeError):
                _cli().solve(MU3, SIGMA3, k=2)

    def test_bad_decimal_string_raises(self) -> None:
        payload = _ok_payload()
        payload["results"][0]["objective_int"] = "12x4"
        with patch(
            "agent.workbench.bridge.subprocess.run", return_value=_completed(payload)
        ):
            with self.assertRaises(BridgeError):
                _cli().solve(MU3, SIGMA3, k=2)

    def test_response_n_mismatch_raises(self) -> None:
        with patch(
            "agent.workbench.bridge.subprocess.run",
            return_value=_completed(_ok_payload(n=7)),
        ):
            with self.assertRaises(BridgeError):
                _cli().solve(MU3, SIGMA3, k=2)

    def test_non_finite_inputs_raise_before_spawn(self) -> None:
        with patch("agent.workbench.bridge.subprocess.run") as run:
            with self.assertRaises(BridgeError):
                _cli().solve([0.1, float("nan"), 0.2], SIGMA3, k=2)
        run.assert_not_called()

    def test_k_out_of_range_raises(self) -> None:
        with self.assertRaises(BridgeError):
            _cli().solve(MU3, SIGMA3, k=4)
        with self.assertRaises(BridgeError):
            _cli().solve(MU3, SIGMA3, k=0)


class DiscoveryTestCase(unittest.TestCase):
    def test_env_var_wins(self) -> None:
        with patch.dict(os.environ, {"SEPARATRIX_CLI": "custom/path/cli.exe"}):
            self.assertEqual(discover_binary(), Path("custom/path/cli.exe"))

    def test_release_exe_then_bare_name(self) -> None:
        case_dir = make_case_dir("wb_bridge_discovery")
        release = case_dir / "separatrix" / "target" / "release"
        release.mkdir(parents=True)

        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(discover_binary(case_dir))

            bare = release / "separatrix-cli"
            bare.write_bytes(b"")
            self.assertEqual(discover_binary(case_dir), bare)

            exe = release / "separatrix-cli.exe"
            exe.write_bytes(b"")
            self.assertEqual(discover_binary(case_dir), exe)  # .exe preferred


# ---------------------------------------------------------------------------
# Integration: only runs when the real Rust binary has been built.
# ---------------------------------------------------------------------------

_REAL_BINARY = None
if os.environ.get("SEPARATRIX_CLI"):
    candidate = Path(os.environ["SEPARATRIX_CLI"])
    _REAL_BINARY = candidate if candidate.exists() else None
else:
    found = discover_binary(REPO_ROOT)
    _REAL_BINARY = found if found is not None and found.exists() else None


@unittest.skipUnless(
    _REAL_BINARY is not None, "separatrix-cli binary not built; integration skipped"
)
class BridgeIntegrationTestCase(unittest.TestCase):
    def test_solves_a_tiny_six_asset_instance(self) -> None:
        rng = np.random.default_rng(42)
        n, k = 6, 3
        mu = rng.normal(0.001, 0.002, n)
        chol = rng.normal(0.0, 0.01, (n, n))
        sigma = chol @ chol.T + np.eye(n) * 1e-4  # symmetric PSD

        cli = SeparatrixCli(binary=_REAL_BINARY, timeout_seconds=120)
        response = cli.solve(
            mu, sigma, k,
            solvers=["bsb", "dsb", "sa", "pt", "exact"],
            seed=42,
            budget={
                "sb_steps": 200, "sb_replicas": 4,
                "sa_sweeps": 200, "sa_restarts": 4,
                "pt_sweeps": 200, "pt_replicas": 8,
            },
        )

        self.assertEqual(response.n, n)
        self.assertEqual(response.k, k)
        self.assertIsNotNone(response.exact)
        self.assertIsNone(response.exact.error)
        self.assertEqual(sum(response.exact.bits), k)
        self.assertGreater(len(response.results), 0)
        for result in response.results:
            self.assertEqual(sum(result.bits), k, f"{result.solver} not repaired to K")
            self.assertIsInstance(result.objective_int, int)
            if result.gap_int is not None:
                self.assertGreaterEqual(result.gap_int, 0)
                self.assertGreaterEqual(result.objective_int, response.exact.objective_int)
            self.assertAlmostEqual(sum(result.weights), 1.0, places=6)


if __name__ == "__main__":
    unittest.main()
