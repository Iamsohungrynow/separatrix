/**
 * Leash instruction builder + account decoder.
 *
 * Pure, dependency-light, and shared between the browser owner UI and the Node
 * verification script (scripts/verify-owner-ix.js) so the bytes the page sends
 * are exactly the bytes the verifier checks against Anchor. Give it the
 * @solana/web3.js module (global `solanaWeb3` in the browser, `require` in Node)
 * and the program id; it returns a small client with one method per instruction.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LeashIx = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

  const DISCRIMINATORS = {
    create_leash: [78, 13, 81, 231, 46, 252, 193, 74],
    deposit: [242, 35, 198, 137, 82, 225, 242, 182],
    update_limits: [89, 37, 137, 60, 75, 70, 48, 194],
    set_halt: [212, 192, 179, 66, 23, 73, 197, 15],
    set_allowlist: [141, 30, 41, 131, 132, 7, 216, 134],
    withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  };
  const LEASH_STATE_DISCRIMINATOR = [114, 236, 199, 219, 101, 62, 224, 191];

  function u64le(value) {
    let v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n) throw new Error("u64 cannot be negative: " + value);
    if (v > 0xffffffffffffffffn) throw new Error("u64 out of range: " + value);
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      bytes[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return bytes;
  }

  function u32le(value) {
    const bytes = new Uint8Array(4);
    let v = value >>> 0;
    for (let i = 0; i < 4; i++) {
      bytes[i] = v & 0xff;
      v >>>= 8;
    }
    return bytes;
  }

  function boolByte(value) {
    return new Uint8Array([value ? 1 : 0]);
  }

  function concat(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  function readU64le(data, offset) {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
    return v;
  }

  function readI64le(data, offset) {
    let v = readU64le(data, offset);
    if (v >= 1n << 63n) v -= 1n << 64n;
    return v;
  }

  function readU32le(data, offset) {
    return (
      (data[offset] |
        (data[offset + 1] << 8) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 24)) >>>
      0
    );
  }

  return function makeLeashClient(web3, programIdInput) {
    const PublicKey = web3.PublicKey;
    const TransactionInstruction = web3.TransactionInstruction;
    const programId = new PublicKey(programIdInput);
    const systemProgram = new PublicKey(SYSTEM_PROGRAM_ID);
    const enc = (s) => new TextEncoder().encode(s);

    function toPk(value) {
      return value instanceof PublicKey ? value : new PublicKey(value);
    }

    function deriveLeash(agent) {
      const agentPk = toPk(agent);
      const [leashPda] = PublicKey.findProgramAddressSync(
        [enc("leash"), agentPk.toBuffer()],
        programId
      );
      const [vaultPda] = PublicKey.findProgramAddressSync(
        [enc("vault"), leashPda.toBuffer()],
        programId
      );
      return { leashPda, vaultPda };
    }

    function meta(pubkey, isSigner, isWritable) {
      return { pubkey: toPk(pubkey), isSigner, isWritable };
    }

    function build(discName, keys, argChunks) {
      const data = concat([Uint8Array.from(DISCRIMINATORS[discName]), ...argChunks]);
      return new TransactionInstruction({ programId, keys, data });
    }

    return {
      programId,
      DISCRIMINATORS,
      LEASH_STATE_DISCRIMINATOR,
      deriveLeash,

      createLeash({ owner, agent, perTxCapLamports, dailyCapLamports, allowlistEnforced }) {
        const { leashPda, vaultPda } = deriveLeash(agent);
        return build(
          "create_leash",
          [
            meta(owner, true, true),
            meta(agent, false, false),
            meta(leashPda, false, true),
            meta(vaultPda, false, false),
            meta(systemProgram, false, false),
          ],
          [u64le(perTxCapLamports), u64le(dailyCapLamports), boolByte(allowlistEnforced)]
        );
      },

      deposit({ depositor, agent, amountLamports }) {
        const { leashPda, vaultPda } = deriveLeash(agent);
        return build(
          "deposit",
          [
            meta(depositor, true, true),
            meta(leashPda, false, false),
            meta(vaultPda, false, true),
            meta(systemProgram, false, false),
          ],
          [u64le(amountLamports)]
        );
      },

      updateLimits({ owner, agent, perTxCapLamports, dailyCapLamports }) {
        const { leashPda } = deriveLeash(agent);
        return build(
          "update_limits",
          [meta(leashPda, false, true), meta(owner, true, false)],
          [u64le(perTxCapLamports), u64le(dailyCapLamports)]
        );
      },

      setHalt({ owner, agent, halted }) {
        const { leashPda } = deriveLeash(agent);
        return build(
          "set_halt",
          [meta(leashPda, false, true), meta(owner, true, false)],
          [boolByte(halted)]
        );
      },

      setAllowlist({ owner, agent, enforced, recipients }) {
        const { leashPda } = deriveLeash(agent);
        const list = recipients.map(toPk);
        if (list.length > 8) throw new Error("allowlist holds at most 8 recipients");
        const recipientBytes = concat([u32le(list.length), ...list.map((pk) => pk.toBytes())]);
        return build(
          "set_allowlist",
          [meta(leashPda, false, true), meta(owner, true, false)],
          [boolByte(enforced), recipientBytes]
        );
      },

      withdraw({ owner, agent, amountLamports }) {
        const { leashPda, vaultPda } = deriveLeash(agent);
        return build(
          "withdraw",
          [
            meta(leashPda, false, false),
            meta(owner, true, true),
            meta(vaultPda, false, true),
            meta(systemProgram, false, false),
          ],
          [u64le(amountLamports)]
        );
      },

      /** Decode a raw LeashState account (including the 8-byte discriminator). */
      decodeLeash(data) {
        for (let i = 0; i < 8; i++) {
          if (data[i] !== LEASH_STATE_DISCRIMINATOR[i]) {
            throw new Error("not a LeashState account (discriminator mismatch)");
          }
        }
        let o = 8;
        const owner = new PublicKey(data.slice(o, o + 32));
        o += 32;
        const agent = new PublicKey(data.slice(o, o + 32));
        o += 32;
        const perTxCapLamports = readU64le(data, o); o += 8;
        const dailyCapLamports = readU64le(data, o); o += 8;
        const spentTodayLamports = readU64le(data, o); o += 8;
        const currentDayIndex = readI64le(data, o); o += 8;
        const totalSpentLamports = readU64le(data, o); o += 8;
        const spendCount = readU64le(data, o); o += 8;
        const halted = data[o] !== 0; o += 1;
        const allowlistEnforced = data[o] !== 0; o += 1;
        const recipientCount = readU32le(data, o); o += 4;
        const allowedRecipients = [];
        for (let i = 0; i < recipientCount; i++) {
          allowedRecipients.push(new PublicKey(data.slice(o, o + 32)));
          o += 32;
        }
        const bump = data[o]; o += 1;
        const vaultBump = data[o]; o += 1;
        return {
          owner,
          agent,
          perTxCapLamports,
          dailyCapLamports,
          spentTodayLamports,
          currentDayIndex,
          totalSpentLamports,
          spendCount,
          halted,
          allowlistEnforced,
          allowedRecipients,
          bump,
          vaultBump,
        };
      },
    };
  };
});
