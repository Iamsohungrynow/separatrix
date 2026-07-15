/**
 * Land an over-cap spend on devnet as a FAILED on-chain transaction.
 *
 * The normal bridge (`devnet-leash.ts spend`) rejects over-cap spends at
 * transaction preflight, so they never hit the chain. This script sends the
 * same instruction with `skipPreflight: true` so the transaction lands and is
 * rejected in-band by the program, producing a real, explorer-verifiable failed
 * tx whose logs show `PerTxCapExceeded` (custom program error 0x1771 / 6001).
 *
 * Usage: npx ts-node scripts/land-rejection.ts
 */
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

function loadKeypair(p: string): anchor.web3.Keypair {
  const secret = JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main(): Promise<void> {
  const agent = loadKeypair(process.env.AGENT_WALLET_PATH || "keys/agent-devnet.json");
  const treasury = loadKeypair(process.env.TREASURY_WALLET_PATH || "keys/treasury-devnet.json");
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

  const idl = JSON.parse(fs.readFileSync(path.resolve("idl/leash.json"), "utf8"));
  const program = new anchor.Program(idl, provider) as any;

  const [leashPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("leash"), agent.publicKey.toBuffer()],
    program.programId
  );
  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), leashPda.toBuffer()],
    program.programId
  );

  const leash = await program.account.leashState.fetch(leashPda);
  const overCap = leash.perTxCapLamports.add(new anchor.BN(1_000_000));
  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`Leash PDA: ${leashPda.toBase58()}`);
  console.log(`per_tx_cap_lamports: ${leash.perTxCapLamports.toString()}`);
  console.log(`Submitting spend of ${overCap.toString()} lamports (over cap) with skipPreflight...`);

  const tx: anchor.web3.Transaction = await program.methods
    .spend(overCap)
    .accounts({
      leash: leashPda,
      agent: agent.publicKey,
      vault: vaultPda,
      recipient: treasury.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
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
    console.log("Expected program error: PerTxCapExceeded (custom 0x1771 / 6001).");
  } else {
    console.error("UNEXPECTED: the over-cap spend was not rejected on-chain.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
