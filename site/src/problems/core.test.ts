import { describe, expect, it } from "vitest";
import { Rng } from "./rng";
import { bruteForce, density, evaluate, evaluateWithOffset, maxAbs, QuboBuilder, quboStats, toDense } from "./qubo";
import type { Qubo } from "./types";

describe("Rng", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const sa = Array.from({ length: 20 }, () => a.next());
    const sb = Array.from({ length: 20 }, () => b.next());
    const sc = Array.from({ length: 20 }, () => c.next());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  it("int() stays inside the inclusive range and hits both ends", () => {
    const r = new Rng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7]);
  });

  it("float() is in [0,1) and normal() has sane moments", () => {
    const r = new Rng(7);
    let sum = 0;
    let sq = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const f = r.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const z = r.normal();
      sum += z;
      sq += z * z;
    }
    expect(Math.abs(sum / N)).toBeLessThan(0.05);
    expect(Math.abs(sq / N - 1)).toBeLessThan(0.05);
  });

  it("shuffle is a deterministic permutation", () => {
    const x = new Rng(5).shuffle([...Array(10).keys()]);
    const y = new Rng(5).shuffle([...Array(10).keys()]);
    expect(x).toEqual(y);
    expect([...x].sort((a, b) => a - b)).toEqual([...Array(10).keys()]);
  });

  it("accepts odd seeds (negative, fractional, huge)", () => {
    for (const s of [-1, 0.5, 2 ** 40 + 3, Number.NaN]) {
      const v = new Rng(s).float();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Rng(0.25).next()).not.toBe(new Rng(0.75).next());
  });
});

function naiveMin(q: Qubo): number {
  let best = Infinity;
  for (let m = 0; m < 1 << q.n; m++) {
    const bits = Array.from({ length: q.n }, (_, i) => (m >> i) & 1);
    best = Math.min(best, evaluate(q, bits));
  }
  return best;
}

function randomQubo(n: number, seed: number): Qubo {
  const r = new Rng(seed);
  const b = new QuboBuilder(n);
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) if (r.chance(0.6)) b.add(j, i, r.int(-9, 9));
  b.addOffset(r.int(-5, 5));
  return b.build();
}

describe("QuboBuilder", () => {
  it("maps (j, i) into the upper triangle, merges duplicates and drops zeros", () => {
    const q = new QuboBuilder(3).add(2, 0, 1).add(0, 2, 2).add(1, 1, -1).add(1, 2, 5).add(2, 1, -5).add(0, 0, 0).addOffset(0.5).build();
    expect(q).toEqual({ n: 3, terms: [[0, 2, 3], [1, 1, -1]], offset: 0.5 });
  });

  it("sorts terms by (i, j) and validates input", () => {
    const q = new QuboBuilder(4).add(3, 3, 1).add(1, 0, 1).add(0, 0, 1).build();
    expect(q.terms.map((t) => [t[0], t[1]])).toEqual([[0, 0], [0, 1], [3, 3]]);
    expect(() => new QuboBuilder(2).add(0, 2, 1)).toThrow(/out of range/);
    expect(() => new QuboBuilder(2).add(0, 1, Number.NaN)).toThrow(/not finite/);
    expect(() => new QuboBuilder(2, ["a"])).toThrow(/labels/);
  });
});

describe("evaluate / bruteForce / stats", () => {
  it("evaluate follows the upper-triangular convention (matches model.rs test)", () => {
    const q = new QuboBuilder(3).add(0, 0, 1).add(2, 0, 2).add(1, 2, -3).addOffset(10).build();
    expect(evaluate(q, [1, 0, 1])).toBe(3);
    expect(evaluate(q, [1, 1, 1])).toBe(0);
    expect(evaluate(q, [0, 0, 0])).toBe(0);
    expect(evaluateWithOffset(q, [1, 0, 1])).toBe(13);
    expect(() => evaluate(q, [1, 0])).toThrow(/length/);
  });

  it("bruteForce matches naive enumeration on random QUBOs", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const q = randomQubo(1 + (seed % 10), seed);
      const bf = bruteForce(q);
      expect(bf.value).toBe(naiveMin(q));
      expect(evaluate(q, bf.bits)).toBe(bf.value);
      expect(bf.degeneracy).toBeGreaterThanOrEqual(1);
    }
  });

  it("bruteForce solves the lib.rs doc example and counts degeneracy", () => {
    const q = new QuboBuilder(3).add(0, 0, -1).add(1, 1, -1).add(0, 1, 2).add(2, 2, -1).build();
    const bf = bruteForce(q);
    expect(bf.value).toBe(-2);
    expect(bf.degeneracy).toBe(2); // x0 xor x1, plus x2
    expect(() => bruteForce({ n: 21, terms: [], offset: 0 })).toThrow(/n <= 20/);
  });

  it("toDense, density and maxAbs", () => {
    const q = new QuboBuilder(3).add(0, 0, -1).add(1, 0, 4).add(2, 2, 2).build();
    expect(toDense(q)).toEqual([
      [-1, 4, 0],
      [0, 0, 0],
      [0, 0, 2],
    ]);
    expect(density(q)).toBeCloseTo(1 / 3);
    expect(maxAbs(q)).toBe(4);
    expect(quboStats(q)).toEqual({ n: 3, linearTerms: 2, quadraticTerms: 1, density: 1 / 3, maxAbs: 4 });
  });
});
