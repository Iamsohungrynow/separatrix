import { checkBits, fmtNum, fmtPct } from "./format";
import { ParamReader } from "./params";
import type { Interpretation, ParamSpec, ProblemDef } from "./types";

/** Shape of `public/data/portfolio-<date>.json`. */
export interface PortfolioDataset {
  /** ISO date the statistics were computed at, e.g. "2026-07-31". */
  date: string;
  tickers: string[];
  /** Mean daily log-return per ticker. */
  mu: number[];
  /** Daily covariance matrix, tickers × tickers. */
  sigma: number[][];
  risk_aversion: number;
  /** Plain-text provenance of the statistics. */
  source: string;
}

export interface PortfolioInstance {
  /** First n tickers of the dataset, in listed order. */
  tickers: string[];
  mu: number[];
  /** Row-major n × n covariance. */
  sigma: number[];
  /** Number of assets to pick. */
  k: number;
  riskAversion: number;
  /** Dataset date (the statistics are fixed as of this day). */
  date: string;
  /** Set when k had to be clamped to the universe size. */
  notice?: string;
}

let dataset: PortfolioDataset | null = null;

/** Validate and register the dataset the portfolio problem draws from. */
export function setPortfolioDataset(data: PortfolioDataset): void {
  const n = data.tickers?.length ?? 0;
  if (n === 0) throw new Error("Portfolio dataset has no tickers");
  if (!Array.isArray(data.mu) || data.mu.length !== n) throw new Error(`Portfolio dataset: mu has ${data.mu?.length ?? 0} entries, expected ${n}`);
  if (!Array.isArray(data.sigma) || data.sigma.length !== n || data.sigma.some((row) => !Array.isArray(row) || row.length !== n)) {
    throw new Error(`Portfolio dataset: sigma must be ${n} × ${n}`);
  }
  if (!data.mu.every(Number.isFinite) || !data.sigma.every((row) => row.every(Number.isFinite))) {
    throw new Error("Portfolio dataset contains non-finite numbers");
  }
  dataset = data;
}

export function getPortfolioDataset(): PortfolioDataset | null {
  return dataset;
}

const params: ParamSpec[] = [
  { key: "n", label: "Universe size", kind: "int", min: 4, max: 39, step: 1, default: 20, hint: "The first n assets of the dataset, in listed order." },
  { key: "k", label: "Assets to pick (k)", kind: "int", min: 1, max: 39, step: 1, default: 8, hint: "Exactly k assets, equally weighted. Clamped to the universe size." },
  {
    key: "riskAversion",
    label: "Return weight (λ)",
    kind: "float",
    min: 0,
    max: 5,
    step: 0.05,
    default: 0.5,
    hint: "Objective = variance − λ·mean return (per day, equal weights). Larger λ leans on historical mean returns; 0 minimizes variance only.",
  },
];

function describe(): string {
  const date = dataset?.date ?? "a fixed historical date";
  return (
    `An educational study, not investment advice: pick exactly k of n crypto assets, equally weighted, to trade off historical mean daily return against historical covariance, using statistics fixed as of ${date}. ` +
    "Cardinality-constrained selection like this is a standard QUBO benchmark from portfolio construction; past returns say nothing reliable about future ones. " +
    "Each asset is a bit; the QUBO is (1/k²)·xᵀΣx − (λ/k)·μᵀx plus a penalty P·(Σx − k)² that makes picking any number other than k never pay."
  );
}

export const portfolio: ProblemDef<PortfolioInstance> = {
  id: "portfolio",
  name: "Portfolio Selection",
  tagline: "Choose exactly k assets balancing historical return against risk (educational, historical data).",
  get description() {
    return describe();
  },
  params,
  presets: [
    { label: "Small: 12 assets, pick 4", params: { n: 12, k: 4, riskAversion: 0.5 }, seed: 1, note: "4,096 states: exact-verifiable." },
    { label: "Exact-verifiable: 20 assets, pick 8", params: { n: 20, k: 8, riskAversion: 0.5 }, seed: 1 },
    { label: "Minimum variance: 20 assets, pick 8", params: { n: 20, k: 8, riskAversion: 0 }, seed: 1, note: "λ = 0 ignores returns entirely." },
    { label: "Full universe: 39 assets, pick 8", params: { n: 39, k: 8, riskAversion: 0.5 }, seed: 1 },
  ],
  generate(p) {
    if (!dataset) throw new Error("The portfolio dataset has not loaded yet");
    const r = new ParamReader(params, p);
    const n = Math.min(r.number("n"), dataset.tickers.length);
    const kRequested = r.number("k");
    const k = Math.min(kRequested, n);
    const riskAversion = r.number("riskAversion");
    const sigma: number[] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sigma.push(dataset.sigma[i][j]);
    const inst: PortfolioInstance = {
      tickers: dataset.tickers.slice(0, n),
      mu: dataset.mu.slice(0, n),
      sigma,
      k,
      riskAversion,
      date: dataset.date,
    };
    if (k !== kRequested) inst.notice = `You asked for ${kRequested} assets but the universe has only ${n}; using k = ${n}.`;
    return inst;
  },
  async toQubo(instance, ctx) {
    return ctx.portfolioQubo(instance.mu, instance.sigma, instance.k, instance.riskAversion);
  },
  interpret(instance, bits): Interpretation {
    const n = instance.tickers.length;
    checkBits(bits, n);
    const chosen: number[] = [];
    for (let i = 0; i < n; i++) if (bits[i] !== 0) chosen.push(i);
    const k = instance.k;
    const feasible = chosen.length === k;
    const s = portfolioStats(instance, chosen);
    const names = chosen.map((i) => instance.tickers[i]);
    const list = names.length === 0 ? "none" : names.join(", ");
    const metrics: Interpretation["metrics"] = [
      { label: "Picked", value: `${chosen.length} of ${n} (target k = ${k})`, tone: feasible ? "good" : "bad" },
      { label: "Assets", value: list, tone: "neutral" },
      { label: "Mean daily return (historical)", value: fmtPct(s.dailyReturn, 3), tone: "neutral" },
      { label: "Daily volatility (historical)", value: fmtPct(s.dailyVol, 2), tone: "neutral" },
      { label: "Annualised return (×365)", value: fmtPct(s.annualReturn, 1), tone: "neutral" },
      { label: "Annualised volatility (×√365)", value: fmtPct(s.annualVol, 1), tone: "neutral" },
      { label: "Objective wᵀΣw − λ·μᵀw", value: fmtNum(s.objective, 5), tone: "neutral" },
    ];
    if (instance.notice) metrics.push({ label: "Note", value: instance.notice, tone: "neutral" });
    const stats = `historical mean daily return ${fmtPct(s.dailyReturn, 3)}, daily volatility ${fmtPct(s.dailyVol, 2)} (equal weights 1/${k}, data as of ${instance.date})`;
    return {
      feasible,
      score: s.objective,
      scoreLabel: "risk-return objective",
      better: "lower",
      metrics,
      summary: feasible
        ? `Picks ${k} of ${n}: ${list}; ${stats}`
        : `Picks ${chosen.length} assets but exactly ${k} are required (${list}); ${stats}`,
    };
  },
};

export interface PortfolioStats {
  /** Σ_{i∈S} μ_i / k (weights 1/k on the chosen assets). */
  dailyReturn: number;
  /** sqrt(wᵀΣw) with w_i = 1/k on the chosen assets. */
  dailyVol: number;
  /** dailyReturn × 365 (crypto trades every day). */
  annualReturn: number;
  /** dailyVol × √365. */
  annualVol: number;
  /** wᵀΣw − λ·μᵀw: the portfolio objective without the cardinality penalty. */
  objective: number;
}

/**
 * Equal-weight statistics with w_i = 1/k for every chosen asset, exactly the
 * weights the QUBO objective assumes (even when the count differs from k).
 */
export function portfolioStats(instance: PortfolioInstance, chosen: number[]): PortfolioStats {
  const n = instance.tickers.length;
  const w = 1 / instance.k;
  let ret = 0;
  for (const i of chosen) ret += instance.mu[i] * w;
  let variance = 0;
  for (const i of chosen) for (const j of chosen) variance += instance.sigma[i * n + j] * w * w;
  const dailyVol = Math.sqrt(Math.max(0, variance));
  return {
    dailyReturn: ret,
    dailyVol,
    annualReturn: ret * 365,
    annualVol: dailyVol * Math.sqrt(365),
    objective: variance - instance.riskAversion * ret,
  };
}
