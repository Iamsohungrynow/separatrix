import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultParams, PROBLEM_BY_ID, PROBLEMS, setPortfolioDataset, type PortfolioDataset, type Qubo, type QuboContext } from "./index";
import { bruteForce, MAX_QUBO_N, QuboBuilder } from "./qubo";

const data = JSON.parse(readFileSync(new URL("../../public/data/portfolio-2026-07-31.json", import.meta.url), "utf8")) as PortfolioDataset;
setPortfolioDataset(data);

/** Mock of the WASM portfolio builder: documented formula with a simple penalty. */
const ctx: QuboContext = {
  async portfolioQubo(mu, sigma, k, lambda): Promise<Qubo> {
    const n = mu.length;
    const P = 1;
    const b = new QuboBuilder(n);
    for (let i = 0; i < n; i++) {
      b.add(i, i, sigma[i * n + i] / (k * k) - (lambda / k) * mu[i] + P * (1 - 2 * k));
      for (let j = i + 1; j < n; j++) b.add(i, j, (2 * sigma[i * n + j]) / (k * k) + 2 * P);
    }
    b.addOffset(P * k * k);
    return b.build();
  },
};

function assertWellFormed(q: Qubo): void {
  expect(Number.isInteger(q.n) && q.n >= 1 && q.n <= MAX_QUBO_N).toBe(true);
  let prev = -1;
  for (const [i, j, v] of q.terms) {
    expect(i).toBeLessThanOrEqual(j);
    expect(j).toBeLessThan(q.n);
    expect(v).not.toBe(0);
    expect(Number.isFinite(v)).toBe(true);
    const key = i * q.n + j;
    expect(key).toBeGreaterThan(prev); // sorted, merged
    prev = key;
  }
  expect(Number.isFinite(q.offset)).toBe(true);
  if (q.labels) expect(q.labels.length).toBe(q.n);
}

describe("problem registry", () => {
  it("lists the five problems in order", () => {
    expect(PROBLEMS.map((p) => p.id)).toEqual(["maxcut", "partition", "mis", "portfolio", "custom"]);
    for (const p of PROBLEMS) expect(PROBLEM_BY_ID[p.id]).toBe(p);
  });

  it("every problem has copy, valid param specs, and presets", () => {
    for (const p of PROBLEMS) {
      expect(p.name.length).toBeGreaterThan(2);
      expect(p.tagline.length).toBeGreaterThan(10);
      const sentences = p.description.split(/[.!?](\s|$)/).filter((s) => s.trim().length > 1);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(p.presets.length).toBeGreaterThanOrEqual(3);
      for (const s of p.params) {
        if (s.kind === "int" || s.kind === "float") {
          expect(s.min).toBeLessThanOrEqual(s.default);
          expect(s.default).toBeLessThanOrEqual(s.max);
        }
        if (s.kind === "select") expect(s.options.some((o) => o.value === s.default)).toBe(true);
      }
    }
  });

  it("defaults and every preset generate deterministically, build a well-formed QUBO, and interpret", async () => {
    for (const p of PROBLEMS) {
      const runs = [{ params: defaultParams(p.params), seed: 1 }, ...p.presets];
      for (const run of runs) {
        const a = p.generate(run.params, run.seed);
        expect(p.generate(run.params, run.seed)).toEqual(a);
        const q = await p.toQubo(a, ctx);
        assertWellFormed(q);
        const zeros = new Array<number>(q.n).fill(0);
        const r = p.interpret(a, zeros);
        expect(typeof r.summary).toBe("string");
        expect(r.summary.length).toBeGreaterThan(5);
        expect(Number.isFinite(r.score)).toBe(true);
        if (q.n <= 16) {
          const bf = bruteForce(q);
          const best = p.interpret(a, bf.bits);
          if (p.id !== "portfolio") expect(best.feasible).toBe(true);
        }
      }
    }
  }, 60_000);

  it("presets marked exact-verifiable really are small enough, and 'beyond exact' ones are not", async () => {
    let checked = 0;
    for (const p of PROBLEMS) {
      for (const preset of p.presets) {
        const q = await p.toQubo(p.generate(preset.params, preset.seed), ctx);
        if (/exact-verifiable/i.test(preset.label)) {
          expect(q.n).toBeLessThanOrEqual(20);
          checked++;
        }
        if (/beyond exact/i.test(preset.label)) expect(q.n).toBeGreaterThan(20);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});
