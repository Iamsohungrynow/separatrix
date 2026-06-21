/**
 * Land an over-cap BUY on devnet as a FAILED on-chain transaction.
 *
 * The normal bridge (`devnet-policy.ts submit`) rejects over-cap trades at
 * transaction preflight, so they never hit the chain. This script sends the
 * same instruction with `skipPreflight: true` so the transaction lands and is
 * rejected in-band by the program, producing a real, explorer-verifiable failed
 * tx whose logs show the `TRADE_TOO_BIG` (custom program error 0x1771).
 *
 * Usage: npx ts-node scripts/land-rejection.ts
 */
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const OVER_CAP_MICROUSDC = new anchor.BN(99_000_000); // 99 USDC, far above the 5 USDC per-trade cap

function loadKeypair(p: string): anchor.web3.Keypair {
  const secret = JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main(): Promise<void> {
  const agent = loadKeypair(process.env.AGENT_WALLET_PATH || "keys/agent-devnet.json");
  const connection = new anchor.web3.Connection(RPC, "confirmed");

  const wallet = {
    publicKey: agent.publicKey,
    signTransaction: async <T extends anchor.web3.Transaction>(tx: T): Promise<T> => {
      tx.partialSign(agent);
      return tx;
    },
    signAllTransactions: async <T extends anchor.web3.Transaction>(txs: T[]): Promise<T[]> => {
      txs.forEach((tx) => tx.partialSign(agent));
      return txs;
    },
  };

  const provider = new anchor.AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/policy_controller.json"), "utf8"));
  const program = new anchor.Program(idl, provider) as any;

  const [policyPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), agent.publicKey.toBuffer()],
    program.programId
  );

  const policy = await program.account.agentPolicy.fetch(policyPda);
  const seq = policy.nextTradeSeq;
  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`Policy PDA: ${policyPda.toBase58()}`);
  console.log(`next_trade_seq: ${seq.toString()}  per_trade_cap_microusdc: ${policy.perTradeBuyLimitMicrousdc.toString()}`);
  console.log(`Submitting BUY ${OVER_CAP_MICROUSDC.toString()} microUSDC (over cap) with skipPreflight...`);

  const tx: anchor.web3.Transaction = await program.methods
    .submitTrade(seq, { buy: {} }, OVER_CAP_MICROUSDC)
    .accounts({ policy: policyPda, agent: agent.publicKey })
    .transaction();

  const latest = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = agent.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(agent);

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  console.log(`Signature: ${signature}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

  const conf = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed"
  );

  if (conf.value.err) {
    console.log(`On-chain result: REJECTED (err = ${JSON.stringify(conf.value.err)})`);
    console.log("Expected program error: TRADE_TOO_BIG (custom 0x1771 / 6001).");
  } else {
    console.error("UNEXPECTED: the over-cap trade was not rejected on-chain.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
