import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const LAMPORTS_PER_SOL = 1_000_000_000;

type Command =
  | "init"
  | "status"
  | "status-json"
  | "deposit"
  | "spend"
  | "halt"
  | "resume"
  | "withdraw"
  | "smoke";

interface Context {
  agent: anchor.web3.Keypair;
  owner: anchor.web3.Keypair | null;
  leashPda: anchor.web3.PublicKey;
  vaultPda: anchor.web3.PublicKey;
  program: any;
  providerWallet: anchor.web3.Keypair;
  rpcUrl: string;
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function loadKeypair(keypairPath: string): anchor.web3.Keypair {
  const resolvedPath = path.resolve(keypairPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Missing keypair: ${resolvedPath}`);
  }

  const secret = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  if (!Array.isArray(secret)) {
    throw new Error(`Keypair file is not a JSON array: ${resolvedPath}`);
  }

  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secret));
}

function solToLamports(value: string): anchor.BN {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid SOL amount: ${value}`);
  }
  return new anchor.BN(Math.round(parsed * LAMPORTS_PER_SOL).toString());
}

function lamportsToSol(value: anchor.BN | number | bigint): number {
  return Number(value.toString()) / LAMPORTS_PER_SOL;
}

function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function explorerAddress(address: anchor.web3.PublicKey): string {
  return `https://explorer.solana.com/address/${address.toBase58()}?cluster=devnet`;
}

function rejectionReason(error: unknown): string | null {
  const code = (error as any)?.error?.errorCode?.code ||
    (error as any)?.errorCode?.code ||
    (error as any)?.code ||
    "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${code} ${message}`;

  const mappings: Array<[string, string]> = [
    ["LeashHalted", "LEASH_HALTED"],
    ["PerTxCapExceeded", "PER_TX_CAP_EXCEEDED"],
    ["DailyCapExceeded", "DAILY_CAP_EXCEEDED"],
    ["RecipientNotAllowed", "RECIPIENT_NOT_ALLOWED"],
    ["VaultInsufficient", "VAULT_INSUFFICIENT"],
    ["Overflow", "LEASH_OVERFLOW"],
    ["UnauthorizedAgent", "UNAUTHORIZED_AGENT"],
    ["UnauthorizedOwner", "UNAUTHORIZED_OWNER"],
    ["InvalidAmount", "INVALID_AMOUNT"]
  ];

  for (const [anchorCode, reason] of mappings) {
    if (text.includes(anchorCode)) {
      return reason;
    }
  }

  return null;
}

function deriveLeashPdas(
  programId: anchor.web3.PublicKey,
  agent: anchor.web3.PublicKey
): { leashPda: anchor.web3.PublicKey; vaultPda: anchor.web3.PublicKey } {
  const [leashPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("leash"), agent.toBuffer()],
    programId
  );
  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), leashPda.toBuffer()],
    programId
  );
  return { leashPda, vaultPda };
}

function defaultRecipient(): anchor.web3.PublicKey {
  const fromEnv = process.env.SPEND_RECIPIENT;
  if (fromEnv && fromEnv.trim()) {
    return new anchor.web3.PublicKey(fromEnv.trim());
  }

  const treasuryPath = path.resolve(env("TREASURY_WALLET_PATH", "keys/treasury-devnet.json"));
  if (fs.existsSync(treasuryPath)) {
    return loadKeypair(treasuryPath).publicKey;
  }

  throw new Error("No spend recipient: set SPEND_RECIPIENT or provide keys/treasury-devnet.json");
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

async function buildContext(providerRole: "owner" | "agent" = "owner"): Promise<Context> {
  const rpcUrl = env("SOLANA_RPC_URL", DEVNET_RPC_URL);
  const agent = loadKeypair(env("AGENT_WALLET_PATH", "keys/agent-devnet.json"));
  const ownerPath = env("OWNER_WALLET_PATH", "keys/owner-devnet.json");
  const owner = fs.existsSync(path.resolve(ownerPath)) ? loadKeypair(ownerPath) : null;
  if (providerRole === "owner" && !owner) {
    throw new Error(`Missing owner keypair: ${path.resolve(ownerPath)}`);
  }
  const providerWallet = providerRole === "owner" ? owner as anchor.web3.Keypair : agent;
  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, createWallet(providerWallet), {
    commitment: "confirmed",
    preflightCommitment: "confirmed"
  });

  anchor.setProvider(provider);

  const idlPath = ["idl/leash.json", "target/idl/leash.json"]
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => fs.existsSync(candidate));
  if (!idlPath) {
    throw new Error("Missing IDL: expected idl/leash.json (run `npm run gen:idl`) or target/idl/leash.json.");
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, provider) as any;

  const expectedProgramId = process.env.LEASH_PROGRAM_ID;
  if (expectedProgramId && expectedProgramId !== program.programId.toBase58()) {
    throw new Error(
      `Program id mismatch: expected ${expectedProgramId}, Anchor workspace resolved ${program.programId.toBase58()}`
    );
  }

  const { leashPda, vaultPda } = deriveLeashPdas(program.programId, agent.publicKey);

  return { agent, owner, leashPda, vaultPda, program, providerWallet, rpcUrl };
}

async function fetchLeash(ctx: Context): Promise<any | null> {
  const accountInfo = await ctx.program.provider.connection.getAccountInfo(ctx.leashPda, "confirmed");
  if (!accountInfo) {
    return null;
  }
  return ctx.program.account["leashState"].fetch(ctx.leashPda);
}

async function vaultBalance(ctx: Context): Promise<number> {
  return ctx.program.provider.connection.getBalance(ctx.vaultPda, "confirmed");
}

function printLeash(ctx: Context, leash: any | null, vaultLamports: number): void {
  console.log(`RPC: ${ctx.rpcUrl}`);
  console.log(`Program: ${ctx.program.programId.toBase58()}`);
  console.log(`Owner: ${ctx.owner ? ctx.owner.publicKey.toBase58() : "not loaded"}`);
  console.log(`Agent: ${ctx.agent.publicKey.toBase58()}`);
  console.log(`Leash PDA: ${ctx.leashPda.toBase58()}`);
  console.log(`Vault PDA: ${ctx.vaultPda.toBase58()}`);
  console.log(`Leash Explorer: ${explorerAddress(ctx.leashPda)}`);

  if (!leash) {
    console.log("Leash state: not initialized");
    return;
  }

  console.log("Leash state: initialized");
  console.log(`  owner: ${leash.owner.toBase58()}`);
  console.log(`  agent: ${leash.agent.toBase58()}`);
  console.log(`  per_tx_cap: ${lamportsToSol(leash.perTxCapLamports)} SOL`);
  console.log(`  daily_cap: ${lamportsToSol(leash.dailyCapLamports)} SOL`);
  console.log(`  spent_today: ${lamportsToSol(leash.spentTodayLamports)} SOL`);
  console.log(`  total_spent: ${lamportsToSol(leash.totalSpentLamports)} SOL`);
  console.log(`  spend_count: ${leash.spendCount.toString()}`);
  console.log(`  halted: ${leash.halted}`);
  console.log(`  allowlist_enforced: ${leash.allowlistEnforced}`);
  console.log(`  allowed_recipients: ${leash.allowedRecipients.map((r: any) => r.toBase58()).join(", ") || "(none)"}`);
  console.log(`  vault_balance: ${vaultLamports / LAMPORTS_PER_SOL} SOL`);
}

function leashStatusJson(ctx: Context, leash: any | null, vaultLamports: number): object {
  const base = {
    available: true,
    initialized: Boolean(leash),
    rpc_url: ctx.rpcUrl,
    program_id: ctx.program.programId.toBase58(),
    program_explorer_url: explorerAddress(ctx.program.programId),
    agent: ctx.agent.publicKey.toBase58(),
    leash_pda: ctx.leashPda.toBase58(),
    vault_pda: ctx.vaultPda.toBase58(),
    leash_explorer_url: explorerAddress(ctx.leashPda),
    vault_explorer_url: explorerAddress(ctx.vaultPda),
    vault_balance_lamports: String(vaultLamports)
  };

  if (!leash) {
    return base;
  }

  return {
    ...base,
    owner: leash.owner.toBase58(),
    per_tx_cap_lamports: leash.perTxCapLamports.toString(),
    daily_cap_lamports: leash.dailyCapLamports.toString(),
    spent_today_lamports: leash.spentTodayLamports.toString(),
    total_spent_lamports: leash.totalSpentLamports.toString(),
    spend_count: leash.spendCount.toString(),
    current_day_index: leash.currentDayIndex.toString(),
    halted: leash.halted,
    allowlist_enforced: leash.allowlistEnforced,
    allowed_recipients: leash.allowedRecipients.map((r: any) => r.toBase58())
  };
}

async function initLeash(ctx: Context): Promise<void> {
  if (!ctx.owner) {
    throw new Error("Owner keypair is required to create a leash.");
  }

  let leash = await fetchLeash(ctx);
  if (leash) {
    console.log("Leash already initialized.");
  } else {
    const perTxCap = solToLamports(env("PER_TX_CAP_SOL", "0.05"));
    const dailyCap = solToLamports(env("DAILY_CAP_SOL", "0.2"));
    const allowlistEnforced = env("ALLOWLIST_ENFORCED", "true").toLowerCase() !== "false";

    const signature = await ctx.program.methods
      .createLeash(perTxCap, dailyCap, allowlistEnforced)
      .accounts({
        owner: ctx.owner.publicKey,
        agent: ctx.agent.publicKey,
        leash: ctx.leashPda,
        vault: ctx.vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .rpc();
    console.log(`Created leash: ${signature}`);
    console.log(`Explorer: ${explorerTx(signature)}`);

    if (allowlistEnforced) {
      const recipients = [defaultRecipient()];
      const allowSig = await ctx.program.methods
        .setAllowlist(true, recipients)
        .accounts({
          leash: ctx.leashPda,
          owner: ctx.owner.publicKey
        })
        .rpc();
      console.log(`Allowlist set (${recipients.map((r) => r.toBase58()).join(", ")}): ${allowSig}`);
    }
  }

  const initDepositSol = Number(env("INIT_DEPOSIT_SOL", "0.5"));
  const currentVault = await vaultBalance(ctx);
  if (initDepositSol > 0 && currentVault < initDepositSol * LAMPORTS_PER_SOL) {
    const topUp = new anchor.BN(
      Math.round(initDepositSol * LAMPORTS_PER_SOL - currentVault).toString()
    );
    const depositSig = await ctx.program.methods
      .deposit(topUp)
      .accounts({
        depositor: ctx.owner.publicKey,
        leash: ctx.leashPda,
        vault: ctx.vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .rpc();
    console.log(`Deposited ${lamportsToSol(topUp)} SOL into vault: ${depositSig}`);
  }

  printLeash(ctx, await fetchLeash(ctx), await vaultBalance(ctx));
}

async function requireLeash(ctx: Context): Promise<any> {
  const leash = await fetchLeash(ctx);
  if (!leash) {
    throw new Error("Leash is not initialized. Run `npm run devnet:init` first.");
  }
  return leash;
}

async function deposit(ctx: Context, amountArg: string | undefined): Promise<void> {
  if (!ctx.owner) {
    throw new Error("Owner keypair is required to deposit.");
  }
  await requireLeash(ctx);
  const amount = solToLamports(amountArg || "");
  const signature = await ctx.program.methods
    .deposit(amount)
    .accounts({
      depositor: ctx.owner.publicKey,
      leash: ctx.leashPda,
      vault: ctx.vaultPda,
      systemProgram: anchor.web3.SystemProgram.programId
    })
    .rpc();
  console.log(`Deposited ${lamportsToSol(amount)} SOL: ${signature}`);
  console.log(`Explorer: ${explorerTx(signature)}`);
}

async function spend(
  ctx: Context,
  amountArg: string | undefined,
  recipientArg: string | undefined
): Promise<void> {
  await requireLeash(ctx);

  const amount = solToLamports(amountArg || "");
  const recipient = recipientArg
    ? new anchor.web3.PublicKey(recipientArg)
    : defaultRecipient();

  const builder = ctx.program.methods
    .spend(amount)
    .accounts({
      leash: ctx.leashPda,
      agent: ctx.agent.publicKey,
      vault: ctx.vaultPda,
      recipient,
      systemProgram: anchor.web3.SystemProgram.programId
    });

  try {
    const signature = ctx.providerWallet.publicKey.equals(ctx.agent.publicKey)
      ? await builder.rpc()
      : await builder.signers([ctx.agent]).rpc();

    console.log(JSON.stringify({
      approved: true,
      reason: "APPROVED",
      tx_signature: signature,
      explorer_url: explorerTx(signature),
      amount_lamports: amount.toString(),
      recipient: recipient.toBase58(),
      leash_pda: ctx.leashPda.toBase58(),
      program_id: ctx.program.programId.toBase58()
    }));
  } catch (error) {
    const reason = rejectionReason(error);
    if (!reason) {
      throw error;
    }

    console.log(JSON.stringify({
      approved: false,
      reason,
      tx_signature: null,
      amount_lamports: amount.toString(),
      recipient: recipient.toBase58(),
      leash_pda: ctx.leashPda.toBase58(),
      program_id: ctx.program.programId.toBase58()
    }));
  }
}

async function setHalt(ctx: Context, halted: boolean): Promise<void> {
  if (!ctx.owner) {
    throw new Error("Owner keypair is required to change halt state.");
  }
  await requireLeash(ctx);
  const signature = await ctx.program.methods
    .setHalt(halted)
    .accounts({
      leash: ctx.leashPda,
      owner: ctx.owner.publicKey
    })
    .rpc();
  console.log(`${halted ? "Halted" : "Resumed"} leash: ${signature}`);
  console.log(`Explorer: ${explorerTx(signature)}`);
}

async function withdraw(ctx: Context, amountArg: string | undefined): Promise<void> {
  if (!ctx.owner) {
    throw new Error("Owner keypair is required to withdraw.");
  }
  await requireLeash(ctx);
  const amount = solToLamports(amountArg || "");
  const signature = await ctx.program.methods
    .withdraw(amount)
    .accounts({
      leash: ctx.leashPda,
      owner: ctx.owner.publicKey,
      vault: ctx.vaultPda,
      systemProgram: anchor.web3.SystemProgram.programId
    })
    .rpc();
  console.log(`Withdrew ${lamportsToSol(amount)} SOL: ${signature}`);
  console.log(`Explorer: ${explorerTx(signature)}`);
}

async function expectBlocked(action: Promise<void> | Promise<string>, expected: string): Promise<void> {
  try {
    await action;
    throw new Error(`Expected rejection ${expected}, but the transaction was approved.`);
  } catch (error) {
    const reason = rejectionReason(error);
    if (reason !== expected) {
      throw error;
    }
    console.log(`Blocked as expected: ${expected}`);
  }
}

async function runSmoke(ctx: Context): Promise<void> {
  if (!ctx.owner) {
    throw new Error("Owner keypair is required for the smoke test.");
  }

  const leash = await requireLeash(ctx);
  const recipient = defaultRecipient();
  const perTxCap = BigInt(leash.perTxCapLamports.toString());
  const dailyCap = BigInt(leash.dailyCapLamports.toString());
  const spentToday = BigInt(leash.spentTodayLamports.toString());
  const remainingToday = dailyCap > spentToday ? dailyCap - spentToday : 0n;
  const smallSpend = [perTxCap / 2n, remainingToday, BigInt(await vaultBalance(ctx))]
    .reduce((min, value) => (value < min ? value : min));

  if (smallSpend <= 0n) {
    throw new Error("No spend capacity remains (daily cap or vault exhausted); top up or wait for day roll.");
  }

  const spendIx = (lamports: bigint) =>
    ctx.program.methods
      .spend(new anchor.BN(lamports.toString()))
      .accounts({
        leash: ctx.leashPda,
        agent: ctx.agent.publicKey,
        vault: ctx.vaultPda,
        recipient,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([ctx.agent])
      .rpc();

  console.log(`1. Agent spends ${Number(smallSpend) / LAMPORTS_PER_SOL} SOL within policy...`);
  const okSig = await spendIx(smallSpend);
  console.log(`   Approved: ${explorerTx(okSig)}`);

  console.log("2. Agent tries to exceed the per-transaction cap...");
  await expectBlocked(spendIx(perTxCap + 1n), "PER_TX_CAP_EXCEEDED");

  if (leash.allowlistEnforced) {
    console.log("3. Agent tries to pay a non-allowlisted recipient...");
    const stranger = anchor.web3.Keypair.generate().publicKey;
    await expectBlocked(
      ctx.program.methods
        .spend(new anchor.BN("1000"))
        .accounts({
          leash: ctx.leashPda,
          agent: ctx.agent.publicKey,
          vault: ctx.vaultPda,
          recipient: stranger,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([ctx.agent])
        .rpc(),
      "RECIPIENT_NOT_ALLOWED"
    );
  }

  console.log("4. Owner pulls the kill switch...");
  await setHalt(ctx, true);
  await expectBlocked(spendIx(1000n), "LEASH_HALTED");

  console.log("5. Owner resumes...");
  await setHalt(ctx, false);

  printLeash(ctx, await fetchLeash(ctx), await vaultBalance(ctx));
  console.log("Smoke test passed: every guardrail held.");
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  const commands: Command[] = [
    "init", "status", "status-json", "deposit", "spend", "halt", "resume", "withdraw", "smoke"
  ];
  if (!command || !commands.includes(command)) {
    throw new Error(`Usage: ts-node scripts/devnet-leash.ts <${commands.join("|")}>`);
  }

  const agentCommands: Command[] = ["status", "status-json", "spend"];
  const ctx = await buildContext(agentCommands.includes(command) ? "agent" : "owner");

  if (command === "init") {
    await initLeash(ctx);
  } else if (command === "status") {
    printLeash(ctx, await fetchLeash(ctx), await vaultBalance(ctx));
  } else if (command === "status-json") {
    console.log(JSON.stringify(leashStatusJson(ctx, await fetchLeash(ctx), await vaultBalance(ctx))));
  } else if (command === "deposit") {
    await deposit(ctx, process.argv[3]);
  } else if (command === "spend") {
    await spend(ctx, process.argv[3], process.argv[4]);
  } else if (command === "halt") {
    await setHalt(ctx, true);
  } else if (command === "resume") {
    await setHalt(ctx, false);
  } else if (command === "withdraw") {
    await withdraw(ctx, process.argv[3]);
  } else {
    await runSmoke(ctx);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
