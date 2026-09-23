// Separatrix Studio solver worker.
//
// Solving runs off the main thread: exact enumeration is allowed to take
// seconds and the UI must stay live (and cancellable) meanwhile. Cancelling
// is done by terminating this worker and starting a fresh one, so nothing in
// here needs to be interruptible.
//
// This is a CLASSIC worker (importScripts) loading the `--target no-modules`
// wasm-bindgen bundle. Module workers proved unreliable to load in testing
// (one failed with no error event at all, indistinguishable from a hang).
//
// Results are streamed one solver at a time so the page can fill in as each
// finishes instead of blocking on the slowest (usually exact).
importScripts("/pkg/separatrix_wasm.js");

const api = wasm_bindgen;
const ready = api({ module_or_path: "/pkg/separatrix_wasm_bg.wasm" });

ready.then(
  () => self.postMessage({ id: -1, type: "ready" }),
  (e) => self.postMessage({ id: -1, type: "error", error: "Failed to load the solver: " + msg(e) }),
);

function msg(e) {
  return String(e && e.message ? e.message : e);
}

function u32(a) { return Uint32Array.from(a); }
function f64(a) { return Float64Array.from(a); }

self.onmessage = async (event) => {
  const { id, kind, payload } = event.data;
  const post = (type, data, transfer) => self.postMessage({ id, type, data }, transfer || []);
  try {
    await ready;
    switch (kind) {
      case "solve": {
        const { n, rows, cols, vals, opts, trace } = payload;
        const R = u32(rows), C = u32(cols), V = f64(vals);
        if (trace) {
          const t = api.trace_sb(n, R, C, V, trace);
          post("trace", t, [t.x.buffer, t.objective.buffer]);
        }
        for (const solver of opts.solvers) {
          const r = api.solve_qubo(n, R, C, V, { ...opts, solvers: [solver], exact: false });
          post("run", r.results[0]);
        }
        if (opts.exact) {
          const r = api.solve_qubo(n, R, C, V, { ...opts, solvers: [], exact: true });
          post("exact", { exact: r.exact, exactSkipped: r.exactSkipped, exactReason: r.exactReason });
        }
        post("done");
        return;
      }
      case "trace": {
        const { n, rows, cols, vals, trace } = payload;
        const t = api.trace_sb(n, u32(rows), u32(cols), f64(vals), trace);
        post("result", t, [t.x.buffer, t.objective.buffer]);
        return;
      }
      case "portfolioQubo": {
        const { mu, sigma, k, riskAversion } = payload;
        post("result", api.portfolio_qubo(f64(mu), f64(sigma), k, riskAversion));
        return;
      }
      case "solvePortfolio": {
        const { mu, sigma, k, riskAversion, seed, steps, maxSubsets } = payload;
        post("result", api.solve_portfolio(f64(mu), f64(sigma), k, riskAversion, BigInt(seed), steps, maxSubsets));
        return;
      }
      case "subsets": {
        post("result", api.subsets(payload.n, payload.k));
        return;
      }
      default:
        throw new Error("unknown request: " + kind);
    }
  } catch (e) {
    post("error", msg(e));
  }
};
