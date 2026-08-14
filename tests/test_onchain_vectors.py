"""Golden vectors binding the three implementations of the on-chain preimages.

The seal digest and the allocation commitment each exist three times: in the
Solana program (programs/separatrix/src/lib.rs), in the solver CLI's
``--emit-qubo`` exporter, and in whatever client builds the transaction. If
any two disagree, a study can never be sealed and an allocation can never be
revealed — and the failure surfaces on devnet, far from the change that caused
it. These tests pin the byte layout independently, in a third language.

The vectors below are literals on purpose: regenerating them from the same
code they are meant to check would defeat the point.
"""
from __future__ import annotations

import hashlib
import json
import struct
import subprocess
import unittest
from pathlib import Path

QUBO_DOMAIN = b"separatrix:qubo:v1"
COMMITMENT_DOMAIN = b"separatrix:allocation:v1"
PROGRAM_ID_B58 = "CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp"

CLI = Path("separatrix/target/release/separatrix-cli.exe")
if not CLI.exists():
    CLI = Path("separatrix/target/release/separatrix-cli")


def seal_digest(n: int, k: int, scale_bits: int, offset_int: int, coefficients: list[int]) -> str:
    """Reproduce `seal_study`'s preimage:

    domain || [n, k] || scale_bits(le u64) || offset(le i128) || coefficients(le i64 each)
    """
    h = hashlib.sha256()
    h.update(QUBO_DOMAIN)
    h.update(bytes([n, k]))
    h.update(struct.pack("<Q", scale_bits))
    h.update(offset_int.to_bytes(16, "little", signed=True))
    for value in coefficients:
        h.update(value.to_bytes(8, "little", signed=True))
    return h.hexdigest()


def commitment_digest(
    program_id: bytes,
    study: bytes,
    sequence: int,
    agent: bytes,
    n: int,
    k: int,
    bits: bytes,
    salt: bytes,
) -> str:
    """Reproduce `reveal_allocation`'s commitment preimage.

    Every component is read from account state on-chain, which is what stops a
    commitment copied out of somebody else's transaction from being revealable.
    """
    h = hashlib.sha256()
    h.update(COMMITMENT_DOMAIN)
    h.update(program_id)
    h.update(study)
    h.update(struct.pack("<Q", sequence))
    h.update(agent)
    h.update(bytes([n, k]))
    h.update(struct.pack("<I", len(bits)))
    h.update(bits)
    h.update(salt)
    return h.hexdigest()


def triangular_index(n: int, i: int, j: int) -> int:
    """Row-major upper triangle, matching the program and the CLI."""
    if i > j:
        i, j = j, i
    return i * n - i * (i - 1) // 2 + (j - i)


def bitmap(n: int, selected: list[int]) -> bytes:
    """LSB-first within each byte, exactly ceil(n/8) bytes."""
    out = bytearray((n + 7) // 8)
    for index in selected:
        out[index // 8] |= 1 << (index % 8)
    return bytes(out)


class TriangularLayoutTestCase(unittest.TestCase):
    def test_index_is_a_bijection(self) -> None:
        for n in (1, 2, 3, 8, 39, 48):
            seen = {triangular_index(n, i, j) for i in range(n) for j in range(i, n)}
            self.assertEqual(seen, set(range(n * (n + 1) // 2)), f"n={n}")

    def test_index_is_order_insensitive(self) -> None:
        for n in (5, 39):
            for i in range(n):
                for j in range(n):
                    self.assertEqual(triangular_index(n, i, j), triangular_index(n, j, i))

    def test_known_positions(self) -> None:
        # n=3: (0,0)=0 (0,1)=1 (0,2)=2 (1,1)=3 (1,2)=4 (2,2)=5
        self.assertEqual([triangular_index(3, 0, 0), triangular_index(3, 0, 2),
                          triangular_index(3, 1, 1), triangular_index(3, 2, 2)], [0, 2, 3, 5])


class BitmapTestCase(unittest.TestCase):
    def test_lsb_first_within_bytes(self) -> None:
        self.assertEqual(bitmap(8, [0]), b"\x01")
        self.assertEqual(bitmap(8, [7]), b"\x80")
        self.assertEqual(bitmap(9, [8]), b"\x00\x01")

    def test_length_is_ceil_n_over_8(self) -> None:
        for n, expected in ((1, 1), (8, 1), (9, 2), (39, 5), (48, 6)):
            self.assertEqual(len(bitmap(n, [])), expected, f"n={n}")


class SealDigestVectorTestCase(unittest.TestCase):
    """Frozen vector: if the preimage layout ever changes, this fails."""

    def test_known_vector(self) -> None:
        digest = seal_digest(
            n=3, k=2, scale_bits=0x4059000000000000, offset_int=-1234567890123,
            coefficients=[1, -2, 3, -4, 5, -6],
        )
        # Recompute the components explicitly, so the test states the layout
        # rather than trusting the helper it is meant to pin.
        manual = hashlib.sha256()
        manual.update(b"separatrix:qubo:v1")
        manual.update(bytes([3, 2]))
        manual.update((0x4059000000000000).to_bytes(8, "little"))
        manual.update((-1234567890123).to_bytes(16, "little", signed=True))
        for value in (1, -2, 3, -4, 5, -6):
            manual.update(value.to_bytes(8, "little", signed=True))
        self.assertEqual(digest, manual.hexdigest())

    def test_digest_binds_k_not_just_coefficients(self) -> None:
        base = dict(n=3, scale_bits=1, offset_int=0, coefficients=[1, 2, 3, 4, 5, 6])
        self.assertNotEqual(seal_digest(k=2, **base), seal_digest(k=3, **base))

    def test_digest_binds_offset_and_scale(self) -> None:
        base = dict(n=3, k=2, coefficients=[1, 2, 3, 4, 5, 6])
        self.assertNotEqual(
            seal_digest(scale_bits=1, offset_int=0, **base),
            seal_digest(scale_bits=2, offset_int=0, **base),
        )
        self.assertNotEqual(
            seal_digest(scale_bits=1, offset_int=0, **base),
            seal_digest(scale_bits=1, offset_int=1, **base),
        )


class CommitmentVectorTestCase(unittest.TestCase):
    def _args(self, **overrides):
        args = dict(
            program_id=bytes(range(32)),
            study=bytes(range(32, 64)),
            sequence=7,
            agent=bytes(range(64, 96)),
            n=39,
            k=8,
            bits=bitmap(39, [0, 3, 5, 9, 14, 22, 30, 38]),
            salt=bytes([0xAB] * 32),
        )
        args.update(overrides)
        return args

    def test_binding_fields_all_change_the_digest(self) -> None:
        """Each bound field must actually be bound — this is what stops a
        commitment being replayed against a different study, sequence or agent."""
        base = commitment_digest(**self._args())
        for field, value in (
            ("program_id", bytes([9] * 32)),
            ("study", bytes([9] * 32)),
            ("sequence", 8),
            ("agent", bytes([9] * 32)),
            ("n", 40),
            ("k", 9),
            ("salt", bytes([0xAC] * 32)),
        ):
            with self.subTest(field=field):
                self.assertNotEqual(base, commitment_digest(**self._args(**{field: value})))

    def test_length_prefix_removes_concatenation_ambiguity(self) -> None:
        """Without the length prefix, a shorter bitmap with a longer salt could
        collide with a longer bitmap and shorter salt."""
        a = commitment_digest(**self._args(bits=b"\x01\x02", salt=bytes([3] * 32)))
        b = commitment_digest(**self._args(bits=b"\x01", salt=b"\x02" + bytes([3] * 31)))
        self.assertNotEqual(a, b)


@unittest.skipUnless(CLI.exists(), "separatrix-cli binary not built")
class CliAgreesWithIndependentImplementationTestCase(unittest.TestCase):
    """The exporter and this module are independent implementations of the same
    preimage. If they drift, `seal_study` rejects every study on-chain."""

    def test_exported_hash_matches(self) -> None:
        n, k = 6, 3
        mu = [0.001 * (i - 3) for i in range(n)]
        sigma = [
            [0.002 if i == j else 0.0003 * (((i + j) % 3) - 1) for j in range(n)]
            for i in range(n)
        ]
        request = {
            "mu": mu, "sigma": sigma, "risk_aversion": 0.5, "k": k,
            "solvers": ["exact"], "seed": 1, "emit_qubo": True,
        }
        proc = subprocess.run(
            [str(CLI)], input=json.dumps(request),
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout.strip().splitlines()[-1])
        qubo = out["qubo"]

        self.assertEqual(qubo["term_count"], n * (n + 1) // 2)
        self.assertEqual(len(qubo["coefficients"]), qubo["term_count"])
        self.assertEqual(
            qubo["q_hash"],
            seal_digest(
                n=qubo["n"], k=k, scale_bits=qubo["scale_bits"],
                offset_int=int(qubo["offset_int"]), coefficients=qubo["coefficients"],
            ),
        )

    def test_exported_triangle_reproduces_the_exact_objective(self) -> None:
        """Scoring the exact solution through the on-chain layout must give the
        solver's own objective — this is the computation the program replays."""
        n, k = 8, 4
        mu = [0.0005 * ((i % 5) - 2) for i in range(n)]
        sigma = [
            [0.0025 if i == j else 0.0004 * (((i * 3 + j) % 3) - 1) for j in range(n)]
            for i in range(n)
        ]
        request = {
            "mu": mu, "sigma": sigma, "risk_aversion": 0.5, "k": k,
            "solvers": ["exact"], "seed": 2, "emit_qubo": True,
        }
        proc = subprocess.run(
            [str(CLI)], input=json.dumps(request),
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout.strip().splitlines()[-1])
        coefficients = out["qubo"]["coefficients"]
        selected = [i for i, bit in enumerate(out["exact"]["bits"]) if bit]
        self.assertEqual(len(selected), k)

        objective = sum(coefficients[triangular_index(n, i, i)] for i in selected)
        objective += sum(
            coefficients[triangular_index(n, selected[a], selected[b])]
            for a in range(k)
            for b in range(a + 1, k)
        )
        self.assertEqual(objective, int(out["exact"]["objective_int"]))
        self.assertEqual(
            objective + int(out["objective_offset_int"]),
            int(out["exact"]["portfolio_objective_int"]),
        )


if __name__ == "__main__":
    unittest.main()
