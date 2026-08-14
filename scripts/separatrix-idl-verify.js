/**
 * Byte-equality verification of the committed separatrix IDL.
 *
 * `idl/separatrix.json` is hand-mirrored from programs/separatrix/src/lib.rs by
 * scripts/gen-separatrix-idl.js (see AGENT.md's IDL-sync invariant), so nothing
 * but a check like this stands between a typo and a program that silently
 * rejects every transaction on devnet. A wrong discriminator does not throw a
 * helpful error; it dispatches to nothing.
 *
 * Four independent checks, all of which must pass:
 *
 *  1. INSTRUCTIONS. For each instruction, @coral-xyz/anchor builds the
 *     instruction from the committed IDL; this file rebuilds the same bytes
 *     from first principles (sha256("global:<name>")[0..8] followed by borsh
 *     args encoded by hand) and byte-compares. The account metas are compared
 *     against a table transcribed from the `#[derive(Accounts)]` structs, not
 *     read back out of the IDL.
 *  2. ACCOUNTS / EVENTS. Their discriminators must equal
 *     sha256("account:<Name>")[0..8] and sha256("event:<Name>")[0..8].
 *  3. PDAs. Every `pda.seeds` definition in the IDL is evaluated by a small
 *     interpreter here and must land on the address that
 *     `findProgramAddressSync` produces from the literal seeds written in
 *     lib.rs.
 *  4. GENERATOR. Re-running scripts/gen-separatrix-idl.js must reproduce the
 *     committed file byte for byte, so the checked artifact is the shipped one.
 *
 *   node scripts/separatrix-idl-verify.js      (npm run verify:separatrix-idl)
 */
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(REPO_ROOT, "idl", "separatrix.json");
const GENERATOR_PATH = path.join(REPO_ROOT, "scripts", "gen-separatrix-idl.js");
const EXPECTED_PROGRAM_ID = "CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const idlText = fs.readFileSync(IDL_PATH, "utf8");
const idl = JSON.parse(idlText);

let failures = 0;
function ok(name, detail) {
  console.log(`ok   ${name}${detail ? `  (${detail})` : ""}`);
}
function fail(name, ...lines) {
  failures += 1;
  console.log(`FAIL ${name}`);
  lines.forEach((line) => console.log(`       ${line}`));
}
function check(name, condition, ...lines) {
  if (condition) {
    ok(name);
  } else {
    fail(name, ...lines);
  }
  return condition;
}

// --------------------------------------------------------------------------
// Independent primitives. Nothing below reads the IDL to decide a layout.
// --------------------------------------------------------------------------

function discriminator(prefix, name) {
  return crypto.createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8);
}

function u8(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error(`bad u8 ${value}`);
  return Buffer.from([value]);
}

function u32le(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function u64le(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

function i64le(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(value), 0);
  return buf;
}

/** borsh `[u8; N]`: N raw bytes, no length prefix. */
function fixedBytes(values, length) {
  const buf = Buffer.from(values);
  if (buf.length !== length) throw new Error(`expected ${length} bytes, got ${buf.length}`);
  return buf;
}

/** borsh `Vec<i64>`: u32 length prefix then each element little-endian. */
function vecI64(values) {
  return Buffer.concat([u32le(values.length), ...values.map((v) => i64le(v))]);
}

/** borsh `Vec<u8>` (`bytes` in the IDL spec). */
function vecU8(buf) {
  return Buffer.concat([u32le(buf.length), Buffer.from(buf)]);
}

function hex(buf) {
  return Buffer.from(buf).toString("hex");
}

function metaString(keys) {
  return keys
    .map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? "S" : "-"}${k.isWritable ? "W" : "-"}`)
    .join("\n");
}

// --------------------------------------------------------------------------
// Fixtures. Fixed, arbitrary, non-degenerate values: a bug that zeroes a field
// or transposes two adjacent fields has to change the bytes.
// --------------------------------------------------------------------------

const SYSTEM_PROGRAM = web3.SystemProgram.programId;
const authority = new web3.PublicKey("6MgHTgFakCFLjt7bnjSXsGZaVKKr9Ye7z2v8sYzNVCTF");
const agent = new web3.PublicKey("AM1tDDPyyj1q4bsWtZXB88G1Ku5hUrSXZDWjhp5VYPot");

const STUDY_ID = 0x0102030405060708n;
const SEQUENCE = 7n;
const SCALE_BITS = 4780509421331506504n; // f64::to_bits of a real quantization scale
const OFFSET_INT_LE = Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff);
const Q_HASH = Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff);
const LABEL = Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
const COMMITMENT = Array.from({ length: 32 }, (_, i) => (i * 13 + 9) & 0xff);
const METHOD = Array.from({ length: 16 }, (_, i) => (i * 19 + 2) & 0xff);
const SALT = Array.from({ length: 32 }, (_, i) => (i * 23 + 6) & 0xff);
const BITS = Buffer.from([0x29, 0x42, 0x00, 0x80, 0x01]); // 39-asset bitmap, LSB-first
const COEFFICIENTS = [1n, -2n, 2147483647n, -2147483647n, 0n, 123456789n];
const START_INDEX = 96;

/** ["study", authority, study_id as little-endian u64] — literally as in lib.rs. */
function deriveStudy(programId, authorityKey, studyId) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("study", "utf8"), authorityKey.toBuffer(), u64le(studyId)],
    programId
  )[0];
}

/** ["alloc", study, sequence as little-endian u64]. */
function deriveAllocation(programId, studyKey, sequence) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("alloc", "utf8"), studyKey.toBuffer(), u64le(sequence)],
    programId
  )[0];
}

function buildCases(programId) {
  const study = deriveStudy(programId, authority, STUDY_ID);
  const allocation = deriveAllocation(programId, study, SEQUENCE);

  return [
    {
      name: "create_study",
      // discriminator + u64 + u8 + u8 + u64 + [u8;16] + [u8;32] + [u8;32]
      data: Buffer.concat([
        discriminator("global", "create_study"),
        u64le(STUDY_ID),
        u8(39),
        u8(8),
        u64le(SCALE_BITS),
        fixedBytes(OFFSET_INT_LE, 16),
        fixedBytes(Q_HASH, 32),
        fixedBytes(LABEL, 32)
      ]),
      // Transcribed from `struct CreateStudy`: authority is `#[account(mut)]
      // Signer`, agent is a read-only `Signer` (attribution is consensual —
      // `Study.agent` is memcmp-indexable, so an unsigned binding would let
      // anyone open studies naming someone else's pubkey), study is `init` so
      // writable, then the system program.
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: agent, isSigner: true, isWritable: false },
        { pubkey: study, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }
      ],
      build: (program) =>
        program.methods
          .createStudy(
            new anchor.BN(STUDY_ID.toString()),
            39,
            8,
            new anchor.BN(SCALE_BITS.toString()),
            OFFSET_INT_LE,
            Q_HASH,
            LABEL
          )
          .accountsPartial({ authority, agent, study, systemProgram: SYSTEM_PROGRAM })
          .instruction()
    },
    {
      name: "write_coefficients",
      data: Buffer.concat([
        discriminator("global", "write_coefficients"),
        u32le(START_INDEX),
        vecI64(COEFFICIENTS)
      ]),
      // `struct WriteCoefficients`: authority signs but is not mut; study is mut.
      keys: [
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: study, isSigner: false, isWritable: true }
      ],
      build: (program) =>
        program.methods
          .writeCoefficients(
            START_INDEX,
            COEFFICIENTS.map((v) => new anchor.BN(v.toString()))
          )
          .accountsPartial({ authority, study })
          .instruction()
    },
    {
      name: "seal_study",
      data: discriminator("global", "seal_study"),
      keys: [
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: study, isSigner: false, isWritable: true }
      ],
      build: (program) =>
        program.methods.sealStudy().accountsPartial({ authority, study }).instruction()
    },
    {
      name: "publish_allocation",
      data: Buffer.concat([
        discriminator("global", "publish_allocation"),
        u64le(SEQUENCE),
        fixedBytes(COMMITMENT, 32),
        fixedBytes(METHOD, 16)
      ]),
      // `struct PublishAllocation`: agent is `#[account(mut)] Signer` (it pays
      // rent for the allocation), study is mut, allocation is `init`.
      keys: [
        { pubkey: agent, isSigner: true, isWritable: true },
        { pubkey: study, isSigner: false, isWritable: true },
        { pubkey: allocation, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }
      ],
      build: (program) =>
        program.methods
          .publishAllocation(new anchor.BN(SEQUENCE.toString()), COMMITMENT, METHOD)
          .accountsPartial({ agent, study, allocation, systemProgram: SYSTEM_PROGRAM })
          .instruction()
    },
    {
      name: "reveal_allocation",
      // `bits` is `Vec<u8>` — length-prefixed — and `salt` is a fixed [u8; 32].
      data: Buffer.concat([
        discriminator("global", "reveal_allocation"),
        vecU8(BITS),
        fixedBytes(SALT, 32)
      ]),
      // `struct RevealAllocation`: no signer at all. Study is mut because the
      // reveal advances revealed_count; allocation is mut.
      keys: [
        { pubkey: study, isSigner: false, isWritable: true },
        { pubkey: allocation, isSigner: false, isWritable: true }
      ],
      build: (program) =>
        program.methods
          .revealAllocation(BITS, SALT)
          .accountsPartial({ study, allocation })
          .instruction()
    }
  ];
}

// --------------------------------------------------------------------------
// PDA seed interpreter: evaluates the IDL's declarative seeds so they can be
// compared against the literal derivation above.
// --------------------------------------------------------------------------

function encodeByIdlType(type, value) {
  if (type === "u64") return u64le(value);
  if (type === "u32") return u32le(value);
  if (type === "u8") return u8(value);
  if (type === "pubkey") return value.toBuffer();
  throw new Error(`seed encoder has no rule for IDL type ${JSON.stringify(type)}`);
}

function idlAccountFieldType(accountName, fieldName) {
  const type = idl.types.find((t) => t.name === accountName);
  if (!type) throw new Error(`IDL has no type named ${accountName}`);
  const field = type.type.fields.find((f) => f.name === fieldName);
  if (!field) throw new Error(`${accountName} has no field ${fieldName}`);
  return field.type;
}

function evaluateSeeds(instruction, seeds, ctx) {
  return seeds.map((seed) => {
    if (seed.kind === "const") return Buffer.from(seed.value);
    if (seed.kind === "arg") {
      const arg = instruction.args.find((a) => a.name === seed.path);
      if (!arg) throw new Error(`${instruction.name} has no arg ${seed.path}`);
      return encodeByIdlType(arg.type, ctx.args[seed.path]);
    }
    if (seed.kind === "account") {
      if (!seed.path.includes(".")) {
        const key = ctx.accounts[seed.path];
        if (!key) throw new Error(`no fixture pubkey for account ${seed.path}`);
        return key.toBuffer();
      }
      const [accountKey, fieldName] = seed.path.split(".");
      const state = ctx.accountState[accountKey];
      if (!state || !(fieldName in state)) {
        throw new Error(`no fixture state for ${seed.path}`);
      }
      return encodeByIdlType(idlAccountFieldType(seed.account, fieldName), state[fieldName]);
    }
    throw new Error(`unknown seed kind ${seed.kind}`);
  });
}

function verifyPdas(programId) {
  const study = deriveStudy(programId, authority, STUDY_ID);
  const allocation = deriveAllocation(programId, study, SEQUENCE);
  const expected = { study, allocation };
  const ctx = {
    accounts: { authority, agent, study, allocation },
    args: { study_id: STUDY_ID, sequence: SEQUENCE },
    accountState: { study: { study_id: STUDY_ID }, allocation: { sequence: SEQUENCE } }
  };

  let seen = 0;
  for (const instruction of idl.instructions) {
    for (const account of instruction.accounts) {
      if (!account.pda) continue;
      seen += 1;
      const label = `pda ${instruction.name}.${account.name}`;
      let derived;
      try {
        const seeds = evaluateSeeds(instruction, account.pda.seeds, ctx);
        derived = web3.PublicKey.findProgramAddressSync(seeds, programId)[0];
      } catch (error) {
        fail(label, error.message);
        continue;
      }
      const want = expected[account.name];
      if (!want) {
        fail(label, `no literal derivation defined for account ${account.name}`);
        continue;
      }
      check(
        label,
        derived.equals(want),
        `idl seeds -> ${derived.toBase58()}`,
        `lib.rs seeds -> ${want.toBase58()}`
      );
    }
  }
  // study on create_study/write_coefficients/seal_study, allocation on
  // publish_allocation/reveal_allocation.
  check("pda coverage", seen === 5, `expected 5 declared PDAs, found ${seen}`);
}

// --------------------------------------------------------------------------

function verifyDiscriminatorTable(kind, prefix, entries) {
  for (const entry of entries) {
    const want = discriminator(prefix, entry.name);
    const got = Buffer.from(entry.discriminator);
    check(
      `${kind} discriminator ${entry.name}`,
      got.equals(want),
      `idl:    [${Array.from(got).join(", ")}]`,
      `sha256("${prefix}:${entry.name}")[0..8]: [${Array.from(want).join(", ")}]`
    );
  }
}

function verifyGeneratorIsReproducible() {
  const outPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "separatrix-idl-")),
    "separatrix.json"
  );
  try {
    execFileSync(process.execPath, [GENERATOR_PATH, outPath], { stdio: "pipe" });
    const regenerated = fs.readFileSync(outPath, "utf8");
    check(
      "generator reproduces the committed IDL",
      regenerated === idlText,
      "scripts/gen-separatrix-idl.js output differs from idl/separatrix.json",
      "run `npm run gen:idl:separatrix` and review the diff"
    );
  } catch (error) {
    fail("generator reproduces the committed IDL", error.message);
  } finally {
    fs.rmSync(path.dirname(outPath), { recursive: true, force: true });
  }
}

async function main() {
  console.log(`IDL: ${IDL_PATH}`);
  check(
    "idl address matches the deployed program id",
    idl.address === EXPECTED_PROGRAM_ID,
    `idl:      ${idl.address}`,
    `expected: ${EXPECTED_PROGRAM_ID}`
  );

  const wallet = {
    publicKey: authority,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs
  };
  const provider = new anchor.AnchorProvider(
    new web3.Connection(RPC_URL, "confirmed"),
    wallet,
    { commitment: "confirmed" }
  );
  const program = new anchor.Program(idl, provider);
  const programId = program.programId;

  console.log("\n--- instructions: anchor encoder vs hand-rolled borsh ---");
  const cases = buildCases(programId);
  check(
    "instruction coverage",
    cases.length === idl.instructions.length,
    `IDL declares ${idl.instructions.length} instructions, this file checks ${cases.length}`
  );

  for (const testCase of cases) {
    const declared = idl.instructions.find((i) => i.name === testCase.name);
    if (!declared) {
      fail(`instruction ${testCase.name}`, "not present in the IDL");
      continue;
    }
    verifyDiscriminatorTable("instruction", "global", [declared]);

    let built;
    try {
      built = await testCase.build(program);
    } catch (error) {
      fail(`instruction ${testCase.name}`, `anchor failed to build: ${error.message}`);
      continue;
    }

    const anchorData = hex(built.data);
    const handData = hex(testCase.data);
    check(
      `instruction data ${testCase.name}`,
      anchorData === handData,
      `anchor: ${anchorData}`,
      `hand:   ${handData}`
    );
    check(
      `instruction programId ${testCase.name}`,
      built.programId.equals(programId),
      `${built.programId.toBase58()} != ${programId.toBase58()}`
    );
    const anchorKeys = metaString(built.keys);
    const handKeys = metaString(testCase.keys);
    check(
      `instruction accounts ${testCase.name}`,
      anchorKeys === handKeys,
      `anchor:\n${anchorKeys}`,
      `lib.rs:\n${handKeys}`
    );
  }

  console.log("\n--- account and event discriminators ---");
  verifyDiscriminatorTable("account", "account", idl.accounts);
  verifyDiscriminatorTable("event", "event", idl.events);

  console.log("\n--- pda seed definitions ---");
  verifyPdas(programId);

  console.log("\n--- generator determinism ---");
  verifyGeneratorIsReproducible();

  if (failures) {
    console.log(`\n${failures} CHECK(S) FAILED — the IDL has drifted from the program.`);
    process.exitCode = 1;
  } else {
    console.log("\nALL CHECKS PASSED");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
