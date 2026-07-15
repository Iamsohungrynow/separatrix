const API_BASE = "http://127.0.0.1:8000";
const REFRESH_MS = 30000;

let hasLoaded = false;
const prev = {};

async function fetchJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

/* ---------- formatting ---------- */

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(value) || 0);
}

function signedUsd(value) {
  const n = Number(value) || 0;
  const abs = formatUsd(Math.abs(n));
  if (n > 0) return { text: `+${abs}`, cls: "pos" };
  if (n < 0) return { text: `-${abs}`, cls: "neg" };
  return { text: abs, cls: "" };
}

function formatNumber(value, fractionDigits = 4) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  });
}

function formatTimestamp(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return value;
  }
}

function formatTime(value) {
  if (!value) return "--";
  try {
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch (_) {
    return value;
  }
}

function microToUsdc(value) {
  return (Number(value) || 0) / 1_000_000;
}

function clamp01(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function shortAddr(addr) {
  if (!addr) return "-";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function explorerLink(url, text) {
  if (!url) return `<code class="addr">${text}</code>`;
  return `<a class="ext" href="${url}" target="_blank" rel="noreferrer">${text} <span class="arrow">&#8599;</span></a>`;
}

function actionView(action) {
  if (action === "BUY") return { cls: "buy", label: "BUY" };
  if (action === "SELL") return { cls: "sell", label: "SELL" };
  return { cls: "other", label: action || "HOLD" };
}

/* ---------- dom helpers ---------- */

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function setKpi(valueId, tileId, text, cls) {
  const el = document.getElementById(valueId);
  if (!el) return;
  const tile = document.getElementById(tileId);
  if (hasLoaded && tile && prev[valueId] !== undefined && prev[valueId] !== text) {
    tile.classList.remove("flash");
    void tile.offsetWidth; // restart the flash animation
    tile.classList.add("flash");
  }
  prev[valueId] = text;
  el.textContent = text;
  el.classList.remove("pos", "neg");
  if (cls) el.classList.add(cls);
}

function setMeter(barId, fraction, kind) {
  const bar = document.getElementById(barId);
  if (!bar) return;
  bar.style.width = `${clamp01(fraction) * 100}%`;
  bar.classList.remove("pos", "neg", "warn");
  if (kind) bar.classList.add(kind);
}

function setConnection(state, text) {
  document.body.dataset.state = state;
  const dot = document.getElementById("conn-dot");
  if (dot) dot.dataset.state = state;
  setText("conn-text", text);
}

function setDot(id, state) {
  const dot = document.getElementById(id);
  if (dot) dot.dataset.state = state;
}

/* ---------- row renderers ---------- */

function renderPositionRow(pos) {
  return `
    <tr>
      <td class="asset">${pos.asset}</td>
      <td class="num">${formatNumber(pos.quantity, 6)}</td>
      <td class="num">${formatNumber(pos.avg_cost, 4)}</td>
      <td class="muted">${formatTimestamp(pos.updated_at)}</td>
    </tr>`;
}

function renderSignalRow(sig) {
  const act = actionView(sig.action);
  const validated = sig.validated
    ? '<span class="flag yes">yes</span>'
    : '<span class="flag no">no</span>';
  return `
    <tr>
      <td class="muted">${formatTimestamp(sig.created_at)}</td>
      <td class="asset">${sig.asset}</td>
      <td><span class="pill ${act.cls}">${act.label}</span></td>
      <td class="num">${Number(sig.sentiment).toFixed(2)}</td>
      <td class="num">${Number(sig.confidence).toFixed(2)}</td>
      <td class="num">${formatNumber(sig.position_size_usdc, 2)}</td>
      <td>${validated}</td>
    </tr>`;
}

function renderTradeRow(trade) {
  const act = actionView(trade.action);
  const pnl = Number(trade.realized_pnl) || 0;
  const pnlCls = pnl > 0 ? "pos" : pnl < 0 ? "neg" : "";
  return `
    <tr>
      <td class="muted">${formatTimestamp(trade.executed_at)}</td>
      <td class="asset">${trade.asset}</td>
      <td><span class="pill ${act.cls}">${act.label}</span></td>
      <td class="num">${formatNumber(trade.quantity, 6)}</td>
      <td class="num">${formatNumber(trade.price_usdc, 4)}</td>
      <td class="num">${formatNumber(trade.amount_usdc, 2)}</td>
      <td class="num ${pnlCls}">${formatNumber(trade.realized_pnl, 2)}</td>
      <td>${explorerLink(trade.explorer_url, shortAddr(trade.tx_signature))}</td>
    </tr>`;
}

function setRows(tbodyId, rows, emptyMessage, emptyColspan, render, countId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${emptyColspan}" class="t-empty">${emptyMessage}</td></tr>`;
    if (countId) setText(countId, "");
    return;
  }

  tbody.innerHTML = rows.map(render).join("");
  if (countId) setText(countId, `${rows.length} shown`);
}

/* ---------- panels ---------- */

function renderSignal(latestSignal) {
  const signal = latestSignal && latestSignal.signal;
  const actionEl = document.getElementById("sig-action");

  if (!signal) {
    setText("sig-asset", "No signal");
    if (actionEl) {
      actionEl.className = "pill other";
      actionEl.textContent = "WAITING";
    }
    setText("sig-sentiment", "--");
    setText("sig-confidence", "--");
    setMeter("bar-sentiment", 0);
    setMeter("bar-confidence", 0);
    setText("signal-time", "--");
    setText(
      "sig-reasoning",
      "Run `python -m agent.main --init-db --once` to seed the local demo, then start the API."
    );
    return;
  }

  const act = actionView(signal.action);
  const sentiment = Number(signal.sentiment) || 0;
  const confidence = Number(signal.confidence) || 0;

  setText("sig-asset", signal.asset);
  if (actionEl) {
    actionEl.className = `pill ${act.cls}`;
    actionEl.textContent = act.label;
  }
  setText("sig-sentiment", sentiment.toFixed(2));
  setText("sig-confidence", confidence.toFixed(2));
  setMeter("bar-sentiment", Math.abs(sentiment), sentiment < 0 ? "neg" : "pos");
  setMeter("bar-confidence", confidence);
  setText("signal-time", formatTimestamp(signal.created_at));
  setText("sig-reasoning", signal.reasoning || "No reasoning recorded for this signal.");
}

function renderPolicy(policy) {
  const stateEl = document.getElementById("policy-state-text");
  const rowsEl = document.getElementById("policy-rows");
  const tag = document.getElementById("policy-mode-tag");
  if (!stateEl || !rowsEl) return;

  if (!policy) {
    setDot("policy-dot", "offline");
    stateEl.textContent = "No policy payload";
    rowsEl.innerHTML = row("Status", "The API did not return policy status.");
    return;
  }

  if (policy.program_id) {
    setHtml(
      "footer-prog",
      explorerLink(policy.program_explorer_url, shortAddr(policy.program_id))
    );
  }

  // local simulator mode
  if (!policy.devnet_policy_enabled) {
    setDot("policy-dot", "warn");
    if (tag) tag.textContent = "local simulator";
    stateEl.textContent = "Local simulator";
    rowsEl.innerHTML =
      row("Mode", "Off-chain simulator, same rule shape") +
      row("Program", explorerLink(policy.program_explorer_url, shortAddr(policy.program_id))) +
      row("Devnet policy", "disabled");
    return;
  }

  if (tag) tag.textContent = "devnet anchor";
  const chain = policy.on_chain;

  if (!chain || chain.available === false) {
    setDot("policy-dot", "offline");
    const reason = chain && chain.reason ? chain.reason : "status unavailable";
    stateEl.textContent = "Devnet status unavailable";
    rowsEl.innerHTML =
      row("Program", explorerLink(policy.program_explorer_url, shortAddr(policy.program_id))) +
      row("Reason", reason);
    return;
  }

  if (!chain.initialized) {
    setDot("policy-dot", "warn");
    stateEl.textContent = "Policy not initialized";
    rowsEl.innerHTML =
      row("Program", explorerLink(policy.program_explorer_url, shortAddr(policy.program_id))) +
      row("Policy PDA", explorerLink(chain.policy_explorer_url, shortAddr(chain.policy_pda))) +
      row("Next step", "run init-policy");
    return;
  }

  setDot("policy-dot", chain.halted ? "offline" : "live");
  stateEl.textContent = chain.halted ? "Halted" : "Active";

  const used = microToUsdc(chain.daily_buy_used_microusdc);
  const limit = microToUsdc(chain.daily_buy_limit_microusdc);
  const frac = limit > 0 ? used / limit : 0;
  const capKind = frac >= 1 ? "neg" : frac >= 0.7 ? "warn" : "accent";

  rowsEl.innerHTML =
    row("Program", explorerLink(policy.program_explorer_url, shortAddr(policy.program_id))) +
    row("Policy PDA", explorerLink(chain.policy_explorer_url, shortAddr(chain.policy_pda))) +
    row("Trade sequence", chain.next_trade_seq) +
    `<div class="cap">
       <div class="cap-top">
         <span class="r-k">Daily BUY used</span>
         <span class="r-v">${used.toFixed(2)} / ${limit.toFixed(2)} USDC</span>
       </div>
       <div class="meter"><i id="bar-cap"></i></div>
     </div>`;

  setMeter("bar-cap", frac, capKind === "accent" ? null : capKind);
}

function row(key, valueHtml) {
  return `<div class="row"><span class="r-k">${key}</span><span class="r-v">${valueHtml}</span></div>`;
}

/* ---------- refresh loop ---------- */

async function refresh() {
  try {
    const [health, pnl, latestSignal, signalHistory, tradesPayload] = await Promise.all([
      fetchJson("/health"),
      fetchJson("/pnl"),
      fetchJson("/signal/latest"),
      fetchJson("/signal/history?limit=20"),
      fetchJson("/trades?limit=20")
    ]);

    // topbar
    setText("m-cycle", formatTime(health.last_cycle_at));
    setText("m-seq", health.next_trade_sequence ?? "-");
    setText("m-mode", health.policy_mode || "-");
    setText("m-net", health.network || "devnet");
    if (health.policy_program_id) {
      setHtml(
        "footer-prog",
        explorerLink(health.policy_program_explorer_url, shortAddr(health.policy_program_id))
      );
    }

    // KPI cluster
    setKpi("v-portfolio", "kpi-portfolio", formatUsd(pnl.total_value_usdc));
    setText(
      "s-portfolio",
      `${(pnl.positions || []).length} open position${(pnl.positions || []).length === 1 ? "" : "s"}`
    );
    setKpi("v-cash", "kpi-cash", formatUsd(pnl.cash_usdc));

    const unreal = signedUsd(pnl.unrealized_pnl);
    setKpi("v-unrealized", "kpi-unrealized", unreal.text, unreal.cls);
    const real = signedUsd(pnl.realized_pnl);
    setKpi("v-realized", "kpi-realized", real.text, real.cls);

    // panels + tables
    renderSignal(latestSignal);
    setRows("positions-body", pnl.positions, "No open positions.", 4, renderPositionRow, "positions-count");
    setRows("signals-body", signalHistory.signals, "No signals recorded yet.", 7, renderSignalRow, "signals-count");
    setRows("trades-body", tradesPayload.trades, "No trades recorded yet.", 8, renderTradeRow, "trades-count");

    setConnection("live", "Live");
    hasLoaded = true;
    refreshPolicy();
  } catch (error) {
    setConnection("offline", "API offline");
    setText("m-cycle", "--");
    setDot("policy-dot", "offline");
    const stateEl = document.getElementById("policy-state-text");
    const rowsEl = document.getElementById("policy-rows");
    if (stateEl) stateEl.textContent = "API offline";
    if (rowsEl) {
      rowsEl.innerHTML = row(
        "Start the API",
        "<code class=\"addr\">uvicorn agent.api.server:app --reload</code>"
      );
    }
  }
}

async function refreshPolicy() {
  try {
    renderPolicy(await fetchJson("/policy"));
  } catch (error) {
    setDot("policy-dot", "offline");
    setText("policy-state-text", "Policy unavailable");
    setHtml("policy-rows", row("Status", "The policy endpoint did not respond."));
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
