/**
 * Devnet bridge for the separatrix program.
 *
 *   ts-node scripts/devnet-separatrix.ts <command> [args]
 *
 *   create <qubo-export.json>   create_study + chunked write_coefficients + seal_study
 *   publish <study-id>          commit to an allocation (fresh CSPRNG salt, kept local)
 *   reveal  <study-id>          reveal it and print the objective the CHAIN computed
 *   status  [study-id]          decode the Study (and its Allocations)
 *   smoke                       solve -> seal -> publish -> reveal -> assert equality
 *   measure                     land real transactions and report their compute units
 *
 * Every preimage in this file is a third implementation of what
 * programs/separatrix/src/lib.rs computes on-chain and what the solver CLI's
 * `--emit-qubo` exporter computes off-chain. tests/test_onchain_vectors.py pins
 * the same bytes in Python; if any of the three drift, a study can never be
 * sealed and an allocation can never be revealed.
 *
 * Salts are secrets until the reveal lands: they are written under
 * secrets/separatrix/ (gitignored) and are never printed before reveal.
 */
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = "CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp";

/** Must match QUBO_DOMAIN in programs/separatrix/src/lib.rs. */
const QUBO_DOMAIN = Buffer.from("separatrix:qubo:v1", "utf8");
/** Must match COMMITMENT_DOMAIN in programs/separatrix/src/lib.rs. */
const COMMITMENT_DOMAIN = Buffer.from("separatrix:allocation:v1", "utf8");
/** Must match MAX_CHUNK / MAX_ASSETS / MAX_ABS_COEFFICIENT in the program. */
const MAX_CHUNK = 96;
const MAX_ASSETS = 48;
const MAX_ABS_COEFFICIENT = 2147483647n;
/** Must match MAX_CARDINALITY in the program: anything publishable is revealable. */
const MAX_CARDINALITY = 40;
/** Must match MAX_ABS_OFFSET in the program (i64::MAX as i128). */
const MAX_ABS_OFFSET = 9223372036854775807n;

const STATE_DIR = path.resolve("secrets", "separatrix");
const STATE_PATH = path.join(STATE_DIR, "studies.json");

type Command = "create" | "publish" | "reveal" | "status" | "smoke" | "measure";

const COMMANDS: Command[] = ["create", "publish", "reveal", "status", "smoke", "measure"];

// ---------------------------------------------------------------------------
// Byte-level primitives. These are the load-bearing part of the file.
// ---------------------------------------------------------------------------

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function u32le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function i64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value, 0);
  return buf;
}

/** Two's-complement little-endian encoding of a signed integer. */
function signedToLeBytes(value: bigint, byteLength: number): Buffer {
  const bits = BigInt(byteLength) * 8n;
  const limit = 1n << (bits - 1n);
  if (value < -limit || value >= limit) {
    throw new Error(`value ${value} does not fit in i${bits}`);
  }
  let raw = value < 0n ? (1n << bits) + value : value;
  const out = Buffer.alloc(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    out[i] = Number(raw & 0xffn);
    raw >>= 8n;
  }
  return out;
}

/** Inverse of signedToLeBytes — used to read i128 fields back off the chain. */
function signedFromLeBytes(bytes: ArrayLike<number>): bigint {
  let raw = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    raw = (raw << 8n) | BigInt(bytes[i] & 0xff);
  }
  const bits = BigInt(bytes.length) * 8n;
  return raw >= 1n << (bits - 1n) ? raw - (1n << bits) : raw;
}

function f64ToBits(value: number): bigint {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value, 0);
  return buf.readBigUInt64LE(0);
}

function bitsToF64(bits: bigint): number {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(bits, 0);
  return buf.readDoubleLE(0);
}

/**
 * seal_study's preimage:
 *   b"separatrix:qubo:v1" || [n, k] || scale_bits(le u64)
 *     || offset_int(le i128) || coefficients(le i64 each)
 */
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

/**
 * reveal_allocation's commitment preimage:
 *   b"separatrix:allocation:v1" || program_id || study || sequence(le u64)
 *     || agent || [n, k] || bits_len(le u32) || bits || salt
 *
 * Every field but `bits` and `salt` is read from account state on-chain, which
 * is what stops a commitment lifted out of somebody else's transaction from
 * being revealable here.
 */
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

/** Row-major upper triangle with the diagonal included, i <= j. */
function triangularIndex(n: number, i: number, j: number): number {
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  return lo * n - (lo * Math.max(lo - 1, 0)) / 2 + (hi - lo);
}

function termCount(n: number): number {
  return (n * (n + 1)) / 2;
}

function bitmapLen(n: number): number {
  return Math.ceil(n / 8);
}

/** LSB-first within each byte: asset i is bit (i % 8) of byte (i / 8). */
function bitmap(n: number, selected: number[]): Buffer {
  const out = Buffer.alloc(bitmapLen(n));
  for (const index of selected) {
    if (index < 0 || index >= n) {
      throw new Error(`selected index ${index} is outside the ${n}-asset universe`);
    }
    out[index >> 3] |= 1 << (index & 7);
  }
  return out;
}

/** Replays the program's O(k^2) scoring loop off-chain. */
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

/**
 * Compute-unit limit to request for a reveal transaction.
 *
 * The program's cost model — `~7441 + 179 * k(k+1)/2` CU, fitted to the landed
 * devnet transactions tabulated in docs/onchain.md §5 — is a fit, not a bound:
 * the measured `k = 24` reveal consumed 61,454 CU against a modelled 61,141. So
 * the request below is the model plus 30% plus a flat 2,000 CU, the latter also
 * covering the 150 CU the `ComputeBudget` instruction itself spends. At the
 * program's `MAX_CARDINALITY = 40` that is ~202k, far inside the 1.4M per-
 * transaction ceiling.
 *
 * This is belt-and-braces, not a fix: a single-instruction transaction already
 * gets Solana's 200,000 default, and `MAX_CARDINALITY` exists precisely so that
 * anything publishable fits inside it. Setting the limit explicitly means a
 * reveal never depends on that default, nor on the CU model staying exactly
 * where it was measured.
 */
function revealComputeUnitLimit(k: number): number {
  const terms = (k * (k + 1)) / 2;
  const modelled = 7441 + 179 * terms;
  return Math.min(1_400_000, Math.ceil(modelled * 1.3) + 2000);
}

function padToBytes(text: string, length: number): number[] {
  const raw = Buffer.from(text, "utf8");
  if (raw.length > length) {
    throw new Error(`"${text}" does not fit in ${length} bytes`);
  }
  return Array.from(Buffer.concat([raw, Buffer.alloc(length - raw.length)]));
}

function bytesToLabel(values: number[]): string {
  return Buffer.from(values).toString("utf8").replace(/\0+$/, "");
}

// ---------------------------------------------------------------------------
// Environment, keys, provider
// ---------------------------------------------------------------------------

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The public devnet RPC answers 429 well before a study finishes uploading, and
 * a half-uploaded study leaves a rent-paying account behind. Pace every landed
 * transaction instead of relying on the client's retry storm.
 */
const PACE_MS = Number(env("SEPARATRIX_PACE_MS", "900"));

function loadKeypair(keypairPath: string): anchor.web3.Keypair {
  const resolved = path.resolve(keypairPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing keypair: ${resolved}`);
  }
  const secret = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(secret)) {
    throw new Error(`Keypair file is not a JSON array: ${resolved}`);
  }
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secret));
}

function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function explorerAddress(address: anchor.web3.PublicKey): string {
  return `https://explorer.solana.com/address/${address.toBase58()}?cluster=devnet`;
}

interface Context {
  owner: anchor.web3.Keypair;
  agent: anchor.web3.Keypair;
  program: any;
  connection: anchor.web3.Connection;
  programId: anchor.web3.PublicKey;
  rpcUrl: string;
}

function createWallet(signer: anchor.web3.Keypair): any {
  return {
    publicKey: signer.publicKey,
    signTransaction: async <T extends anchor.web3.Transaction>(tx: T): Promise<T> => {
      tx.partialSign(signer);
      return tx;
    },
    signAllTransactions: async <T extends anchor.web3.Transaction>(txs: T[]): Promise<T[]> => {
      txs.forEach((tx) => tx.partialSign(signer));
      return txs;
    }
  };
}

async function buildContext(): Promise<Context> {
  const rpcUrl = env("SOLANA_RPC_URL", DEVNET_RPC_URL);
  const owner = loadKeypair(env("OWNER_WALLET_PATH", "keys/owner-devnet.json"));
  const agent = loadKeypair(env("AGENT_WALLET_PATH", "keys/agent-devnet.json"));

  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, createWallet(owner), {
    commitment: "confirmed",
    preflightCommitment: "confirmed"
  });
  anchor.setProvider(provider);

  const idlPath = ["idl/separatrix.json", "target/idl/separatrix_program.json"]
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => fs.existsSync(candidate));
  if (!idlPath) {
    throw new Error("Missing IDL: expected idl/separatrix.json (npm run gen:idl:separatrix).");
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, provider) as any;

  const expected = env("SEPARATRIX_PROGRAM_ID", PROGRAM_ID);
  if (program.programId.toBase58() !== expected) {
    throw new Error(
      `Program id mismatch: IDL says ${program.programId.toBase58()}, expected ${expected}`
    );
  }

  return { owner, agent, program, connection, programId: program.programId, rpcUrl };
}

function deriveStudy(
  programId: anchor.web3.PublicKey,
  authority: anchor.web3.PublicKey,
  studyId: bigint
): anchor.web3.PublicKey {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("study", "utf8"), authority.toBuffer(), u64le(studyId)],
    programId
  )[0];
}

function deriveAllocation(
  programId: anchor.web3.PublicKey,
  study: anchor.web3.PublicKey,
  sequence: bigint
): anchor.web3.PublicKey {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("alloc", "utf8"), study.toBuffer(), u64le(sequence)],
    programId
  )[0];
}

// ---------------------------------------------------------------------------
// Local state: study metadata and, crucially, the un-revealed salts.
// ---------------------------------------------------------------------------

interface AllocationRecord {
  sequence: number;
  indices: number[];
  bitsHex: string;
  saltHex: string;
  commitmentHex: string;
  method: string;
  expectedObjectiveInt: string;
  publishSignature: string | null;
  revealSignature: string | null;
  revealed: boolean;
}

interface StudyRecord {
  studyId: string;
  authority: string;
  agent: string;
  studyPda: string;
  n: number;
  k: number;
  scaleBits: string;
  offsetInt: string;
  qHash: string;
  label: string;
  source: string | null;
  coefficients: string[];
  solverObjectiveInt: string | null;
  solverPortfolioObjectiveInt: string | null;
  solverIndices: number[] | null;
  createdAt: string;
  sealSignature: string | null;
  allocations: Record<string, AllocationRecord>;
}

type StateFile = Record<string, StudyRecord>;

function loadState(): StateFile {
  if (!fs.existsSync(STATE_PATH)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as StateFile;
}

function saveState(state: StateFile): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function stateKey(authority: anchor.web3.PublicKey, studyId: bigint): string {
  return `${authority.toBase58()}:${studyId.toString()}`;
}

function requireRecord(state: StateFile, key: string): StudyRecord {
  const record = state[key];
  if (!record) {
    throw new Error(
      `No local record for ${key}. Run \`create\` first, or pass the study id used then.`
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Solver CLI
// ---------------------------------------------------------------------------

function solverCliPath(): string {
  const override = process.env.SEPARATRIX_CLI;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  const candidates = [
    "separatrix/target/release/separatrix-cli.exe",
    "separatrix/target/release/separatrix-cli"
  ].map((candidate) => path.resolve(candidate));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      "separatrix-cli not built. Run `cargo build --release -p separatrix-cli` in separatrix/."
    );
  }
  return found;
}

interface QuboExport {
  n: number;
  k: number;
  scaleBits: bigint;
  offsetInt: bigint;
  coefficients: bigint[];
  qHash: string;
  exactIndices: number[] | null;
  exactObjectiveInt: bigint | null;
  exactPortfolioObjectiveInt: bigint | null;
  bestIndices: number[] | null;
  raw: string;
}

/**
 * Parse a solver-CLI response.
 *
 * `scale_bits` is a u64 that routinely exceeds 2^53, so JSON.parse would
 * silently round it. It is read out of the raw text instead, and cross-checked
 * against f64::to_bits of the `scale` field.
 */
function parseQuboExport(raw: string): QuboExport {
  const parsed = JSON.parse(raw);
  const qubo = parsed.qubo;
  if (!qubo) {
    throw new Error('solver response has no "qubo" object — set "emit_qubo": true in the request');
  }

  const match = /"scale_bits"\s*:\s*(\d+)/.exec(raw);
  if (!match) {
    throw new Error("solver response has no scale_bits");
  }
  const scaleBits = BigInt(match[1]);
  const fromScale = f64ToBits(qubo.scale);
  if (scaleBits !== fromScale) {
    throw new Error(`scale_bits ${scaleBits} disagrees with f64::to_bits(scale) ${fromScale}`);
  }

  const n: number = qubo.n;
  const k: number = parsed.k;
  const coefficients: bigint[] = qubo.coefficients.map((v: number) => BigInt(v));
  if (coefficients.length !== termCount(n)) {
    throw new Error(`expected ${termCount(n)} coefficients, got ${coefficients.length}`);
  }
  if (qubo.term_count !== termCount(n)) {
    throw new Error(`exporter term_count ${qubo.term_count} != n(n+1)/2 ${termCount(n)}`);
  }
  for (const value of coefficients) {
    if (value > MAX_ABS_COEFFICIENT || value < -MAX_ABS_COEFFICIENT) {
      throw new Error(`coefficient ${value} exceeds the program's i32 quantization bound`);
    }
  }

  const offsetInt = BigInt(qubo.offset_int);
  if (BigInt(parsed.objective_offset_int) !== offsetInt) {
    throw new Error("objective_offset_int and qubo.offset_int disagree");
  }

  const exact = parsed.exact && parsed.exact.bits ? parsed.exact : null;
  const exactIndices: number[] | null = exact
    ? exact.bits
        .map((bit: number, index: number) => (bit ? index : -1))
        .filter((index: number) => index >= 0)
    : null;

  let bestIndices: number[] | null = exactIndices;
  if (!bestIndices && Array.isArray(parsed.results) && parsed.results.length > 0) {
    const first = parsed.results[0];
    bestIndices = first.bits
      .map((bit: number, index: number) => (bit ? index : -1))
      .filter((index: number) => index >= 0);
  }

  return {
    n,
    k,
    scaleBits,
    offsetInt,
    coefficients,
    qHash: qubo.q_hash,
    exactIndices,
    exactObjectiveInt: exact ? BigInt(exact.objective_int) : null,
    exactPortfolioObjectiveInt: exact ? BigInt(exact.portfolio_objective_int) : null,
    bestIndices,
    raw
  };
}

function runSolver(request: object): string {
  return execFileSync(solverCliPath(), {
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024
  })
    .trim()
    .split(/\r?\n/)
    .slice(-1)[0];
}

/** A deterministic, well-conditioned covariance/return pair for demo studies. */
function syntheticRequest(n: number, k: number, seed: number, solvers: string[]): object {
  const mu: number[] = [];
  for (let i = 0; i < n; i += 1) {
    mu.push(0.0005 * (((i * 7 + seed) % 11) - 5));
  }
  const sigma: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < n; j += 1) {
      if (i === j) {
        row.push(0.0025 + 0.0001 * ((i + seed) % 5));
      } else {
        const lo = Math.min(i, j);
        const hi = Math.max(i, j);
        row.push(0.0003 * ((((lo * 13 + hi * 7 + seed) % 5) - 2) / 2));
      }
    }
    sigma.push(row);
  }
  return { mu, sigma, risk_aversion: 0.5, k, solvers, seed, emit_qubo: true };
}

// ---------------------------------------------------------------------------
// Compute units, read straight out of the landed transaction's logs.
// ---------------------------------------------------------------------------

interface CuSample {
  instruction: string;
  params: string;
  computeUnits: number;
  signature: string;
}

const cuSamples: CuSample[] = [];
const CU_PATH = path.join(STATE_DIR, "cu-samples.json");

/**
 * Append this run's measurements to the on-disk log. Every command does this,
 * so a hand-driven create/publish/reveal contributes to the table in
 * docs/onchain.md exactly as `measure` does.
 */
function flushComputeUnits(): void {
  if (cuSamples.length === 0) return;
  const existing: CuSample[] = fs.existsSync(CU_PATH)
    ? (JSON.parse(fs.readFileSync(CU_PATH, "utf8")) as CuSample[])
    : [];
  const bySignature = new Map<string, CuSample>();
  for (const sample of [...existing, ...cuSamples]) {
    bySignature.set(`${sample.instruction}:${sample.signature}`, sample);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CU_PATH, `${JSON.stringify(Array.from(bySignature.values()), null, 2)}\n`);
}

async function recordComputeUnits(
  ctx: Context,
  instruction: string,
  params: string,
  signature: string
): Promise<number | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const tx = await ctx.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });
    const logs = tx?.meta?.logMessages;
    if (logs) {
      const pattern = new RegExp(
        `Program ${ctx.programId.toBase58()} consumed (\\d+) of (\\d+) compute units`
      );
      for (const line of logs) {
        const match = pattern.exec(line);
        if (match) {
          const consumed = Number(match[1]);
          cuSamples.push({ instruction, params, computeUnits: consumed, signature });
          return consumed;
        }
      }
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return null;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

interface CreateOptions {
  studyId: bigint;
  label: string;
  source: string | null;
}

async function createStudyFromExport(
  ctx: Context,
  exportData: QuboExport,
  options: CreateOptions
): Promise<StudyRecord> {
  const { n, k, scaleBits, offsetInt, coefficients } = exportData;
  if (n > MAX_ASSETS) {
    throw new Error(`n=${n} exceeds the program's MAX_ASSETS=${MAX_ASSETS}`);
  }
  if (k < 1 || k > n) {
    throw new Error(`k=${k} must satisfy 1 <= k <= n`);
  }
  // The program rejects these too (CardinalityTooLarge / OffsetOutOfRange).
  // Failing here costs nothing; failing on-chain costs a transaction.
  if (k > MAX_CARDINALITY) {
    throw new Error(
      `k=${k} exceeds the program's MAX_CARDINALITY=${MAX_CARDINALITY}; a larger k ` +
        "could not be revealed inside the default 200,000 CU budget"
    );
  }
  if (offsetInt < -MAX_ABS_OFFSET || offsetInt > MAX_ABS_OFFSET) {
    throw new Error(
      `offset_int=${offsetInt} exceeds the program's MAX_ABS_OFFSET=${MAX_ABS_OFFSET}`
    );
  }

  // Third implementation of the seal preimage. If this disagrees with the
  // exporter, seal_study would reject the study on-chain — say so here instead.
  const digest = sealDigest(n, k, scaleBits, offsetInt, coefficients);
  const digestHex = digest.toString("hex");
  if (digestHex !== exportData.qHash) {
    throw new Error(
      `seal digest mismatch:\n  this client: ${digestHex}\n  solver CLI:  ${exportData.qHash}`
    );
  }
  console.log(`q_hash agrees with the solver CLI: ${digestHex}`);

  const studyPda = deriveStudy(ctx.programId, ctx.owner.publicKey, options.studyId);
  console.log(`Study PDA: ${studyPda.toBase58()}`);
  console.log(`n=${n} k=${k} terms=${termCount(n)} label="${options.label}"`);

  const existing = await ctx.connection.getAccountInfo(studyPda, "confirmed");
  if (!existing) {
    const signature = await ctx.program.methods
      .createStudy(
        new anchor.BN(options.studyId.toString()),
        n,
        k,
        new anchor.BN(scaleBits.toString()),
        Array.from(signedToLeBytes(offsetInt, 16)),
        Array.from(digest),
        padToBytes(options.label, 32)
      )
      .accountsPartial({
        authority: ctx.owner.publicKey,
        agent: ctx.agent.publicKey,
        study: studyPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      // The agent signs its own attribution. `Study.agent` is memcmp-indexable,
      // so without this anyone could open studies naming someone else's pubkey.
      .signers([ctx.agent])
      .rpc();
    await sleep(PACE_MS);
    console.log(`create_study: ${signature}`);
    console.log(`  ${explorerTx(signature)}`);
    await recordComputeUnits(ctx, "create_study", `n=${n} k=${k}`, signature);
  } else {
    console.log("create_study: study account already exists, skipping");
  }

  let study = await ctx.program.account.study.fetch(studyPda);
  let sealSignature: string | null = null;
  if (study.sealed === 0) {
    const total = termCount(n);
    const chunks = Math.ceil(total / MAX_CHUNK);
    console.log(`write_coefficients: ${total} terms in ${chunks} chunk(s) of <= ${MAX_CHUNK}`);
    for (let start = 0; start < total; start += MAX_CHUNK) {
      const values = coefficients.slice(start, Math.min(start + MAX_CHUNK, total));
      const signature = await ctx.program.methods
        .writeCoefficients(
          start,
          values.map((v) => new anchor.BN(v.toString()))
        )
        .accountsPartial({ authority: ctx.owner.publicKey, study: studyPda })
        .rpc();
      await sleep(PACE_MS);
      console.log(`  [${start}..${start + values.length}) ${signature}`);
      if (start === 0) {
        await recordComputeUnits(
          ctx,
          "write_coefficients",
          `values=${values.length}`,
          signature
        );
      }
    }

    const landed: string = await ctx.program.methods
      .sealStudy()
      .accountsPartial({ authority: ctx.owner.publicKey, study: studyPda })
      .rpc();
    sealSignature = landed;
    await sleep(PACE_MS);
    console.log(`seal_study: ${landed}`);
    console.log(`  ${explorerTx(landed)}`);
    await recordComputeUnits(ctx, "seal_study", `n=${n} terms=${termCount(n)}`, landed);
    study = await ctx.program.account.study.fetch(studyPda);
    if (study.sealed !== 1) {
      throw new Error("seal_study landed but the study is not sealed");
    }
  } else {
    console.log("Study is already sealed; nothing to write.");
  }

  // The sealed q_hash on-chain is the real check that this export is the
  // problem this study froze — not the local bookkeeping.
  const onChainHash = Buffer.from(study.qHash).toString("hex");
  if (onChainHash !== digestHex) {
    throw new Error(
      `study ${options.studyId} is sealed against ${onChainHash}, not this export's ${digestHex}`
    );
  }

  const state = loadState();
  const key = stateKey(ctx.owner.publicKey, options.studyId);
  const previous = state[key];
  const record: StudyRecord = {
    studyId: options.studyId.toString(),
    authority: ctx.owner.publicKey.toBase58(),
    agent: ctx.agent.publicKey.toBase58(),
    studyPda: studyPda.toBase58(),
    n,
    k,
    scaleBits: scaleBits.toString(),
    offsetInt: offsetInt.toString(),
    qHash: digestHex,
    label: options.label,
    source: options.source,
    coefficients: coefficients.map((v) => v.toString()),
    solverObjectiveInt: exportData.exactObjectiveInt
      ? exportData.exactObjectiveInt.toString()
      : null,
    solverPortfolioObjectiveInt: exportData.exactPortfolioObjectiveInt
      ? exportData.exactPortfolioObjectiveInt.toString()
      : null,
    solverIndices: exportData.bestIndices,
    createdAt: previous ? previous.createdAt : new Date().toISOString(),
    sealSignature: sealSignature ?? (previous ? previous.sealSignature : null),
    allocations: previous ? previous.allocations : {}
  };
  state[key] = record;
  saveState(state);
  console.log(`Sealed. Study id ${options.studyId} recorded in ${STATE_PATH}`);
  return record;
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

async function publishAllocation(
  ctx: Context,
  studyId: bigint,
  indicesArg: number[] | null,
  method: string
): Promise<AllocationRecord> {
  const state = loadState();
  const key = stateKey(ctx.owner.publicKey, studyId);
  const record = requireRecord(state, key);
  const studyPda = new anchor.web3.PublicKey(record.studyPda);
  const study = await ctx.program.account.study.fetch(studyPda);

  if (study.sealed !== 1) {
    throw new Error("study is not sealed; publish_allocation would fail with StudyNotSealed");
  }
  if (study.agent.toBase58() !== ctx.agent.publicKey.toBase58()) {
    throw new Error(
      `this study is bound to agent ${study.agent.toBase58()}, not ${ctx.agent.publicKey.toBase58()}`
    );
  }

  const indices = indicesArg ?? record.solverIndices;
  if (!indices || indices.length === 0) {
    throw new Error("no selection: pass --indices 0,3,7 or create the study from a solver export");
  }
  if (indices.length !== record.k) {
    throw new Error(`selection has ${indices.length} assets but the study fixes k=${record.k}`);
  }
  const unique = new Set(indices);
  if (unique.size !== indices.length) {
    throw new Error("selection contains a duplicate index");
  }

  // The program requires `sequence == study.published_count`, strictly.
  const sequence = BigInt(study.publishedCount.toString());
  const allocationPda = deriveAllocation(ctx.programId, studyPda, sequence);

  const bits = bitmap(record.n, indices);
  const salt = crypto.randomBytes(32); // CSPRNG; kept local until reveal
  if (salt.every((byte) => byte === 0)) {
    throw new Error("CSPRNG produced an all-zero salt; the program rejects it (EmptySalt)");
  }
  const commitment = commitmentDigest(
    ctx.programId,
    studyPda,
    sequence,
    ctx.agent.publicKey,
    record.n,
    record.k,
    bits,
    salt
  );

  const coefficients = record.coefficients.map((v) => BigInt(v));
  const expectedObjective = scoreSelection(record.n, coefficients, indices);

  const signature = await ctx.program.methods
    .publishAllocation(
      new anchor.BN(sequence.toString()),
      Array.from(commitment),
      padToBytes(method, 16)
    )
    .accountsPartial({
      agent: ctx.agent.publicKey,
      study: studyPda,
      allocation: allocationPda,
      systemProgram: anchor.web3.SystemProgram.programId
    })
    .signers([ctx.agent])
    .rpc();
  await sleep(PACE_MS);

  const allocationRecord: AllocationRecord = {
    sequence: Number(sequence),
    indices,
    bitsHex: bits.toString("hex"),
    saltHex: salt.toString("hex"),
    commitmentHex: commitment.toString("hex"),
    method,
    expectedObjectiveInt: expectedObjective.toString(),
    publishSignature: signature,
    revealSignature: null,
    revealed: false
  };
  record.allocations[sequence.toString()] = allocationRecord;
  state[key] = record;
  saveState(state);

  await recordComputeUnits(ctx, "publish_allocation", `k=${record.k}`, signature);

  console.log(`publish_allocation: ${signature}`);
  console.log(`  ${explorerTx(signature)}`);
  console.log(`  study:      ${studyPda.toBase58()}`);
  console.log(`  allocation: ${allocationPda.toBase58()}`);
  console.log(`  sequence:   ${sequence}`);
  console.log(`  commitment: ${commitment.toString("hex")}`);
  console.log(`  method:     ${method}`);
  console.log(`  salt:       WITHHELD until reveal (32 bytes, stored in ${STATE_PATH})`);
  console.log("  The chain now holds a binding commitment; the selection is still secret.");
  return allocationRecord;
}

// ---------------------------------------------------------------------------
// reveal
// ---------------------------------------------------------------------------

interface RevealResult {
  objectiveInt: bigint;
  portfolioObjectiveInt: bigint;
  signature: string;
}

async function revealAllocation(
  ctx: Context,
  studyId: bigint,
  sequenceArg: bigint | null
): Promise<RevealResult> {
  const state = loadState();
  const key = stateKey(ctx.owner.publicKey, studyId);
  const record = requireRecord(state, key);
  const studyPda = new anchor.web3.PublicKey(record.studyPda);

  const pending = Object.values(record.allocations)
    .filter((a) => !a.revealed)
    .sort((a, b) => a.sequence - b.sequence);
  const sequence =
    sequenceArg !== null
      ? Number(sequenceArg)
      : pending.length > 0
        ? pending[0].sequence
        : -1;
  if (sequence < 0) {
    throw new Error("no unrevealed allocation recorded for this study");
  }
  const allocationRecord = record.allocations[String(sequence)];
  if (!allocationRecord) {
    throw new Error(`no local salt for sequence ${sequence}; it cannot be revealed`);
  }

  const allocationPda = deriveAllocation(ctx.programId, studyPda, BigInt(sequence));
  const bits = Buffer.from(allocationRecord.bitsHex, "hex");
  const salt = Buffer.from(allocationRecord.saltHex, "hex");

  const computeUnitLimit = revealComputeUnitLimit(record.k);
  const signature = await ctx.program.methods
    .revealAllocation(bits, Array.from(salt))
    .accountsPartial({ study: studyPda, allocation: allocationPda })
    .preInstructions([
      anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit })
    ])
    .rpc();
  await sleep(PACE_MS);
  await recordComputeUnits(ctx, "reveal_allocation", `n=${record.n} k=${record.k}`, signature);

  const allocation = await ctx.program.account.allocation.fetch(allocationPda);
  const objectiveInt = signedFromLeBytes(allocation.objectiveIntLe);
  const portfolioObjectiveInt = signedFromLeBytes(allocation.portfolioObjectiveIntLe);
  const scale = bitsToF64(BigInt(record.scaleBits));

  allocationRecord.revealed = true;
  allocationRecord.revealSignature = signature;
  state[key] = record;
  saveState(state);

  console.log(`reveal_allocation: ${signature}`);
  console.log(`  ${explorerTx(signature)}`);
  console.log(`  allocation: ${allocationPda.toBase58()}`);
  console.log(`  selection:  [${allocationRecord.indices.join(", ")}]`);
  console.log(`  bits:       ${allocationRecord.bitsHex} (LSB-first, ${bits.length} bytes)`);
  console.log(`  cu limit:   ${computeUnitLimit} requested for k=${record.k}`);
  console.log(`  salt:       ${allocationRecord.saltHex} (public now that the reveal landed)`);
  console.log("");
  console.log("  Objective computed ON-CHAIN from the sealed matrix:");
  console.log(`    objective_int            = ${objectiveInt}`);
  console.log(`    portfolio_objective_int  = ${portfolioObjectiveInt}`);
  console.log(`    scale                    = ${scale}`);
  console.log(`    portfolio objective / scale = ${Number(portfolioObjectiveInt) / scale}`);

  if (objectiveInt.toString() !== allocationRecord.expectedObjectiveInt) {
    throw new Error(
      `on-chain objective ${objectiveInt} != locally replayed ${allocationRecord.expectedObjectiveInt}`
    );
  }
  console.log("  matches the local replay of the same O(k^2) sum.");

  return { objectiveInt, portfolioObjectiveInt, signature };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function printStatus(ctx: Context, studyId: bigint | null): Promise<void> {
  console.log(`RPC:     ${ctx.rpcUrl}`);
  console.log(`Program: ${ctx.programId.toBase58()}`);
  console.log(`  ${explorerAddress(ctx.programId)}`);
  console.log(`Authority (owner): ${ctx.owner.publicKey.toBase58()}`);
  console.log(`Agent:             ${ctx.agent.publicKey.toBase58()}`);

  const state = loadState();
  const ids =
    studyId !== null
      ? [studyId]
      : Object.values(state)
          .filter((r) => r.authority === ctx.owner.publicKey.toBase58())
          .map((r) => BigInt(r.studyId))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (ids.length === 0) {
    console.log("\nNo studies recorded locally. Run `create` or `smoke`.");
    return;
  }

  for (const id of ids) {
    const studyPda = deriveStudy(ctx.programId, ctx.owner.publicKey, id);
    console.log(`\n=== study ${id} ===`);
    console.log(`PDA: ${studyPda.toBase58()}`);
    console.log(`  ${explorerAddress(studyPda)}`);
    const info = await ctx.connection.getAccountInfo(studyPda, "confirmed");
    if (!info) {
      console.log("  not on chain");
      continue;
    }
    const study = await ctx.program.account.study.fetch(studyPda);
    const scale = bitsToF64(BigInt(study.scaleBits.toString()));
    const publishedCount = Number(study.publishedCount.toString());
    const revealedCount = Number(study.revealedCount.toString());
    console.log(`  account size:    ${info.data.length} bytes`);
    console.log(`  lamports:        ${info.lamports} (${info.lamports / 1e9} SOL rent)`);
    console.log(`  authority:       ${study.authority.toBase58()}`);
    console.log(`  agent:           ${study.agent.toBase58()}`);
    console.log(`  label:           "${bytesToLabel(study.label)}"`);
    console.log(`  n / k:           ${study.n} / ${study.k}`);
    console.log(`  term_count:      ${study.termCount}`);
    console.log(`  sealed:          ${study.sealed === 1}`);
    console.log(`  q_hash:          ${Buffer.from(study.qHash).toString("hex")}`);
    console.log(`  scale_bits:      ${study.scaleBits.toString()} (scale ${scale})`);
    console.log(`  offset_int:      ${signedFromLeBytes(study.offsetIntLe)}`);
    console.log(`  created_at:      ${new Date(Number(study.createdAt) * 1000).toISOString()}`);
    console.log(`  published_count: ${publishedCount}`);
    console.log(`  revealed_count:  ${revealedCount}`);
    console.log(
      `  unrevealed:      ${publishedCount - revealedCount}` +
        `  <- the honest reading of the record is both numbers, not one`
    );

    for (let sequence = 0; sequence < publishedCount; sequence += 1) {
      const allocationPda = deriveAllocation(ctx.programId, studyPda, BigInt(sequence));
      const allocationInfo = await ctx.connection.getAccountInfo(allocationPda, "confirmed");
      if (!allocationInfo) {
        console.log(`  allocation #${sequence}: missing at ${allocationPda.toBase58()}`);
        continue;
      }
      const allocation = await ctx.program.account.allocation.fetch(allocationPda);
      const revealed = allocation.revealed === 1;
      console.log(`  allocation #${sequence}: ${allocationPda.toBase58()}`);
      console.log(`    size:       ${allocationInfo.data.length} bytes`);
      console.log(`    agent:      ${allocation.agent.toBase58()}`);
      console.log(`    method:     "${bytesToLabel(allocation.method)}"`);
      console.log(`    commitment: ${Buffer.from(allocation.commitment).toString("hex")}`);
      console.log(
        `    published:  slot ${allocation.publishedSlot.toString()} / ` +
          `${new Date(Number(allocation.publishedAt) * 1000).toISOString()}`
      );
      console.log(`    revealed:   ${revealed}`);
      if (revealed) {
        console.log(`    objective_int:           ${signedFromLeBytes(allocation.objectiveIntLe)}`);
        console.log(
          `    portfolio_objective_int: ${signedFromLeBytes(allocation.portfolioObjectiveIntLe)}`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// smoke
// ---------------------------------------------------------------------------

function banner(lines: string[]): void {
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  console.log("");
  console.log("#".repeat(width));
  for (const line of lines) {
    console.log(`# ${line}${" ".repeat(width - line.length - 3)}#`);
  }
  console.log("#".repeat(width));
  console.log("");
}

async function runSmoke(ctx: Context, n: number, k: number, seed: number): Promise<void> {
  console.log(`1. Solving a ${n}-asset / choose-${k} study with the separatrix CLI (exact)...`);
  const raw = runSolver(syntheticRequest(n, k, seed, ["exact"]));
  const exportData = parseQuboExport(raw);
  if (!exportData.exactIndices || exportData.exactObjectiveInt === null) {
    throw new Error("solver did not return an exact solution; lower n or raise max_exact_subsets");
  }
  if (exportData.exactIndices.length !== k) {
    throw new Error(`exact solution has ${exportData.exactIndices.length} assets, expected ${k}`);
  }
  console.log(`   exact selection: [${exportData.exactIndices.join(", ")}]`);
  console.log(`   solver objective_int:           ${exportData.exactObjectiveInt}`);
  console.log(`   solver portfolio_objective_int: ${exportData.exactPortfolioObjectiveInt}`);

  const studyId = BigInt(Date.now());
  console.log(`\n2. Sealing the problem on-chain as study ${studyId}...`);
  await createStudyFromExport(ctx, exportData, {
    studyId,
    label: `smoke n=${n} k=${k}`,
    source: null
  });

  console.log("\n3. Agent commits to the allocation (salt withheld)...");
  await publishAllocation(ctx, studyId, exportData.exactIndices, "exact");

  console.log("\n4. Revealing; the chain re-derives the objective itself...");
  const revealed = await revealAllocation(ctx, studyId, null);

  console.log("\n5. Comparing the chain's number to the solver's number...");
  const solverObjective = exportData.exactObjectiveInt;
  const solverPortfolio = exportData.exactPortfolioObjectiveInt as bigint;
  console.log(`   solver objective_int  = ${solverObjective}`);
  console.log(`   chain  objective_int  = ${revealed.objectiveInt}`);
  console.log(`   solver portfolio_int  = ${solverPortfolio}`);
  console.log(`   chain  portfolio_int  = ${revealed.portfolioObjectiveInt}`);

  if (revealed.objectiveInt !== solverObjective) {
    banner([
      "SMOKE TEST FAILED",
      `on-chain objective_int ${revealed.objectiveInt}`,
      `!= solver objective_int ${solverObjective}`
    ]);
    throw new Error("on-chain objective does not equal the solver's objective_int");
  }
  if (revealed.portfolioObjectiveInt !== solverPortfolio) {
    banner([
      "SMOKE TEST FAILED",
      `on-chain portfolio_objective_int ${revealed.portfolioObjectiveInt}`,
      `!= solver portfolio_objective_int ${solverPortfolio}`
    ]);
    throw new Error("on-chain portfolio objective does not equal the solver's");
  }

  banner([
    "SMOKE TEST PASSED",
    "",
    "The Solana program independently re-derived the objective of a",
    "commitment made before the reveal, from a matrix sealed before the",
    "commitment, and got EXACTLY the integer the off-chain solver got:",
    "",
    `  objective_int            = ${revealed.objectiveInt}`,
    `  portfolio_objective_int  = ${revealed.portfolioObjectiveInt}`,
    "",
    `  reveal tx: ${revealed.signature}`
  ]);
}

// ---------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------

interface MeasurePair {
  n: number;
  k: number;
  studyId: bigint;
}

/**
 * Deterministic study ids, so an interrupted run resumes into the *same*
 * accounts instead of stranding another 0.068 SOL of rent per retry. A study
 * account cannot be closed, so this is the difference between a rerun costing
 * nothing and costing half a SOL.
 */
function measureStudyId(n: number, k: number): bigint {
  return BigInt(4_800_000_000 + n * 1000 + k);
}

async function runMeasure(ctx: Context, pairs: MeasurePair[]): Promise<void> {
  for (const { n, k, studyId } of pairs) {
    console.log(`\n=== measuring n=${n} k=${k} (study ${studyId}) ===`);
    // "bsb" (ballistic simulated bifurcation) rather than "exact": the
    // measurement only needs a real quantized matrix from the exporter, and
    // C(48,24) is not enumerable.
    const raw = runSolver(syntheticRequest(n, k, 11, ["bsb"]));
    const exportData = parseQuboExport(raw);
    await createStudyFromExport(ctx, exportData, {
      studyId,
      label: `cu n=${n} k=${k}`,
      source: null
    });

    const studyPda = deriveStudy(ctx.programId, ctx.owner.publicKey, studyId);
    const study = await ctx.program.account.study.fetch(studyPda);
    if (Number(study.revealedCount.toString()) > 0) {
      console.log("  already published and revealed once; skipping");
      continue;
    }
    // Any valid k-subset costs the same: the program scans the whole bitmap and
    // then sums k(k+1)/2 terms. Use the first k indices so the measurement is
    // reproducible and does not depend on a heuristic's output.
    const indices = Array.from({ length: k }, (_, i) => i);
    if (Number(study.publishedCount.toString()) === 0) {
      await publishAllocation(ctx, studyId, indices, "cu-bench");
    }
    await revealAllocation(ctx, studyId, null);
  }

  console.log("\n=== measured compute units (from landed transaction logs) ===");
  console.log("| instruction | params | compute units | signature |");
  console.log("| --- | --- | ---: | --- |");
  for (const sample of cuSamples) {
    console.log(
      `| ${sample.instruction} | ${sample.params} | ${sample.computeUnits} | ${sample.signature} |`
    );
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > 0) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
    } else {
      flags.set(token.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }
  return flags;
}

function positionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      if (token.indexOf("=") < 0) i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function parseIndices(text: string): number[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const value = Number(part);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`bad asset index "${part}"`);
      }
      return value;
    })
    .sort((a, b) => a - b);
}

/** "48:24" or "48:4@1786681504555" to pin an existing (possibly half-uploaded) study. */
function parsePairs(text: string): MeasurePair[] {
  return text.split(",").map((pair) => {
    const [shape, pinned] = pair.split("@");
    const [n, k] = shape.split(":").map((v) => Number(v.trim()));
    if (!Number.isInteger(n) || !Number.isInteger(k)) {
      throw new Error(`bad n:k pair "${pair}"`);
    }
    return { n, k, studyId: pinned ? BigInt(pinned.trim()) : measureStudyId(n, k) };
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !COMMANDS.includes(command)) {
    throw new Error(`Usage: ts-node scripts/devnet-separatrix.ts <${COMMANDS.join("|")}>`);
  }

  const rest = process.argv.slice(3);
  const flags = parseFlags(rest);
  const args = positionals(rest);
  const ctx = await buildContext();

  if (command === "create") {
    const exportPath = args[0];
    if (!exportPath) {
      throw new Error("Usage: create <qubo-export.json> [--study-id N] [--label TEXT]");
    }
    const raw = fs.readFileSync(path.resolve(exportPath), "utf8").trim();
    const exportData = parseQuboExport(raw.split(/\r?\n/).slice(-1)[0]);
    const studyId = flags.has("study-id")
      ? BigInt(flags.get("study-id") as string)
      : BigInt(Date.now());
    await createStudyFromExport(ctx, exportData, {
      studyId,
      label: flags.get("label") ?? `n=${exportData.n} k=${exportData.k}`,
      source: path.resolve(exportPath)
    });
  } else if (command === "publish") {
    const studyId = args[0];
    if (!studyId) {
      throw new Error("Usage: publish <study-id> [--indices 0,3,7] [--method TEXT]");
    }
    const indices = flags.has("indices") ? parseIndices(flags.get("indices") as string) : null;
    await publishAllocation(ctx, BigInt(studyId), indices, flags.get("method") ?? "separatrix");
  } else if (command === "reveal") {
    const studyId = args[0];
    if (!studyId) {
      throw new Error("Usage: reveal <study-id> [--sequence N]");
    }
    const sequence = flags.has("sequence") ? BigInt(flags.get("sequence") as string) : null;
    await revealAllocation(ctx, BigInt(studyId), sequence);
  } else if (command === "status") {
    await printStatus(ctx, args[0] ? BigInt(args[0]) : null);
  } else if (command === "smoke") {
    await runSmoke(
      ctx,
      Number(flags.get("n") ?? 8),
      Number(flags.get("k") ?? 4),
      Number(flags.get("seed") ?? 7)
    );
  } else {
    await runMeasure(ctx, parsePairs(flags.get("pairs") ?? "48:4,48:8,48:16,48:24,8:4,16:8,32:16"));
  }
}

main()
  .then(() => {
    flushComputeUnits();
  })
  .catch((error) => {
    flushComputeUnits();
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
