async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(value);
}

async function refresh() {
  try {
    const [health, pnl, latestSignal] = await Promise.all([
      fetchJson("http://127.0.0.1:8000/health"),
      fetchJson("http://127.0.0.1:8000/pnl"),
      fetchJson("http://127.0.0.1:8000/signal/latest")
    ]);

    document.getElementById("status").textContent = health.status;
    document.getElementById("last-cycle").textContent = `Last cycle: ${health.last_cycle_at ?? "not recorded"}`;
    document.getElementById("cash").textContent = formatUsd(pnl.cash_usdc);
    document.getElementById("pnl").textContent = `Portfolio value ${formatUsd(pnl.total_value_usdc)} | Unrealized ${formatUsd(
      pnl.unrealized_pnl
    )}`;

    if (latestSignal.signal) {
      const signal = latestSignal.signal;
      document.getElementById("signal").textContent = `${signal.asset} ${signal.action} | sentiment ${signal.sentiment.toFixed(
        2
      )}`;
      document.getElementById("signal-reasoning").textContent = signal.reasoning;
    }
  } catch (error) {
    document.getElementById("status").textContent = "API offline";
    document.getElementById("last-cycle").textContent = "Start FastAPI with `uvicorn agent.api.server:app --reload`.";
  }
}

refresh();
setInterval(refresh, 30000);
