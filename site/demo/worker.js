// Solving runs off the main thread on purpose: exact enumeration is the point
// of the demo and it is allowed to take seconds, which would otherwise freeze
// the tab mid-demonstration.
//
// This is a CLASSIC worker (importScripts), not a module worker. Module
// workers are still unevenly supported — in testing one failed to load with
// no error event at all, which is indistinguishable from a hang. The
// `no-modules` wasm-bindgen target works everywhere a worker does.
importScripts("./pkg/separatrix_wasm.js");

const { solve_portfolio, subsets } = wasm_bindgen;
let ready = null;

function ensureReady() {
  if (!ready) ready = wasm_bindgen({ module_or_path: "./pkg/separatrix_wasm_bg.wasm" });
  return ready;
}

self.onmessage = async (event) => {
  const { id, kind, payload } = event.data;
  try {
    await ensureReady();
    if (kind === "subsets") {
      self.postMessage({ id, ok: true, result: subsets(payload.n, payload.k) });
      return;
    }
    if (kind === "solve") {
      const { mu, sigma, k, riskAversion, seed, steps, maxSubsets } = payload;
      const started = performance.now();
      const report = solve_portfolio(
        Float64Array.from(mu),
        Float64Array.from(sigma),
        k,
        riskAversion,
        BigInt(seed),
        steps,
        maxSubsets
      );
      report.wallMillis = performance.now() - started;
      self.postMessage({ id, ok: true, result: report });
      return;
    }
    throw new Error(`unknown request: ${kind}`);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: String(error && error.message ? error.message : error),
    });
  }
};
