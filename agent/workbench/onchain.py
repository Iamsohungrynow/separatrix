"""Publishing walk-forward allocations to the separatrix program on Solana.

Two halves, deliberately kept apart:

* A **pure-Python mirror** of the only two things ``reveal_allocation`` reads
  out of an instruction: the LSB-first selection bitmap and the commitment
  preimage. No subprocess, no network, no I/O — importable and cheap.
  ``tests/test_onchain_vectors.py`` holds the canonical Python implementation
  of the same bytes; this module is the callable version of it and the tests
  pin the two together. Drift there means a commitment can never be revealed,
  so the agreement is checked rather than assumed.
* A **fail-closed bridge** to ``scripts/devnet-separatrix.ts``, shelling out
  the way ``agent/trading/leash_client.py`` shells out to the leash bridge.
  Every failure mode — missing npm, spawn error, timeout, non-zero exit,
  unparseable or self-inconsistent output — raises. None of them fabricates a
  receipt, because a fabricated "published" is exactly the lie the commitment
  scheme exists to make impossible.

**Salt custody.** The salt is what keeps the tiny allocation space (C(39,8) is
only ~61M) from being brute-forced out of a published commitment, so it has to
be a CSPRNG draw and it has to stay secret until the reveal lands. On the live
path the salt is drawn *by the TypeScript bridge* (``crypto.randomBytes``) and
written under ``secrets/separatrix/`` — this module never sees it until the
reveal prints it. :func:`generate_salt` is the Python-side draw, used for
dry-run previews and for any future Python-owned publish path; it is
``secrets.token_bytes``, never ``random``.

So a dry run previews everything the commitment binds *except* the salt: the
study, the sequence, the agent, ``n``/``k``, and the exact bitmap. It cannot
predict the digest that lands, because those bytes carry the bridge's salt.
:meth:`StudyCommitter.reveal` closes that loop the honest way — it recomputes
the commitment locally from the bits and salt the chain published and checks
it against the digest recorded at publish time.

Byte-level contract: ``docs/onchain.md`` §2.2 and §3.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import secrets
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

logger = logging.getLogger("leash.workbench.onchain")

# Must match programs/separatrix/src/lib.rs.
PROGRAM_ID = "CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp"
COMMITMENT_DOMAIN = b"separatrix:allocation:v1"
MAX_ASSETS = 48
SALT_BYTES = 32
METHOD_MAX_BYTES = 16

DEVNET_RPC_URL = "https://api.devnet.solana.com"
# Where the TypeScript bridge keeps the un-revealed salts (gitignored).
SALT_STATE_PATH = "secrets/separatrix/studies.json"

# Method labels ride an npm argument list through `cmd /c` on Windows, so the
# alphabet is restricted rather than quoted: no spaces, no shell metacharacters.
# 16 bytes is the program's `Allocation.method` field.
_METHOD_RE = re.compile(r"^[A-Za-z0-9._:+-]{1,16}$")


class OnChainError(RuntimeError):
    """Any failure on the commitment path. Callers skip; they never guess."""


class SelectionError(OnChainError):
    """The selection cannot be encoded for this study — raised before spawning."""


class CommitmentBridgeError(OnChainError):
    """The TypeScript bridge failed, or returned output that cannot be trusted."""


# ---------------------------------------------------------------------------
# base58, for the three 32-byte keys the commitment binds
# ---------------------------------------------------------------------------

_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {char: value for value, char in enumerate(_B58_ALPHABET)}


def b58decode(text: str) -> bytes:
    """Decode a base58 (Bitcoin alphabet) string, leading '1's as zero bytes."""
    if not text:
        raise OnChainError("empty base58 string")
    number = 0
    for char in text:
        digit = _B58_INDEX.get(char)
        if digit is None:
            raise OnChainError(f"invalid base58 character {char!r} in {text!r}")
        number = number * 58 + digit
    body = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    padding = len(text) - len(text.lstrip("1"))
    return b"\x00" * padding + body


def decode_pubkey(text: str, field: str = "pubkey") -> bytes:
    """A Solana public key is exactly 32 bytes; anything else is a typo."""
    raw = b58decode(text)
    if len(raw) != 32:
        raise OnChainError(f"{field} {text!r} decodes to {len(raw)} bytes, expected 32")
    return raw


# ---------------------------------------------------------------------------
# Bitmap encoding — LSB-first, exactly ceil(n/8) bytes (docs/onchain.md §3)
# ---------------------------------------------------------------------------

def bitmap_len(n: int) -> int:
    """Bytes in an ``n``-bit selection bitmap."""
    return (n + 7) // 8


def encode_bitmap(n: int, indices: Sequence[int]) -> bytes:
    """Asset ``i`` is bit ``i % 8`` of byte ``i // 8``.

    Rejects duplicates and out-of-range indices instead of folding them
    silently: both would produce a bitmap with fewer than ``len(indices)`` bits
    set, and the program would reject the reveal with ``WrongCardinality``
    long after the commitment had been paid for.
    """
    if not 1 <= n <= MAX_ASSETS:
        raise SelectionError(f"n={n} outside 1..{MAX_ASSETS}")
    out = bytearray(bitmap_len(n))
    seen: set[int] = set()
    for index in indices:
        if isinstance(index, bool) or not isinstance(index, int):
            raise SelectionError(f"asset index {index!r} is not an int")
        if not 0 <= index < n:
            raise SelectionError(f"asset index {index} outside the {n}-asset universe")
        if index in seen:
            raise SelectionError(f"asset index {index} selected twice")
        seen.add(index)
        out[index // 8] |= 1 << (index % 8)
    return bytes(out)


def decode_bitmap(n: int, bits: bytes) -> list[int]:
    """Inverse of :func:`encode_bitmap`, with the program's two reveal checks.

    A wrong length is ``BadBitmapLength`` on-chain and a bit at an index
    ``>= n`` is ``BitOutsideUniverse`` — padding bits must be zero, or the
    same selection could be smuggled through two different commitments.
    """
    if not 1 <= n <= MAX_ASSETS:
        raise SelectionError(f"n={n} outside 1..{MAX_ASSETS}")
    if len(bits) != bitmap_len(n):
        raise SelectionError(
            f"bitmap is {len(bits)} bytes, expected {bitmap_len(n)} for n={n}"
        )
    selected: list[int] = []
    for byte_index, byte in enumerate(bits):
        for bit in range(8):
            if byte & (1 << bit):
                index = byte_index * 8 + bit
                if index >= n:
                    raise SelectionError(
                        f"bitmap sets bit {index} outside the {n}-asset universe"
                    )
                selected.append(index)
    return selected


def triangular_index(n: int, i: int, j: int) -> int:
    """Row-major upper triangle with the diagonal, symmetric in ``i``/``j``.

    The coefficient layout the program indexes when it replays an objective.
    """
    if i > j:
        i, j = j, i
    return i * n - i * (i - 1) // 2 + (j - i)


def score_selection(n: int, coefficients: Sequence[int], indices: Sequence[int]) -> int:
    """Replay ``reveal_allocation``'s O(k^2) scoring loop off-chain.

    Returns ``objective_int``; add the study's ``offset_int`` for
    ``portfolio_objective_int``. Only usable by a caller that holds the sealed
    coefficient vector (the ``--emit-qubo`` export the study was created from).
    """
    total = 0
    for position, i in enumerate(indices):
        total += coefficients[triangular_index(n, i, i)]
        for j in indices[position + 1:]:
            total += coefficients[triangular_index(n, i, j)]
    return total


# ---------------------------------------------------------------------------
# Ticker selections -> indices -> bitmap
# ---------------------------------------------------------------------------

def selection_indices(
    tickers: Sequence[str],
    selection: Sequence[str],
    *,
    k: int | None = None,
) -> list[int]:
    """Map ticker names onto the study's canonical order, sorted ascending.

    ``tickers`` is the order frozen when the study was created; ``selection``
    is what the walk-forward loop picked this week. A ticker the study does
    not know is an error, never a silent drop — dropping one would publish a
    commitment to a ``k-1`` portfolio that the chain then refuses to reveal.
    """
    order = {ticker: index for index, ticker in enumerate(tickers)}
    if len(order) != len(tickers):
        raise SelectionError("study ticker order contains duplicates")
    if k is not None and len(selection) != k:
        raise SelectionError(
            f"selection has {len(selection)} assets but the study fixes k={k}"
        )
    indices: list[int] = []
    seen: set[str] = set()
    for ticker in selection:
        index = order.get(ticker)
        if index is None:
            raise SelectionError(
                f"{ticker!r} is not in the study's {len(tickers)}-asset universe"
            )
        if ticker in seen:
            raise SelectionError(f"{ticker!r} selected twice")
        seen.add(ticker)
        indices.append(index)
    return sorted(indices)


def selection_bitmap(
    tickers: Sequence[str],
    selection: Sequence[str],
    *,
    k: int | None = None,
) -> bytes:
    """A walk-forward selection as the LSB-first bitmap the program expects."""
    return encode_bitmap(len(tickers), selection_indices(tickers, selection, k=k))


def bitmap_tickers(tickers: Sequence[str], bits: bytes) -> list[str]:
    """Inverse of :func:`selection_bitmap`, in the study's canonical order."""
    return [tickers[index] for index in decode_bitmap(len(tickers), bits)]


# ---------------------------------------------------------------------------
# Salt
# ---------------------------------------------------------------------------

def generate_salt() -> bytes:
    """32 CSPRNG bytes. Never ``random``; never all-zero.

    ``random`` is seeded and reproducible, which would let anyone who learns
    the seed brute-force the selection straight out of the commitment. An
    all-zero draw is rejected outright (the program's ``EmptySalt``) rather
    than redrawn: 32 zero bytes out of ``secrets`` means the system CSPRNG is
    broken, and retrying a broken generator is not a fix.
    """
    salt = secrets.token_bytes(SALT_BYTES)
    if len(salt) != SALT_BYTES:
        raise OnChainError(f"CSPRNG returned {len(salt)} bytes, expected {SALT_BYTES}")
    if not any(salt):
        raise OnChainError("CSPRNG produced an all-zero salt; the program rejects it")
    return salt


# ---------------------------------------------------------------------------
# Commitment preimage (docs/onchain.md §2.2)
# ---------------------------------------------------------------------------

def commitment_preimage(
    *,
    program_id: bytes,
    study: bytes,
    sequence: int,
    agent: bytes,
    n: int,
    k: int,
    bits: bytes,
    salt: bytes,
) -> bytes:
    """The exact bytes ``reveal_allocation`` hashes.

    ``domain || program_id || study || sequence(u64 LE) || agent || [n, k]
    || len(bits)(u32 LE) || bits || salt``

    Keyword-only on purpose: ``program_id``, ``study`` and ``agent`` are all
    32 bytes, so a positional swap would type-check, hash cleanly, and produce
    a commitment that can never be opened.
    """
    for name, key in (("program_id", program_id), ("study", study), ("agent", agent)):
        if len(key) != 32:
            raise OnChainError(f"{name} is {len(key)} bytes, expected 32")
    if not 0 <= sequence < 2**64:
        raise OnChainError(f"sequence {sequence} does not fit in u64")
    if not 1 <= n <= MAX_ASSETS:
        raise OnChainError(f"n={n} outside 1..{MAX_ASSETS}")
    if not 1 <= k <= n:
        raise OnChainError(f"k={k} must satisfy 1 <= k <= n={n}")
    if len(bits) != bitmap_len(n):
        raise OnChainError(f"bits is {len(bits)} bytes, expected {bitmap_len(n)} for n={n}")
    if len(salt) != SALT_BYTES:
        raise OnChainError(f"salt is {len(salt)} bytes, expected {SALT_BYTES}")
    if not any(salt):
        raise OnChainError("all-zero salt; the program rejects it (EmptySalt)")

    return b"".join((
        COMMITMENT_DOMAIN,
        program_id,
        study,
        struct.pack("<Q", sequence),
        agent,
        bytes([n, k]),
        struct.pack("<I", len(bits)),
        bits,
        salt,
    ))


def commitment_digest(
    *,
    program_id: bytes,
    study: bytes,
    sequence: int,
    agent: bytes,
    n: int,
    k: int,
    bits: bytes,
    salt: bytes,
) -> bytes:
    """SHA-256 of :func:`commitment_preimage` — the 32 bytes stored on-chain."""
    return hashlib.sha256(
        commitment_preimage(
            program_id=program_id, study=study, sequence=sequence, agent=agent,
            n=n, k=k, bits=bits, salt=salt,
        )
    ).digest()


# ---------------------------------------------------------------------------
# Study identity
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class StudyRef:
    """A sealed study: everything the commitment binds except bits and salt.

    All of it is fixed when the owner runs ``npm run separatrix:create`` and
    none of it can move afterwards, so it belongs in config, not in the loop.
    ``tickers`` is the canonical asset order the coefficient matrix was built
    in — position ``i`` in this tuple is bit ``i`` in every bitmap and row
    ``i`` in the sealed triangle. Getting it out of order silently commits to
    a different portfolio, which is why it is pinned here alongside the keys.
    """

    study_id: int
    study_pubkey: str
    agent_pubkey: str
    tickers: tuple[str, ...]
    k: int
    program_id: str = PROGRAM_ID

    def __post_init__(self) -> None:
        object.__setattr__(self, "tickers", tuple(self.tickers))
        if isinstance(self.study_id, bool) or not isinstance(self.study_id, int):
            raise OnChainError(f"study_id {self.study_id!r} is not an int")
        if not 0 <= self.study_id < 2**64:
            raise OnChainError(f"study_id {self.study_id} does not fit in u64")
        if not 1 <= len(self.tickers) <= MAX_ASSETS:
            raise OnChainError(
                f"universe has {len(self.tickers)} assets, outside 1..{MAX_ASSETS}"
            )
        if len(set(self.tickers)) != len(self.tickers):
            raise OnChainError("study ticker order contains duplicates")
        if not 1 <= self.k <= len(self.tickers):
            raise OnChainError(f"k={self.k} must satisfy 1 <= k <= n={len(self.tickers)}")
        # Decoded once, here, so a mistyped key fails at construction rather
        # than three subprocesses later.
        decode_pubkey(self.program_id, "program_id")
        decode_pubkey(self.study_pubkey, "study_pubkey")
        decode_pubkey(self.agent_pubkey, "agent_pubkey")

    @property
    def n(self) -> int:
        return len(self.tickers)

    def indices_for(self, selection: Sequence[str]) -> list[int]:
        return selection_indices(self.tickers, selection, k=self.k)

    def bitmap_for(self, selection: Sequence[str]) -> bytes:
        return selection_bitmap(self.tickers, selection, k=self.k)

    def tickers_for(self, bits: bytes) -> list[str]:
        return bitmap_tickers(self.tickers, bits)


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class CommitmentPlan:
    """What a publish *would* commit to. Produced offline; touches nothing."""

    study_id: int
    program_id: str
    study_pubkey: str
    agent_pubkey: str
    sequence: int
    n: int
    k: int
    indices: tuple[int, ...]
    tickers: tuple[str, ...]
    bits: bytes
    salt: bytes
    commitment: bytes
    method: str

    @property
    def bits_hex(self) -> str:
        return self.bits.hex()

    @property
    def salt_hex(self) -> str:
        return self.salt.hex()

    @property
    def commitment_hex(self) -> str:
        return self.commitment.hex()

    def to_dict(self, *, reveal_salt: bool = False) -> dict[str, Any]:
        """Loggable form. The salt is withheld unless explicitly asked for —
        printing it before the reveal lands destroys the hiding property."""
        return {
            "study_id": self.study_id,
            "program_id": self.program_id,
            "study": self.study_pubkey,
            "agent": self.agent_pubkey,
            "sequence": self.sequence,
            "n": self.n,
            "k": self.k,
            "indices": list(self.indices),
            "tickers": list(self.tickers),
            "bits": self.bits_hex,
            "salt": self.salt_hex if reveal_salt else "WITHHELD",
            "commitment": self.commitment_hex,
            "method": self.method,
        }


@dataclass(frozen=True, slots=True)
class PublishReceipt:
    """A landed ``publish_allocation``, as reported by the bridge.

    ``commitment`` is the digest that is now on-chain. It is *not* the digest
    of any local plan: the salt behind it was drawn by the bridge and is held
    at ``salt_location`` until the reveal.
    """

    sequence: int
    commitment: bytes
    study_pubkey: str
    allocation_pubkey: str
    signature: str
    method: str
    indices: tuple[int, ...]
    tickers: tuple[str, ...]
    salt_location: str = SALT_STATE_PATH

    @property
    def commitment_hex(self) -> str:
        return self.commitment.hex()


@dataclass(frozen=True, slots=True)
class RevealReceipt:
    """A landed ``reveal_allocation``.

    ``commitment`` is recomputed *locally* from the bits and salt the chain
    published, so comparing it against the publish receipt is an independent
    check that the opened allocation is the one that was committed to.
    ``objective_int`` is the chain's own number, not a submitted one.
    """

    sequence: int
    signature: str
    allocation_pubkey: str
    bits: bytes
    salt: bytes
    indices: tuple[int, ...]
    tickers: tuple[str, ...]
    commitment: bytes
    objective_int: int
    portfolio_objective_int: int

    @property
    def commitment_hex(self) -> str:
        return self.commitment.hex()


# ---------------------------------------------------------------------------
# Dry run: the whole commitment, computed offline
# ---------------------------------------------------------------------------

def build_commitment(
    study: StudyRef,
    selection: Sequence[str],
    sequence: int,
    *,
    method: str = "separatrix",
    salt: bytes | None = None,
) -> CommitmentPlan:
    """Compute the commitment for a selection without touching the network.

    This is the dry run: every byte the program will hash is derived here, so
    a caller can see exactly what a publish means before paying for it, and
    the whole path is unit-testable offline. Pass ``salt`` to make it
    deterministic (tests, vector checks); omit it for a fresh CSPRNG draw.

    ``sequence`` must be the study's current ``published_count`` — the program
    accepts nothing else. Offline there is no way to know it, so it is an
    argument rather than a guess.
    """
    validate_method(method)
    indices = study.indices_for(selection)
    bits = encode_bitmap(study.n, indices)
    salt = generate_salt() if salt is None else salt
    commitment = commitment_digest(
        program_id=decode_pubkey(study.program_id, "program_id"),
        study=decode_pubkey(study.study_pubkey, "study_pubkey"),
        sequence=sequence,
        agent=decode_pubkey(study.agent_pubkey, "agent_pubkey"),
        n=study.n,
        k=study.k,
        bits=bits,
        salt=salt,
    )
    return CommitmentPlan(
        study_id=study.study_id,
        program_id=study.program_id,
        study_pubkey=study.study_pubkey,
        agent_pubkey=study.agent_pubkey,
        sequence=sequence,
        n=study.n,
        k=study.k,
        indices=tuple(indices),
        tickers=tuple(study.tickers[i] for i in indices),
        bits=bits,
        salt=salt,
        commitment=commitment,
        method=method,
    )


def validate_method(method: str) -> str:
    """``Allocation.method`` is 16 bytes and rides an argv; keep it tame."""
    if not isinstance(method, str) or not _METHOD_RE.match(method):
        raise SelectionError(
            f"method {method!r} must be 1..{METHOD_MAX_BYTES} chars of [A-Za-z0-9._:+-]"
        )
    return method


# ---------------------------------------------------------------------------
# The bridge
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class StudyCommitter:
    """Publishes and reveals allocations through ``scripts/devnet-separatrix.ts``.

    Fails closed, in the same shape as ``AnchorLeashClient``: a missing npm, a
    spawn error, a timeout, a non-zero exit, output that cannot be parsed, or
    output that disagrees with this study all raise :class:`OnChainError`.
    There is no return value that means "probably published".

    The bridge needs the study's local record (written by
    ``npm run separatrix:create``) and both wallets: the owner keypair signs
    nothing on this path but keys the record, and the agent keypair is the only
    signer ``publish_allocation`` accepts.
    """

    study: StudyRef
    rpc_url: str = DEVNET_RPC_URL
    owner_wallet_path: str = "keys/owner-devnet.json"
    agent_wallet_path: str = "keys/agent-devnet.json"
    project_root: str = "."
    timeout_seconds: int = 300

    # -- dry run ------------------------------------------------------------

    def plan(
        self,
        selection: Sequence[str],
        sequence: int,
        *,
        method: str = "separatrix",
        salt: bytes | None = None,
    ) -> CommitmentPlan:
        """Dry run of :meth:`publish`. Computes the commitment, sends nothing."""
        return build_commitment(
            self.study, selection, sequence, method=method, salt=salt
        )

    # -- live ---------------------------------------------------------------

    def publish(
        self,
        selection: Sequence[str],
        *,
        method: str = "separatrix",
    ) -> PublishReceipt:
        """Commit to ``selection`` on-chain, before it is acted on.

        The sequence is not an argument: the program requires
        ``sequence == study.published_count``, which only the chain knows, so
        the bridge reads it and reports back what it used.
        """
        validate_method(method)
        indices = self.study.indices_for(selection)  # raises before spawning
        tickers = tuple(self.study.tickers[i] for i in indices)

        fields, _ = self._run(
            "separatrix:publish",
            str(self.study.study_id),
            "--indices", ",".join(str(i) for i in indices),
            "--method", method,
            context="publish",
        )

        signature = _require(fields, "publish_allocation", "publish")
        study_pubkey = _require(fields, "study", "publish")
        allocation = _require(fields, "allocation", "publish")
        sequence = _parse_u64(_require(fields, "sequence", "publish"), "sequence")
        commitment = _parse_hash(_require(fields, "commitment", "publish"), "commitment")
        reported_method = _require(fields, "method", "publish")

        # The bridge keeps its own study record; if it published against a
        # different study or a different label than this client asked for, the
        # commitment is not the one this caller is entitled to reason about.
        if study_pubkey != self.study.study_pubkey:
            raise CommitmentBridgeError(
                f"bridge published against study {study_pubkey}, "
                f"not {self.study.study_pubkey}"
            )
        if reported_method != method:
            raise CommitmentBridgeError(
                f"bridge published method {reported_method!r}, not {method!r}"
            )

        logger.info(
            "published allocation seq=%d study=%s commitment=%s tx=%s",
            sequence, study_pubkey, commitment.hex(), signature,
        )
        return PublishReceipt(
            sequence=sequence,
            commitment=commitment,
            study_pubkey=study_pubkey,
            allocation_pubkey=allocation,
            signature=signature,
            method=method,
            indices=tuple(indices),
            tickers=tickers,
        )

    def reveal(
        self,
        sequence: int,
        *,
        expect_commitment: bytes | None = None,
    ) -> RevealReceipt:
        """Open allocation ``sequence`` and return the objective the chain computed.

        ``sequence`` is required rather than "whatever is pending": naming the
        allocation is what makes the local commitment check below meaningful,
        since the preimage binds the sequence.
        """
        if not 0 <= sequence < 2**64:
            raise OnChainError(f"sequence {sequence} does not fit in u64")

        fields, assigned = self._run(
            "separatrix:reveal",
            str(self.study.study_id),
            "--sequence", str(sequence),
            context="reveal",
        )

        signature = _require(fields, "reveal_allocation", "reveal")
        allocation = _require(fields, "allocation", "reveal")
        bits = _parse_hex(_first_token(_require(fields, "bits", "reveal")), "bits")
        salt = _parse_hex(_first_token(_require(fields, "salt", "reveal")), "salt")
        objective = _parse_int(_require(assigned, "objective_int", "reveal"), "objective_int")
        portfolio = _parse_int(
            _require(assigned, "portfolio_objective_int", "reveal"),
            "portfolio_objective_int",
        )

        try:
            indices = decode_bitmap(self.study.n, bits)
        except SelectionError as exc:
            raise CommitmentBridgeError(f"reveal returned an unusable bitmap: {exc}") from exc
        if len(indices) != self.study.k:
            raise CommitmentBridgeError(
                f"reveal opened {len(indices)} assets, but the study fixes k={self.study.k}"
            )
        printed = _parse_index_list(fields.get("selection"))
        if printed is not None and printed != indices:
            raise CommitmentBridgeError(
                f"reveal printed selection {printed} but bitmap decodes to {indices}"
            )

        # Independent re-derivation: these are the bytes the chain hashed.
        commitment = commitment_digest(
            program_id=decode_pubkey(self.study.program_id, "program_id"),
            study=decode_pubkey(self.study.study_pubkey, "study_pubkey"),
            sequence=sequence,
            agent=decode_pubkey(self.study.agent_pubkey, "agent_pubkey"),
            n=self.study.n,
            k=self.study.k,
            bits=bits,
            salt=salt,
        )
        if expect_commitment is not None and commitment != expect_commitment:
            raise CommitmentBridgeError(
                "revealed bits/salt do not reproduce the published commitment: "
                f"{commitment.hex()} != {bytes(expect_commitment).hex()}"
            )

        logger.info(
            "revealed allocation seq=%d objective_int=%d portfolio_objective_int=%d tx=%s",
            sequence, objective, portfolio, signature,
        )
        return RevealReceipt(
            sequence=sequence,
            signature=signature,
            allocation_pubkey=allocation,
            bits=bits,
            salt=salt,
            indices=tuple(indices),
            tickers=tuple(self.study.tickers[i] for i in indices),
            commitment=commitment,
            objective_int=objective,
            portfolio_objective_int=portfolio,
        )

    # -- subprocess ---------------------------------------------------------

    def _run(self, script: str, *args: str, context: str) -> tuple[dict[str, str], dict[str, str]]:
        command = self._build_command(script, *args)
        logger.debug("%s: %s", context, " ".join(command))

        try:
            completed = subprocess.run(
                command,
                cwd=str(Path(self.project_root)),
                env=self._env(),
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except FileNotFoundError as exc:
            raise CommitmentBridgeError(f"{context} bridge unavailable: {exc}") from exc
        except subprocess.TimeoutExpired as exc:
            raise CommitmentBridgeError(
                f"{context} bridge timed out after {self.timeout_seconds}s"
            ) from exc
        except OSError as exc:
            raise CommitmentBridgeError(f"{context} bridge failed to spawn: {exc}") from exc

        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "no output").strip()
            raise CommitmentBridgeError(
                f"{context} bridge exited {completed.returncode}: {detail[:400]}"
            )
        return _parse_bridge_output(completed.stdout or "", context)

    def _build_command(self, script: str, *args: str) -> list[str]:
        argv = ["npm", "run", "-s", script, "--", *args]
        if os.name == "nt":
            return ["cmd", "/c", *argv]
        return argv

    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        env["SOLANA_RPC_URL"] = self.rpc_url
        env["SEPARATRIX_PROGRAM_ID"] = self.study.program_id
        env["OWNER_WALLET_PATH"] = self.owner_wallet_path
        env["AGENT_WALLET_PATH"] = self.agent_wallet_path
        return env


# ---------------------------------------------------------------------------
# Output parsing. The separatrix bridge prints "key: value" and "key = value"
# lines rather than JSON, so this is deliberately strict: an unrecognised or
# contradictory line is an error, never a default.
# ---------------------------------------------------------------------------

_LABELLED = re.compile(r"^\s*([a-z][a-z_]*):\s+(\S.*?)\s*$")
_ASSIGNED = re.compile(r"^\s*([a-z][a-z_]*)\s+=\s+(\S.*?)\s*$")


def _parse_bridge_output(stdout: str, context: str) -> tuple[dict[str, str], dict[str, str]]:
    fields: dict[str, str] = {}
    assigned: dict[str, str] = {}
    for line in stdout.splitlines():
        for pattern, sink in ((_LABELLED, fields), (_ASSIGNED, assigned)):
            match = pattern.match(line)
            if not match:
                continue
            key, value = match.group(1), match.group(2)
            previous = sink.get(key)
            if previous is not None and previous != value:
                # Two different values for one key means the output covers more
                # than one allocation; picking either would be a guess.
                raise CommitmentBridgeError(
                    f"{context} bridge printed {key!r} twice ({previous!r}, {value!r})"
                )
            sink[key] = value
            break
    if not fields and not assigned:
        raise CommitmentBridgeError(f"{context} bridge produced no parseable output")
    return fields, assigned


def _require(fields: dict[str, str], key: str, context: str) -> str:
    value = fields.get(key)
    if not value:
        raise CommitmentBridgeError(f"{context} bridge output is missing {key!r}")
    return value


def _first_token(value: str) -> str:
    """``"c202 (LSB-first, 2 bytes)"`` -> ``"c202"``."""
    tokens = value.split()
    return tokens[0] if tokens else value


def _parse_u64(text: str, field: str) -> int:
    try:
        value = int(text, 10)
    except ValueError as exc:
        raise CommitmentBridgeError(f"bad {field} {text!r}") from exc
    if not 0 <= value < 2**64:
        raise CommitmentBridgeError(f"{field} {value} does not fit in u64")
    return value


def _parse_int(text: str, field: str) -> int:
    """i128 objectives exceed float precision, so they are parsed as exact ints."""
    try:
        return int(text, 10)
    except ValueError as exc:
        raise CommitmentBridgeError(f"bad {field} {text!r}") from exc


def _parse_hex(text: str, field: str) -> bytes:
    try:
        return bytes.fromhex(text)
    except ValueError as exc:
        raise CommitmentBridgeError(f"bad {field} hex {text!r}") from exc


def _parse_hash(text: str, field: str) -> bytes:
    raw = _parse_hex(text, field)
    if len(raw) != 32:
        raise CommitmentBridgeError(f"{field} is {len(raw)} bytes, expected 32")
    if not any(raw):
        # publish_allocation rejects this on-chain; seeing it back means the
        # output was not a real receipt.
        raise CommitmentBridgeError(f"{field} is all zero")
    return raw


def _parse_index_list(text: str | None) -> list[int] | None:
    """``selection:  [1, 6, 7, 9]`` -> ``[1, 6, 7, 9]``; None when absent."""
    if text is None:
        return None
    inner = text.strip()
    if not (inner.startswith("[") and inner.endswith("]")):
        raise CommitmentBridgeError(f"bad selection list {text!r}")
    body = inner[1:-1].strip()
    if not body:
        return []
    try:
        return [int(part.strip(), 10) for part in body.split(",")]
    except ValueError as exc:
        raise CommitmentBridgeError(f"bad selection list {text!r}") from exc
