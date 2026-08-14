# Separatrix On-Chain Reference

The byte-level contract for the `separatrix` Anchor program: what each account
costs, what exactly gets hashed, how a selection is encoded, how many
transactions a study takes, and what the program measurably costs to run.

Program id `CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp`, deployed on devnet.
Source of truth is [`programs/separatrix/src/lib.rs`](../programs/separatrix/src/lib.rs);
everything below is transcribed from it and then checked against the chain.

**No cost in this document is a projection.** Compute units come from
`Program … consumed N of M compute units` lines in landed transactions; account
sizes, rent and fees come from `getAccountInfo` / `meta.fee`; transaction counts
come from `getSignaturesForAddress`. Each is reported with the signature or
address it came from, so a reader with an RPC endpoint can re-derive all of it.
Most rows are devnet. The few taken from a local `solana-test-validator` running
the same `separatrix_program.so` say so on the row, because a local ledger's
signatures mean nothing to anybody else — those are reproducible by re-running
the Anchor suite (§8), not by looking anything up. The only derived quantities
are the layout arithmetic in §1 and the term counts, and both are stated
alongside the live accounts that confirm them. Where something was *not*
measured, this document says so instead of extrapolating.

The program was hardened after an adversarial review and redeployed at the same
address. Four changes are visible from the outside: `create_study` now requires
the **agent** to sign (§4.1), rejects `k > MAX_CARDINALITY = 40`
(`CardinalityTooLarge`, §3) and rejects a penalty offset outside `i64` range
(`OffsetOutOfRange`, §3), and `write_coefficients` range-compares instead of
calling `abs()`. Everything in §5 measured before that change is labelled.

---

## 1. Account size math

### `Study` (zero-copy, `#[repr(C)]`)

Zero-copy exists so the 1176-term coefficient buffer never round-trips through
Borsh. That makes the layout literally the account bytes, so field order matters:
the align-1 byte arrays come first, then the 8-byte scalars, then the small
integers, then the align-8 `[i64; MAX_TERMS]`. That ordering introduces **no
padding anywhere**, which is why the arithmetic below is exact.

| offset | field | type | bytes |
| ---: | --- | --- | ---: |
| 0 | anchor account discriminator | `sha256("account:Study")[0..8]` | 8 |
| 8 | `authority` | `Pubkey` | 32 |
| 40 | `agent` | `Pubkey` | 32 |
| 72 | `q_hash` | `[u8; 32]` | 32 |
| 104 | `label` | `[u8; 32]` | 32 |
| 136 | `offset_int_le` | `[u8; 16]` (i128 LE) | 16 |
| 152 | `study_id` | `u64` | 8 |
| 160 | `scale_bits` | `u64` | 8 |
| 168 | `created_at` | `i64` | 8 |
| 176 | `published_count` | `u64` | 8 |
| 184 | `revealed_count` | `u64` | 8 |
| 192 | `term_count` | `u32` | 4 |
| 196 | `n` | `u8` | 1 |
| 197 | `k` | `u8` | 1 |
| 198 | `sealed` | `u8` | 1 |
| 199 | `bump` | `u8` | 1 |
| 200 | `coefficients` | `[i64; 1176]` | 9408 |
| | **total** | | **9608** |

`MAX_TERMS = MAX_ASSETS * (MAX_ASSETS + 1) / 2 = 48 * 49 / 2 = 1176`.

Struct body is 9600 bytes with align 8 (9600 % 8 == 0, so no tail padding), and
`space = 8 + size_of::<Study>() = 9608`. Every study account is this size
**regardless of `n`** — the buffer is fixed and only the first `term_count`
entries are used. Measured on five live studies with `n` from 8 to 48, all
9608 bytes (§4).

Why `MAX_ASSETS = 48` and not larger: an account created by CPI cannot exceed
10,240 bytes, and the header ahead of the coefficient buffer is 200 bytes
(8 discriminator + 192 of fields). `n = 49` needs `200 + 1225*8 = 10,000` and
would still fit; `n = 50` needs `200 + 1275*8 = 10,400` and does not. So 48 sits
one step below the hard ceiling, leaving `10,240 - 9,608 = 632` bytes of
headroom. Do not read 48 as a mathematical limit — it is a deliberately
conservative one.

`MAX_ASSETS` bounds the **universe**. The **selection** is bounded separately and
much lower, at `MAX_CARDINALITY = 40`, for a reason that has nothing to do with
account size: see §3.

### `Allocation` (Borsh, `#[derive(InitSpace)]`)

| field | type | bytes |
| --- | --- | ---: |
| discriminator | `sha256("account:Allocation")[0..8]` | 8 |
| `study` | `Pubkey` | 32 |
| `agent` | `Pubkey` | 32 |
| `commitment` | `[u8; 32]` | 32 |
| `method` | `[u8; 16]` | 16 |
| `sequence` | `u64` | 8 |
| `published_slot` | `u64` | 8 |
| `published_at` | `i64` | 8 |
| `revealed_at` | `i64` | 8 |
| `objective_int_le` | `[u8; 16]` (i128 LE) | 16 |
| `portfolio_objective_int_le` | `[u8; 16]` (i128 LE) | 16 |
| `revealed` | `u8` | 1 |
| `bump` | `u8` | 1 |
| **total** | | **186** |

### Rent

Solana's rent-exempt minimum is `(128 + data_len) * 3480 * 2` lamports.

| account | data_len | rent-exempt lamports | SOL | measured on |
| --- | ---: | ---: | ---: | --- |
| `Study` | 9608 | 67,762,560 | 0.06776256 | `N8mTHmQCYgtA8pnHhUreMkrV829wzZgVF9HDAarKmHz` |
| `Allocation` | 186 | 2,185,440 | 0.00218544 | `9ch59MipD7MQH9gRuCTs8kkf5cHu65NTgr4sRNA7R8wp` |

**A study costs 0.0678 SOL of rent and the program has no `close` instruction**,
so that SOL is locked for good. This is the dominant cost of running separatrix,
and it is why `scripts/devnet-separatrix.ts measure` uses deterministic study ids
— an interrupted run resumes into the same accounts instead of stranding another
0.0678 SOL per retry.

---

## 2. The two preimages, byte by byte

Both digests are SHA-256 over a concatenation with a domain separator in front.
Neither is length-delimited between fixed-width fields because every field but
one is fixed width; the one variable-length field (`bits`) carries an explicit
`u32` length prefix.

### 2.1 Seal digest — `seal_study`, checked against `Study.q_hash`

```
sha256(
    b"separatrix:qubo:v1"          //  18 bytes, QUBO_DOMAIN
 || [n, k]                          //   2 bytes, two u8
 || scale_bits.to_le_bytes()        //   8 bytes, u64 LE (f64::to_bits of the scale)
 || offset_int_le                   //  16 bytes, i128 LE, two's complement
 || coefficients[0..term_count]     // 8*term_count bytes, i64 LE each, in order
)
```

Notes that matter:

- The coefficient bytes are hashed **straight out of the account** via
  `bytemuck::cast_slice`. The buffer is already little-endian `i64` in memory, so
  a `to_le_bytes()` loop would only add ~1200 iterations and a 9.4 KB heap
  allocation against BPF's 32 KB heap for the identical bytes.
- Only `term_count` terms are hashed, not all 1176. A study with `n = 10` hashes
  55 terms.
- `n`, `k`, `scale_bits` and `offset_int_le` are inside the digest on purpose.
  Without them, an authority could reuse one matrix under a different cardinality
  or a different penalty offset and present it as the same sealed problem.

The solver CLI emits exactly this as `qubo.q_hash` when the request contains
`"emit_qubo": true`, alongside `scale_bits`, `offset_int`, `coefficients` and
`term_count`.

**Live vector** (study `4fzo7jXAecbxZ32oGAyfMk28VkSs8YCThcFapL86R6PV`, n=10, k=4):

```
q_hash = f1f7cd82cf834fc985b4e90e8ab9cc918eca96600c0a4138de78a3cf6b89c82e
```

sealed on devnet by
`3b7gnenK8n4ui8shgiSDDfinN3EY1zJFehmGDdSYDdBfm4W36gx5zniyr3pnaqzza5QWFByZXdf1mtbQaiKAqCwh`,
and reproduced independently by the Rust exporter, the TypeScript client, and
the Python helper in `tests/test_onchain_vectors.py`.

### 2.2 Commitment digest — `publish_allocation` stores it, `reveal_allocation` re-derives it

```
sha256(
    b"separatrix:allocation:v1"    //  24 bytes, COMMITMENT_DOMAIN
 || program_id                     //  32 bytes, crate::ID
 || study_pubkey                   //  32 bytes
 || sequence.to_le_bytes()         //   8 bytes, u64 LE
 || agent_pubkey                   //  32 bytes
 || [n, k]                         //   2 bytes, two u8
 || (bits.len() as u32).to_le()    //   4 bytes, u32 LE
 || bits                           //   ceil(n/8) bytes
 || salt                           //  32 bytes, must not be all zero
)
```

Every field except `bits` and `salt` is read from **account state** on-chain,
never from an instruction argument. That is what stops a commitment lifted out of
somebody else's transaction from being revealable here: a different program,
study, sequence, agent, or problem shape produces a different digest, and the
program compares against the `commitment` already stored in the allocation.

The `u32` length prefix removes concatenation ambiguity. Without it, a 2-byte
bitmap followed by a 32-byte salt and a 1-byte bitmap followed by a 33-byte
"salt" would hash the same bytes. `tests/test_onchain_vectors.py` pins that case
explicitly.

**Live vector** (allocation `FF7qPkHStSe67FhecjsFyqRoUCtqxup5wMM7eqmbmA6N`):

| component | value |
| --- | --- |
| program_id | `CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp` |
| study | `4fzo7jXAecbxZ32oGAyfMk28VkSs8YCThcFapL86R6PV` |
| sequence | `0` |
| agent | `AM1tDDPyyj1q4bsWtZXB88G1Ku5hUrSXZDWjhp5VYPot` |
| n, k | `10, 4` |
| bits | `c202` (2 bytes) |
| salt | `843f2af38c01fae6a249da953eb16037aa92e994d1bc02906151a9ec9ddc66a2` |
| **commitment** | `420dd77239c5561f73db25e803dcd18003369db8abd410dbb06a8978c1c5556c` |

Published by
`57RSdihnF6Z11phkK8sRPJciA28mearkJDbfsYDvP6vZ8hJJV6JFWCUQBo1rq2d95VHKaiLGBy2igkou2rJpK66L`
and opened by
`4pexDm8zXVGd7QhabdibhsnEdBD2a1PKFxsGPThDSxWLjyqnRX42swQQKimGxbprdzt7c6XQjGVNpNTQpjZm92uM`.
Feeding the table above into `commitment_digest()` in
`tests/test_onchain_vectors.py` reproduces the commitment exactly.

---

## 3. Bitmap convention: LSB-first, exactly `ceil(n/8)` bytes

Asset `i` is **bit `i % 8` of byte `i / 8`**.

```
byte_index = i >> 3
bit_mask   = 1 << (i & 7)
```

Three rules the program enforces, all of them on the reveal path:

1. `bits.len() == ceil(n / 8)` exactly — longer or shorter is `BadBitmapLength`.
2. No bit set at an index `>= n`. The padding bits in the last byte must be zero,
   or the reveal fails with `BitOutsideUniverse`. This is **not** about smuggling
   a different bitmap past a commitment — it cannot be: the bitmap is hashed, so
   flipping a padding bit changes the digest and the reveal dies at
   `CommitmentMismatch` instead. The rule exists because of its interaction with
   rule 3. A bitmap with `k` bits set, some of them past `n`, would satisfy a
   plain "exactly `k` bits" count while naming **fewer than `k` real assets** —
   the out-of-universe indices land on coefficient slots the study never wrote.
   The index check is what makes rule 3 a statement about assets rather than
   about bits.
3. Exactly `k` bits set — `WrongCardinality` otherwise. The program short-circuits
   as soon as a `(k+1)`-th bit appears, so an adversarial all-ones bitmap costs
   nothing extra.

Worked example, the live smoke selection `[1, 6, 7, 9]` with `n = 10`:

```
byte 0: bits 1, 6, 7  ->  0b1100_0010 = 0xc2
byte 1: bit  1 (= asset 9 - 8)  ->  0b0000_0010 = 0x02
bits = c202,  length ceil(10/8) = 2
```

Reference sizes: `n=1 -> 1`, `n=8 -> 1`, `n=9 -> 2`, `n=39 -> 5`, `n=48 -> 6`.

### Cardinality cap: `MAX_CARDINALITY = 40`

`create_study` enforces `1 <= k <= n` (`InvalidCardinality`) **and** `k <= 40`
(`CardinalityTooLarge`). The second bound has nothing to do with account size — a
`k = 48` selection fits a 48-asset study perfectly well. It exists so that
**anything publishable is revealable**.

`reveal_allocation` costs about `7,441 + 179 * k(k+1)/2` compute units (§5), and
a single-instruction transaction gets Solana's default 200,000. Extrapolating
that model, the budget runs out around `k = 46`. Without the cap, an authority
could seal a study at `k = 48` and the agent could publish a commitment against
it — irreversibly advancing `published_count`, because a published sequence can
never be overwritten or withdrawn — and then no client in this repo could open
it. The study would manufacture exactly the unrevealed-allocation gap §7 treats
as the tell for selective silence, out of arithmetic rather than dishonesty.

At `k = 40` a reveal measured **154,337 of 200,000** CU (§5), leaving 23% of the
default budget unused. `scripts/devnet-separatrix.ts` additionally prepends a
`ComputeBudgetProgram.setComputeUnitLimit` to every reveal, sized at
`ceil(1.3 * model) + 2,000` — 14,001 units at `k = 4`, 202,488 at `k = 40` — so a
reveal does not depend on the default at all. That is belt and braces: the cap
already guarantees the fit, and the explicit limit only removes the dependence on
the model still being right.

### Penalty offset bound: `|offset| <= i64::MAX`

`create_study` rejects an `offset_int_le` outside `[-i64::MAX, i64::MAX]` with
`OffsetOutOfRange`. The field is a full i128 in the account and in the seal
digest, but an unbounded one would let a study be sealed in which every reveal
fails with `Overflow` on the final addition — again, publishable but not
revealable. See the arithmetic argument below.

### Error codes

Anchor numbers custom errors from 6000 in declaration order, so a client that
matches on the number rather than the name is sensitive to insertions. The
hardening appended two and, in doing so, moved `Overflow`.

| code | name | raised by |
| ---: | --- | --- |
| 6000 | `UniverseTooLarge` | `create_study`, `n > MAX_ASSETS` |
| 6001 | `InvalidCardinality` | `create_study`, not `1 <= k <= n` |
| 6002 | `EmptyChunk` | `write_coefficients` |
| 6003 | `ChunkTooLarge` | `write_coefficients`, `len > MAX_CHUNK` |
| 6004 | `IndexOutOfRange` | `write_coefficients`, past `term_count` |
| 6005 | `StudySealed` | `write_coefficients` / `seal_study` after sealing |
| 6006 | `StudyNotSealed` | `publish_allocation` before sealing |
| 6007 | `CoefficientHashMismatch` | `seal_study` |
| 6008 | `AlreadyRevealed` | `reveal_allocation` |
| 6009 | `BadBitmapLength` | `reveal_allocation` |
| 6010 | `BitOutsideUniverse` | `reveal_allocation` |
| 6011 | `WrongCardinality` | `reveal_allocation` |
| 6012 | `CommitmentMismatch` | `reveal_allocation` |
| 6013 | `StudyMismatch` | `reveal_allocation` account constraint |
| 6014 | `UnauthorizedAuthority` | `write_coefficients` / `seal_study` |
| 6015 | `UnauthorizedAgent` | `publish_allocation` |
| 6016 | `SequenceOutOfOrder` | `publish_allocation` |
| 6017 | `EmptyCommitment` | `publish_allocation` |
| 6018 | `EmptySalt` | `reveal_allocation` |
| 6019 | `CoefficientOutOfRange` | `write_coefficients`, `|value| > i32::MAX` |
| **6020** | **`CardinalityTooLarge`** | `create_study`, `k > MAX_CARDINALITY` — new |
| **6021** | **`OffsetOutOfRange`** | `create_study`, `|offset| > i64::MAX` — new |
| **6022** | `Overflow` | any `checked_add` — **was 6020** |

A missing agent signature is not in this table: it is rejected by the runtime
before the program runs, so it surfaces as a signature-verification failure, not
an Anchor error code (§4.1).

### Upper-triangular index

The coefficient buffer is the row-major upper triangle with the diagonal
included, so for `i <= j`:

```
triangular_index(n, i, j) = i*n - i*(i-1)/2 + (j - i)
```

For `n = 3` that lays out as `(0,0)=0 (0,1)=1 (0,2)=2 (1,1)=3 (1,2)=4 (2,2)=5`.
The function is symmetric — callers may pass `i > j`.

The reveal's scoring loop is then simply

```
objective = sum over selected i of  Q[i][i]
          + sum over selected pairs i<j of  Q[i][j]
```

which is `k*(k+1)/2` `i128` additions, and then **one more** to add the study's
penalty offset:

```
portfolio_objective = objective + offset_int
```

Both sums are bounded on the way in, and the second bound is easy to forget
because no coefficient rule touches it:

- `|Q| <= i32::MAX` is enforced at `write_coefficients`, and at most
  `MAX_TERMS = 1176` terms are ever summed, so `|objective| < 1176 * 2^31`,
  about `2.5e12`.
- `|offset_int| <= i64::MAX` is enforced at `create_study`, so
  `|portfolio_objective| < 2.5e12 + 9.22e18`, about `9.22e18`.

`i128` holds up to `1.7e38`, so both are safe by nineteen orders of magnitude.
Every addition is still a `checked_add` returning `Overflow`; the claim is that
the error is unreachable, not that it is unhandled.

---

## 4. Transactions to upload a study

```
tx_count = 1 (create_study) + ceil(n*(n+1)/2 / 96) (write_coefficients) + 1 (seal_study)
```

`MAX_CHUNK = 96` i64 per chunk: 768 bytes of instruction data, which leaves
comfortable room inside Solana's ~1232-byte transaction limit.

Measured by counting `getSignaturesForAddress` on each study PDA. The counts
below include the study's one `publish_allocation` and one `reveal_allocation`
(both also touch the study account), so "upload" is the total minus 2.

| n | terms | chunks | upload txs | total txs on the PDA | study PDA | account size | lamports |
| ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 8 | 36 | 1 | 3 | 5 | `N8mTHmQCYgtA8pnHhUreMkrV829wzZgVF9HDAarKmHz` | 9608 | 67,762,560 |
| 10 | 55 | 1 | 3 | 5 | `4fzo7jXAecbxZ32oGAyfMk28VkSs8YCThcFapL86R6PV` | 9608 | 67,762,560 |
| 16 | 136 | 2 | 4 | 6 | `4u9cRUeBiYvk9NpWWLnmJpAUAxTfUV9594qDNgbKr57v` | 9608 | 67,762,560 |
| 32 | 528 | 6 | 8 | 10 | `AeQBVdg9eZjmjpXNzg1DYnvVRneuYoSnTHWxobvo1SUF` | 9608 | 67,762,560 |
| 48 | 1176 | 13 | 15 | 17 | `5DH8TyLwyGnEnCtti1zt5drKK9KTy8SUF5LWR9MqM3HR` | 9608 | 67,762,560 |

### 4.1 Who signs what

| instruction | signers | why |
| --- | --- | --- |
| `create_study` | authority **and** agent | authority pays the study's rent; the agent consents to being named |
| `write_coefficients` | authority | only the study's own authority may write |
| `seal_study` | authority | same |
| `publish_allocation` | agent | the bound agent, which also pays the allocation's rent |
| `reveal_allocation` | *nobody* | permissionless by design — see §7 |

The agent's signature on `create_study` is the hardening change with a visible
cost. `Study.agent` sits at a fixed offset and is `memcmp`-indexable, which is
how anyone aggregates an agent's record; without a signature, anyone could open
unlimited studies naming someone else's pubkey and pollute that index. A track
record can be *imposed* on nobody, so attribution is consensual. The price is one
extra signature — 5,000 lamports, measured below.

### 4.2 Measured fees

Summed from `meta.fee` over every transaction that touched the PDA:

| study | txs | total fees (lamports) | build |
| --- | ---: | ---: | --- |
| n=48 (`5DH8Ty…M3HR`) | 17 | 90,000 | pre-hardening |
| n=10 (`4fzo7j…R6PV`) | 5 | 30,000 | pre-hardening |
| n=8 (`Dn8VrL…4ifRa`) | 5 | 35,000 | hardened |

Fees are 5,000 lamports per signature. The `n = 48` row is 15 single-signature
upload txs (75,000) + a two-signature publish (10,000) + a single-signature
reveal (5,000). The last row costs 5,000 more than the `n = 10` row for the same
five transactions, and its per-transaction breakdown says exactly where that goes:
`create_study` 10,000, `write_coefficients` 5,000, `seal_study` 5,000,
`publish_allocation` 10,000, `reveal_allocation` 5,000. `create_study` became a
two-signature transaction when the agent's consent was made mandatory (§4.1);
under the hardened program the `n = 48` upload would be 95,000 rather than 90,000
— arithmetic, not a measurement, since that study was uploaded once and cannot be
re-uploaded. Fees are negligible next to the 67,762,560 lamports of rent either
way.

---

## 5. Measured compute units

Every row below is a landed transaction — devnet unless the row says otherwise.
The number is the `consumed N of M` value the runtime logged for program
`CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp`. The full sample log for the
devnet rows, including signatures, lives in `secrets/separatrix/cu-samples.json`
(gitignored); the signatures below are the audit trail.

### `reveal_allocation` across k — the load-bearing measurement

This is the instruction whose cost has to stay small for the thesis to hold:
verifying a portfolio is `O(k^2)` integer additions, not a search.

| k | n | compute units | signature |
| ---: | ---: | ---: | --- |
| 4 | 8 | 8,553 | `YRM8n4zoe3K3XHffAvCxVHC9sLsvEsDovjXMuLoD1ufJEvPcr3VCbwBecaB7pExNCTyoYT4uHJbaG99HBhQBWVN` |
| 4 | 10 | 8,641 | `4pexDm8zXVGd7QhabdibhsnEdBD2a1PKFxsGPThDSxWLjyqnRX42swQQKimGxbprdzt7c6XQjGVNpNTQpjZm92uM` |
| 4 | 48 | 8,835 | `5zj7XqArpHwCNnFHZP6SMz8KpVYJdLCTWnUoo5Vvc3Ev9iQyPZA4fhERD1CeNKyf1se85w5WvjtPPhmjE6yBSahK` |
| 8 | 16 | 13,430 | `px8WGJLvNCginWH2PinaP3DYwPBm7TFSbCYtNeCm5bxVMgvaCv9qfsCymY3TU4VXLdipVU72gHBh6SgiTqhoQvL` |
| 8 | 48 | 13,630 | `39RpsRAFn8EnBdxgnvbvEVsNUaCF3yRwyTocyZ8xusPw1ccrBkmTm9NuRLpww92f3omNVLwTHzp8fYSAh4Xt9a35` |
| 16 | 32 | 31,714 | `5pBfxdnNKXNFWwxuwA52CnAEXfvgL5RfkAC3mTrYEB8EYhUVEXhAfe5QZ2AHzr4k15vFfwpCWE7agpxoCNR45Pdx` |
| 16 | 48 | 31,814 | `4sXcLPKh3rN29NaDD5QT6wKhh4AV5ZKPMGRXDs7mR84CwVo11WZJRxf9CLUEK7G2ud8AkrC6yaHha1rvFipWRhQ3` |
| 24 | 48 | 61,454 | `5MJu66VX2SdyhX2ziBuXBbtDq94WN1BMBtyXtmErZjGgwJj5bbfs7J25b9fQfLfEMJXqfquHmh9usYHGFArQEt7g` |
| 4 | 8 | 8,554 | `DoNokzvPXDyMkq8V42wERNr5PCZRizAbKwJrDCJ2GZjoADSi8hWR2bGfnC3gsTvh2LdNoqG4SZMDPnUVPPav7MB` (hardened build) |
| 40 | 40 | 154,337 | local `solana-test-validator`, same `.so` — see below |

Reading the numbers: cost is driven by `k`, not `n`. Holding `k = 4` and moving
`n` from 8 to 48 adds 282 CU (+3%); holding `n = 48` and moving `k` from 4 to 24
adds 52,619 CU (7x). The `n` dependence is the linear bitmap scan; the `k`
dependence is the `k(k+1)/2` quadratic term. At `k = 24` the instruction consumes
61,454 of the 200,000 CU default budget — under a third.

The program's source quotes a cost model for this instruction, and
`MAX_CARDINALITY` is derived from it:

```
reveal_allocation  ≈  7,441 + 179 * k(k+1)/2   compute units
```

Held against the rows above, it is close but deliberately not exact. Residuals
(model − measured) run +678, +590, +396 at `k = 4`, +455, +255 at `k = 8`, +71
and −29 at `k = 16`, and −313 at `k = 24`: it overshoots small `k` and undershoots
large `k`. An ordinary least-squares fit of those same eight rows against
`k(k+1)/2` is nearer `6,921 + 182.05 * k(k+1)/2`. So the model is a fit, not a
bound, and anything sized from it needs margin — which is why the client's
`ComputeBudget` request adds 30% and a flat 2,000 CU rather than using the model
directly. Extrapolated, the model crosses the 200,000 default at `k = 46`
(200,940 predicted, against 192,706 at `k = 45`), and `MAX_CARDINALITY = 40` was
set below that (§3).

The `k = 40` row is the check that the extrapolation was not wishful. It was
measured on a local `solana-test-validator` running this same
`separatrix_program.so`, because devnet has no `k = 40` study and creating one
would cost 0.068 SOL of permanent rent to learn a number a local ledger gives
for free. Measured 154,337; model 154,221; the model is 116 CU low, 0.08%, with
23% of the default budget still unused. It reproduces by running the Anchor
suite (§8) — the
`accepts k = MAX_CARDINALITY` case publishes and reveals a 40-of-40 selection and
deliberately sets **no** compute budget, so it fails if that headroom ever
disappears.

There will never be a `k = 48` row. Earlier versions of this document flagged it
as the unmeasured case most at risk of exceeding the budget; the resolution was
not to measure it but to make it unreachable — `create_study` now rejects any
`k > 40` with `CardinalityTooLarge`, so `k = 40` is the top of this table by
construction.

### `seal_study` across n

`seal_study` hashes `18 + 2 + 8 + 16 + 8*term_count` bytes, so its cost is linear
in `term_count`.

| n | terms | bytes hashed | compute units | signature |
| ---: | ---: | ---: | ---: | --- |
| 8 | 36 | 332 | 3,694 | `7Yixm8TPY6RgBS6ppjpMJVsVSeqmvX9GU3nzaq6AwqaTN1vtdQZrLXpf5mf3cwiE2eny4qrbKHgpSGmym9GXeAq` |
| 10 | 55 | 484 | 3,770 | `3b7gnenK8n4ui8shgiSDDfinN3EY1zJFehmGDdSYDdBfm4W36gx5zniyr3pnaqzza5QWFByZXdf1mtbQaiKAqCwh` |
| 16 | 136 | 1,132 | 4,094 | `dHuRheTsXA26jnUGmPYZx6fDsfhDpppqkenyWSV7KPCvEzTZmTL1wFCvJZbj1ZbuHXqiGYX3wAMzk6UsmLv8mj6` |
| 32 | 528 | 4,268 | 5,662 | `2jZ8wPq8tmANuCyC6c39fEumhpn4QQ28JtNxH85vo3zZB56WxaJsYobgaT5Xc2PN3e5NncTqB4SGqFGHH6Gbmx6` |
| 48 | 1176 | 9,452 | 8,254 | `4n2fMicYDmeRGd7q8LrTJhREqnhy8MDrBEH4NgWTiDDWxDKrxnx9x56drjFc8zyPZJTfMdMmMZpL6eTfgbnjALrP` |
| 8 | 36 | 332 | 3,694 | `msWbF3nNrREvkABUGHGkqEdhDZs6Zg22jLHQECkQkfCUCdEeFRdJwWGQgjU8uUmSoBySirJgU6fAX9WogkkTwPE` (hardened) |

Sealing the largest study the program accepts costs 8,254 CU — 4% of the default
budget. Hashing in place instead of rebuilding the byte buffer is why. The
hardened build re-measures the `n = 8` row at the same 3,694 CU, which is the
expected result: `seal_study` was not one of the four changed paths.

### `create_study`, `write_coefficients`, `publish_allocation`

| instruction | params | compute units | signature |
| --- | --- | ---: | --- |
| `create_study` | n=8 k=4 | 8,139 | `32dsojiDGwYLVy4L4F82mScgJ76jPMQ2CPDZ27B3hcxT7CNd8SqJoVQtoZth44YxZ8V73srJehudY5PepMyVGf5i` |
| `create_study` | n=10 k=4 | 9,639 | `61fQivjqBrrVjGfUCXefCg81awa8YKhSphLtK44ze1U5BQfDn8BY5mWx7oWWuoxNmncuGK6TwDekPXqndj2HmGq8` |
| `create_study` | n=48 k=8 | 8,139 | `4V4hAseTMmMH1N1vtHZAsbGJ6mM57b7xQbxN8ZZ9NVfNcYmo8wxBRuUtpky4NP2gi5pJG2GPLbXUPgm5dA9Q4eCh` |
| `write_coefficients` | 36 values | 4,067 | `QzSp8YXkHqDXyJwWvh9ncaQH8CAZfvfxtGtAsni65moBH5oEtz5SBa9M6x6Nyzw49N4DH8jS5DRNnpR8E98Ma1R` |
| `write_coefficients` | 55 values | 4,571 | `5nRLVBFMwVVpLYGtsuco9MTcFDkfRuw1py7JQUc7Hx5cCR2GjLKTgYykzVgkLj9P89uE5u8f198JKrYFYa1aMjF3` |
| `write_coefficients` | 96 values | 5,602 | `5DZjruw5hMFg22aJiKLxVRwW9Lse3ANE6tmPUictRvzycSvrzfqAHLdN3YpsroY35uHzgcK5f4uKcUCfE9vJP4eU` |
| `publish_allocation` | k=4, n=48 | 11,171 | `3V659tgjb13RqMMJTs8YMDn82oGWNoZjY63xVY27Jt14Gpotzmye7SHTSkSA68tTSrKdfizfvCMX4T7ZqNFyjhdj` |
| `publish_allocation` | k=4, n=10 | 12,671 | `57RSdihnF6Z11phkK8sRPJciA28mearkJDbfsYDvP6vZ8hJJV6JFWCUQBo1rq2d95VHKaiLGBy2igkou2rJpK66L` |
| `publish_allocation` | k=8, n=16 | 12,671 | `4d7hNLSZtELd6RoQLkkUM1YGsVTfX7yPnK61xnUzyS9oJ45ePpi3quH3SWWAHQRxSgmEmcafok5xmjrnV6sdqTcm` |
| `publish_allocation` | k=8, n=48 | 18,671 | `5mDShMgSR9Y7vUv7Ji4gnYT1nhkinFF9iFiU3WkDe9B5Mdq3m3s6mKB3wZbKjZFGWsg4A47cNx9jppMNJ2MSHBQQ` |
| `publish_allocation` | k=16, n=48 | 14,171 | `qvCjobohs4PkandbPv5UoBeuwAviJN1XiJGunL5crPAreftzjqrEsAzYqbXSmpgUwswiNtwUksnpZt9J1PYX5MD` |
| `publish_allocation` | k=16, n=32 | 15,671 | `3kr1umM66JZLBSBBxn3zMnvUCA97PamUS2YfAer3cqSc6hzk3gJRWJdQuf4x2njevEVjDpob5m1FNvEB4zTrDTsa` |
| `publish_allocation` | k=24, n=48 | 12,671 | `5oTiEZQzYEGAbrqfKvPtAnaUSKciM6Je6nprEXks9ZhsQxf2UUUyf3b2SYcEmQ9CUTqaK2c81jLkhQfv9jDu37H4` |
| `create_study` | n=8 k=4, **hardened** | 11,245 | `4zcD7vjQuN5AHFwrsF2o9QKToTD7zMhAQHQFQ31xpdJXwz5GeD435kbbAaAyafSwHHZAHdvCLgdtGJhcGCyrcvpj` |
| `write_coefficients` | 36 values, **hardened** | 3,990 | `5H8X8eaVHa51TLbW6eo8BnS22KtkCgYW6LMFDgdfZT2K8N4Z8cd3jheM47kKeB2eEQs3Khv3WXGY9GgxWQ38Vqgg` |
| `publish_allocation` | k=4, n=8, **hardened** | 14,171 | `4kmPwqDZ6yf7Horg3L2g62Q4W4cY2ZvTmkqF5pnqokygWGiexTnkzykdLZX2mekPUfGiugZotE6ZDxe8rrZqnA14` |

Rows not marked *hardened* were measured on the pre-hardening binary. For
`seal_study`, `publish_allocation` and `reveal_allocation` that is the same code;
`create_study` and `write_coefficients` each gained a validation and are directly
comparable only within a build.

#### The `create_study` / `publish_allocation` spread is bump-seed search

Neither instruction's cost tracks `n` or `k` — `publish_allocation` stores a
32-byte commitment and never looks at the selection, so **do not read a `k` trend
into these numbers**. But the spread is not noise, and it is not the
system-program CPI: creating an account is a fixed cost, and the same instruction
creating the same-sized account varies by 7,500 CU across the table.

It is Anchor's `init`, which derives the PDA with `find_program_address`. That
walks bump candidates from 255 downward and pays for a `create_program_address`
syscall on **every candidate, including the failures**. The syscall's fixed cost
is 1,500 CU, so a PDA whose canonical bump is 255 costs one call and one whose
canonical bump is 251 costs five. The bump is a property of the seeds — the
authority key and study id, or the study key and sequence — and is therefore
uncorrelated with `n` and `k`, which is what makes the table look random.

Every `create_study` and `publish_allocation` from one run of the Anchor suite
against a local `solana-test-validator` (same `.so`), grouped by the canonical
bump the program stored in the account it created:

| instruction | canonical bump | candidates tried | samples | compute units |
| --- | ---: | ---: | ---: | --- |
| `create_study` | 255 | 1 | 7 | 8,297 (one at 8,299) |
| `create_study` | 254 | 2 | 9 | 9,797 |
| `create_study` | 251 | 5 | 1 | 14,297 |
| `publish_allocation` | 255 | 1 | 8 | 11,225 |
| `publish_allocation` | 254 | 2 | 4 | 12,725 |
| `publish_allocation` | 253 | 3 | 1 | 14,225 |

`(14,297 − 8,297) / (5 − 1) = 1,500.0` and `(14,225 − 11,225) / (3 − 1) =
1,500.0`. Within one instruction the cost is a function of the bump alone.

(The 8,299 is a 2 CU outlier in an otherwise identical group; nothing in the
instruction depends on `n` or `k` beyond one multiplication.)

The devnet rows sit on the same 1,500 CU lattice: `publish_allocation` at
11,171 / 12,671 / 14,171 / 15,671 / 18,671 is one base plus 0, 1, 2, 3 and 5
extra candidates. The devnet base runs 54 CU below the local one at both
candidate counts we can compare (11,225 vs 11,171 and 14,225 vs 14,171) — a
constant cluster/runtime-version offset, not the program.

The §6 smoke is a check anyone can repeat without a validator: its study
`Dn8VrL…4ifRa` and allocation `HjTZwL…ozSFp` both have canonical bump 253, so
three candidates each. `publish_allocation` consumed 14,171, exactly two 1,500
steps above the measured 11,171 base. `create_study` consumed 11,245, which puts
its one-candidate base at 8,245 — 52 CU below the local 8,297, the same offset
again. Derive the bumps yourself: the seeds are `["study", authority,
study_id_le]` and `["alloc", study, sequence_le]`, and §6 gives the ids.

The only instruction whose cost tracks `k` is `reveal_allocation`.

`write_coefficients` does scale with chunk length: 4,067 CU for 36 values, 4,571
for 55, 5,602 for 96. Repeats of the 96-value chunk across five studies measured
5,602, 5,607 and 5,627, so treat ~5,600 as the figure and the last two digits as
noise. A full `n = 48` upload is 12 chunks of 96 plus a remainder of 24; each one
is its own transaction and none is close to any limit.

---

## 6. The headline claim, and how it was checked

`npm run separatrix:smoke` solves a study with the Rust CLI, seals it on-chain,
commits to the exact optimum with a withheld salt, reveals it, and asserts that
the integer the **program** computed equals the integer the **solver** computed.

The current run, against the **hardened** program at the same address — study
`1786685929827`, n=8, k=4, selection `[0, 2, 3, 5]`:

```
solver objective_int            = -4842457631
chain  objective_int            = -4842457631
solver portfolio_objective_int  = -9439489
chain  portfolio_objective_int  = -9439489
```

reveal tx
`DoNokzvPXDyMkq8V42wERNr5PCZRizAbKwJrDCJ2GZjoADSi8hWR2bGfnC3gsTvh2LdNoqG4SZMDPnUVPPav7MB`
(study `Dn8VrLpgut2uU7vHWRrc4BzbYv2RoNLWkmQVo8a4ifRa`, allocation
`HjTZwL5P5CeQVcxrejEasNaWStHgTPoVbth5LB1ozSFp`). This is the run that re-proves
the equality after the hardening: the agent signed `create_study` (two signatures,
§4.1), and the reveal carried an explicit compute-unit limit of 14,001 for
`k = 4` and consumed 8,554.

The earlier run on study `1786682584393` (n=10, k=4, selection `[1, 6, 7, 9]`,
reveal `4pexDm8z…jZm92uM`, objectives `-4866638522` / `-22974966`) is the source
of the live vectors in §2. It predates the hardening, and none of the four
changes touched a preimage, so those vectors still verify against the current
binary.

Four independent implementations of the same preimages have to agree for that to
happen at all: the Rust program, the Rust solver's `--emit-qubo` exporter, the
TypeScript client in `scripts/devnet-separatrix.ts`, and the Python vectors in
`tests/test_onchain_vectors.py`. If any two drift, `seal_study` rejects the study
or `reveal_allocation` rejects the reveal — loudly, and before anything is
claimed.

Related checks:

- `npm run verify:separatrix-idl` — rebuilds every instruction from the committed
  IDL with Anchor's encoder and byte-compares against a hand-rolled
  discriminator + Borsh encoding, checks account/event discriminators against
  `sha256("account:<Name>")[0..8]` / `sha256("event:<Name>")[0..8]`, evaluates
  every declared PDA seed set against directly computed PDAs, and re-runs the
  generator to confirm the committed file is reproducible.
- `python -m unittest tests.test_onchain_vectors` — the frozen golden vectors.
- `tests/anchor/separatrix.ts` — 19 tests against a local validator (see §8):
  the happy path, every rejection, the three `create_study` admission rules
  (agent signature, `MAX_CARDINALITY`, offset range), and a `k = 40` publish and
  reveal that runs on the default compute budget.

---

## 7. What this program does **not** prove

Read this section before quoting any track record produced by separatrix.

**It cannot force a reveal.** Nothing on a public chain can. An agent may publish
several commitments and open only the one that aged well. The program does not
pretend to prevent this; it makes it *countable*:

- sequences are strictly monotonic — `sequence` must equal the study's current
  `published_count`, so there are no gaps to hide an unrevealed commitment in;
- a published commitment cannot be overwritten. The allocation PDA is
  `["alloc", study, sequence_le]`, so re-publishing a sequence fails at `init`
  with a system-program "account already in use", before the handler even runs;
- exactly one agent is bound to a study at creation — and, since the hardening,
  signs to accept that binding — so nobody else can squat a future sequence, pad
  the record, or open a study in somebody's name;
- both `published_count` and `revealed_count` live on the `Study` account.

**That countability is scoped to one study, and nothing binds an agent's studies
together.** This is the sharpest limitation on the page. The counters live on a
`Study`; the program has no notion of an agent's history across studies, no
registry, and nothing gating another one but the 0.068 SOL of rent (§1). An agent sitting on an
awkward unrevealed commitment does not have to leave it hanging in a study it
keeps using — it can simply stop using that study and create a fresh one with
`published_count = revealed_count = 0`. Nothing in the program prevents that or
records that it happened.

So a gap is evidence only *within* the study you are reading, and a clean study
is evidence about that study alone. The honest aggregate is every study an agent
has signed into, which has to be assembled off-chain: `Study.agent` sits at a
fixed offset (40 bytes into the account, past the 8-byte discriminator and the
32-byte authority) precisely so a `getProgramAccounts` `memcmp` filter can find
them all. That is also why the agent must now sign `create_study` — otherwise
the index that aggregation depends on could be stuffed with studies the agent
never agreed to. But a consensual, unpollutable index is still only an index: the
aggregate is as complete as the scan you ran, and an agent that used a fresh
keypair per study is not in it at all. Separatrix makes silence countable inside
a study; it does not make an
agent's *identity* accountable across studies, and no claim here should be read
as if it did.

**The reveal is permissionless.** `RevealAllocation` takes no signer: anyone
holding `(bits, salt)` can open a commitment, and the agent cannot claim it was
unable to. The flip side is that a leaked salt lets a third party open an
allocation the agent intended to leave closed. Treat
`secrets/separatrix/studies.json` accordingly.

**The honest reading of a record is both numbers.** `published_count = 40,
revealed_count = 40` is a claim. `published_count = 400, revealed_count = 40` is
a different claim wearing the same 40 reveals. `npm run separatrix:status` prints
the gap on its own line for this reason — for the studies this machine created,
which is all that command can see (§8). Any dashboard, README, or thread that
quotes reveal results without the publish count is misrepresenting the data, and
the data to catch it is on-chain.

**It does not prove the problem is a good one.** The program checks that the
uploaded coefficients hash to the committed `q_hash`, not that the matrix is a
sensible risk model, that `mu` and `sigma` were estimated honestly, or that the
study was chosen before the returns were known. Sealing binds an authority to
*a* problem; it says nothing about whether that problem was worth solving.

**It does not prove optimality.** `reveal_allocation` scores the submitted
selection. It does not and cannot verify that no better `k`-subset exists — that
is the NP-hard direction, and the whole design premise is that the chain does not
attempt it. A revealed objective is a *verified score*, never a verified optimum.

**It claims no quantum or solver advantage.** The chain replays `O(k^2)` integer
additions that any validator can redo. Where the selection came from — exact
enumeration, a heuristic, a coin flip — is outside what the program can attest.
The `method` field is a 16-byte label the agent chose; it is self-reported and
unverified.

**Scope of the arithmetic guarantee.** Two bounds are enforced on the way in:
`|coefficient| <= i32::MAX` at `write_coefficients`, and `|offset_int| <=
i64::MAX` at `create_study`. With at most `MAX_TERMS = 1176` terms summed, they
make **both** `i128` results unoverflowable — `objective` under `2.5e12` and
`portfolio_objective = objective + offset_int` under `9.3e18`, against `i128`'s
`1.7e38` (§3). The offset bound is the half that was missing before the
hardening: the coefficient rule never touched `offset_int`, so the guarantee
covered `objective_int` but not `portfolio_objective_int`, and an offset near
`i128::MAX` could have sealed a study in which every reveal died with `Overflow`.
Both halves are a real guarantee about the *program*. It says nothing about whether the
off-chain quantization from floats to integers was faithful — that is the
exporter's job, and it is checked by
`tests/test_onchain_vectors.py::CliAgreesWithIndependentImplementationTestCase`,
not by the chain.

---

## 8. Reproducing the tests

The Anchor suite needs a validator with the program deployed **at its declared
address** — the commitment preimage hashes `crate::ID`, so a copy deployed
anywhere else cannot verify a reveal.

On Windows, `solana-test-validator` needs two accommodations:

- `--log`, because it otherwise creates a `validator.log` symlink and symlink
  creation needs a privilege a normal account does not hold (`os error 1314`);
- `--mint <provider-pubkey>`, because its faucet binds to `0.0.0.0` and Windows
  cannot connect to that address (airdrops fail with `WSAEADDRNOTAVAIL`). The
  suite's `fund()` also falls back to a plain transfer for the same reason.

```powershell
solana-test-validator --reset --log `
  --mint $(solana address -k keys/owner-devnet.json) `
  --bpf-program CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp `
    target/deploy/separatrix_program.so

$env:ANCHOR_PROVIDER_URL = "http://127.0.0.1:8899"
$env:ANCHOR_WALLET = "keys/owner-devnet.json"
npx ts-mocha -p tsconfig.json -t 1000000 tests/anchor/separatrix.ts
```

Devnet commands (`scripts/devnet-separatrix.ts`, via npm):

| command | what it does |
| --- | --- |
| `npm run separatrix:create -- <qubo.json>` | `create_study` + chunked `write_coefficients` + `seal_study` |
| `npm run separatrix:publish -- <study-id>` | fresh 32-byte CSPRNG salt, commitment, `publish_allocation` |
| `npm run separatrix:reveal -- <study-id>` | `reveal_allocation`, prints the objective the chain computed |
| `npm run separatrix:status` | decodes the studies **this machine created** — see below |
| `npm run separatrix:smoke` | end-to-end, asserts chain objective == solver objective |
| `npm run separatrix:measure` | lands transactions and reports their compute units |

`separatrix:status` is not a cluster-wide scan, whatever the name suggests. It
reads study ids out of `secrets/separatrix/studies.json` — the gitignored local
state file — keeps only the records whose `authority` equals the owner key on
this machine, derives each study PDA from that key, and then decodes that `Study`
plus every `Allocation` from sequence `0` to `published_count - 1`. So it reports
on studies created from this working copy and nothing else: a study created by
another operator, or one whose local record was deleted, does not appear. Passing
an id (`npm run separatrix:status -- <study-id>`) skips the state file but still
derives the PDA under the **local** owner key, so it cannot reach another
authority's studies either.

To enumerate studies you did not create, query the cluster directly:
`getProgramAccounts` on `CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp` with a
`memcmp` at offset 8 for `Study.authority` or offset 40 for `Study.agent`, and a
`dataSize` of 9608. Nothing in this repo does that yet.

Salts are written to `secrets/separatrix/studies.json` (mode 0600, gitignored)
and are **never printed before the reveal lands**. Losing that file means the
matching allocation can never be opened — and `published_count` will out-run
`revealed_count` for good, exactly as §7 describes.
