"""The workbench's on-chain commitment client.

Three things are being defended here:

1. **Byte agreement.** ``agent/workbench/onchain.py`` and
   ``tests/test_onchain_vectors.py`` are independent implementations of the
   same commitment preimage and the same bitmap. If they drift, a published
   allocation stops being revealable and the failure surfaces on devnet, far
   from the change that caused it. Every digest below is checked against the
   other implementation, and one is checked against a commitment that is
   actually on devnet (docs/onchain.md §2.2).
2. **No silent drops.** A ticker the study has never heard of, or a selection
   that is not exactly ``k`` assets, must raise. Dropping either would publish
   a commitment the program refuses to open, after the rent is paid.
3. **Fail-closed.** Every bridge failure raises. There is no code path that
   returns something receipt-shaped without a landed transaction behind it.

No test here touches the network: every subprocess call is mocked.
"""
from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from agent.workbench import onchain
from agent.workbench.onchain import (
    CommitmentBridgeError,
    OnChainError,
    SelectionError,
    StudyCommitter,
    StudyRef,
    bitmap_len,
    bitmap_tickers,
    build_commitment,
    commitment_digest,
    commitment_preimage,
    decode_bitmap,
    encode_bitmap,
    generate_salt,
    score_selection,
    selection_bitmap,
    selection_indices,
    triangular_index,
)

# The canonical, independently written implementations.
from tests.test_onchain_vectors import (
    bitmap as vector_bitmap,
    commitment_digest as vector_commitment_digest,
    triangular_index as vector_triangular_index,
)

PROGRAM_ID = "CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp"

# The live devnet allocation from docs/onchain.md §2.2:
# study 4fzo7j…R6PV, allocation FF7qPkHStSe67FhecjsFyqRoUCtqxup5wMM7eqmbmA6N.
LIVE_STUDY = "4fzo7jXAecbxZ32oGAyfMk28VkSs8YCThcFapL86R6PV"
LIVE_AGENT = "AM1tDDPyyj1q4bsWtZXB88G1Ku5hUrSXZDWjhp5VYPot"
LIVE_ALLOCATION = "FF7qPkHStSe67FhecjsFyqRoUCtqxup5wMM7eqmbmA6N"
LIVE_SALT = "843f2af38c01fae6a249da953eb16037aa92e994d1bc02906151a9ec9ddc66a2"
LIVE_BITS = "c202"
LIVE_COMMITMENT = "420dd77239c5561f73db25e803dcd18003369db8abd410dbb06a8978c1c5556c"
LIVE_TICKERS = tuple(f"L{i:02d}" for i in range(10))
LIVE_SELECTION = ("L01", "L06", "L07", "L09")

# A workbench-shaped study: 39 eligible assets, choose 8.
TICKERS_39 = tuple(f"AST{i:02d}" for i in range(39))
SELECTION_8 = ("AST00", "AST03", "AST05", "AST09", "AST14", "AST22", "AST30", "AST38")

SIGNATURE = "5" + "x" * 86


def live_study() -> StudyRef:
    return StudyRef(
        study_id=1786681504555,
        study_pubkey=LIVE_STUDY,
        agent_pubkey=LIVE_AGENT,
        tickers=LIVE_TICKERS,
        k=4,
    )


def study39() -> StudyRef:
    return StudyRef(
        study_id=99,
        study_pubkey=LIVE_STUDY,
        agent_pubkey=LIVE_AGENT,
        tickers=TICKERS_39,
        k=8,
    )


def committer(study: StudyRef | None = None) -> StudyCommitter:
    return StudyCommitter(study=study or study39(), project_root=".")


def completed(stdout: str, returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(
        args=[], returncode=returncode, stdout=stdout, stderr=stderr
    )


def publish_stdout(
    *,
    study: str = LIVE_STUDY,
    sequence: int = 0,
    commitment: str = LIVE_COMMITMENT,
    method: str = "separatrix",
    signature: str = SIGNATURE,
) -> str:
    """Byte-for-byte the shape scripts/devnet-separatrix.ts prints on publish."""
    return (
        f"publish_allocation: {signature}\n"
        f"  https://explorer.solana.com/tx/{signature}?cluster=devnet\n"
        f"  study:      {study}\n"
        f"  allocation: {LIVE_ALLOCATION}\n"
        f"  sequence:   {sequence}\n"
        f"  commitment: {commitment}\n"
        f"  method:     {method}\n"
        "  salt:       WITHHELD until reveal (32 bytes, stored in "
        "secrets/separatrix/studies.json)\n"
        "  The chain now holds a binding commitment; the selection is still secret.\n"
    )


def reveal_stdout(
    *,
    selection: str = "[1, 6, 7, 9]",
    bits: str = LIVE_BITS,
    salt: str = LIVE_SALT,
    objective: str = "-123456789012345678901",
    portfolio: str = "-78901",
    signature: str = SIGNATURE,
) -> str:
    """Byte-for-byte the shape scripts/devnet-separatrix.ts prints on reveal."""
    return (
        f"reveal_allocation: {signature}\n"
        f"  https://explorer.solana.com/tx/{signature}?cluster=devnet\n"
        f"  allocation: {LIVE_ALLOCATION}\n"
        f"  selection:  {selection}\n"
        f"  bits:       {bits} (LSB-first, {len(bits) // 2} bytes)\n"
        f"  salt:       {salt} (public now that the reveal landed)\n"
        "\n"
        "  Objective computed ON-CHAIN from the sealed matrix:\n"
        f"    objective_int            = {objective}\n"
        f"    portfolio_objective_int  = {portfolio}\n"
        "    scale                    = 12345.6\n"
        "    portfolio objective / scale = -1.0002e+16\n"
        "  matches the local replay of the same O(k^2) sum.\n"
    )


# ---------------------------------------------------------------------------
# 1. Agreement with the independent implementation
# ---------------------------------------------------------------------------

class AgreesWithVectorsTestCase(unittest.TestCase):
    """This module vs tests/test_onchain_vectors.py, byte for byte."""

    def test_commitment_matches_the_independent_implementation(self) -> None:
        cases = [
            (39, 8, 7, [0, 3, 5, 9, 14, 22, 30, 38], bytes([0xAB] * 32)),
            (10, 4, 0, [1, 6, 7, 9], bytes.fromhex(LIVE_SALT)),
            (48, 24, 2**63 + 5, list(range(24)), bytes(range(1, 33))),
            (1, 1, 0, [0], b"\x01" + bytes(31)),
            (8, 3, 18_446_744_073_709_551_615, [0, 4, 7], bytes([0xFF] * 32)),
        ]
        program_id = onchain.decode_pubkey(PROGRAM_ID)
        study = bytes(range(32, 64))
        agent = bytes(range(64, 96))
        for n, k, sequence, indices, salt in cases:
            with self.subTest(n=n, k=k, sequence=sequence):
                bits = encode_bitmap(n, indices)
                mine = commitment_digest(
                    program_id=program_id, study=study, sequence=sequence,
                    agent=agent, n=n, k=k, bits=bits, salt=salt,
                )
                theirs = vector_commitment_digest(
                    program_id=program_id, study=study, sequence=sequence,
                    agent=agent, n=n, k=k, bits=vector_bitmap(n, indices), salt=salt,
                )
                self.assertEqual(mine.hex(), theirs)

    def test_live_devnet_commitment_reproduces(self) -> None:
        """docs/onchain.md §2.2: a commitment that is actually on devnet.

        This also pins the base58 decoder — three 32-byte keys go into the
        preimage, and a wrong alphabet or a dropped leading zero would show up
        here and nowhere else.
        """
        plan = build_commitment(
            live_study(), LIVE_SELECTION, sequence=0, salt=bytes.fromhex(LIVE_SALT)
        )
        self.assertEqual(plan.bits_hex, LIVE_BITS)
        self.assertEqual(plan.commitment_hex, LIVE_COMMITMENT)

    def test_bitmap_matches_the_independent_implementation(self) -> None:
        for n in (1, 7, 8, 9, 10, 12, 16, 17, 31, 32, 39, 47, 48):
            indices = sorted({(i * 7 + 3) % n for i in range(min(n, 8))})
            with self.subTest(n=n):
                self.assertEqual(encode_bitmap(n, indices), vector_bitmap(n, indices))

    def test_triangular_index_matches_the_independent_implementation(self) -> None:
        for n in (1, 3, 8, 39, 48):
            for i in range(n):
                for j in range(n):
                    self.assertEqual(
                        triangular_index(n, i, j), vector_triangular_index(n, i, j)
                    )

    def test_score_selection_replays_the_programs_loop(self) -> None:
        # n=3 triangle [(0,0) (0,1) (0,2) (1,1) (1,2) (2,2)] = [1..6];
        # selecting {0,2} sums Q00 + Q02 + Q22 = 1 + 3 + 6.
        self.assertEqual(score_selection(3, [1, 2, 3, 4, 5, 6], [0, 2]), 10)

    def test_preimage_is_the_documented_layout(self) -> None:
        bits = encode_bitmap(39, [0, 1, 2, 3, 4, 5, 6, 7])
        preimage = commitment_preimage(
            program_id=bytes(32), study=bytes(32), sequence=1, agent=bytes(32),
            n=39, k=8, bits=bits, salt=bytes([1] * 32),
        )
        # 24 domain + 32 program + 32 study + 8 sequence + 32 agent + 2 (n,k)
        # + 4 length prefix + 5 bitmap + 32 salt
        self.assertEqual(len(preimage), 24 + 32 + 32 + 8 + 32 + 2 + 4 + 5 + 32)
        self.assertTrue(preimage.startswith(b"separatrix:allocation:v1"))
        self.assertTrue(preimage.endswith(bytes([1] * 32)))


# ---------------------------------------------------------------------------
# 2. Bitmap
# ---------------------------------------------------------------------------

class BitmapTestCase(unittest.TestCase):
    def test_round_trips_tickers_for_the_39_asset_study(self) -> None:
        study = study39()
        bits = study.bitmap_for(SELECTION_8)
        self.assertEqual(len(bits), 5)  # ceil(39/8)
        self.assertEqual(tuple(study.tickers_for(bits)), tuple(sorted(SELECTION_8)))

    def test_round_trips_for_universes_that_are_not_multiples_of_eight(self) -> None:
        for n in (1, 3, 7, 9, 10, 12, 15, 17, 23, 31, 33, 39, 41, 47):
            tickers = tuple(f"T{i:02d}" for i in range(n))
            k = min(n, 5)
            # Deterministic spread that always includes the last asset, which
            # is the one that lives in the padded tail byte.
            indices = sorted({(i * 5 + 1) % n for i in range(k - 1)} | {n - 1})
            selection = [tickers[i] for i in indices]
            with self.subTest(n=n):
                bits = selection_bitmap(tickers, selection)
                self.assertEqual(len(bits), bitmap_len(n))
                self.assertEqual(bitmap_tickers(tickers, bits), selection)
                self.assertEqual(decode_bitmap(n, bits), indices)

    def test_lsb_first_within_each_byte(self) -> None:
        self.assertEqual(encode_bitmap(8, [0]), b"\x01")
        self.assertEqual(encode_bitmap(8, [7]), b"\x80")
        self.assertEqual(encode_bitmap(9, [8]), b"\x00\x01")
        self.assertEqual(encode_bitmap(10, [1, 6, 7, 9]).hex(), "c202")

    def test_padding_bits_stay_zero(self) -> None:
        # n=39 uses 7 bits of the fifth byte; the eighth must never be set, or
        # the program rejects the reveal with BitOutsideUniverse.
        bits = encode_bitmap(39, list(range(31, 39)))
        self.assertEqual(len(bits), 5)
        self.assertEqual(bits[4] & 0x80, 0)

    def test_rejects_a_bit_outside_the_universe(self) -> None:
        with self.assertRaises(SelectionError):
            decode_bitmap(39, b"\x00\x00\x00\x00\x80")  # bit 39, n=39
        with self.assertRaises(SelectionError):
            encode_bitmap(39, [39])

    def test_rejects_a_bitmap_of_the_wrong_length(self) -> None:
        with self.assertRaises(SelectionError):
            decode_bitmap(39, bytes(4))
        with self.assertRaises(SelectionError):
            decode_bitmap(39, bytes(6))

    def test_rejects_a_duplicate_index(self) -> None:
        with self.assertRaises(SelectionError):
            encode_bitmap(39, [3, 3])


# ---------------------------------------------------------------------------
# 3. Ticker selections
# ---------------------------------------------------------------------------

class SelectionMappingTestCase(unittest.TestCase):
    def test_unknown_ticker_raises_rather_than_being_dropped(self) -> None:
        study = study39()
        selection = list(SELECTION_8[:-1]) + ["DOGE"]
        with self.assertRaises(SelectionError) as caught:
            study.bitmap_for(selection)
        self.assertIn("DOGE", str(caught.exception))

    def test_selection_size_must_equal_k(self) -> None:
        study = study39()
        with self.assertRaises(SelectionError):
            study.bitmap_for(SELECTION_8[:7])
        with self.assertRaises(SelectionError):
            study.bitmap_for(SELECTION_8 + ("AST01",))

    def test_duplicate_ticker_raises(self) -> None:
        study = study39()
        with self.assertRaises(SelectionError):
            study.bitmap_for(SELECTION_8[:7] + (SELECTION_8[0],))

    def test_selection_order_does_not_change_the_bitmap(self) -> None:
        study = study39()
        forward = study.bitmap_for(SELECTION_8)
        backward = study.bitmap_for(tuple(reversed(SELECTION_8)))
        self.assertEqual(forward, backward)
        self.assertEqual(study.indices_for(SELECTION_8), sorted(study.indices_for(SELECTION_8)))

    def test_indices_follow_the_studys_order_not_the_selections(self) -> None:
        tickers = ("ETH", "BTC", "SOL")
        self.assertEqual(selection_indices(tickers, ["SOL", "ETH"]), [0, 2])

    def test_study_rejects_an_inconsistent_universe(self) -> None:
        with self.assertRaises(OnChainError):  # duplicate ticker
            StudyRef(study_id=1, study_pubkey=LIVE_STUDY, agent_pubkey=LIVE_AGENT,
                     tickers=("A", "B", "A"), k=2)
        with self.assertRaises(OnChainError):  # k > n
            StudyRef(study_id=1, study_pubkey=LIVE_STUDY, agent_pubkey=LIVE_AGENT,
                     tickers=("A", "B"), k=3)
        with self.assertRaises(OnChainError):  # n > MAX_ASSETS
            StudyRef(study_id=1, study_pubkey=LIVE_STUDY, agent_pubkey=LIVE_AGENT,
                     tickers=tuple(f"T{i}" for i in range(49)), k=4)
        with self.assertRaises(OnChainError):  # not a base58 key
            StudyRef(study_id=1, study_pubkey="not a key", agent_pubkey=LIVE_AGENT,
                     tickers=("A", "B"), k=1)
        with self.assertRaises(OnChainError):  # 0 is not in the base58 alphabet
            StudyRef(study_id=1, study_pubkey=LIVE_STUDY, agent_pubkey="0" * 44,
                     tickers=("A", "B"), k=1)


# ---------------------------------------------------------------------------
# 4. Salt
# ---------------------------------------------------------------------------

class SaltTestCase(unittest.TestCase):
    def test_is_32_bytes_and_never_all_zero(self) -> None:
        for _ in range(32):
            salt = generate_salt()
            self.assertIsInstance(salt, bytes)
            self.assertEqual(len(salt), 32)
            self.assertTrue(any(salt))

    def test_differs_across_calls(self) -> None:
        self.assertEqual(len({generate_salt() for _ in range(64)}), 64)

    def test_draws_from_the_system_csprng(self) -> None:
        with patch(
            "agent.workbench.onchain.secrets.token_bytes", return_value=bytes([7] * 32)
        ) as token_bytes:
            self.assertEqual(generate_salt(), bytes([7] * 32))
        token_bytes.assert_called_once_with(32)

    def test_module_never_reaches_for_a_prng(self) -> None:
        # `random` is seeded and reproducible: anyone who learns the seed can
        # brute-force the selection straight out of a published commitment.
        self.assertFalse(hasattr(onchain, "random"))

    def test_all_zero_draw_raises_instead_of_being_used(self) -> None:
        with patch("agent.workbench.onchain.secrets.token_bytes", return_value=bytes(32)):
            with self.assertRaises(OnChainError):
                generate_salt()

    def test_short_draw_raises(self) -> None:
        with patch("agent.workbench.onchain.secrets.token_bytes", return_value=b"\x01\x02"):
            with self.assertRaises(OnChainError):
                generate_salt()

    def test_commitment_refuses_an_all_zero_salt(self) -> None:
        # The program rejects it with EmptySalt; refuse before paying rent.
        with self.assertRaises(OnChainError):
            commitment_digest(
                program_id=bytes(32), study=bytes(32), sequence=0, agent=bytes(32),
                n=8, k=2, bits=encode_bitmap(8, [0, 1]), salt=bytes(32),
            )


# ---------------------------------------------------------------------------
# 5. Dry run
# ---------------------------------------------------------------------------

class DryRunTestCase(unittest.TestCase):
    def test_computes_the_commitment_without_touching_the_network(self) -> None:
        with patch("agent.workbench.onchain.subprocess.run") as run:
            plan = committer().plan(SELECTION_8, sequence=12)
        run.assert_not_called()

        self.assertEqual(plan.sequence, 12)
        self.assertEqual(plan.n, 39)
        self.assertEqual(plan.k, 8)
        self.assertEqual(plan.tickers, tuple(sorted(SELECTION_8)))
        self.assertEqual(len(plan.bits), 5)
        self.assertEqual(len(plan.commitment), 32)
        self.assertEqual(len(plan.salt), 32)

    def test_dry_run_commitment_matches_the_independent_implementation(self) -> None:
        study = study39()
        plan = committer(study).plan(SELECTION_8, sequence=3, salt=bytes([0x5A] * 32))
        self.assertEqual(
            plan.commitment_hex,
            vector_commitment_digest(
                program_id=onchain.decode_pubkey(PROGRAM_ID),
                study=onchain.decode_pubkey(LIVE_STUDY),
                sequence=3,
                agent=onchain.decode_pubkey(LIVE_AGENT),
                n=39,
                k=8,
                bits=vector_bitmap(39, study.indices_for(SELECTION_8)),
                salt=bytes([0x5A] * 32),
            ),
        )

    def test_each_plan_draws_a_fresh_salt(self) -> None:
        first = committer().plan(SELECTION_8, sequence=0)
        second = committer().plan(SELECTION_8, sequence=0)
        self.assertNotEqual(first.salt, second.salt)
        self.assertNotEqual(first.commitment, second.commitment)

    def test_commitment_binds_the_sequence(self) -> None:
        salt = bytes([0x11] * 32)
        a = committer().plan(SELECTION_8, sequence=0, salt=salt)
        b = committer().plan(SELECTION_8, sequence=1, salt=salt)
        self.assertNotEqual(a.commitment, b.commitment)

    def test_to_dict_withholds_the_salt_by_default(self) -> None:
        plan = committer().plan(SELECTION_8, sequence=0)
        self.assertEqual(plan.to_dict()["salt"], "WITHHELD")
        self.assertEqual(plan.to_dict(reveal_salt=True)["salt"], plan.salt_hex)
        self.assertEqual(plan.to_dict()["commitment"], plan.commitment_hex)

    def test_rejects_a_bad_selection_offline(self) -> None:
        with self.assertRaises(SelectionError):
            committer().plan(SELECTION_8[:7], sequence=0)
        with self.assertRaises(SelectionError):
            committer().plan(list(SELECTION_8[:7]) + ["NOPE"], sequence=0)

    def test_rejects_a_method_the_program_cannot_hold(self) -> None:
        with self.assertRaises(SelectionError):
            committer().plan(SELECTION_8, sequence=0, method="x" * 17)
        with self.assertRaises(SelectionError):
            committer().plan(SELECTION_8, sequence=0, method="rm -rf /")
        with self.assertRaises(SelectionError):
            committer().plan(SELECTION_8, sequence=0, method="")


# ---------------------------------------------------------------------------
# 6. Publish (bridge mocked)
# ---------------------------------------------------------------------------

class PublishTestCase(unittest.TestCase):
    def test_publishes_through_the_typescript_bridge(self) -> None:
        client = committer()
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed(publish_stdout(sequence=4, method="bsb")),
        ) as run:
            receipt = client.publish(SELECTION_8, method="bsb")

        self.assertEqual(receipt.sequence, 4)
        self.assertEqual(receipt.commitment_hex, LIVE_COMMITMENT)
        self.assertEqual(receipt.study_pubkey, LIVE_STUDY)
        self.assertEqual(receipt.allocation_pubkey, LIVE_ALLOCATION)
        self.assertEqual(receipt.signature, SIGNATURE)
        self.assertEqual(receipt.tickers, tuple(sorted(SELECTION_8)))
        self.assertEqual(receipt.indices, (0, 3, 5, 9, 14, 22, 30, 38))
        # The salt behind that commitment lives with the bridge until reveal.
        self.assertIn("secrets/separatrix", receipt.salt_location)

        command = run.call_args.args[0]
        self.assertIn("separatrix:publish", command)
        self.assertIn("99", command)  # study id
        self.assertIn("--indices", command)
        self.assertIn("0,3,5,9,14,22,30,38", command)
        self.assertIn("bsb", command)

        env = run.call_args.kwargs["env"]
        self.assertEqual(env["SOLANA_RPC_URL"], "https://api.devnet.solana.com")
        self.assertEqual(env["SEPARATRIX_PROGRAM_ID"], PROGRAM_ID)
        self.assertEqual(env["AGENT_WALLET_PATH"], "keys/agent-devnet.json")
        self.assertEqual(env["OWNER_WALLET_PATH"], "keys/owner-devnet.json")
        self.assertFalse(run.call_args.kwargs["check"])

    def test_publish_method_defaults_are_passed_through(self) -> None:
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed(publish_stdout()),
        ) as run:
            receipt = committer().publish(SELECTION_8)
        self.assertEqual(receipt.method, "separatrix")
        self.assertIn("separatrix", run.call_args.args[0])

    def test_bad_selection_never_reaches_the_bridge(self) -> None:
        with patch("agent.workbench.onchain.subprocess.run") as run:
            with self.assertRaises(SelectionError):
                committer().publish(list(SELECTION_8[:7]) + ["DOGE"])
            with self.assertRaises(SelectionError):
                committer().publish(SELECTION_8[:5])
            with self.assertRaises(SelectionError):
                committer().publish(SELECTION_8, method="not a method")
        run.assert_not_called()

    def test_nonzero_exit_raises(self) -> None:
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed("", returncode=1, stderr="SequenceOutOfOrder"),
        ):
            with self.assertRaisesRegex(CommitmentBridgeError, "SequenceOutOfOrder"):
                committer().publish(SELECTION_8)

    def test_timeout_raises(self) -> None:
        with patch(
            "agent.workbench.onchain.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="npm", timeout=300),
        ):
            with self.assertRaisesRegex(CommitmentBridgeError, "timed out"):
                committer().publish(SELECTION_8)

    def test_missing_bridge_raises(self) -> None:
        with patch(
            "agent.workbench.onchain.subprocess.run",
            side_effect=FileNotFoundError("npm not found"),
        ):
            with self.assertRaisesRegex(CommitmentBridgeError, "unavailable"):
                committer().publish(SELECTION_8)

    def test_spawn_failure_raises(self) -> None:
        with patch(
            "agent.workbench.onchain.subprocess.run", side_effect=OSError("exec format")
        ):
            with self.assertRaises(CommitmentBridgeError):
                committer().publish(SELECTION_8)

    def test_unparseable_output_raises(self) -> None:
        for stdout in ("", "\n\n", "something went sideways\n"):
            with self.subTest(stdout=stdout):
                with patch(
                    "agent.workbench.onchain.subprocess.run",
                    return_value=completed(stdout),
                ):
                    with self.assertRaises(CommitmentBridgeError):
                        committer().publish(SELECTION_8)

    def test_missing_field_raises_rather_than_defaulting(self) -> None:
        stdout = publish_stdout()
        for missing in ("sequence:", "commitment:", "study:", "publish_allocation:"):
            trimmed = "".join(
                line + "\n"
                for line in stdout.splitlines()
                if missing not in line
            )
            with self.subTest(missing=missing):
                with patch(
                    "agent.workbench.onchain.subprocess.run",
                    return_value=completed(trimmed),
                ):
                    with self.assertRaises(CommitmentBridgeError):
                        committer().publish(SELECTION_8)

    def test_a_different_study_raises(self) -> None:
        other = "N8mTHmQCYgtA8pnHhUreMkrV829wzZgVF9HDAarKmHz"
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed(publish_stdout(study=other)),
        ):
            with self.assertRaisesRegex(CommitmentBridgeError, "not"):
                committer().publish(SELECTION_8)

    def test_a_different_method_raises(self) -> None:
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed(publish_stdout(method="something-else")),
        ):
            with self.assertRaises(CommitmentBridgeError):
                committer().publish(SELECTION_8, method="bsb")

    def test_an_empty_commitment_raises(self) -> None:
        # publish_allocation rejects an all-zero commitment on-chain, so seeing
        # one echoed back means the output is not a receipt.
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed(publish_stdout(commitment="00" * 32)),
        ):
            with self.assertRaises(CommitmentBridgeError):
                committer().publish(SELECTION_8)

    def test_a_malformed_commitment_raises(self) -> None:
        for bad in ("zz" * 32, "abcd", ""):
            with self.subTest(bad=bad):
                with patch(
                    "agent.workbench.onchain.subprocess.run",
                    return_value=completed(publish_stdout(commitment=bad)),
                ):
                    with self.assertRaises(CommitmentBridgeError):
                        committer().publish(SELECTION_8)

    def test_two_allocations_in_one_output_raises(self) -> None:
        doubled = publish_stdout(sequence=0) + publish_stdout(sequence=1)
        with patch(
            "agent.workbench.onchain.subprocess.run", return_value=completed(doubled)
        ):
            with self.assertRaisesRegex(CommitmentBridgeError, "twice"):
                committer().publish(SELECTION_8)


# ---------------------------------------------------------------------------
# 7. Reveal (bridge mocked)
# ---------------------------------------------------------------------------

class RevealTestCase(unittest.TestCase):
    def test_recomputes_the_commitment_from_what_the_chain_published(self) -> None:
        client = committer(live_study())
        with patch(
            "agent.workbench.onchain.subprocess.run", return_value=completed(reveal_stdout())
        ) as run:
            receipt = client.reveal(0, expect_commitment=bytes.fromhex(LIVE_COMMITMENT))

        self.assertEqual(receipt.commitment_hex, LIVE_COMMITMENT)
        self.assertEqual(receipt.indices, (1, 6, 7, 9))
        self.assertEqual(receipt.tickers, LIVE_SELECTION)
        self.assertEqual(receipt.salt.hex(), LIVE_SALT)
        self.assertEqual(receipt.signature, SIGNATURE)
        # i128 objectives exceed float precision; they must survive exactly.
        self.assertEqual(receipt.objective_int, -123456789012345678901)
        self.assertEqual(receipt.portfolio_objective_int, -78901)

        command = run.call_args.args[0]
        self.assertIn("separatrix:reveal", command)
        self.assertIn("--sequence", command)
        self.assertIn("0", command)

    def test_a_commitment_mismatch_raises(self) -> None:
        client = committer(live_study())
        with patch(
            "agent.workbench.onchain.subprocess.run", return_value=completed(reveal_stdout())
        ):
            # Same bits and salt, different sequence: the preimage binds the
            # sequence, so the digest must not match the published one.
            with self.assertRaisesRegex(CommitmentBridgeError, "do not reproduce"):
                client.reveal(1, expect_commitment=bytes.fromhex(LIVE_COMMITMENT))

    def test_bitmap_disagreeing_with_the_printed_selection_raises(self) -> None:
        client = committer(live_study())
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed(reveal_stdout(selection="[1, 2, 3, 4]")),
        ):
            with self.assertRaisesRegex(CommitmentBridgeError, "selection"):
                client.reveal(0)

    def test_a_bitmap_of_the_wrong_cardinality_raises(self) -> None:
        client = committer(live_study())
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed(reveal_stdout(bits="0300", selection="[0, 1]")),
        ):
            with self.assertRaisesRegex(CommitmentBridgeError, "k=4"):
                client.reveal(0)

    def test_a_bit_outside_the_universe_raises(self) -> None:
        client = committer(live_study())  # n=10, so bit 10 is out of range
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed(reveal_stdout(bits="c206", selection="[1, 6, 7, 9, 10]")),
        ):
            with self.assertRaises(CommitmentBridgeError):
                client.reveal(0)

    def test_nonzero_exit_raises(self) -> None:
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed("", returncode=1, stderr="CommitmentMismatch"),
        ):
            with self.assertRaisesRegex(CommitmentBridgeError, "CommitmentMismatch"):
                committer(live_study()).reveal(0)

    def test_missing_objective_raises(self) -> None:
        stdout = "".join(
            line + "\n"
            for line in reveal_stdout().splitlines()
            if "objective_int  " not in line
        )
        with patch("agent.workbench.onchain.subprocess.run", return_value=completed(stdout)):
            with self.assertRaises(CommitmentBridgeError):
                committer(live_study()).reveal(0)

    def test_publish_then_reveal_closes_the_loop(self) -> None:
        """The pair a caller actually runs: publish, then open it a week later
        and check the chain opened the commitment it was given."""
        client = committer(live_study())
        with patch(
            "agent.workbench.onchain.subprocess.run",
            return_value=completed(publish_stdout(sequence=0)),
        ):
            published = client.publish(LIVE_SELECTION)
        with patch(
            "agent.workbench.onchain.subprocess.run", return_value=completed(reveal_stdout())
        ):
            revealed = client.reveal(published.sequence, expect_commitment=published.commitment)

        self.assertEqual(revealed.commitment, published.commitment)
        self.assertEqual(revealed.tickers, published.tickers)


if __name__ == "__main__":
    unittest.main()
