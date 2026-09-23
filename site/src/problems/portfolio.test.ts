import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPortfolioDataset, portfolio, portfolioStats, setPortfolioDataset, type PortfolioDataset } from "./portfolio";
import { bruteForce, QuboBuilder } from "./qubo";
import type { Qubo, QuboContext } from "./types";

const data = JSON.parse(readFileSync(new URL("../../public/data/portfolio-2026-07-31.json", import.meta.url), "utf8")) as PortfolioDataset;

/**
 * Test double for the WASM call: the documented formula
 * (1/k²)xᵀΣx − (λ/k)μᵀx + P(Σx − k)², with the constant P·k² in `offset`
 * (same split as separatrix/src/portfolio.rs).
 */
function referenceQubo(mu: number[], sigma: number[], k: number, lambda: number): Qubo {
  const n = mu.length;
  let bound = 0;
  for (let i = 0; i < n; i++) {
    let row = Math.abs(sigma[i * n + i] / (k * k) - (lambda / k) * mu[i]);
    for (let j = 0; j < n; j++) if (j !== i) row += Math.abs((2 * sigma[i * n + j]) / (k * k));
    bound = Math.max(bound, row);
  }
  const P = 2 * bound + 1e-12;
  const b = new QuboBuilder(n);
  for (let i = 0; i < n; i++) {
    b.add(i, i, sigma[i * n + i] / (k * k) - (lambda / k) * mu[i] + P * (1 - 2 * k));
    for (let j = i + 1; j < n; j++) b.add(i, j, (2 * sigma[i * n + j]) / (k * k) + 2 * P);
  }
  b.addOffset(P * k * k);
  return b.build();
}

const calls: [number[], number[], number, number][] = [];
const ctx: QuboContext = {
  async portfolioQubo(mu, sigma, k, lambda) {
    calls.push([mu, sigma, k, lambda]);
    return referenceQubo(mu, sigma, k, lambda);
  },
};

describe("Portfolio selection", () => {
  it("refuses to generate before a dataset is registered", () => {
    expect(getPortfolioDataset()).toBeNull();
    expect(() => portfolio.generate({}, 1)).toThrow(/not loaded/);
    expect(portfolio.description).toMatch(/not investment advice/);
  });

  it("validates the dataset shape", () => {
    expect(() => setPortfolioDataset({ ...data, mu: data.mu.slice(1) })).toThrow(/mu has/);
    expect(() => setPortfolioDataset({ ...data, sigma: data.sigma.slice(1) })).toThrow(/sigma/);
  });

  it("takes the first n tickers, flattens sigma row-major, and names the date in the description", () => {
    setPortfolioDataset(data);
    expect(portfolio.description).toContain(data.date);
    expect(portfolio.description).toMatch(/educational/i);
    expect(portfolio.description).toMatch(/not investment advice/);
    const inst = portfolio.generate({ n: 6, k: 3, riskAversion: 0.5 }, 1);
    expect(inst.tickers).toEqual(data.tickers.slice(0, 6));
    expect(inst.mu).toEqual(data.mu.slice(0, 6));
    expect(inst.sigma.length).toBe(36);
    expect(inst.sigma[1 * 6 + 4]).toBe(data.sigma[1][4]);
    expect(inst.k).toBe(3);
    expect(inst.date).toBe(data.date);
    expect(inst.notice).toBeUndefined();
  });

  it("clamps k to the universe size with a clear notice", () => {
    setPortfolioDataset(data);
    const inst = portfolio.generate({ n: 5, k: 8, riskAversion: 0.5 }, 1);
    expect(inst.k).toBe(5);
    expect(inst.notice).toBe("You asked for 8 assets but the universe has only 5; using k = 5.");
    const r = portfolio.interpret(inst, [1, 1, 1, 1, 1]);
    expect(r.metrics.some((m) => m.label === "Note" && m.value === inst.notice)).toBe(true);
  });

  it("toQubo passes the instance to ctx.portfolioQubo", async () => {
    setPortfolioDataset(data);
    const inst = portfolio.generate({ n: 8, k: 3, riskAversion: 0.7 }, 1);
    calls.length = 0;
    await portfolio.toQubo(inst, ctx);
    expect(calls).toEqual([[inst.mu, inst.sigma, 3, 0.7]]);
  });

  it("interpret's objective agrees with the QUBO on the feasible set (brute force, n = 12, k = 4)", async () => {
    setPortfolioDataset(data);
    const inst = portfolio.generate({ n: 12, k: 4, riskAversion: 0.5 }, 1);
    const q = await portfolio.toQubo(inst, ctx);
    const bf = bruteForce(q);
    const r = portfolio.interpret(inst, bf.bits);
    expect(r.feasible).toBe(true);
    expect(r.score).toBeCloseTo(bf.value + q.offset, 12);
    // …and it is the best 4-subset by the interpreted objective.
    let best = Infinity;
    for (let m = 0; m < 1 << 12; m++) {
      const chosen = [...Array(12).keys()].filter((i) => (m >> i) & 1);
      if (chosen.length === 4) best = Math.min(best, portfolioStats(inst, chosen).objective);
    }
    expect(r.score).toBeCloseTo(best, 12);
  });

  it("reports equal-weight historical statistics and flags the wrong count", () => {
    setPortfolioDataset(data);
    const inst = portfolio.generate({ n: 4, k: 2, riskAversion: 0.5 }, 1);
    const r = portfolio.interpret(inst, [1, 0, 1, 0]);
    const mu = (data.mu[0] + data.mu[2]) / 2;
    const variance = (data.sigma[0][0] + 2 * data.sigma[0][2] + data.sigma[2][2]) / 4;
    const s = portfolioStats(inst, [0, 2]);
    expect(s.dailyReturn).toBeCloseTo(mu, 15);
    expect(s.dailyVol).toBeCloseTo(Math.sqrt(variance), 15);
    expect(s.annualReturn).toBeCloseTo(mu * 365, 12);
    expect(s.annualVol).toBeCloseTo(Math.sqrt(variance) * Math.sqrt(365), 12);
    expect(s.objective).toBeCloseTo(variance - 0.5 * mu, 15);
    expect(r.feasible).toBe(true);
    expect(r.better).toBe("lower");
    expect(r.summary).toContain(`${data.tickers[0]}, ${data.tickers[2]}`);
    expect(r.summary).not.toMatch(/\b(buy|sell|recommend)/i);
    const bad = portfolio.interpret(inst, [1, 1, 1, 0]);
    expect(bad.feasible).toBe(false);
    expect(bad.summary).toMatch(/exactly 2 are required/);
  });
});
