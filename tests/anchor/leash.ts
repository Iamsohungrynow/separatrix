import * as anchor from "@coral-xyz/anchor";
import { AnchorError } from "@coral-xyz/anchor";
import { assert } from "chai";

const LAMPORTS_PER_SOL = anchor.web3.LAMPORTS_PER_SOL;

describe("leash", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Leash as any;

  function assertAnchorError(error: unknown, code: string): void {
    assert.instanceOf(error, AnchorError);
    assert.equal((error as AnchorError).error.errorCode.code, code);
  }

  function derivePdas(agent: anchor.web3.PublicKey): {
    leashPda: anchor.web3.PublicKey;
    vaultPda: anchor.web3.PublicKey;
  } {
    const [leashPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("leash"), agent.toBuffer()],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), leashPda.toBuffer()],
      program.programId
    );
    return { leashPda, vaultPda };
  }

  async function createLeash(
    agent: anchor.web3.Keypair,
    perTxCap = 0.5 * LAMPORTS_PER_SOL,
    dailyCap = 0.8 * LAMPORTS_PER_SOL,
    allowlistEnforced = false
  ): Promise<{ leashPda: anchor.web3.PublicKey; vaultPda: anchor.web3.PublicKey }> {
    const { leashPda, vaultPda } = derivePdas(agent.publicKey);

    await program.methods
      .createLeash(new anchor.BN(perTxCap), new anchor.BN(dailyCap), allowlistEnforced)
      .accounts({
        owner: provider.wallet.publicKey,
        agent: agent.publicKey,
        leash: leashPda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .rpc();

    return { leashPda, vaultPda };
  }

  async function deposit(
    leashPda: anchor.web3.PublicKey,
    vaultPda: anchor.web3.PublicKey,
    lamports: number
  ): Promise<void> {
    await program.methods
      .deposit(new anchor.BN(lamports))
      .accounts({
        depositor: provider.wallet.publicKey,
        leash: leashPda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .rpc();
  }

  function spend(
    agent: anchor.web3.Keypair,
    leashPda: anchor.web3.PublicKey,
    vaultPda: anchor.web3.PublicKey,
    recipient: anchor.web3.PublicKey,
    lamports: number
  ): Promise<string> {
    return program.methods
      .spend(new anchor.BN(lamports))
      .accounts({
        leash: leashPda,
        agent: agent.publicKey,
        vault: vaultPda,
        recipient,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([agent])
      .rpc();
  }

  async function expectError(action: Promise<unknown>, code: string): Promise<void> {
    let caught: unknown = null;
    try {
      await action;
    } catch (error) {
      caught = error;
    }
    assert.isNotNull(caught, `expected ${code} but the transaction succeeded`);
    assertAnchorError(caught, code);
  }

  it("creates leash state without requiring agent consent", async () => {
    const agent = anchor.web3.Keypair.generate();
    const { leashPda } = await createLeash(agent);
    const leash = await program.account["leashState"].fetch(leashPda);

    assert.equal(leash.owner.toBase58(), provider.wallet.publicKey.toBase58());
    assert.equal(leash.agent.toBase58(), agent.publicKey.toBase58());
    assert.equal(leash.perTxCapLamports.toNumber(), 0.5 * LAMPORTS_PER_SOL);
    assert.equal(leash.dailyCapLamports.toNumber(), 0.8 * LAMPORTS_PER_SOL);
    assert.equal(leash.spentTodayLamports.toNumber(), 0);
    assert.equal(leash.spendCount.toNumber(), 0);
    assert.equal(leash.halted, false);
    assert.equal(leash.allowlistEnforced, false);
    assert.deepEqual(leash.allowedRecipients, []);
  });

  it("rejects invalid limits", async () => {
    const agent = anchor.web3.Keypair.generate();
    await expectError(
      createLeash(agent, 2 * LAMPORTS_PER_SOL, 1 * LAMPORTS_PER_SOL),
      "InvalidLimits"
    );
  });

  it("moves real lamports on an approved spend", async () => {
    const agent = anchor.web3.Keypair.generate();
    const recipient = anchor.web3.Keypair.generate().publicKey;
    const { leashPda, vaultPda } = await createLeash(agent);
    await deposit(leashPda, vaultPda, 1 * LAMPORTS_PER_SOL);

    const amount = 0.3 * LAMPORTS_PER_SOL;
    await spend(agent, leashPda, vaultPda, recipient, amount);

    const recipientBalance = await provider.connection.getBalance(recipient, "confirmed");
    const vaultBalance = await provider.connection.getBalance(vaultPda, "confirmed");
    assert.equal(recipientBalance, amount);
    assert.equal(vaultBalance, 0.7 * LAMPORTS_PER_SOL);

    const leash = await program.account["leashState"].fetch(leashPda);
    assert.equal(leash.spentTodayLamports.toNumber(), amount);
    assert.equal(leash.totalSpentLamports.toNumber(), amount);
    assert.equal(leash.spendCount.toNumber(), 1);
  });

  it("enforces the per-transaction cap", async () => {
    const agent = anchor.web3.Keypair.generate();
    const recipient = anchor.web3.Keypair.generate().publicKey;
    const { leashPda, vaultPda } = await createLeash(agent);
    await deposit(leashPda, vaultPda, 2 * LAMPORTS_PER_SOL);

    await expectError(
      spend(agent, leashPda, vaultPda, recipient, 0.5 * LAMPORTS_PER_SOL + 1),
      "PerTxCapExceeded"
    );
  });

  it("enforces the daily cap across spends", async () => {
    const agent = anchor.web3.Keypair.generate();
    const recipient = anchor.web3.Keypair.generate().publicKey;
    const { leashPda, vaultPda } = await createLeash(agent);
    await deposit(leashPda, vaultPda, 2 * LAMPORTS_PER_SOL);

    await spend(agent, leashPda, vaultPda, recipient, 0.5 * LAMPORTS_PER_SOL);
    await expectError(
      spend(agent, leashPda, vaultPda, recipient, 0.5 * LAMPORTS_PER_SOL),
      "DailyCapExceeded"
    );

    await spend(agent, leashPda, vaultPda, recipient, 0.3 * LAMPORTS_PER_SOL);
    const leash = await program.account["leashState"].fetch(leashPda);
    assert.equal(leash.spentTodayLamports.toNumber(), 0.8 * LAMPORTS_PER_SOL);
  });

  it("enforces the recipient allowlist when enabled", async () => {
    const agent = anchor.web3.Keypair.generate();
    const allowed = anchor.web3.Keypair.generate().publicKey;
    const stranger = anchor.web3.Keypair.generate().publicKey;
    const { leashPda, vaultPda } = await createLeash(agent);
    await deposit(leashPda, vaultPda, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .setAllowlist(true, [allowed])
      .accounts({
        leash: leashPda,
        owner: provider.wallet.publicKey
      })
      .rpc();

    await expectError(
      spend(agent, leashPda, vaultPda, stranger, 1000),
      "RecipientNotAllowed"
    );
    const signature = await spend(agent, leashPda, vaultPda, allowed, 1000);
    assert.isString(signature);
  });

  it("blocks all spending while halted", async () => {
    const agent = anchor.web3.Keypair.generate();
    const recipient = anchor.web3.Keypair.generate().publicKey;
    const { leashPda, vaultPda } = await createLeash(agent);
    await deposit(leashPda, vaultPda, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .setHalt(true)
      .accounts({ leash: leashPda, owner: provider.wallet.publicKey })
      .rpc();
    await expectError(spend(agent, leashPda, vaultPda, recipient, 1000), "LeashHalted");

    await program.methods
      .setHalt(false)
      .accounts({ leash: leashPda, owner: provider.wallet.publicKey })
      .rpc();
    const signature = await spend(agent, leashPda, vaultPda, recipient, 1000);
    assert.isString(signature);
  });

  it("rejects spends that exceed the vault balance", async () => {
    const agent = anchor.web3.Keypair.generate();
    const recipient = anchor.web3.Keypair.generate().publicKey;
    const { leashPda, vaultPda } = await createLeash(
      agent,
      5 * LAMPORTS_PER_SOL,
      5 * LAMPORTS_PER_SOL
    );
    await deposit(leashPda, vaultPda, 0.01 * LAMPORTS_PER_SOL);

    await expectError(
      spend(agent, leashPda, vaultPda, recipient, 1 * LAMPORTS_PER_SOL),
      "VaultInsufficient"
    );
  });

  it("rejects unauthorized owner and agent", async () => {
    const agent = anchor.web3.Keypair.generate();
    const outsider = anchor.web3.Keypair.generate();
    const recipient = anchor.web3.Keypair.generate().publicKey;
    const { leashPda, vaultPda } = await createLeash(agent);
    await deposit(leashPda, vaultPda, 1 * LAMPORTS_PER_SOL);

    await expectError(
      program.methods
        .setHalt(true)
        .accounts({ leash: leashPda, owner: outsider.publicKey })
        .signers([outsider])
        .rpc(),
      "UnauthorizedOwner"
    );

    await expectError(
      spend(outsider, leashPda, vaultPda, recipient, 1000),
      "UnauthorizedAgent"
    );
  });

  it("lets the owner update limits and withdraw the vault", async () => {
    const agent = anchor.web3.Keypair.generate();
    const { leashPda, vaultPda } = await createLeash(agent);
    await deposit(leashPda, vaultPda, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .updateLimits(new anchor.BN(1 * LAMPORTS_PER_SOL), new anchor.BN(2 * LAMPORTS_PER_SOL))
      .accounts({ leash: leashPda, owner: provider.wallet.publicKey })
      .rpc();
    const leash = await program.account["leashState"].fetch(leashPda);
    assert.equal(leash.perTxCapLamports.toNumber(), 1 * LAMPORTS_PER_SOL);
    assert.equal(leash.dailyCapLamports.toNumber(), 2 * LAMPORTS_PER_SOL);

    await program.methods
      .withdraw(new anchor.BN(1 * LAMPORTS_PER_SOL))
      .accounts({
        leash: leashPda,
        owner: provider.wallet.publicKey,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .rpc();
    const vaultBalance = await provider.connection.getBalance(vaultPda, "confirmed");
    assert.equal(vaultBalance, 0);
  });
});
