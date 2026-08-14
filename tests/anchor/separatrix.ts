/**
 * Anchor tests for the separatrix program.
 *
 * These need a validator with the program deployed at its declared address —
 * the commitment preimage hashes `crate::ID`, so a copy deployed anywhere else
 * cannot verify a reveal.
 *
 * On Windows, `solana-test-validator` needs two accommodations. `--log` skips
 * the `validator.log` symlink it otherwise creates, which needs a privilege a
 * normal account does not hold; and `--mint <provider>` pre-funds the wallet,
 * because the built-in faucet binds to 0.0.0.0 and Windows cannot connect to
 * that address (airdrops fail with WSAEADDRNOTAVAIL). `fund()` below falls back
 * to a plain transfer for the same reason.
 *
 *   solana-test-validator --reset --log \
 *     --mint $(solana address -k keys/owner-devnet.json) \
 *     --bpf-program CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp \
 *       target/deploy/separatrix_program.so
 *
 *   $env:ANCHOR_PROVIDER_URL = "http://127.0.0.1:8899"
 *   $env:ANCHOR_WALLET = "keys/owner-devnet.json"
 *   npx ts-mocha -p tsconfig.json -t 1000000 tests/anchor/separatrix.ts
 *
 * The digests below are re-implemented from programs/separatrix/src/lib.rs on
 * purpose. tests/test_onchain_vectors.py pins the same bytes in Python and
 * scripts/devnet-separatrix.ts does it again in the client; three independent
 * implementations that must agree is the whole point.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { AnchorError } from "@coral-xyz/anchor";
import { assert } from "chai";

const QUBO_DOMAIN = Buffer.from("separatrix:qubo:v1", "utf8");
const COMMITMENT_DOMAIN = Buffer.from("separatrix:allocation:v1", "utf8");
const MAX_CHUNK = 96;
const I32_MAX = 2147483647n;

function u32le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function i64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value, 0);
  return buf;
}

function signedToLeBytes(value: bigint, byteLength: number): Buffer {
  const bits = BigInt(byteLength) * 8n;
  let raw = value < 0n ? (1n << bits) + value : value;
  const out = Buffer.alloc(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    out[i] = Number(raw & 0xffn);
    raw >>= 8n;
  }
  return out;
}

function signedFromLeBytes(bytes: ArrayLike<number>): bigint {
  let raw = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    raw = (raw << 8n) | BigInt(bytes[i] & 0xff);
  }
  const bits = BigInt(bytes.length) * 8n;
  return raw >= 1n << (bits - 1n) ? raw - (1n << bits) : raw;
}

function termCount(n: number): number {
  return (n * (n + 1)) / 2;
}

function triangularIndex(n: number, i: number, j: number): number {
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  return lo * n - (lo * Math.max(lo - 1, 0)) / 2 + (hi - lo);
}

/** LSB-first within each byte, exactly ceil(n/8) bytes. */
function bitmap(n: number, selected: number[]): Buffer {
  const out = Buffer.alloc(Math.ceil(n / 8));
  for (const index of selected) {
    out[index >> 3] |= 1 << (index & 7);
  }
  return out;
}

/** Deliberately allows out-of-universe bits so BitOutsideUniverse is reachable. */
function rawBitmap(byteLength: number, selected: number[]): Buffer {
  const out = Buffer.alloc(byteLength);
  for (const index of selected) {
    out[index >> 3] |= 1 << (index & 7);
  }
  return out;
}

function sealDigest(
  n: number,
  k: number,
  scaleBits: bigint,
  offsetInt: bigint,
  coefficients: bigint[]
): Buffer {
  const hash = crypto.createHash("sha256");
  hash.update(QUBO_DOMAIN);
  hash.update(Buffer.from([n, k]));
  hash.update(u64le(scaleBits));
  hash.update(signedToLeBytes(offsetInt, 16));
  for (const value of coefficients) {
    hash.update(i64le(value));
  }
  return hash.digest();
}

function commitmentDigest(
  programId: anchor.web3.PublicKey,
  study: anchor.web3.PublicKey,
  sequence: bigint,
  agent: anchor.web3.PublicKey,
  n: number,
  k: number,
  bits: Buffer,
  salt: Buffer
): Buffer {
  const hash = crypto.createHash("sha256");
  hash.update(COMMITMENT_DOMAIN);
  hash.update(programId.toBuffer());
  hash.update(study.toBuffer());
  hash.update(u64le(sequence));
  hash.update(agent.toBuffer());
  hash.update(Buffer.from([n, k]));
  hash.update(u32le(bits.length));
  hash.update(bits);
  hash.update(salt);
  return hash.digest();
}

function scoreSelection(n: number, coefficients: bigint[], selected: number[]): bigint {
  let objective = 0n;
  for (let a = 0; a < selected.length; a += 1) {
    objective += coefficients[triangularIndex(n, selected[a], selected[a])];
    for (let b = a + 1; b < selected.length; b += 1) {
      objective += coefficients[triangularIndex(n, selected[a], selected[b])];
    }
  }
  return objective;
}

/** UTF-8, zero-padded to a fixed-width byte array argument. */
function padToBytes(text: string, length: number): number[] {
  const raw = Buffer.from(text, "utf8");
  return Array.from(Buffer.concat([raw, Buffer.alloc(length - raw.length)]));
}

/** Deterministic, in-range coefficients: a fixed matrix per (n, tweak). */
function makeCoefficients(n: number, tweak = 0): bigint[] {
  return Array.from({ length: termCount(n) }, (_, t) =>
    BigInt(((t * 37 + tweak * 101) % 4001) - 2000)
  );
}

describe("separatrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idlPath = path.resolve("idl", "separatrix.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, provider) as any;
  const programId: anchor.web3.PublicKey = program.programId;

  const SCALE_BITS = 4780509421331506504n;
  const OFFSET_INT = -1234567890123n;
  const ZERO_SALT = Buffer.alloc(32);
  /** Must match MAX_CARDINALITY in programs/separatrix/src/lib.rs. */
  const MAX_CARDINALITY = 40;
  /** Must match MAX_ABS_OFFSET: `i64::MAX as i128`. */
  const MAX_ABS_OFFSET = 9223372036854775807n;

  let nextStudyId = BigInt(Date.now());
  function freshStudyId(): bigint {
    nextStudyId += 1n;
    return nextStudyId;
  }

  function freshSalt(): Buffer {
    const salt = crypto.randomBytes(32);
    salt[0] |= 1; // the program rejects an all-zero salt
    return salt;
  }

  function deriveStudy(authority: anchor.web3.PublicKey, studyId: bigint): anchor.web3.PublicKey {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("study", "utf8"), authority.toBuffer(), u64le(studyId)],
      programId
    )[0];
  }

  function deriveAllocation(
    study: anchor.web3.PublicKey,
    sequence: bigint
  ): anchor.web3.PublicKey {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("alloc", "utf8"), study.toBuffer(), u64le(sequence)],
      programId
    )[0];
  }

  /**
   * Top up an account. Prefers the faucet, but falls back to a transfer from the
   * provider wallet: `solana-test-validator` binds its faucet to 0.0.0.0, which
   * a Windows host cannot connect to, and a validator started with
   * `--mint <provider>` has no faucet worth using anyway.
   */
  async function fund(target: anchor.web3.PublicKey, sol: number): Promise<void> {
    const lamports = sol * anchor.web3.LAMPORTS_PER_SOL;
    try {
      const signature = await provider.connection.requestAirdrop(target, lamports);
      const latest = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({ signature, ...latest }, "confirmed");
      return;
    } catch (error) {
      if (target.equals(provider.wallet.publicKey)) {
        throw error;
      }
    }
    const transfer = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: target,
        lamports
      })
    );
    await provider.sendAndConfirm(transfer, []);
  }

  async function expectError(action: Promise<unknown>, code: string): Promise<void> {
    let caught: unknown = null;
    try {
      await action;
    } catch (error) {
      caught = error;
    }
    assert.isNotNull(caught, `expected ${code} but the transaction succeeded`);
    assert.instanceOf(caught, AnchorError, `expected an AnchorError, got: ${String(caught)}`);
    assert.equal((caught as AnchorError).error.errorCode.code, code);
  }

  /** For failures raised before the handler runs, which are not AnchorErrors. */
  async function expectFailureContaining(
    action: Promise<unknown>,
    fragment: string
  ): Promise<void> {
    let caught: unknown = null;
    try {
      await action;
    } catch (error) {
      caught = error;
    }
    assert.isNotNull(caught, `expected a failure mentioning "${fragment}" but it succeeded`);
    const text = `${String(caught)} ${JSON.stringify((caught as any)?.logs ?? [])}`;
    assert.include(text, fragment);
  }

  /**
   * anchor 0.30.1 camel-cases every IDL name inside `Program`, so the event the
   * coder yields is `allocationScored`, not `AllocationScored`. Match either.
   */
  async function decodeEvents(signature: string, name: string): Promise<any[]> {
    const wanted = name.toLowerCase();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const tx = await provider.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      const logs = tx?.meta?.logMessages;
      if (logs) {
        return logs
          .filter((line) => line.startsWith("Program data: "))
          .map((line) => program.coder.events.decode(line.slice("Program data: ".length)))
          .filter((event: any) => event && event.name.toLowerCase() === wanted);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`transaction ${signature} never became readable`);
  }

  interface Study {
    studyId: bigint;
    studyPda: anchor.web3.PublicKey;
    n: number;
    k: number;
    coefficients: bigint[];
    agent: anchor.web3.Keypair;
  }

  /**
   * Build a `create_study` instruction. Kept separate from the send so a test
   * can drop the agent's signature and watch the runtime reject it.
   */
  function createStudyIx(
    studyId: bigint,
    studyPda: anchor.web3.PublicKey,
    n: number,
    k: number,
    qHash: Buffer,
    agent: anchor.web3.PublicKey,
    label: string,
    offsetInt: bigint
  ): Promise<anchor.web3.TransactionInstruction> {
    return program.methods
      .createStudy(
        new anchor.BN(studyId.toString()),
        n,
        k,
        new anchor.BN(SCALE_BITS.toString()),
        Array.from(signedToLeBytes(offsetInt, 16)),
        Array.from(qHash),
        padToBytes(label, 32)
      )
      .accountsPartial({
        authority: provider.wallet.publicKey,
        agent,
        study: studyPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .instruction();
  }

  /**
   * create_study with a q_hash committing to `coefficients`.
   *
   * The agent signs: `Study.agent` is memcmp-indexable, so the program requires
   * consent before it will attribute a track record to a pubkey.
   */
  async function createStudy(
    n: number,
    k: number,
    coefficients: bigint[],
    agent: anchor.web3.Keypair,
    label = "test",
    offsetInt = OFFSET_INT
  ): Promise<Study> {
    const studyId = freshStudyId();
    const studyPda = deriveStudy(provider.wallet.publicKey, studyId);
    const qHash = sealDigest(n, k, SCALE_BITS, offsetInt, coefficients);
    await program.methods
      .createStudy(
        new anchor.BN(studyId.toString()),
        n,
        k,
        new anchor.BN(SCALE_BITS.toString()),
        Array.from(signedToLeBytes(offsetInt, 16)),
        Array.from(qHash),
        padToBytes(label, 32)
      )
      .accountsPartial({
        authority: provider.wallet.publicKey,
        agent: agent.publicKey,
        study: studyPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([agent])
      .rpc();
    return { studyId, studyPda, n, k, coefficients, agent };
  }

  function writeChunk(
    study: Study,
    startIndex: number,
    values: bigint[]
  ): Promise<string> {
    return program.methods
      .writeCoefficients(
        startIndex,
        values.map((v) => new anchor.BN(v.toString()))
      )
      .accountsPartial({ authority: provider.wallet.publicKey, study: study.studyPda })
      .rpc();
  }

  async function writeAll(study: Study, values: bigint[]): Promise<number> {
    let chunks = 0;
    for (let start = 0; start < values.length; start += MAX_CHUNK) {
      await writeChunk(study, start, values.slice(start, start + MAX_CHUNK));
      chunks += 1;
    }
    return chunks;
  }

  function seal(study: Study): Promise<string> {
    return program.methods
      .sealStudy()
      .accountsPartial({ authority: provider.wallet.publicKey, study: study.studyPda })
      .rpc();
  }

  async function createAndSeal(
    n: number,
    k: number,
    agent: anchor.web3.Keypair,
    tweak = 0
  ): Promise<Study> {
    const coefficients = makeCoefficients(n, tweak);
    const study = await createStudy(n, k, coefficients, agent);
    await writeAll(study, coefficients);
    await seal(study);
    return study;
  }

  function publish(
    study: Study,
    sequence: bigint,
    commitment: Buffer,
    signer: anchor.web3.Keypair,
    method = "test"
  ): Promise<string> {
    return program.methods
      .publishAllocation(
        new anchor.BN(sequence.toString()),
        Array.from(commitment),
        padToBytes(method, 16)
      )
      .accountsPartial({
        agent: signer.publicKey,
        study: study.studyPda,
        allocation: deriveAllocation(study.studyPda, sequence),
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([signer])
      .rpc();
  }

  function reveal(
    study: Study,
    sequence: bigint,
    bits: Buffer,
    salt: Buffer
  ): Promise<string> {
    return program.methods
      .revealAllocation(bits, Array.from(salt))
      .accountsPartial({
        study: study.studyPda,
        allocation: deriveAllocation(study.studyPda, sequence)
      })
      .rpc();
  }

  /** Publish a commitment over exactly these bits, so reveal reaches the checks after it. */
  async function publishFor(
    study: Study,
    sequence: bigint,
    bits: Buffer,
    salt: Buffer
  ): Promise<void> {
    const commitment = commitmentDigest(
      programId,
      study.studyPda,
      sequence,
      study.agent.publicKey,
      study.n,
      study.k,
      bits,
      salt
    );
    await publish(study, sequence, commitment, study.agent);
  }

  let agent: anchor.web3.Keypair;

  before(async () => {
    const balance = await provider.connection.getBalance(provider.wallet.publicKey);
    if (balance < 20 * anchor.web3.LAMPORTS_PER_SOL) {
      await fund(provider.wallet.publicKey, 100);
    }
    agent = anchor.web3.Keypair.generate();
    await fund(agent.publicKey, 10);
  });

  it("seals a chunked study, scores a committed allocation, and counts both sides", async () => {
    const n = 14;
    const k = 4;
    const selected = [1, 4, 9, 13];
    const coefficients = makeCoefficients(n, 1);
    const study = await createStudy(n, k, coefficients, agent, "happy path");

    // 105 terms at MAX_CHUNK=96 is deliberately more than one transaction.
    const chunks = await writeAll(study, coefficients);
    assert.equal(termCount(n), 105);
    assert.equal(chunks, 2);

    await seal(study);
    let onChainStudy = await program.account.study.fetch(study.studyPda);
    assert.equal(onChainStudy.sealed, 1);
    assert.equal(onChainStudy.termCount, 105);
    assert.equal(onChainStudy.agent.toBase58(), agent.publicKey.toBase58());
    assert.equal(onChainStudy.publishedCount.toNumber(), 0);
    assert.equal(onChainStudy.revealedCount.toNumber(), 0);

    const bits = bitmap(n, selected);
    assert.equal(bits.length, 2);
    const salt = freshSalt();
    await publishFor(study, 0n, bits, salt);

    onChainStudy = await program.account.study.fetch(study.studyPda);
    assert.equal(onChainStudy.publishedCount.toNumber(), 1);
    assert.equal(onChainStudy.revealedCount.toNumber(), 0);

    const allocationPda = deriveAllocation(study.studyPda, 0n);
    let allocation = await program.account.allocation.fetch(allocationPda);
    assert.equal(allocation.revealed, 0);
    assert.equal(signedFromLeBytes(allocation.objectiveIntLe), 0n);

    const signature = await reveal(study, 0n, bits, salt);

    allocation = await program.account.allocation.fetch(allocationPda);
    const expected = scoreSelection(n, coefficients, selected);
    assert.equal(allocation.revealed, 1);
    assert.equal(signedFromLeBytes(allocation.objectiveIntLe).toString(), expected.toString());
    assert.equal(
      signedFromLeBytes(allocation.portfolioObjectiveIntLe).toString(),
      (expected + OFFSET_INT).toString()
    );

    onChainStudy = await program.account.study.fetch(study.studyPda);
    assert.equal(onChainStudy.publishedCount.toNumber(), 1);
    assert.equal(onChainStudy.revealedCount.toNumber(), 1);

    // The AllocationScored event must carry the same number the account does,
    // which also exercises the event discriminator in the committed IDL.
    const events = await decodeEvents(signature, "AllocationScored");
    assert.lengthOf(events, 1);
    assert.equal(
      signedFromLeBytes(events[0].data.objectiveIntLe).toString(),
      expected.toString()
    );
    assert.equal(events[0].data.selectedCount, k);
  });

  it("refuses a create_study the agent did not sign", async () => {
    const n = 6;
    const k = 3;
    const unwilling = anchor.web3.Keypair.generate();
    const studyId = freshStudyId();
    const studyPda = deriveStudy(provider.wallet.publicKey, studyId);
    const qHash = sealDigest(n, k, SCALE_BITS, OFFSET_INT, makeCoefficients(n, 16));

    const ix = await createStudyIx(
      studyId,
      studyPda,
      n,
      k,
      qHash,
      unwilling.publicKey,
      "unconsented",
      OFFSET_INT
    );
    // The account meta is there and marked signer; what this test proves is that
    // the runtime rejects the transaction when that signature is missing, so a
    // pubkey cannot have studies opened in its name behind its back.
    const meta = ix.keys.find((key) => key.pubkey.equals(unwilling.publicKey));
    assert.isDefined(meta, "agent is not among the instruction's accounts");
    assert.isTrue(meta!.isSigner, "agent is not marked as a signer");

    const tx = new anchor.web3.Transaction().add(ix);
    tx.feePayer = provider.wallet.publicKey;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    const signed = await provider.wallet.signTransaction(tx);

    let caught: unknown = null;
    try {
      // `requireAllSignatures: false` is what gets the half-signed transaction
      // past the client; the cluster is the thing under test.
      await provider.connection.sendRawTransaction(
        signed.serialize({ requireAllSignatures: false, verifySignatures: false })
      );
    } catch (error) {
      caught = error;
    }
    assert.isNotNull(caught, "a create_study without the agent's signature was accepted");
    assert.match(String(caught), /signature/i, `unexpected failure: ${String(caught)}`);

    const info = await provider.connection.getAccountInfo(studyPda);
    assert.isNull(info, "the study account was created despite the missing signature");
  });

  it("rejects a cardinality beyond MAX_CARDINALITY", async () => {
    const n = 48;
    // k = 41 is a legal `1 <= k <= n`, so only the MAX_CARDINALITY rule can
    // reject it. The cap exists because reveal_allocation at k >= 46 exceeds the
    // 200,000 CU default, which would let a study be sealed and published into a
    // state no client could ever reveal.
    const tooLarge = MAX_CARDINALITY + 1;
    const coefficients = makeCoefficients(n, 17);
    await expectError(
      createStudy(n, tooLarge, coefficients, agent, "k too large"),
      "CardinalityTooLarge"
    );
    await expectError(createStudy(n, n, coefficients, agent, "k=n=48"), "CardinalityTooLarge");
  });

  it("rejects a penalty offset outside the i64 range", async () => {
    const n = 6;
    const k = 3;
    const coefficients = makeCoefficients(n, 18);
    await expectError(
      createStudy(n, k, coefficients, agent, "offset high", MAX_ABS_OFFSET + 1n),
      "OffsetOutOfRange"
    );
    await expectError(
      createStudy(n, k, coefficients, agent, "offset low", -MAX_ABS_OFFSET - 1n),
      "OffsetOutOfRange"
    );
    // The bound itself is allowed, and it survives the seal — the offset is
    // inside the q_hash preimage, so an accepted study is sealed against it.
    const study = await createStudy(n, k, coefficients, agent, "offset edge", MAX_ABS_OFFSET);
    await writeAll(study, coefficients);
    await seal(study);
    const onChain = await program.account.study.fetch(study.studyPda);
    assert.equal(onChain.sealed, 1);
    assert.equal(signedFromLeBytes(onChain.offsetIntLe).toString(), MAX_ABS_OFFSET.toString());
  });

  it("accepts k = MAX_CARDINALITY and reveals it inside the default compute budget", async () => {
    const n = 40;
    const k = MAX_CARDINALITY;
    const coefficients = makeCoefficients(n, 19);
    const study = await createStudy(n, k, coefficients, agent, "k=40");
    assert.equal(termCount(n), 820);
    await writeAll(study, coefficients);
    await seal(study);

    // Every asset selected: the largest scoring loop the program will ever run.
    const selected = Array.from({ length: k }, (_, i) => i);
    const bits = bitmap(n, selected);
    assert.equal(bits.length, 5);
    const salt = freshSalt();
    await publishFor(study, 0n, bits, salt);

    // Deliberately no ComputeBudget instruction here. MAX_CARDINALITY's whole
    // justification is that anything publishable is revealable on the default
    // 200,000 CU, and this is the test that holds that claim to account.
    await reveal(study, 0n, bits, salt);

    const allocation = await program.account.allocation.fetch(deriveAllocation(study.studyPda, 0n));
    const expected = scoreSelection(n, coefficients, selected);
    assert.equal(allocation.revealed, 1);
    assert.equal(signedFromLeBytes(allocation.objectiveIntLe).toString(), expected.toString());
    assert.equal(
      signedFromLeBytes(allocation.portfolioObjectiveIntLe).toString(),
      (expected + OFFSET_INT).toString()
    );
  });

  it("refuses to seal coefficients that do not match the committed hash", async () => {
    const n = 6;
    const committed = makeCoefficients(n, 2);
    const study = await createStudy(n, 3, committed, agent);

    const tampered = [...committed];
    tampered[4] += 1n; // one term, one bit
    await writeAll(study, tampered);

    await expectError(seal(study), "CoefficientHashMismatch");
    const onChain = await program.account.study.fetch(study.studyPda);
    assert.equal(onChain.sealed, 0);
  });

  it("rejects coefficients beyond the i32 quantization bound", async () => {
    const n = 6;
    const coefficients = makeCoefficients(n, 3);
    const study = await createStudy(n, 3, coefficients, agent);

    await expectError(writeChunk(study, 0, [I32_MAX + 1n]), "CoefficientOutOfRange");
    await expectError(writeChunk(study, 0, [-(I32_MAX + 1n)]), "CoefficientOutOfRange");
    // The bound itself is allowed.
    await writeChunk(study, 0, [I32_MAX]);
  });

  it("freezes coefficients once the study is sealed", async () => {
    const study = await createAndSeal(6, 3, agent, 4);
    await expectError(writeChunk(study, 0, [1n]), "StudySealed");
    await expectError(seal(study), "StudySealed");
  });

  it("refuses allocations against an unsealed study", async () => {
    const n = 6;
    const coefficients = makeCoefficients(n, 5);
    const study = await createStudy(n, 3, coefficients, agent);
    await writeAll(study, coefficients);

    const bits = bitmap(n, [0, 1, 2]);
    const salt = freshSalt();
    const commitment = commitmentDigest(
      programId,
      study.studyPda,
      0n,
      agent.publicKey,
      n,
      3,
      bits,
      salt
    );
    await expectError(publish(study, 0n, commitment, agent), "StudyNotSealed");
  });

  it("binds one agent: nobody else can publish", async () => {
    const study = await createAndSeal(6, 3, agent, 6);
    const imposter = anchor.web3.Keypair.generate();
    await fund(imposter.publicKey, 2);

    const bits = bitmap(6, [0, 1, 2]);
    const salt = freshSalt();
    const commitment = commitmentDigest(
      programId,
      study.studyPda,
      0n,
      imposter.publicKey,
      6,
      3,
      bits,
      salt
    );
    await expectError(publish(study, 0n, commitment, imposter), "UnauthorizedAgent");

    const onChain = await program.account.study.fetch(study.studyPda);
    assert.equal(onChain.publishedCount.toNumber(), 0);
  });

  it("requires strictly monotonic sequences with no gaps", async () => {
    const study = await createAndSeal(6, 3, agent, 7);
    const bits = bitmap(6, [0, 1, 2]);

    // published_count is 0, so sequence 1 is a gap and sequence 0 is required.
    const skipSalt = freshSalt();
    const skipCommitment = commitmentDigest(
      programId,
      study.studyPda,
      1n,
      agent.publicKey,
      6,
      3,
      bits,
      skipSalt
    );
    await expectError(publish(study, 1n, skipCommitment, agent), "SequenceOutOfOrder");

    await publishFor(study, 0n, bits, freshSalt());
    // Re-using a sequence cannot even reach the handler: the allocation PDA is
    // derived from the sequence and `init` refuses to allocate it twice. That is
    // a system-program failure, not an AnchorError, and it is the reason a
    // published commitment can never be quietly overwritten with a better one.
    const replaySalt = freshSalt();
    const replayCommitment = commitmentDigest(
      programId,
      study.studyPda,
      0n,
      agent.publicKey,
      6,
      3,
      bits,
      replaySalt
    );
    await expectFailureContaining(publish(study, 0n, replayCommitment, agent), "already in use");

    await publishFor(study, 1n, bitmap(6, [1, 2, 3]), freshSalt());
    const onChain = await program.account.study.fetch(study.studyPda);
    assert.equal(onChain.publishedCount.toNumber(), 2);
  });

  it("rejects an empty commitment", async () => {
    const study = await createAndSeal(6, 3, agent, 8);
    await expectError(publish(study, 0n, Buffer.alloc(32), agent), "EmptyCommitment");
  });

  it("rejects a reveal with the wrong salt or the wrong bits", async () => {
    const n = 6;
    const k = 3;
    const study = await createAndSeal(n, k, agent, 9);
    const bits = bitmap(n, [0, 1, 2]);
    const salt = freshSalt();
    await publishFor(study, 0n, bits, salt);

    const wrongSalt = freshSalt();
    await expectError(reveal(study, 0n, bits, wrongSalt), "CommitmentMismatch");

    const wrongBits = bitmap(n, [0, 1, 3]);
    await expectError(reveal(study, 0n, wrongBits, salt), "CommitmentMismatch");

    // The honest pair still works afterwards.
    await reveal(study, 0n, bits, salt);
    const allocation = await program.account.allocation.fetch(deriveAllocation(study.studyPda, 0n));
    assert.equal(allocation.revealed, 1);
  });

  it("rejects an all-zero salt", async () => {
    const n = 6;
    const k = 3;
    const study = await createAndSeal(n, k, agent, 10);
    const bits = bitmap(n, [0, 1, 2]);
    // Commit to the zero salt so EmptySalt, not CommitmentMismatch, is what fires.
    await publishFor(study, 0n, bits, ZERO_SALT);
    await expectError(reveal(study, 0n, bits, ZERO_SALT), "EmptySalt");
  });

  it("rejects a bitmap of the wrong length", async () => {
    const n = 12; // ceil(12/8) = 2 bytes
    const k = 3;
    const study = await createAndSeal(n, k, agent, 11);
    const overlongBits = rawBitmap(3, [0, 1, 2]);
    const salt = freshSalt();
    // Commit to the overlong bitmap so the length check, not the commitment
    // check, is what rejects it.
    await publishFor(study, 0n, overlongBits, salt);
    await expectError(reveal(study, 0n, overlongBits, salt), "BadBitmapLength");
  });

  it("rejects a bit set past the end of the universe", async () => {
    const n = 12; // 2 bytes of bitmap, bits 12..15 are padding and must stay 0
    const k = 3;
    const study = await createAndSeal(n, k, agent, 12);
    const bits = rawBitmap(2, [0, 1, 13]);
    const salt = freshSalt();
    await publishFor(study, 0n, bits, salt);
    await expectError(reveal(study, 0n, bits, salt), "BitOutsideUniverse");
  });

  it("rejects a selection that is not exactly k assets", async () => {
    const n = 12;
    const k = 3;
    const study = await createAndSeal(n, k, agent, 13);

    const tooFew = bitmap(n, [0, 1]);
    const saltFew = freshSalt();
    await publishFor(study, 0n, tooFew, saltFew);
    await expectError(reveal(study, 0n, tooFew, saltFew), "WrongCardinality");

    const tooMany = bitmap(n, [0, 1, 2, 3]);
    const saltMany = freshSalt();
    await publishFor(study, 1n, tooMany, saltMany);
    await expectError(reveal(study, 1n, tooMany, saltMany), "WrongCardinality");
  });

  it("refuses a second reveal of the same allocation", async () => {
    const n = 8;
    const k = 3;
    const study = await createAndSeal(n, k, agent, 14);
    const bits = bitmap(n, [2, 5, 7]);
    const salt = freshSalt();
    await publishFor(study, 0n, bits, salt);

    await reveal(study, 0n, bits, salt);
    await expectError(reveal(study, 0n, bits, salt), "AlreadyRevealed");

    const onChain = await program.account.study.fetch(study.studyPda);
    assert.equal(onChain.publishedCount.toNumber(), 1);
    assert.equal(onChain.revealedCount.toNumber(), 1);
  });

  it("leaves the published/revealed gap visible when a commitment is never opened", async () => {
    const n = 8;
    const k = 3;
    const study = await createAndSeal(n, k, agent, 15);

    const revealedBits = bitmap(n, [0, 1, 2]);
    const revealedSalt = freshSalt();
    await publishFor(study, 0n, revealedBits, revealedSalt);
    await publishFor(study, 1n, bitmap(n, [3, 4, 5]), freshSalt());
    await reveal(study, 0n, revealedBits, revealedSalt);

    const onChain = await program.account.study.fetch(study.studyPda);
    assert.equal(onChain.publishedCount.toNumber(), 2);
    assert.equal(onChain.revealedCount.toNumber(), 1);
    // Nothing on-chain can force the second reveal. The program's claim is only
    // that the gap is countable, and here it counts 1.
  });
});
