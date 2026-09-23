// Main-thread side of the solver worker. One job at a time per client: a new
// job (or cancel()) terminates whatever is running and starts a fresh worker,
// which is how a multi-second exact enumeration gets interrupted.
import type { Qubo } from "../problems/types";

export type SolverName = "bSB" | "dSB" | "SA" | "PT";
export const SOLVERS: { id: SolverName; name: string; blurb: string }[] = [
  { id: "bSB", name: "Ballistic SB", blurb: "Simulated bifurcation, coupling through oscillator positions. Fast and smooth." },
  { id: "dSB", name: "Discrete SB", blurb: "Simulated bifurcation, coupling through sign(x). Tuned for hard instances." },
  { id: "SA", name: "Simulated annealing", blurb: "The classic Metropolis baseline, with restarts." },
  { id: "PT", name: "Parallel tempering", blurb: "Replica-exchange Monte Carlo across a temperature ladder." },
];

export interface SolveOpts {
  seed: number;
  steps: number;
  replicas: number;
  solvers: SolverName[];
  exact: boolean;
  exactMaxN: number;
}

export interface Run { solver: SolverName; bits: number[]; objective: number; millis: number }
export interface ExactRun { bits: number[]; objective: number; millis: number; states: string }
export interface ExactOutcome { exact: ExactRun | null; exactSkipped: boolean; exactReason: string | null }
export interface Trace {
  n: number;
  steps: number;
  frames: number;
  /** frames * n positions, frame-major. */
  x: Float32Array;
  /** QUBO objective of sign(x) at each frame. */
  objective: Float64Array;
  bits: number[];
  bestObjective: number;
}

export interface TraceOpts {
  variant: "bSB" | "dSB";
  steps: number;
  seed: number;
  frames: number;
  /** Multiplies the solver's default coupling c0. 1 = the dynamics the race ran. */
  couplingScale?: number;
}

export interface PortfolioQubo { n: number; rows: number[]; cols: number[]; vals: number[]; penalty: number; offset: number }
export interface PortfolioReport {
  n: number;
  k: number;
  subsets: string;
  exact_skipped: boolean;
  exact: { selection: number[]; objective_int: string; worst_objective_int: string; millis: number; subsets: string } | null;
  results: { solver: SolverName; selection: number[]; objective_int: string; gap_int: string | null; gap_norm: number | null; is_optimal: boolean | null; feasible_raw: boolean; millis: number }[];
  wallMillis?: number;
}

export type SolveEvent =
  | { type: "trace"; data: Trace }
  | { type: "run"; data: Run }
  | { type: "exact"; data: ExactOutcome };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onEvent?: (e: SolveEvent) => void;
}

export class CancelledError extends Error {
  constructor() { super("cancelled"); }
}

export class SolverClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private readyListeners = new Set<(ok: boolean, err?: string) => void>();
  ready = false;
  loadError: string | null = null;

  constructor() { this.spawn(); }

  private spawn() {
    const w = new Worker("/solver-worker.js");
    this.ready = false;
    w.onmessage = (e: MessageEvent) => {
      const { id, type, data } = e.data as { id: number; type: string; data: unknown };
      if (id === -1) {
        this.ready = type === "ready";
        this.loadError = type === "error" ? String(data ?? e.data.error) : null;
        this.readyListeners.forEach((f) => f(this.ready, this.loadError ?? undefined));
        return;
      }
      const p = this.pending.get(id);
      if (!p) return;
      if (type === "error") {
        this.pending.delete(id);
        p.reject(new Error(String(data)));
      } else if (type === "done" || type === "result") {
        this.pending.delete(id);
        p.resolve(data);
      } else {
        p.onEvent?.({ type, data } as SolveEvent);
      }
    };
    // A worker that fails to load never answers; fail everything loudly
    // instead of leaving the page on a spinner forever.
    w.onerror = (e) => {
      const msg = `Solver worker failed: ${e.message || "load error"}`;
      this.loadError = msg;
      this.readyListeners.forEach((f) => f(false, msg));
      this.pending.forEach((p) => p.reject(new Error(msg)));
      this.pending.clear();
    };
    this.worker = w;
  }

  onReady(f: (ok: boolean, err?: string) => void): () => void {
    this.readyListeners.add(f);
    if (this.ready || this.loadError) f(this.ready, this.loadError ?? undefined);
    return () => this.readyListeners.delete(f);
  }

  /** Terminate whatever is running and start a fresh worker. */
  cancel() {
    if (this.pending.size === 0) return;
    this.worker?.terminate();
    this.pending.forEach((p) => p.reject(new CancelledError()));
    this.pending.clear();
    this.spawn();
  }

  get busy() { return this.pending.size > 0; }

  private call<T>(kind: string, payload: unknown, onEvent?: (e: SolveEvent) => void): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onEvent });
      this.worker!.postMessage({ id, kind, payload });
    });
  }

  solve(q: Qubo, opts: SolveOpts, trace: TraceOpts | null, onEvent: (e: SolveEvent) => void) {
    const { rows, cols, vals } = triplets(q);
    return this.call<void>("solve", { n: q.n, rows, cols, vals, opts, trace }, onEvent);
  }

  trace(q: Qubo, trace: TraceOpts) {
    const { rows, cols, vals } = triplets(q);
    return this.call<Trace>("trace", { n: q.n, rows, cols, vals, trace });
  }

  portfolioQubo(mu: number[], sigma: number[], k: number, riskAversion: number) {
    return this.call<PortfolioQubo>("portfolioQubo", { mu, sigma, k, riskAversion });
  }

  solvePortfolio(p: { mu: number[]; sigma: number[]; k: number; riskAversion: number; seed: number; steps: number; maxSubsets: number }) {
    return this.call<PortfolioReport>("solvePortfolio", p);
  }
}

function triplets(q: Qubo) {
  const rows: number[] = [], cols: number[] = [], vals: number[] = [];
  for (const [i, j, v] of q.terms) { rows.push(i); cols.push(j); vals.push(v); }
  return { rows, cols, vals };
}

let shared: SolverClient | null = null;
/** The app-wide solver (the Solve page). The hero animation uses its own. */
export function solver(): SolverClient {
  if (!shared) shared = new SolverClient();
  return shared;
}
