/* Leash owner console — connect a wallet and manage an agent's leash on devnet.
   Depends on the vendored @solana/web3.js (global solanaWeb3) and leash-ix.js
   (global LeashIx). No build step; open the file or serve the folder. */

const PROGRAM_ID = "EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV";
const RPC_URL = "https://api.devnet.solana.com";
const LAMPORTS_PER_SOL = 1_000_000_000;

// The vendored web3 build ships its own Buffer; expose it globally so legacy
// Transaction serialization works in the browser.
if (typeof window !== "undefined" && !window.Buffer && solanaWeb3.Buffer) {
  window.Buffer = solanaWeb3.Buffer;
}

const connection = new solanaWeb3.Connection(RPC_URL, "confirmed");
const leash = LeashIx(solanaWeb3, PROGRAM_ID);

let provider = null; // wallet provider (Phantom-compatible)
let ownerPubkey = null; // connected wallet
let currentAgent = null; // PublicKey being managed

/* ---------- dom helpers ---------- */

const $ = (id) => document.getElementById(id);
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}
function setHtml(id, html) {
  const el = $(id);
  if (el) el.innerHTML = html;
}
function short(addr) {
  const s = String(addr);
  return s.length <= 12 ? s : `${s.slice(0, 5)}…${s.slice(-5)}`;
}
function explorerAddr(addr) {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}
function explorerTx(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}
function toSol(lamports) {
  return Number(BigInt(lamports)) / LAMPORTS_PER_SOL;
}
function solToLamports(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid SOL amount: ${value}`);
  return Math.round(n * LAMPORTS_PER_SOL);
}

/* ---------- status line ---------- */

let statusTimer = null;
function status(message, kind = "info") {
  const el = $("status");
  if (!el) return;
  el.className = `status ${kind}`;
  el.innerHTML = message;
  el.hidden = false;
  if (statusTimer) clearTimeout(statusTimer);
  if (kind === "ok") statusTimer = setTimeout(() => (el.hidden = true), 12000);
}
function txStatus(prefix, signature) {
  status(`${prefix} <a href="${explorerTx(signature)}" target="_blank" rel="noreferrer">${short(signature)} &#8599;</a>`, "ok");
}
function errText(err) {
  const raw = err && err.message ? err.message : String(err);
  const map = {
    LeashHalted: "the leash is halted",
    PerTxCapExceeded: "over the per-transaction cap",
    DailyCapExceeded: "over the daily budget",
    RecipientNotAllowed: "recipient not on the allowlist",
    VaultInsufficient: "vault balance too low",
    InvalidLimits: "invalid limits (per-tx must be > 0 and <= daily)",
    UnauthorizedOwner: "connected wallet is not this leash's owner",
    AllowlistTooLarge: "allowlist holds at most 8 recipients",
    InvalidAmount: "amount must be greater than zero",
  };
  for (const [code, human] of Object.entries(map)) {
    if (raw.includes(code)) return `${human} (${code})`;
  }
  if (/User rejected|rejected the request/i.test(raw)) return "request rejected in the wallet";
  return raw;
}

/* ---------- wallet ---------- */

function detectProvider() {
  if (window.phantom && window.phantom.solana) return window.phantom.solana;
  if (window.solana) return window.solana;
  return null;
}

async function connectWallet() {
  provider = detectProvider();
  if (!provider) {
    status(
      'No Solana wallet found. Install <a href="https://phantom.app" target="_blank" rel="noreferrer">Phantom</a> and reload.',
      "error"
    );
    return;
  }
  try {
    const resp = await provider.connect();
    ownerPubkey = resp.publicKey ? resp.publicKey : provider.publicKey;
    onWalletConnected();
  } catch (err) {
    status(`Wallet connection failed: ${errText(err)}`, "error");
  }
}

function onWalletConnected() {
  $("btn-connect").hidden = true;
  const bar = $("wallet-bar");
  bar.hidden = false;
  setHtml(
    "wallet-addr",
    `<a href="${explorerAddr(ownerPubkey.toBase58())}" target="_blank" rel="noreferrer">${short(ownerPubkey.toBase58())} &#8599;</a>`
  );
  document.body.dataset.wallet = "connected";
  refreshOwnerBalance();
  if (provider.on) {
    provider.on("disconnect", handleDisconnect);
    provider.on("accountChanged", (pk) => {
      if (!pk) return handleDisconnect();
      ownerPubkey = pk;
      onWalletConnected();
    });
  }
  status("Wallet connected. Enter an agent address to manage its leash.", "ok");
}

function handleDisconnect() {
  ownerPubkey = null;
  document.body.dataset.wallet = "disconnected";
  $("btn-connect").hidden = false;
  $("wallet-bar").hidden = true;
}

async function refreshOwnerBalance() {
  try {
    const bal = await connection.getBalance(ownerPubkey, "confirmed");
    setText("wallet-balance", `${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  } catch (_) {
    setText("wallet-balance", "");
  }
}

/* ---------- agent + state ---------- */

function readAgentInput() {
  const raw = $("agent-input").value.trim();
  if (!raw) throw new Error("Enter the agent address you want to leash.");
  return new solanaWeb3.PublicKey(raw);
}

async function loadState() {
  try {
    currentAgent = readAgentInput();
  } catch (err) {
    status(errText(err), "error");
    return;
  }
  const { leashPda, vaultPda } = leash.deriveLeash(currentAgent);
  $("state-panel").hidden = false;
  $("actions").hidden = false;
  setHtml("st-agent", linkAddr(currentAgent.toBase58()));
  setHtml("st-leash-pda", linkAddr(leashPda.toBase58()));
  setHtml("st-vault-pda", linkAddr(vaultPda.toBase58()));

  try {
    const info = await connection.getAccountInfo(leashPda, "confirmed");
    const vaultLamports = await connection.getBalance(vaultPda, "confirmed");
    if (!info) {
      renderUninitialized(vaultLamports);
      return;
    }
    const state = leash.decodeLeash(info.data);
    renderState(state, vaultLamports);
  } catch (err) {
    status(`Could not read leash state: ${errText(err)}`, "error");
  }
}

function linkAddr(addr) {
  return `<a href="${explorerAddr(addr)}" target="_blank" rel="noreferrer">${short(addr)} &#8599;</a>`;
}

function renderUninitialized(vaultLamports) {
  $("state-body").dataset.state = "uninitialized";
  setText("st-status", "not created");
  setText("st-owner", "—");
  setText("st-per-tx", "—");
  setText("st-daily", "—");
  setText("st-spent", "—");
  setText("st-vault", `${toSol(vaultLamports).toFixed(4)} SOL`);
  setText("st-allowlist", "—");
  setText("st-spend-count", "—");
  status("No leash exists for this agent yet. Use “Create leash” below.", "info");
  toggleOwnerActions(false);
}

function renderState(state, vaultLamports) {
  $("state-body").dataset.state = state.halted ? "halted" : "active";
  setText("st-status", state.halted ? "HALTED" : "active");
  setHtml("st-owner", linkAddr(state.owner.toBase58()));
  setText("st-per-tx", `${toSol(state.perTxCapLamports).toFixed(4)} SOL`);
  const used = toSol(state.spentTodayLamports);
  const cap = toSol(state.dailyCapLamports);
  setText("st-daily", `${cap.toFixed(4)} SOL`);
  setText("st-spent", `${used.toFixed(4)} / ${cap.toFixed(4)} SOL`);
  const frac = cap > 0 ? Math.min(1, used / cap) : 0;
  $("st-budget-bar").style.width = `${frac * 100}%`;
  $("st-budget-bar").dataset.kind = frac >= 1 ? "full" : frac >= 0.7 ? "warn" : "ok";
  setText("st-vault", `${toSol(vaultLamports).toFixed(4)} SOL`);
  const recips = state.allowedRecipients.map((r) => r.toBase58());
  setText(
    "st-allowlist",
    state.allowlistEnforced ? (recips.length ? `${recips.length} recipient(s)` : "enforced, empty") : "not enforced"
  );
  setHtml(
    "st-allowlist-detail",
    recips.length ? recips.map((r) => linkAddr(r)).join(" · ") : ""
  );
  setText("st-spend-count", String(state.spendCount));

  const isOwner = ownerPubkey && state.owner.toBase58() === ownerPubkey.toBase58();
  toggleOwnerActions(isOwner);
  $("halt-btn").textContent = state.halted ? "Resume agent" : "Halt agent";
  $("halt-btn").dataset.halted = String(state.halted);
  if (!isOwner) {
    status("This leash is owned by a different wallet — owner actions are disabled.", "info");
  }
}

function toggleOwnerActions(isOwner) {
  document.querySelectorAll("[data-owner-only]").forEach((el) => {
    el.disabled = !isOwner;
  });
}

/* ---------- transactions ---------- */

async function sendIx(instruction, pendingLabel) {
  if (!provider || !ownerPubkey) {
    status("Connect a wallet first.", "error");
    return null;
  }
  status(`${pendingLabel}… confirm in your wallet.`, "info");
  const tx = new solanaWeb3.Transaction().add(instruction);
  tx.feePayer = ownerPubkey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const { signature } = await provider.signAndSendTransaction(tx);
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

function withBusy(fn) {
  return async (event) => {
    const btn = event && event.currentTarget;
    if (btn) btn.disabled = true;
    try {
      await fn();
      await loadState();
      refreshOwnerBalance();
    } catch (err) {
      status(errText(err), "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

const doCreate = withBusy(async () => {
  const agent = readAgentInput();
  const perTxCapLamports = solToLamports($("create-per-tx").value);
  const dailyCapLamports = solToLamports($("create-daily").value);
  if (perTxCapLamports > dailyCapLamports) throw new Error("InvalidLimits");
  const allowlistEnforced = $("create-allowlist").checked;
  const sig = await sendIx(
    leash.createLeash({ owner: ownerPubkey, agent, perTxCapLamports, dailyCapLamports, allowlistEnforced }),
    "Creating leash"
  );
  if (sig) txStatus("Leash created:", sig);
});

const doDeposit = withBusy(async () => {
  const amountLamports = solToLamports($("deposit-amount").value);
  const sig = await sendIx(
    leash.deposit({ depositor: ownerPubkey, agent: currentAgent, amountLamports }),
    "Depositing"
  );
  if (sig) txStatus("Deposited:", sig);
});

const doUpdateLimits = withBusy(async () => {
  const perTxCapLamports = solToLamports($("limits-per-tx").value);
  const dailyCapLamports = solToLamports($("limits-daily").value);
  if (perTxCapLamports > dailyCapLamports) throw new Error("InvalidLimits");
  const sig = await sendIx(
    leash.updateLimits({ owner: ownerPubkey, agent: currentAgent, perTxCapLamports, dailyCapLamports }),
    "Updating limits"
  );
  if (sig) txStatus("Limits updated:", sig);
});

const doAllowlist = withBusy(async () => {
  const enforced = $("allowlist-enforced").checked;
  const recipients = $("allowlist-recipients")
    .value.split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new solanaWeb3.PublicKey(s));
  const sig = await sendIx(
    leash.setAllowlist({ owner: ownerPubkey, agent: currentAgent, enforced, recipients }),
    "Setting allowlist"
  );
  if (sig) txStatus("Allowlist updated:", sig);
});

const doHalt = withBusy(async () => {
  const halted = $("halt-btn").dataset.halted !== "true"; // toggle
  const sig = await sendIx(leash.setHalt({ owner: ownerPubkey, agent: currentAgent, halted }), halted ? "Halting" : "Resuming");
  if (sig) txStatus(halted ? "Agent halted:" : "Agent resumed:", sig);
});

const doWithdraw = withBusy(async () => {
  const amountLamports = solToLamports($("withdraw-amount").value);
  const sig = await sendIx(
    leash.withdraw({ owner: ownerPubkey, agent: currentAgent, amountLamports }),
    "Withdrawing"
  );
  if (sig) txStatus("Withdrew:", sig);
});

/* ---------- agent keypair helper (devnet convenience) ---------- */

function generateAgent() {
  const kp = solanaWeb3.Keypair.generate();
  const secret = JSON.stringify(Array.from(kp.secretKey));
  $("agent-input").value = kp.publicKey.toBase58();
  const blob = new Blob([secret], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  setHtml(
    "gen-agent-out",
    `New agent <code>${short(kp.publicKey.toBase58())}</code> — ` +
      `<a href="${url}" download="agent-devnet.json">download keypair JSON</a> ` +
      `<span class="warn-inline">(devnet only — this secret key lives only in this download)</span>`
  );
}

/* ---------- wiring ---------- */

function init() {
  $("btn-connect").addEventListener("click", connectWallet);
  $("btn-disconnect").addEventListener("click", () => provider && provider.disconnect && provider.disconnect());
  $("btn-load").addEventListener("click", loadState);
  $("agent-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadState();
  });
  $("create-form").addEventListener("submit", (e) => (e.preventDefault(), doCreate(e)));
  $("deposit-form").addEventListener("submit", (e) => (e.preventDefault(), doDeposit(e)));
  $("limits-form").addEventListener("submit", (e) => (e.preventDefault(), doUpdateLimits(e)));
  $("allowlist-form").addEventListener("submit", (e) => (e.preventDefault(), doAllowlist(e)));
  $("withdraw-form").addEventListener("submit", (e) => (e.preventDefault(), doWithdraw(e)));
  $("halt-btn").addEventListener("click", doHalt);
  $("btn-gen-agent").addEventListener("click", generateAgent);

  if (detectProvider()) {
    // Try eager connect if the wallet already trusts this origin.
    const p = detectProvider();
    if (p.connect) {
      p.connect({ onlyIfTrusted: true })
        .then((resp) => {
          provider = p;
          ownerPubkey = resp.publicKey || p.publicKey;
          onWalletConnected();
        })
        .catch(() => {});
    }
  }

  // Deep link: owner.html?agent=<pubkey> preloads and reads that agent's leash.
  const params = new URLSearchParams(window.location.search);
  const agentParam = params.get("agent");
  if (agentParam) {
    $("agent-input").value = agentParam;
    loadState();
  }
}

document.addEventListener("DOMContentLoaded", init);
