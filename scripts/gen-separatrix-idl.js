// Generates idl/separatrix.json for the separatrix Anchor program
// (anchor 0.30.1 IDL spec), the same way scripts/gen-idl.js does for leash:
// by hand-mirroring the program interface, because `anchor build`'s IDL step
// is rustc-version sensitive on this host.
//
// CRITICAL: if you change any instruction, account, event or error in
// programs/separatrix/src/lib.rs you MUST mirror it here, re-run
// `npm run gen:idl:separatrix`, and re-run `npm run verify:separatrix-idl`,
// which byte-compares this output against Anchor's own encoder.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = "CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp";
const MAX_ASSETS = 48;
const MAX_TERMS = (MAX_ASSETS * (MAX_ASSETS + 1)) / 2;

function disc(prefix, name) {
  return Array.from(crypto.createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8));
}
function constSeed(text) {
  return { kind: "const", value: Array.from(Buffer.from(text, "utf8")) };
}

const SYSTEM_PROGRAM = { name: "system_program", address: "11111111111111111111111111111111" };

// ["study", authority, study_id_le] — study_id comes from the instruction args.
const studyPdaByArg = {
  seeds: [constSeed("study"), { kind: "account", path: "authority" }, { kind: "arg", path: "study_id" }]
};
// The same PDA when study_id must be read back off the account itself.
const studyPdaSelf = {
  seeds: [
    constSeed("study"),
    { kind: "account", path: "authority" },
    { kind: "account", path: "study.study_id", account: "Study" }
  ]
};
const allocationPdaByArg = {
  seeds: [constSeed("alloc"), { kind: "account", path: "study" }, { kind: "arg", path: "sequence" }]
};
const allocationPdaSelf = {
  seeds: [
    constSeed("alloc"),
    { kind: "account", path: "study" },
    { kind: "account", path: "allocation.sequence", account: "Allocation" }
  ]
};

const idl = {
  address: PROGRAM_ID,
  metadata: {
    name: "separatrix_program",
    version: "0.1.0",
    spec: "0.1.0",
    description: "Separatrix: on-chain commitment and verification of portfolio allocations"
  },
  instructions: [
    {
      name: "create_study",
      discriminator: disc("global", "create_study"),
      accounts: [
        { name: "authority", writable: true, signer: true },
        { name: "agent" },
        { name: "study", writable: true, pda: studyPdaByArg },
        SYSTEM_PROGRAM
      ],
      args: [
        { name: "study_id", type: "u64" },
        { name: "n", type: "u8" },
        { name: "k", type: "u8" },
        { name: "scale_bits", type: "u64" },
        { name: "offset_int_le", type: { array: ["u8", 16] } },
        { name: "q_hash", type: { array: ["u8", 32] } },
        { name: "label", type: { array: ["u8", 32] } }
      ]
    },
    {
      name: "write_coefficients",
      discriminator: disc("global", "write_coefficients"),
      accounts: [
        { name: "authority", signer: true },
        { name: "study", writable: true, pda: studyPdaSelf }
      ],
      args: [
        { name: "start_index", type: "u32" },
        { name: "values", type: { vec: "i64" } }
      ]
    },
    {
      name: "seal_study",
      discriminator: disc("global", "seal_study"),
      accounts: [
        { name: "authority", signer: true },
        { name: "study", writable: true, pda: studyPdaSelf }
      ],
      args: []
    },
    {
      name: "publish_allocation",
      discriminator: disc("global", "publish_allocation"),
      accounts: [
        { name: "agent", writable: true, signer: true },
        { name: "study", writable: true },
        { name: "allocation", writable: true, pda: allocationPdaByArg },
        SYSTEM_PROGRAM
      ],
      args: [
        { name: "sequence", type: "u64" },
        { name: "commitment", type: { array: ["u8", 32] } },
        { name: "method", type: { array: ["u8", 16] } }
      ]
    },
    {
      name: "reveal_allocation",
      discriminator: disc("global", "reveal_allocation"),
      accounts: [
        { name: "study", writable: true },
        { name: "allocation", writable: true, pda: allocationPdaSelf }
      ],
      args: [
        { name: "bits", type: "bytes" },
        { name: "salt", type: { array: ["u8", 32] } }
      ]
    }
  ],
  accounts: [
    { name: "Study", discriminator: disc("account", "Study") },
    { name: "Allocation", discriminator: disc("account", "Allocation") }
  ],
  events: [
    { name: "StudySealed", discriminator: disc("event", "StudySealed") },
    { name: "AllocationPublished", discriminator: disc("event", "AllocationPublished") },
    { name: "AllocationScored", discriminator: disc("event", "AllocationScored") }
  ],
  errors: [
    { code: 6000, name: "UniverseTooLarge", msg: "universe exceeds MAX_ASSETS" },
    { code: 6001, name: "InvalidCardinality", msg: "cardinality must satisfy 1 <= k <= n" },
    { code: 6002, name: "EmptyChunk", msg: "coefficient chunk is empty" },
    { code: 6003, name: "ChunkTooLarge", msg: "coefficient chunk exceeds MAX_CHUNK" },
    { code: 6004, name: "IndexOutOfRange", msg: "coefficient index out of range for this study" },
    { code: 6005, name: "StudySealed", msg: "study is sealed and its coefficients are immutable" },
    { code: 6006, name: "StudyNotSealed", msg: "study must be sealed before allocations are accepted" },
    { code: 6007, name: "CoefficientHashMismatch", msg: "uploaded coefficients do not match the committed hash" },
    { code: 6008, name: "AlreadyRevealed", msg: "allocation has already been revealed" },
    { code: 6009, name: "BadBitmapLength", msg: "bitmap length does not match the universe size" },
    { code: 6010, name: "BitOutsideUniverse", msg: "bitmap sets a bit outside the universe" },
    { code: 6011, name: "WrongCardinality", msg: "selection does not contain exactly k assets" },
    { code: 6012, name: "CommitmentMismatch", msg: "revealed allocation does not match the commitment" },
    { code: 6013, name: "StudyMismatch", msg: "allocation belongs to a different study" },
    { code: 6014, name: "UnauthorizedAuthority", msg: "signer is not the study authority" },
    { code: 6015, name: "UnauthorizedAgent", msg: "signer is not the study's bound agent" },
    { code: 6016, name: "SequenceOutOfOrder", msg: "sequence must equal the study's published_count" },
    { code: 6017, name: "EmptyCommitment", msg: "commitment must not be all zeroes" },
    { code: 6018, name: "EmptySalt", msg: "salt must not be all zeroes" },
    { code: 6019, name: "CoefficientOutOfRange", msg: "coefficient magnitude exceeds the quantization bound" },
    { code: 6020, name: "Overflow", msg: "arithmetic overflow" }
  ],
  types: [
    {
      name: "Study",
      serialization: "bytemuck",
      repr: { kind: "c" },
      type: {
        kind: "struct",
        fields: [
          { name: "authority", type: "pubkey" },
          { name: "agent", type: "pubkey" },
          { name: "q_hash", type: { array: ["u8", 32] } },
          { name: "label", type: { array: ["u8", 32] } },
          { name: "offset_int_le", type: { array: ["u8", 16] } },
          { name: "study_id", type: "u64" },
          { name: "scale_bits", type: "u64" },
          { name: "created_at", type: "i64" },
          { name: "published_count", type: "u64" },
          { name: "revealed_count", type: "u64" },
          { name: "term_count", type: "u32" },
          { name: "n", type: "u8" },
          { name: "k", type: "u8" },
          { name: "sealed", type: "u8" },
          { name: "bump", type: "u8" },
          { name: "coefficients", type: { array: ["i64", MAX_TERMS] } }
        ]
      }
    },
    {
      name: "Allocation",
      type: {
        kind: "struct",
        fields: [
          { name: "study", type: "pubkey" },
          { name: "agent", type: "pubkey" },
          { name: "commitment", type: { array: ["u8", 32] } },
          { name: "method", type: { array: ["u8", 16] } },
          { name: "sequence", type: "u64" },
          { name: "published_slot", type: "u64" },
          { name: "published_at", type: "i64" },
          { name: "revealed_at", type: "i64" },
          { name: "objective_int_le", type: { array: ["u8", 16] } },
          { name: "portfolio_objective_int_le", type: { array: ["u8", 16] } },
          { name: "revealed", type: "u8" },
          { name: "bump", type: "u8" }
        ]
      }
    },
    {
      name: "StudySealed",
      type: {
        kind: "struct",
        fields: [
          { name: "study", type: "pubkey" },
          { name: "authority", type: "pubkey" },
          { name: "n", type: "u8" },
          { name: "k", type: "u8" },
          { name: "term_count", type: "u32" },
          { name: "q_hash", type: { array: ["u8", 32] } }
        ]
      }
    },
    {
      name: "AllocationPublished",
      type: {
        kind: "struct",
        fields: [
          { name: "study", type: "pubkey" },
          { name: "allocation", type: "pubkey" },
          { name: "agent", type: "pubkey" },
          { name: "sequence", type: "u64" },
          { name: "commitment", type: { array: ["u8", 32] } },
          { name: "method", type: { array: ["u8", 16] } },
          { name: "slot", type: "u64" },
          { name: "timestamp", type: "i64" }
        ]
      }
    },
    {
      name: "AllocationScored",
      type: {
        kind: "struct",
        fields: [
          { name: "study", type: "pubkey" },
          { name: "allocation", type: "pubkey" },
          { name: "agent", type: "pubkey" },
          { name: "sequence", type: "u64" },
          { name: "objective_int_le", type: { array: ["u8", 16] } },
          { name: "portfolio_objective_int_le", type: { array: ["u8", 16] } },
          { name: "selected_count", type: "u8" },
          { name: "timestamp", type: "i64" }
        ]
      }
    }
  ]
};

const outPath = process.argv[2] || path.join("idl", "separatrix.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(idl, null, 2)}\n`);
console.log(`wrote ${outPath}`);
