import * as anchor from "@coral-xyz/anchor";
import { AnchorError } from "@coral-xyz/anchor";
import { assert } from "chai";

describe("policy_controller", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  function assertAnchorError(error: unknown, code: string): void {
    assert.instanceOf(error, AnchorError);
    assert.equal((error as AnchorError).error.errorCode.code, code);
  }

  const program = anchor.workspace.PolicyController as any;

  async function fund(pubkey: anchor.web3.PublicKey): Promise<void> {
    const signature = await provider.connection.requestAirdrop(pubkey, anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(signature, "confirmed");
  }

  function derivePolicyPda(agent: anchor.web3.PublicKey): anchor.web3.PublicKey {
    const [policyPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), agent.toBuffer()],
      program.programId
    );
    return policyPda;
  }

  async function initializePolicy(
    agent: anchor.web3.Keypair,
    dailyBuyLimit = 10_000_000,
    perTradeBuyLimit = 5_000_000
  ): Promise<anchor.web3.PublicKey> {
    const policyPda = derivePolicyPda(agent.publicKey);

    await program.methods
      .initializePolicy(agent.publicKey, new anchor.BN(dailyBuyLimit), new anchor.BN(perTradeBuyLimit))
      .accounts({
        owner: provider.wallet.publicKey,
        policy: policyPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .rpc();

    return policyPda;
  }

  it("initializes policy state", async () => {
    const agent = anchor.web3.Keypair.generate();
    const policyPda = await initializePolicy(agent);
    const policy = await program.account["agentPolicy"].fetch(policyPda);

    assert.equal(policy.agent.toBase58(), agent.publicKey.toBase58());
    assert.equal(policy.nextTradeSeq.toNumber(), 1);
    assert.equal(policy.halted, false);
    assert.equal(policy.dailyBuyLimitMicrousdc.toNumber(), 10_000_000);
  });

  it("updates policy limits", async () => {
    const agent = anchor.web3.Keypair.generate();
    const policyPda = await initializePolicy(agent);

    await program.methods
      .updatePolicy(new anchor.BN(20_000_000), new anchor.BN(8_000_000))
      .accounts({
        policy: policyPda,
        owner: provider.wallet.publicKey
      })
      .rpc();

    const policy = await program.account["agentPolicy"].fetch(policyPda);
    assert.equal(policy.dailyBuyLimitMicrousdc.toNumber(), 20_000_000);
    assert.equal(policy.perTradeBuyLimitMicrousdc.toNumber(), 8_000_000);
  });

  it("rejects invalid policy limits on initialize and update", async () => {
    const agent = anchor.web3.Keypair.generate();
    let initializeError: unknown = null;
    try {
      await initializePolicy(agent, 5_000_000, 6_000_000);
    } catch (error) {
      initializeError = error;
    }
    assert.isNotNull(initializeError);
    assertAnchorError(initializeError, "InvalidPolicy");

    const policyPda = await initializePolicy(agent, 10_000_000, 5_000_000);
    let updateError: unknown = null;
    try {
      await program.methods
        .updatePolicy(new anchor.BN(4_000_000), new anchor.BN(5_000_000))
        .accounts({
          policy: policyPda,
          owner: provider.wallet.publicKey
        })
        .rpc();
    } catch (error) {
      updateError = error;
    }
    assert.isNotNull(updateError);
    assertAnchorError(updateError, "InvalidPolicy");
  });

  it("rejects unauthorized owner and agent signers", async () => {
    const agent = anchor.web3.Keypair.generate();
    const outsider = anchor.web3.Keypair.generate();
    await fund(outsider.publicKey);

    const policyPda = await initializePolicy(agent);

    let ownerError: unknown = null;
    try {
      await program.methods
        .updatePolicy(new anchor.BN(20_000_000), new anchor.BN(8_000_000))
        .accounts({
          policy: policyPda,
          owner: outsider.publicKey
        })
        .signers([outsider])
        .rpc();
    } catch (error) {
      ownerError = error;
    }
    assert.isNotNull(ownerError);
    assertAnchorError(ownerError, "UnauthorizedOwner");

    let agentError: unknown = null;
    try {
      await program.methods
        .submitTrade(new anchor.BN(1), { buy: {} }, new anchor.BN(1_000_000))
        .accounts({
          policy: policyPda,
          agent: outsider.publicKey
        })
        .signers([outsider])
        .rpc();
    } catch (error) {
      agentError = error;
    }
    assert.isNotNull(agentError);
    assertAnchorError(agentError, "UnauthorizedAgent");
  });

  it("halts and resumes agent trading", async () => {
    const agent = anchor.web3.Keypair.generate();
    const policyPda = await initializePolicy(agent);

    await program.methods
      .setHalt(true)
      .accounts({
        policy: policyPda,
        owner: provider.wallet.publicKey
      })
      .rpc();

    let haltError: unknown = null;
    try {
      await program.methods
        .submitTrade(new anchor.BN(1), { buy: {} }, new anchor.BN(1_000_000))
        .accounts({
          policy: policyPda,
          agent: agent.publicKey
        })
        .signers([agent])
        .rpc();
    } catch (error) {
      haltError = error;
    }
    assert.isNotNull(haltError);
    assertAnchorError(haltError, "AgentHalted");

    await program.methods
      .setHalt(false)
      .accounts({
        policy: policyPda,
        owner: provider.wallet.publicKey
      })
      .rpc();

    const resumed = await program.methods
      .submitTrade(new anchor.BN(1), { buy: {} }, new anchor.BN(1_000_000))
      .accounts({
        policy: policyPda,
        agent: agent.publicKey
      })
      .signers([agent])
      .rpc();

    assert.isString(resumed);
  });

  it("rejects oversized buys and invalid sequence", async () => {
    const agent = anchor.web3.Keypair.generate();
    const policyPda = await initializePolicy(agent);

    let oversizedError: unknown = null;
    try {
      await program.methods
        .submitTrade(new anchor.BN(1), { buy: {} }, new anchor.BN(6_000_000))
        .accounts({
          policy: policyPda,
          agent: agent.publicKey
        })
        .signers([agent])
        .rpc();
    } catch (error) {
      oversizedError = error;
    }
    assert.isNotNull(oversizedError);
    assertAnchorError(oversizedError, "TradeTooBig");

    const approved = await program.methods
      .submitTrade(new anchor.BN(1), { buy: {} }, new anchor.BN(5_000_000))
      .accounts({
        policy: policyPda,
        agent: agent.publicKey
      })
      .signers([agent])
      .rpc();

    let sequenceError: unknown = null;
    try {
      await program.methods
        .submitTrade(new anchor.BN(1), { buy: {} }, new anchor.BN(1_000_000))
        .accounts({
          policy: policyPda,
          agent: agent.publicKey
        })
        .signers([agent])
        .rpc();
    } catch (error) {
      sequenceError = error;
    }

    assert.isString(approved);
    assert.isNotNull(sequenceError);
    assertAnchorError(sequenceError, "InvalidTradeSequence");
  });

  it("enforces daily buy cap but allows sells", async () => {
    const agent = anchor.web3.Keypair.generate();
    const policyPda = await initializePolicy(agent);

    await program.methods
      .submitTrade(new anchor.BN(1), { buy: {} }, new anchor.BN(5_000_000))
      .accounts({
        policy: policyPda,
        agent: agent.publicKey
      })
      .signers([agent])
      .rpc();

    await program.methods
      .submitTrade(new anchor.BN(2), { sell: {} }, new anchor.BN(50_000_000))
      .accounts({
        policy: policyPda,
        agent: agent.publicKey
      })
      .signers([agent])
      .rpc();

    let dailyLimitError: unknown = null;
    try {
      await program.methods
        .submitTrade(new anchor.BN(3), { buy: {} }, new anchor.BN(6_000_000))
        .accounts({
          policy: policyPda,
          agent: agent.publicKey
        })
        .signers([agent])
        .rpc();
    } catch (error) {
      dailyLimitError = error;
    }

    const policy = await program.account["agentPolicy"].fetch(policyPda);
    assert.equal(policy.nextTradeSeq.toNumber(), 3);
    assert.equal(policy.dailyBuyUsedMicrousdc.toNumber(), 5_000_000);
    assert.isNotNull(dailyLimitError);
    assertAnchorError(dailyLimitError, "DailyLimitExceeded");
  });
});
