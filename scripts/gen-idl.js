// Generates target/idl/leash.json for the leash Anchor program (anchor 0.30.1 IDL spec).
// Discriminators: sha256("global:<ix_snake>")[0..8], sha256("account:<Name>")[0..8], sha256("event:<Name>")[0..8].
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function disc(prefix, name) {
  return Array.from(crypto.createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8));
}
function constSeed(text) {
  return { kind: "const", value: Array.from(Buffer.from(text, "utf8")) };
}

const SYSTEM_PROGRAM = { name: "system_program", address: "11111111111111111111111111111111" };

const leashPdaByAgentAccount = {
  seeds: [constSeed("leash"), { kind: "account", path: "agent" }]
};
const leashPdaSelf = {
  seeds: [constSeed("leash"), { kind: "account", path: "leash.agent", account: "LeashState" }]
};
const vaultPda = {
  seeds: [constSeed("vault"), { kind: "account", path: "leash" }]
};

const idl = {
  address: "EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV",
  metadata: {
    name: "leash",
    version: "0.1.0",
    spec: "0.1.0",
    description: "Leash: on-chain spending guardrails for AI agents"
  },
  instructions: [
    {
      name: "create_leash",
      discriminator: disc("global", "create_leash"),
      accounts: [
        { name: "owner", writable: true, signer: true },
        { name: "agent" },
        { name: "leash", writable: true, pda: leashPdaByAgentAccount },
        { name: "vault", pda: vaultPda },
        SYSTEM_PROGRAM
      ],
      args: [
        { name: "per_tx_cap_lamports", type: "u64" },
        { name: "daily_cap_lamports", type: "u64" },
        { name: "allowlist_enforced", type: "bool" }
      ]
    },
    {
      name: "deposit",
      discriminator: disc("global", "deposit"),
      accounts: [
        { name: "depositor", writable: true, signer: true },
        { name: "leash", pda: leashPdaSelf },
        { name: "vault", writable: true, pda: vaultPda },
        SYSTEM_PROGRAM
      ],
      args: [{ name: "amount_lamports", type: "u64" }]
    },
    {
      name: "spend",
      discriminator: disc("global", "spend"),
      accounts: [
        { name: "leash", writable: true, pda: leashPdaSelf },
        { name: "agent", signer: true },
        { name: "vault", writable: true, pda: vaultPda },
        { name: "recipient", writable: true },
        SYSTEM_PROGRAM
      ],
      args: [{ name: "amount_lamports", type: "u64" }]
    },
    {
      name: "update_limits",
      discriminator: disc("global", "update_limits"),
      accounts: [
        { name: "leash", writable: true, pda: leashPdaSelf },
        { name: "owner", signer: true }
      ],
      args: [
        { name: "per_tx_cap_lamports", type: "u64" },
        { name: "daily_cap_lamports", type: "u64" }
      ]
    },
    {
      name: "set_halt",
      discriminator: disc("global", "set_halt"),
      accounts: [
        { name: "leash", writable: true, pda: leashPdaSelf },
        { name: "owner", signer: true }
      ],
      args: [{ name: "halted", type: "bool" }]
    },
    {
      name: "set_allowlist",
      discriminator: disc("global", "set_allowlist"),
      accounts: [
        { name: "leash", writable: true, pda: leashPdaSelf },
        { name: "owner", signer: true }
      ],
      args: [
        { name: "enforced", type: "bool" },
        { name: "recipients", type: { vec: "pubkey" } }
      ]
    },
    {
      name: "withdraw",
      discriminator: disc("global", "withdraw"),
      accounts: [
        { name: "leash", pda: leashPdaSelf },
        { name: "owner", writable: true, signer: true },
        { name: "vault", writable: true, pda: vaultPda },
        SYSTEM_PROGRAM
      ],
      args: [{ name: "amount_lamports", type: "u64" }]
    }
  ],
  accounts: [
    { name: "LeashState", discriminator: disc("account", "LeashState") }
  ],
  events: [
    { name: "SpendExecuted", discriminator: disc("event", "SpendExecuted") },
    { name: "VaultDeposited", discriminator: disc("event", "VaultDeposited") },
    { name: "VaultWithdrawn", discriminator: disc("event", "VaultWithdrawn") },
    { name: "HaltChanged", discriminator: disc("event", "HaltChanged") }
  ],
  errors: [
    { code: 6000, name: "LeashHalted", msg: "the leash is halted; the agent may not spend" },
    { code: 6001, name: "PerTxCapExceeded", msg: "the spend exceeds the per-transaction cap" },
    { code: 6002, name: "DailyCapExceeded", msg: "the spend exceeds the daily cap" },
    { code: 6003, name: "RecipientNotAllowed", msg: "the recipient is not on the allowlist" },
    { code: 6004, name: "VaultInsufficient", msg: "the vault balance is insufficient" },
    { code: 6005, name: "Overflow", msg: "arithmetic overflow" },
    { code: 6006, name: "InvalidLimits", msg: "limits are invalid" },
    { code: 6007, name: "AllowlistTooLarge", msg: "the allowlist holds at most 8 recipients" },
    { code: 6008, name: "UnauthorizedOwner", msg: "only the configured owner may perform this action" },
    { code: 6009, name: "UnauthorizedAgent", msg: "only the configured agent may spend" },
    { code: 6010, name: "InvalidAmount", msg: "amount must be greater than zero" }
  ],
  types: [
    {
      name: "LeashState",
      type: {
        kind: "struct",
        fields: [
          { name: "owner", type: "pubkey" },
          { name: "agent", type: "pubkey" },
          { name: "per_tx_cap_lamports", type: "u64" },
          { name: "daily_cap_lamports", type: "u64" },
          { name: "spent_today_lamports", type: "u64" },
          { name: "current_day_index", type: "i64" },
          { name: "total_spent_lamports", type: "u64" },
          { name: "spend_count", type: "u64" },
          { name: "halted", type: "bool" },
          { name: "allowlist_enforced", type: "bool" },
          { name: "allowed_recipients", type: { vec: "pubkey" } },
          { name: "bump", type: "u8" },
          { name: "vault_bump", type: "u8" }
        ]
      }
    },
    {
      name: "SpendExecuted",
      type: {
        kind: "struct",
        fields: [
          { name: "leash", type: "pubkey" },
          { name: "agent", type: "pubkey" },
          { name: "recipient", type: "pubkey" },
          { name: "amount_lamports", type: "u64" },
          { name: "spent_today_lamports", type: "u64" },
          { name: "total_spent_lamports", type: "u64" },
          { name: "spend_count", type: "u64" },
          { name: "timestamp", type: "i64" }
        ]
      }
    },
    {
      name: "VaultDeposited",
      type: {
        kind: "struct",
        fields: [
          { name: "leash", type: "pubkey" },
          { name: "depositor", type: "pubkey" },
          { name: "amount_lamports", type: "u64" },
          { name: "vault_balance_lamports", type: "u64" }
        ]
      }
    },
    {
      name: "VaultWithdrawn",
      type: {
        kind: "struct",
        fields: [
          { name: "leash", type: "pubkey" },
          { name: "owner", type: "pubkey" },
          { name: "amount_lamports", type: "u64" }
        ]
      }
    },
    {
      name: "HaltChanged",
      type: {
        kind: "struct",
        fields: [
          { name: "leash", type: "pubkey" },
          { name: "halted", type: "bool" }
        ]
      }
    }
  ]
};

const outPath = process.argv[2] || path.join(process.cwd(), "target", "idl", "leash.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(idl, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
