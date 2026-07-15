import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const MICROS_PER_USDC = 1_000_000;

type Command = "init" | "status" | "status-json" | "smoke" | "submit";

interface Context {
  agent: anchor.web3.Keypair;
  owner: anchor.web3.Keypair | null;
  policyPda: anchor.web3.PublicKey;
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

function usdcToMicros(value: string): anchor.BN {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid USDC amount: ${value}`);
  }
  return new anchor.BN(Math.round(parsed * MICROS_PER_USDC).toString());
}

function bnToBigInt(value: anchor.BN): bigint {
  return BigInt(value.toString());
}

function minBigInt(values: bigint[]): bigint {
  return values.reduce((min, value) => (value < min ? value : min));
}

function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function explorerAddress(address: anchor.web3.PublicKey): string {
  return `https://explorer.solana.com/address/${address.toBase58()}?cluster=devnet`;
}

function policyRejectionReason(error: unknown): string | null {
  const code = (error as any)?.error?.errorCode?.code ||
    (error as any)?.errorCode?.code ||
    (error as any)?.code ||
    "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${code} ${message}`;

  const mappings: Array<[string, string]> = [
    ["AgentHalted", "POLICY_HALTED"],
    ["TradeTooBig", "TRADE_TOO_BIG"],
    ["DailyLimitExceeded", "DAILY_LIMIT_EXCEEDED"],
    ["InvalidTradeSequence", "INVALID_TRADE_SEQUENCE"],
    ["Overflow", "POLICY_OVERFLOW"],
    ["UnauthorizedAgent", "UNAUTHORIZED_AGENT"]
  ];

  for (const [anchorCode, reason] of mappings) {
    if (text.includes(anchorCode)) {
      return reason;
    }
  }

  return null;
}

function derivePolicyPda(programId: anchor.web3.PublicKey, agent: anchor.web3.PublicKey): anchor.web3.PublicKey {
  const [policyPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), agent.toBuffer()],
    programId
  );
  return policyPda;
}

function createWallet(owner: anchor.web3.Keypair): any {
  return {
    publicKey: owner.publicKey,
    signTransaction: async <T extends anchor.web3.Transaction>(tx: T): Promise<T> => {
      tx.partialSign(owner);
      return tx;
    },
    signAllTransactions: async <T extends anchor.web3.Transaction>(txs: T[]): Promise<T[]> => {
      txs.forEach((tx) => tx.partialSign(owner));
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

  const program = anchor.workspace.PolicyController as any;
  if (!program) {
    throw new Error("Anchor workspace program not found. Run `anchor build` before this script.");
  }

  const expectedProgramId = process.env.POLICY_CONTROLLER_PROGRAM_ID;
  if (expectedProgramId && expectedProgramId !== program.programId.toBase58()) {
    throw new Error(
      `Program id mismatch: expected ${expectedProgramId}, Anchor workspace resolved ${program.programId.toBase58()}`
    );
  }

  return {
    agent,
    owner,
    policyPda: derivePolicyPda(program.programId, agent.publicKey),
    program,
    providerWallet,
    rpcUrl
  };
}

async function fetchPolicy(ctx: Context): Promise<any | null> {
  const accountInfo = await ctx.program.provider.connection.getAccountInfo(ctx.policyPda, "confirmed");
  if (!accountInfo) {
    return null;
  }
  return ctx.program.account["agentPolicy"].fetch(ctx.policyPda);
}

function printPolicy(ctx: Context, policy: any | null): void {
  console.log(`RPC: ${ctx.rpcUrl}`);
  console.log(`Program: ${ctx.program.programId.toBase58()}`);
  console.log(`Owner: ${ctx.owner ? ctx.owner.publicKey.toBase58() : "not loaded"}`);
  console.log(`Agent: ${ctx.agent.publicKey.toBase58()}`);
  console.log(`Policy PDA: ${ctx.policyPda.toBase58()}`);
  console.log(`Policy Explorer: ${explorerAddress(ctx.policyPda)}`);

  if (!policy) {
    console.log("Policy state: not initialized");
    return;
  }

  console.log("Policy state: initialized");
  console.log(`  owner: ${policy.owner.toBase58()}`);
  console.log(`  agent: ${policy.agent.toBase58()}`);
  console.log(`  daily_buy_limit_microusdc: ${policy.dailyBuyLimitMicrousdc.toString()}`);
  console.log(`  per_trade_buy_limit_microusdc: ${policy.perTradeBuyLimitMicrousdc.toString()}`);
  console.log(`  daily_buy_used_microusdc: ${policy.dailyBuyUsedMicrousdc.toString()}`);
  console.log(`  next_trade_seq: ${policy.nextTradeSeq.toString()}`);
  console.log(`  halted: ${policy.halted}`);
}

function policyStatusJson(ctx: Context, policy: any | null): object {
  const base = {
    available: true,
    initialized: Boolean(policy),
    rpc_url: ctx.rpcUrl,
    program_id: ctx.program.programId.toBase58(),
    program_explorer_url: explorerAddress(ctx.program.programId),
    agent: ctx.agent.publicKey.toBase58(),
    policy_pda: ctx.policyPda.toBase58(),
    policy_explorer_url: explorerAddress(ctx.policyPda)
  };

  if (!policy) {
    return base;
  }

  return {
    ...base,
    owner: policy.owner.toBase58(),
    daily_buy_limit_microusdc: policy.dailyBuyLimitMicrousdc.toString(),
    per_trade_buy_limit_microusdc: policy.perTradeBuyLimitMicrousdc.toString(),
    daily_buy_used_microusdc: policy.dailyBuyUsedMicrousdc.toString(),
    current_day_index: policy.currentDayIndex.toString(),
    next_trade_seq: policy.nextTradeSeq.toString(),
    halted: policy.halted
  };
}

async function initializePolicy(ctx: Context): Promise<void> {
  if (!ctx.owner) {
    throw new Error("Owner keypair is required to initialize policy.");
  }

  const existing = await fetchPolicy(ctx);
  if (existing) {
    console.log("Policy already initialized.");
    printPolicy(ctx, existing);
    return;
  }

  const dailyLimit = usdcToMicros(env("DAILY_BUY_LIMIT_USDC", "10"));
  const perTradeLimit = usdcToMicros(env("PER_TRADE_BUY_LIMIT_USDC", "5"));

  const signature = await ctx.program.methods
    .initializePolicy(dailyLimit, perTradeLimit)
      .accounts({
      owner: ctx.owner.publicKey,
      agent: ctx.agent.publicKey,
      policy: ctx.policyPda,
      systemProgram: anchor.web3.SystemProgram.programId
    })
    .signers([ctx.agent])
    .rpc();

  console.log(`Initialized policy: ${signature}`);
  console.log(`Explorer: ${explorerTx(signature)}`);
  printPolicy(ctx, await fetchPolicy(ctx));
}

async function requirePolicy(ctx: Context): Promise<any> {
  const policy = await fetchPolicy(ctx);
  if (!policy) {
    throw new Error("Policy is not initialized. Run `npm run devnet:init-policy` first.");
  }
  return policy;
}

async function runSmoke(ctx: Context): Promise<void> {
  if (!ctx.owner) {
    throw new Error("Owner keypair is required for halt/resume smoke checks.");
  }

  const policy = await requirePolicy(ctx);
  const remainingDaily = bnToBigInt(policy.dailyBuyLimitMicrousdc) - bnToBigInt(policy.dailyBuyUsedMicrousdc);
  const perTrade = bnToBigInt(policy.perTradeBuyLimitMicrousdc);
  const requested = bnToBigInt(usdcToMicros(env("SMOKE_BUY_AMOUNT_USDC", "1")));
  const amount = minBigInt([remainingDaily, perTrade, requested]);

  if (amount <= 0n) {
    throw new Error("No daily BUY capacity remains for the devnet smoke trade.");
  }

  const tradeSeq = policy.nextTradeSeq;
  const buySignature = await ctx.program.methods
    .submitTrade(tradeSeq, { buy: {} }, new anchor.BN(amount.toString()))
    .accounts({
      policy: ctx.policyPda,
      agent: ctx.agent.publicKey
    })
    .signers([ctx.agent])
    .rpc();

  console.log(`Smoke BUY approved: ${buySignature}`);
  console.log(`Explorer: ${explorerTx(buySignature)}`);

  const haltSignature = await ctx.program.methods
    .setHalt(true)
    .accounts({
      policy: ctx.policyPda,
      owner: ctx.owner.publicKey
    })
    .rpc();

  console.log(`Policy halted: ${haltSignature}`);
  console.log(`Explorer: ${explorerTx(haltSignature)}`);

  const haltedPolicy = await requirePolicy(ctx);
  try {
    await ctx.program.methods
      .submitTrade(haltedPolicy.nextTradeSeq, { sell: {} }, new anchor.BN("1"))
      .accounts({
        policy: ctx.policyPda,
        agent: ctx.agent.publicKey
      })
      .signers([ctx.agent])
      .rpc();
    throw new Error("Halted policy unexpectedly approved a trade.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("unexpectedly approved")) {
      throw error;
    }
    console.log("Halted trade rejection observed.");
  }

  const resumeSignature = await ctx.program.methods
    .setHalt(false)
    .accounts({
      policy: ctx.policyPda,
      owner: ctx.owner.publicKey
    })
    .rpc();

  console.log(`Policy resumed: ${resumeSignature}`);
  console.log(`Explorer: ${explorerTx(resumeSignature)}`);
  printPolicy(ctx, await fetchPolicy(ctx));
}

async function submitTrade(ctx: Context, sideArg: string | undefined, amountArg: string | undefined, sequenceArg: string | undefined): Promise<void> {
  const side = (sideArg || "").toUpperCase();
  if (side !== "BUY" && side !== "SELL") {
    throw new Error("Usage: ts-node scripts/devnet-policy.ts submit <BUY|SELL> <amount_usdc> <sequence>");
  }
  if (!sequenceArg || !/^\d+$/.test(sequenceArg)) {
    throw new Error(`Invalid trade sequence: ${sequenceArg || ""}`);
  }

  await requirePolicy(ctx);

  const sidePayload = side === "BUY" ? { buy: {} } : { sell: {} };
  const amount = usdcToMicros(amountArg || "");
  const sequence = new anchor.BN(sequenceArg);
  const builder = ctx.program.methods
    .submitTrade(sequence, sidePayload, amount)
    .accounts({
      policy: ctx.policyPda,
      agent: ctx.agent.publicKey
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
      policy_pda: ctx.policyPda.toBase58(),
      program_id: ctx.program.programId.toBase58()
    }));
  } catch (error) {
    const reason = policyRejectionReason(error);
    if (!reason) {
      throw error;
    }

    console.log(JSON.stringify({
      approved: false,
      reason,
      tx_signature: null,
      policy_pda: ctx.policyPda.toBase58(),
      program_id: ctx.program.programId.toBase58()
    }));
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !["init", "status", "status-json", "smoke", "submit"].includes(command)) {
    throw new Error("Usage: ts-node scripts/devnet-policy.ts <init|status|status-json|smoke|submit>");
  }

  const ctx = await buildContext(command === "init" || command === "smoke" ? "owner" : "agent");
  if (command === "init") {
    await initializePolicy(ctx);
  } else if (command === "status") {
    printPolicy(ctx, await fetchPolicy(ctx));
  } else if (command === "status-json") {
    console.log(JSON.stringify(policyStatusJson(ctx, await fetchPolicy(ctx))));
  } else if (command === "smoke") {
    await runSmoke(ctx);
  } else {
    await submitTrade(ctx, process.argv[3], process.argv[4], process.argv[5]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
