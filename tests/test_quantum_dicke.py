"""Tests for the Dicke / XY-mixer primitives.

Split deliberately in two:

* Everything that does **not** need the Quantinuum stack always runs — the
  analytic |D^n_k>, the weight-k projector, the in-constraint metrics, the HQC
  cost proxy, the (n, k) grid logic, and the numpy reference simulator. That
  last one matters: it means the *correctness of the SCS construction itself*
  is pinned in CI without pytket, qiskit, guppy or selene installed anywhere.
* Everything that does need pytket is guarded by ``skipUnless``, and checks the
  one thing the pure-Python half cannot: that the pytket circuit is the same
  circuit as the IR, amplitude for amplitude.
* A third group, guarded on qiskit, checks that the port really is a port: the
  IR is compared gate-for-gate and statevector-for-statevector against
  ``scripts/heron_qaoa.py``, the implementation it was taken from.

In an environment with the full Quantinuum stack (see
``requirements-quantinuum.txt``) all three groups run.
"""

from __future__ import annotations

import importlib.util
import math
import sys
import unittest
from pathlib import Path

import numpy as np

from quantum import dicke_xy as dx

HAVE_PYTKET = importlib.util.find_spec("pytket") is not None
HAVE_QISKIT = importlib.util.find_spec("qiskit") is not None
HERON = Path(__file__).resolve().parent.parent / "scripts" / "heron_qaoa.py"


def _load_heron():
    """Load scripts/heron_qaoa.py by path; it is a script, not an importable package."""
    spec = importlib.util.spec_from_file_location("heron_qaoa_under_test", HERON)
    module = importlib.util.module_from_spec(spec)
    sys.modules["heron_qaoa_under_test"] = module
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------
# Analytic reference
# --------------------------------------------------------------------------


class AnalyticDickeTestCase(unittest.TestCase):
    def test_is_normalised_and_uniform_over_weight_k(self) -> None:
        for n in range(1, 9):
            for k in range(0, n + 1):
                state = dx.analytic_dicke_state(n, k)
                self.assertAlmostEqual(float(np.vdot(state, state).real), 1.0, places=12)
                support = np.flatnonzero(np.abs(state) > 0)
                self.assertEqual(len(support), math.comb(n, k))
                amplitudes = np.abs(state[support])
                self.assertTrue(np.allclose(amplitudes, amplitudes[0]))

    def test_support_is_exactly_the_weight_k_bitstrings(self) -> None:
        n, k = 6, 3
        support = set(np.flatnonzero(np.abs(dx.analytic_dicke_state(n, k)) > 0).tolist())
        expected = {s for s in range(1 << n) if bin(s).count("1") == k}
        self.assertEqual(support, expected)

    def test_k_zero_and_k_n_are_the_product_states(self) -> None:
        self.assertAlmostEqual(abs(dx.analytic_dicke_state(4, 0)[0]), 1.0)
        self.assertAlmostEqual(abs(dx.analytic_dicke_state(4, 4)[15]), 1.0)

    def test_rejects_out_of_range_k(self) -> None:
        with self.assertRaises(ValueError):
            dx.analytic_dicke_state(4, 5)
        with self.assertRaises(ValueError):
            dx.weight_sector_indices(4, -1)


class WeightSectorTestCase(unittest.TestCase):
    def test_indices_have_the_right_popcount(self) -> None:
        for n in range(1, 8):
            for k in range(0, n + 1):
                indices = dx.weight_sector_indices(n, k)
                self.assertEqual(len(indices), math.comb(n, k))
                for index in indices.tolist():
                    self.assertEqual(bin(index).count("1"), k)

    def test_projector_keeps_only_the_sector(self) -> None:
        n, k = 5, 2
        state = np.arange(1 << n, dtype=complex) + 1.0
        projected = dx.project_weight_sector(state, n, k)
        keep = set(dx.weight_sector_indices(n, k).tolist())
        for index in range(1 << n):
            if index in keep:
                self.assertEqual(projected[index], state[index])
            else:
                self.assertEqual(projected[index], 0)

    def test_projector_rejects_a_mismatched_state(self) -> None:
        with self.assertRaises(ValueError):
            dx.project_weight_sector(np.zeros(8, dtype=complex), 4, 2)

    def test_sectors_partition_the_space(self) -> None:
        n = 6
        total = sum(len(dx.weight_sector_indices(n, k)) for k in range(n + 1))
        self.assertEqual(total, 1 << n)


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------


class InConstraintMetricTestCase(unittest.TestCase):
    def test_dicke_state_is_fully_in_constraint(self) -> None:
        n, k = 6, 2
        probabilities = np.abs(dx.analytic_dicke_state(n, k)) ** 2
        self.assertAlmostEqual(dx.in_constraint_probability(probabilities, n, k), 1.0, places=12)
        self.assertAlmostEqual(dx.in_constraint_probability(probabilities, n, k + 1), 0.0, places=12)

    def test_uniform_distribution_matches_the_binomial_fraction(self) -> None:
        n, k = 8, 3
        probabilities = np.full(1 << n, 1.0 / (1 << n))
        self.assertAlmostEqual(
            dx.in_constraint_probability(probabilities, n, k),
            math.comb(n, k) / (1 << n),
            places=12,
        )

    def test_hamming_weight_distribution_sums_to_one_and_matches_binomial(self) -> None:
        n = 7
        probabilities = np.full(1 << n, 1.0 / (1 << n))
        distribution = dx.hamming_weight_distribution(probabilities, n)
        self.assertEqual(len(distribution), n + 1)
        self.assertAlmostEqual(float(distribution.sum()), 1.0, places=12)
        for w in range(n + 1):
            self.assertAlmostEqual(distribution[w], math.comb(n, w) / (1 << n), places=12)

    def test_hamming_weight_distribution_rejects_a_mismatched_length(self) -> None:
        with self.assertRaises(ValueError):
            dx.hamming_weight_distribution(np.ones(8) / 8, 4)

    def test_from_shots_counts_bitstrings_regardless_of_representation(self) -> None:
        shots = [[1, 1, 0, 0], "1100", [0, 1, 1, 0], [1, 1, 1, 0]]
        probability, hits, total = dx.in_constraint_probability_from_shots(shots, 2)
        self.assertEqual((hits, total), (3, 4))
        self.assertAlmostEqual(probability, 0.75)

    def test_from_shots_is_permutation_invariant(self) -> None:
        """The metric survives a transpiler relabelling qubits. That is the point."""
        shots = [[1, 0, 1, 0], [0, 1, 0, 1]]
        permuted = [[bits[i] for i in (3, 1, 2, 0)] for bits in shots]
        self.assertEqual(
            dx.in_constraint_probability_from_shots(shots, 2),
            dx.in_constraint_probability_from_shots(permuted, 2),
        )

    def test_from_shots_with_no_shots_is_zero_not_a_crash(self) -> None:
        self.assertEqual(dx.in_constraint_probability_from_shots([], 2), (0.0, 0, 0))


class SubspaceLossRateTestCase(unittest.TestCase):
    def test_matches_the_closed_form(self) -> None:
        self.assertAlmostEqual(
            dx.subspace_leakage_rate(math.exp(-0.5), 100), 0.005, places=12
        )

    def test_perfect_retention_is_zero_rate(self) -> None:
        self.assertAlmostEqual(dx.subspace_leakage_rate(1.0, 50), 0.0, places=12)

    def test_undefined_cases_return_none_rather_than_a_number(self) -> None:
        self.assertIsNone(dx.subspace_leakage_rate(0.5, 0))
        self.assertIsNone(dx.subspace_leakage_rate(0.0, 10))
        self.assertIsNone(dx.subspace_leakage_rate(1.5, 10))

    def test_rate_is_constant_when_loss_is_per_gate_independent(self) -> None:
        per_gate = 1e-3
        rates = [
            dx.subspace_leakage_rate((1.0 - per_gate) ** gates, gates)
            for gates in (50, 200, 800)
        ]
        self.assertTrue(all(abs(rate - rates[0]) < 1e-12 for rate in rates))


class HqcCostTestCase(unittest.TestCase):
    def test_matches_the_published_formula(self) -> None:
        # 5 + (1000/5000) * (10 + 10*20 + 5*4) = 5 + 0.2*230 = 51.0
        self.assertAlmostEqual(dx.hqc_estimate(1000, 10, 20, 4), 51.0, places=9)

    def test_zero_shots_is_the_floor(self) -> None:
        self.assertAlmostEqual(dx.hqc_estimate(0, 100, 100, 10), dx.HELIOS.hqc_floor)

    def test_two_qubit_gates_dominate_the_charge(self) -> None:
        one_qubit_heavy = dx.hqc_estimate(1000, 100, 0, 0)
        two_qubit_heavy = dx.hqc_estimate(1000, 0, 100, 0)
        self.assertAlmostEqual(
            two_qubit_heavy - dx.HELIOS.hqc_floor,
            10.0 * (one_qubit_heavy - dx.HELIOS.hqc_floor),
            places=9,
        )

    def test_rejects_negative_shots(self) -> None:
        with self.assertRaises(ValueError):
            dx.hqc_estimate(-1, 1, 1, 1)


# --------------------------------------------------------------------------
# Grid logic
# --------------------------------------------------------------------------


class SweepGridTestCase(unittest.TestCase):
    def test_all_mode_covers_one_to_half_n(self) -> None:
        self.assertEqual(
            dx.sweep_grid([4, 5, 6]),
            [(4, 1), (4, 2), (5, 1), (5, 2), (6, 1), (6, 2), (6, 3)],
        )

    def test_half_mode_takes_only_the_widest_sector(self) -> None:
        self.assertEqual(dx.sweep_grid([6, 8], "half"), [(6, 3), (8, 4)])

    def test_fixed_mode_drops_infeasible_k(self) -> None:
        self.assertEqual(dx.sweep_grid([4], "fixed", [1, 3, 4, 9]), [(4, 1), (4, 3)])

    def test_grid_never_contains_k_zero_or_k_equal_n(self) -> None:
        for n, k in dx.sweep_grid([2, 3, 4, 7, 12]):
            self.assertGreater(k, 0)
            self.assertLess(k, n)

    def test_ordering_is_stable(self) -> None:
        self.assertEqual(dx.sweep_grid([8, 6]), dx.sweep_grid([8, 6]))
        self.assertEqual(dx.sweep_grid([8, 6])[0][0], 8)

    def test_rejects_bad_inputs(self) -> None:
        with self.assertRaises(ValueError):
            dx.sweep_grid([1])
        with self.assertRaises(ValueError):
            dx.sweep_grid([4], "nonsense")
        with self.assertRaises(ValueError):
            dx.sweep_grid([4], "fixed")


# --------------------------------------------------------------------------
# The construction, verified in numpy alone
# --------------------------------------------------------------------------


class ConstructionTestCase(unittest.TestCase):
    """No quantum SDK is involved in any of this."""

    def test_scs_construction_prepares_the_analytic_dicke_state(self) -> None:
        for n in range(2, 8):
            for k in range(0, n + 1):
                state = dx.simulate(dx.dicke_ops(n, k), n)
                fidelity = dx.state_fidelity(dx.analytic_dicke_state(n, k), state)
                self.assertGreater(
                    fidelity, 1.0 - 1e-12, f"|D^{n}_{k}> fidelity {fidelity}"
                )

    def test_verify_dicke_state_accepts_the_construction(self) -> None:
        state = dx.simulate(dx.dicke_ops(6, 3), 6)
        self.assertGreater(dx.verify_dicke_state(state, 6, 3), 1.0 - 1e-12)

    def test_verify_dicke_state_raises_on_the_wrong_state(self) -> None:
        with self.assertRaises(dx.VerificationError):
            dx.verify_dicke_state(dx.analytic_dicke_state(6, 2), 6, 3)

    def test_a_sign_error_in_the_angle_is_caught(self) -> None:
        """The negated Ry angle is the convention that took three attempts."""
        ops = [
            (name, tuple(-p for p in params) if name == "cnry" else params, qubits)
            for name, params, qubits in dx.dicke_ops(6, 3)
        ]
        state = dx.simulate(ops, 6)
        with self.assertRaises(dx.VerificationError):
            dx.verify_dicke_state(state, 6, 3)

    def test_gate_count_is_linear_in_k_times_n(self) -> None:
        # arXiv:1904.07358 bounds the SCS construction by O(kn) gates.
        for n, k in ((8, 2), (12, 3), (16, 4)):
            self.assertLessEqual(len(dx.dicke_ops(n, k)), 12 * k * n)

    def test_ring_edges_cover_the_ring_exactly_once(self) -> None:
        for n in (4, 6, 7, 8):
            even, odd = dx.ring_edges(n)
            edges = {tuple(sorted(edge)) for edge in even + odd}
            expected = {tuple(sorted((i, (i + 1) % n))) for i in range(n)}
            self.assertEqual(edges, expected)
            self.assertEqual(len(even) + len(odd), n)

    def test_ring_colour_classes_are_internally_disjoint(self) -> None:
        even, odd = dx.ring_edges(8)
        for group in (even, odd):
            touched = [q for edge in group for q in edge]
            self.assertEqual(len(touched), len(set(touched)))

    def test_xy_mixer_preserves_hamming_weight(self) -> None:
        for n, k in ((4, 2), (6, 2), (6, 3)):
            state = dx.simulate(dx.ansatz_ops(n, k, [0.4, 0.9]), n)
            population = dx.in_constraint_probability(np.abs(state) ** 2, n, k)
            self.assertAlmostEqual(population, 1.0, places=10)

    def test_xy_mixer_actually_moves_the_state(self) -> None:
        """A mixer that preserves weight by doing nothing would pass everything else."""
        n, k = 6, 3
        prepared = dx.simulate(dx.dicke_ops(n, k), n)
        mixed = dx.simulate(dx.ansatz_ops(n, k, [0.4]), n)
        self.assertLess(dx.state_fidelity(prepared, mixed), 0.999)

    def test_verify_weight_sector_raises_when_the_symmetry_is_broken(self) -> None:
        n, k = 4, 2
        ops = dx.dicke_ops(n, k) + [("x", (), (0,))]
        state = dx.simulate(ops, n)
        with self.assertRaises(dx.VerificationError):
            dx.verify_weight_sector(state, n, k)

    def test_simulator_keeps_the_state_normalised(self) -> None:
        state = dx.simulate(dx.ansatz_ops(6, 3, [0.4, 1.1]), 6)
        self.assertAlmostEqual(float(np.vdot(state, state).real), 1.0, places=12)

    def test_rejects_impossible_parameters(self) -> None:
        with self.assertRaises(ValueError):
            dx.dicke_ops(4, 5)
        with self.assertRaises(ValueError):
            dx.dicke_ops(0, 0)


def _multi_qubit_ir_gates(ops) -> int:
    """cx + cnry ops: the IR's multi-qubit gate count, the same for either construction."""
    return sum(1 for name, _, _ in ops if name in ("cx", "cnry"))


class DivideAndConquerConstructionTestCase(unittest.TestCase):
    """dicke_ops_dc, verified in numpy alone against the analytic |D^n_k>."""

    def test_split_amplitudes_are_the_hypergeometric_law(self) -> None:
        n, k, m1 = 10, 4, 4
        split = dx.dc_split_amplitudes(n, k, m1)
        self.assertEqual([weight for weight, _ in split], list(range(0, 5)))
        self.assertAlmostEqual(sum(a * a for _, a in split), 1.0, places=12)
        # k - m2 > 0 truncates the range from below; k > m1 from above.
        self.assertEqual([weight for weight, _ in dx.dc_split_amplitudes(6, 5, 3)], [2, 3])
        for weight, a in dx.dc_split_amplitudes(8, 3, 5):
            expected = math.comb(5, weight) * math.comb(3, 3 - weight) / math.comb(8, 3)
            self.assertAlmostEqual(a * a, expected, places=12)

    def test_prepares_the_analytic_dicke_state_up_to_n_twelve(self) -> None:
        for n in range(2, 13):
            for k in range(1, n):
                state = dx.simulate(dx.dicke_ops_dc(n, k), n)
                fidelity = dx.verify_dicke_state(state, n, k)  # raises below 1-1e-9
                self.assertGreater(fidelity, 1.0 - 1e-12, f"|D^{n}_{k}> fidelity {fidelity}")

    def test_every_cut_position_prepares_the_same_state(self) -> None:
        """m1 is a free parameter; the recurrence holds for any cut, degenerate ones included."""
        for n in range(2, 8):
            for k in range(0, n + 1):
                for m1 in range(0, n + 1):
                    state = dx.simulate(dx.dicke_ops_dc(n, k, m1), n)
                    fidelity = dx.state_fidelity(dx.analytic_dicke_state(n, k), state)
                    self.assertGreater(fidelity, 1.0 - 1e-12, f"n={n} k={k} m1={m1}")

    def test_trivial_weights_are_product_states(self) -> None:
        self.assertEqual(dx.dicke_ops_dc(5, 0), [])
        self.assertEqual(dx.dicke_ops_dc(5, 5), [("x", (), (q,)) for q in range(5)])
        self.assertEqual(dx.dicke_ops_dc(1, 1), [("x", (), (0,))])

    def test_half_unitary_is_the_scs_cascade_gate_for_gate(self) -> None:
        """The conquer stage is exactly dicke_ops minus its X layer, translated."""
        for n, k in ((5, 2), (8, 3), (9, 4)):
            expected = [op for op in dx.dicke_ops(n, k) if op[0] != "x"]
            self.assertEqual(dx._scs_unitary_ops(0, n, k), expected)
            shifted = dx._scs_unitary_ops(3, n, k)
            self.assertEqual(
                shifted,
                [(name, params, tuple(q + 3 for q in qubits)) for name, params, qubits in expected],
            )

    def test_a_sign_error_in_the_split_angle_is_caught(self) -> None:
        ops = dx.dicke_ops_dc(8, 3)
        first_split = next(i for i, op in enumerate(ops) if op[0] == "cnry")
        name, params, qubits = ops[first_split]
        ops[first_split] = (name, tuple(-p for p in params), qubits)
        with self.assertRaises(dx.VerificationError):
            dx.verify_dicke_state(dx.simulate(ops, 8), 8, 3)

    def test_uses_fewer_multi_qubit_gates_than_scs(self) -> None:
        for n, k in ((10, 3), (8, 4), (12, 6)):
            self.assertLess(
                _multi_qubit_ir_gates(dx.dicke_ops_dc(n, k)),
                _multi_qubit_ir_gates(dx.dicke_ops(n, k)),
                f"n={n} k={k}",
            )
        # k = 1 is the degenerate case: the split ladder is one gadget and the
        # halves cost what the whole did, so the count ties (depth still halves).
        self.assertEqual(
            _multi_qubit_ir_gates(dx.dicke_ops_dc(10, 1)),
            _multi_qubit_ir_gates(dx.dicke_ops(10, 1)),
        )

    def test_xy_mixer_on_the_dc_state_preserves_the_weight_sector(self) -> None:
        for n, k in ((6, 3), (8, 2), (9, 4)):
            state = dx.simulate(dx.ansatz_ops(n, k, [0.4, 0.9], construction="dc"), n)
            population = dx.verify_weight_sector(state, n, k)
            self.assertGreater(population, 1.0 - dx.DEFAULT_FIDELITY_TOLERANCE)

    def test_dispatcher_defaults_to_scs_and_rejects_unknown_names(self) -> None:
        self.assertEqual(dx.build_dicke_ops(6, 2), dx.dicke_ops(6, 2))
        self.assertEqual(dx.build_dicke_ops(6, 2, "dc"), dx.dicke_ops_dc(6, 2))
        self.assertEqual(dx.ansatz_ops(6, 2, [0.3]), dx.ansatz_ops(6, 2, [0.3], "scs"))
        with self.assertRaises(ValueError):
            dx.build_dicke_ops(6, 2, "recursive")
        self.assertEqual(dx.DICKE_CONSTRUCTIONS, ("scs", "dc"))

    def test_rejects_impossible_parameters(self) -> None:
        with self.assertRaises(ValueError):
            dx.dicke_ops_dc(4, 5)
        with self.assertRaises(ValueError):
            dx.dicke_ops_dc(0, 0)
        with self.assertRaises(ValueError):
            dx.dicke_ops_dc(4, 2, m1=5)
        with self.assertRaises(ValueError):
            dx.dc_split_amplitudes(4, 2, 7)


class GeneratedHeavyHexTestCase(unittest.TestCase):
    """The fallback coupling graph, used only when no device snapshot is available.

    It is otherwise dead code in an environment that has qiskit-ibm-runtime, so
    it gets pinned here rather than discovered to be wrong on a machine that
    does not.
    """

    @staticmethod
    def _degrees(edges: list[tuple[int, int]]) -> dict[int, int]:
        degrees: dict[int, int] = {}
        for a, b in edges:
            degrees[a] = degrees.get(a, 0) + 1
            degrees[b] = degrees.get(b, 0) + 1
        return degrees

    def test_no_vertex_exceeds_degree_three(self) -> None:
        """The defining property of heavy-hex, and the reason it routes badly."""
        for rows, cols in ((3, 5), (4, 7), (5, 9)):
            edges = dx.generated_heavy_hex_edges(rows, cols)
            self.assertLessEqual(max(self._degrees(edges).values()), 3, f"{rows}x{cols}")

    def test_link_qubits_have_degree_exactly_two(self) -> None:
        rows, cols = 3, 5
        edges = dx.generated_heavy_hex_edges(rows, cols)
        degrees = self._degrees(edges)
        for node in range(rows * cols, max(degrees) + 1):
            self.assertEqual(degrees[node], 2)

    def test_graph_is_connected(self) -> None:
        edges = dx.generated_heavy_hex_edges(3, 7)
        adjacency: dict[int, set[int]] = {}
        for a, b in edges:
            adjacency.setdefault(a, set()).add(b)
            adjacency.setdefault(b, set()).add(a)
        seen = {next(iter(adjacency))}
        stack = list(seen)
        while stack:
            for neighbour in adjacency[stack.pop()]:
                if neighbour not in seen:
                    seen.add(neighbour)
                    stack.append(neighbour)
        self.assertEqual(len(seen), len(adjacency))

    def test_rejects_a_degenerate_lattice(self) -> None:
        with self.assertRaises(ValueError):
            dx.generated_heavy_hex_edges(0, 5)


class DistanceHelpersTestCase(unittest.TestCase):
    def test_total_variation_distance_bounds(self) -> None:
        p = np.array([0.5, 0.5])
        self.assertAlmostEqual(dx.total_variation_distance(p, p), 0.0)
        self.assertAlmostEqual(
            dx.total_variation_distance(np.array([1.0, 0.0]), np.array([0.0, 1.0])), 1.0
        )

    def test_state_fidelity_is_phase_insensitive(self) -> None:
        state = dx.analytic_dicke_state(4, 2)
        self.assertAlmostEqual(dx.state_fidelity(state, 1j * state), 1.0, places=12)


# --------------------------------------------------------------------------
# pytket layer — skipped when the Quantinuum stack is not installed
# --------------------------------------------------------------------------


@unittest.skipUnless(HAVE_PYTKET, "pytket is not installed (see requirements-quantinuum.txt)")
class TketLayerTestCase(unittest.TestCase):
    def test_pytket_circuit_matches_the_reference_simulator(self) -> None:
        """The half-turn conversion at the pytket boundary, pinned."""
        for n, k in ((4, 2), (6, 3)):
            circuit = dx.ansatz_circuit(n, k, [0.4, 0.9])
            produced = dx.tket_statevector(circuit)
            reference = dx.simulate(dx.ansatz_ops(n, k, [0.4, 0.9]), n)
            self.assertGreater(dx.state_fidelity(reference, produced), 1.0 - 1e-12)

    def test_pytket_dicke_circuit_passes_the_analytic_check(self) -> None:
        for n, k in ((4, 2), (6, 2), (8, 3)):
            fidelity = dx.verify_dicke_state(dx.tket_statevector(dx.dicke_circuit(n, k)), n, k)
            self.assertGreater(fidelity, 1.0 - dx.DEFAULT_FIDELITY_TOLERANCE)

    def test_pytket_dc_circuit_matches_the_reference_simulator(self) -> None:
        """Same half-turn boundary, second construction: nothing new to get wrong, checked anyway."""
        for n, k in ((4, 2), (6, 3), (7, 3)):
            circuit = dx.ansatz_circuit(n, k, [0.4, 0.9], construction="dc")
            produced = dx.tket_statevector(circuit)
            reference = dx.simulate(dx.ansatz_ops(n, k, [0.4, 0.9], construction="dc"), n)
            self.assertGreater(dx.state_fidelity(reference, produced), 1.0 - 1e-12)
            fidelity = dx.verify_dicke_state(
                dx.tket_statevector(dx.dicke_circuit(n, k, construction="dc")), n, k
            )
            self.assertGreater(fidelity, 1.0 - dx.DEFAULT_FIDELITY_TOLERANCE)

    def test_dc_compiles_to_fewer_two_qubit_gates_and_shallower_depth_than_scs(self) -> None:
        n, k = 8, 3
        arch = dx.all_to_all_architecture(n)
        scs = dx.circuit_stats(dx.compile_for_architecture(dx.dicke_circuit(n, k), arch))
        dc = dx.circuit_stats(
            dx.compile_for_architecture(dx.dicke_circuit(n, k, construction="dc"), arch)
        )
        self.assertLess(dc["two_qubit_gates"], scs["two_qubit_gates"])
        self.assertLess(dc["two_qubit_depth"], scs["two_qubit_depth"])

    def test_compilation_preserves_the_weight_sector_on_every_architecture(self) -> None:
        n, k = 6, 2
        logical = dx.ansatz_circuit(n, k, [0.4])
        for architecture in (
            dx.all_to_all_architecture(n),
            dx.line_architecture(n),
        ):
            compiled = dx.compile_for_architecture(logical, architecture)
            population = dx.verify_weight_sector(dx.tket_statevector(compiled), n, k)
            self.assertGreater(population, 1.0 - dx.DEFAULT_FIDELITY_TOLERANCE)

    def test_compilation_emits_only_helios_native_gates(self) -> None:
        n, k = 6, 2
        compiled = dx.compile_for_architecture(
            dx.ansatz_circuit(n, k, [0.4]), dx.all_to_all_architecture(n)
        )
        native = {gate.name for gate in dx.helios_native_gates()}
        for command in compiled.get_commands():
            self.assertIn(command.op.type.name, native | {"Barrier"})

    def test_limited_connectivity_costs_more_two_qubit_gates(self) -> None:
        n, k = 8, 3
        logical = dx.ansatz_circuit(n, k, [0.4])
        all_to_all = dx.circuit_stats(
            dx.compile_for_architecture(logical, dx.all_to_all_architecture(n))
        )
        linear = dx.circuit_stats(
            dx.compile_for_architecture(logical, dx.line_architecture(n))
        )
        self.assertGreater(linear["two_qubit_gates"], all_to_all["two_qubit_gates"])

    def test_circuit_stats_counts_arities_consistently(self) -> None:
        stats = dx.circuit_stats(dx.dicke_circuit(6, 2))
        self.assertEqual(stats["qubits"], 6)
        self.assertEqual(
            stats["total_gates"], stats["one_qubit_gates"] + stats["two_qubit_gates"]
        )
        self.assertGreater(stats["depth"], 0)


@unittest.skipUnless(
    HAVE_QISKIT and HERON.exists(),
    "qiskit or scripts/heron_qaoa.py unavailable (see requirements-quantum.txt)",
)
class PortFidelityTestCase(unittest.TestCase):
    """This module claims to be a *port*, not a reimplementation. Pin that.

    ``scripts/heron_qaoa.py::build_dicke_circuit`` is the version that was
    debugged into correctness over three attempts. If the IR here ever drifts
    from it — a flipped sign, a reversed loop, an off-by-one in the ``n - k``
    offset — these tests fail rather than the drift being discovered later in a
    number nobody can reproduce.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.heron = _load_heron()

    def test_ring_edges_are_identical(self) -> None:
        for n in (4, 6, 7, 8, 10):
            self.assertEqual(self.heron.ring_edges(n), dx.ring_edges(n), f"n={n}")

    def test_ir_matches_the_qiskit_circuit_gate_for_gate(self) -> None:
        for n, k in ((6, 3), (10, 3)):
            circuit = self.heron.build_dicke_circuit(n, k)
            reference = [
                (
                    instruction.operation.name,
                    tuple(float(p) for p in instruction.operation.params),
                    tuple(circuit.find_bit(q).index for q in instruction.qubits),
                )
                for instruction in circuit.data
            ]
            ported = dx.dicke_ops(n, k)
            self.assertEqual(len(ported), len(reference), f"n={n} k={k}")
            for (name, params, qubits), (ref_name, ref_params, ref_qubits) in zip(
                ported, reference
            ):
                self.assertEqual(qubits, ref_qubits)
                if name == "cnry":
                    self.assertEqual(ref_name, "cry" if len(qubits) == 2 else "ccry")
                    self.assertAlmostEqual(params[0], ref_params[0], places=15)
                else:
                    self.assertEqual(name, ref_name)

    def test_statevectors_agree_for_every_n_and_k_up_to_eight(self) -> None:
        from qiskit.quantum_info import Statevector

        for n in range(2, 9):
            for k in range(0, n + 1):
                circuit = self.heron.build_dicke_circuit(n, k)
                # qiskit is little-endian; reverse_qargs gives pytket's ordering.
                reference = np.asarray(
                    Statevector.from_instruction(circuit).reverse_qargs().data
                )
                ported = dx.simulate(dx.dicke_ops(n, k), n)
                self.assertGreater(
                    dx.state_fidelity(reference, ported), 1.0 - 1e-12, f"n={n} k={k}"
                )


if __name__ == "__main__":
    unittest.main()
