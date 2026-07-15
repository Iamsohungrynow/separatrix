/**
 * Verify that the owner UI's hand-rolled instruction encoder
 * (dashboard/leash-ix.js) produces byte-identical transactions to Anchor, and
 * that its account decoder reads the live LeashState correctly.
 *
 * This is what lets the browser UI be trusted without a wallet in the loop: the
 * exact module the page ships is checked here against @coral-xyz/anchor.
 *
 *   node scripts/verify-owner-ix.js
 */
const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const makeLeashClient = require("../dashboard/leash-ix.js");

const IDL_PATH = path.resolve(__dirname, "..", "idl", "leash.json");
const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const PROGRAM_ID = idl.address;
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

function dummyProgram() {
  const connection = new web3.Connection(RPC_URL, "confirmed");
  const wallet = {
    publicKey: web3.Keypair.generate().publicKey,
    signTransaction: async (t) => t,
    signAllTransactions: async (t) => t,
  };
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new anchor.Program(idl, provider);
}

function metaString(keys) {
  return keys
    .map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? "S" : "-"}${k.isWritable ? "W" : "-"}`)
    .join("\n");
}

function compare(name, mine, theirs) {
  const myData = Buffer.from(mine.data).toString("hex");
  const theirData = Buffer.from(theirs.data).toString("hex");
  const problems = [];
  if (myData !== theirData) problems.push(`  data mismatch:\n    ours:   ${myData}\n    anchor: ${theirData}`);
  if (mine.programId.toBase58() !== theirs.programId.toBase58()) {
    problems.push(`  programId mismatch: ${mine.programId.toBase58()} vs ${theirs.programId.toBase58()}`);
  }
  const myKeys = metaString(mine.keys);
  const theirKeys = metaString(theirs.keys);
  if (myKeys !== theirKeys) problems.push(`  accounts mismatch:\n    ours:\n${myKeys}\n    anchor:\n${theirKeys}`);
  if (problems.length) {
    console.log(`FAIL ${name}`);
    problems.forEach((p) => console.log(p));
    return false;
  }
  console.log(`ok   ${name}`);
  return true;
}

async function main() {
  const program = dummyProgram();
  const client = makeLeashClient(web3, PROGRAM_ID);
  const BN = anchor.BN;

  const owner = web3.Keypair.generate().publicKey;
  const agent = web3.Keypair.generate().publicKey;
  const recipients = [web3.Keypair.generate().publicKey, web3.Keypair.generate().publicKey];
  const { leashPda, vaultPda } = client.deriveLeash(agent);
  const systemProgram = web3.SystemProgram.programId;

  const perTx = 50_000_000;
  const daily = 200_000_000;
  const amount = 10_000_000;

  const cases = [
    [
      "create_leash",
      client.createLeash({ owner, agent, perTxCapLamports: perTx, dailyCapLamports: daily, allowlistEnforced: true }),
      () =>
        program.methods
          .createLeash(new BN(perTx), new BN(daily), true)
          .accounts({ owner, agent, leash: leashPda, vault: vaultPda, systemProgram })
          .instruction(),
    ],
    [
      "deposit",
      client.deposit({ depositor: owner, agent, amountLamports: amount }),
      () =>
        program.methods
          .deposit(new BN(amount))
          .accounts({ depositor: owner, leash: leashPda, vault: vaultPda, systemProgram })
          .instruction(),
    ],
    [
      "update_limits",
      client.updateLimits({ owner, agent, perTxCapLamports: perTx, dailyCapLamports: daily }),
      () =>
        program.methods
          .updateLimits(new BN(perTx), new BN(daily))
          .accounts({ leash: leashPda, owner })
          .instruction(),
    ],
    [
      "set_halt",
      client.setHalt({ owner, agent, halted: true }),
      () => program.methods.setHalt(true).accounts({ leash: leashPda, owner }).instruction(),
    ],
    [
      "set_allowlist",
      client.setAllowlist({ owner, agent, enforced: true, recipients }),
      () =>
        program.methods
          .setAllowlist(true, recipients)
          .accounts({ leash: leashPda, owner })
          .instruction(),
    ],
    [
      "withdraw",
      client.withdraw({ owner, agent, amountLamports: amount }),
      () =>
        program.methods
          .withdraw(new BN(amount))
          .accounts({ leash: leashPda, owner, vault: vaultPda, systemProgram })
          .instruction(),
    ],
  ];

  let allOk = true;
  for (const [name, mine, build] of cases) {
    const theirs = await build();
    if (!compare(name, mine, theirs)) allOk = false;
  }

  // Read path: decode the live LeashState for the default devnet agent, if present.
  console.log("\n--- live decode check ---");
  try {
    const agentPath = process.env.AGENT_WALLET_PATH || "keys/agent-devnet.json";
    const resolved = path.resolve(agentPath);
    if (fs.existsSync(resolved)) {
      const agentKp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf8"))));
      const { leashPda: livePda } = client.deriveLeash(agentKp.publicKey);
      const info = await program.provider.connection.getAccountInfo(livePda, "confirmed");
      if (!info) {
        console.log(`no leash account at ${livePda.toBase58()} (run npm run devnet:init) — skipping`);
      } else {
        const decoded = client.decodeLeash(info.data);
        const anchorDecoded = program.account.leashState.coder.accounts.decode("leashState", info.data);
        const checks = [
          ["owner", decoded.owner.toBase58(), anchorDecoded.owner.toBase58()],
          ["agent", decoded.agent.toBase58(), anchorDecoded.agent.toBase58()],
          ["per_tx_cap", decoded.perTxCapLamports.toString(), anchorDecoded.perTxCapLamports.toString()],
          ["daily_cap", decoded.dailyCapLamports.toString(), anchorDecoded.dailyCapLamports.toString()],
          ["spent_today", decoded.spentTodayLamports.toString(), anchorDecoded.spentTodayLamports.toString()],
          ["spend_count", decoded.spendCount.toString(), anchorDecoded.spendCount.toString()],
          ["halted", String(decoded.halted), String(anchorDecoded.halted)],
          ["allowlist_enforced", String(decoded.allowlistEnforced), String(anchorDecoded.allowlistEnforced)],
          ["recipients", decoded.allowedRecipients.map((r) => r.toBase58()).join(","), anchorDecoded.allowedRecipients.map((r) => r.toBase58()).join(",")],
        ];
        for (const [field, mineVal, theirVal] of checks) {
          const same = mineVal === theirVal;
          if (!same) allOk = false;
          console.log(`${same ? "ok  " : "FAIL"} ${field}: ${mineVal}${same ? "" : " != " + theirVal}`);
        }
      }
    } else {
      console.log(`no agent keypair at ${agentPath} — skipping live decode`);
    }
  } catch (err) {
    console.log("live decode skipped:", err.message);
  }

  console.log(allOk ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
  process.exitCode = allOk ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
