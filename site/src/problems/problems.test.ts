import { describe, expect, it } from "vitest";
import { erdosRenyi, petersen, ring, withWeights, type Graph } from "./graph";
import { cutWeight, maxcut, maxCutQubo } from "./maxcut";
import { conflicts, mis, MIS_PENALTY, misQubo, repairIndependentSet } from "./mis";
import { partition, partitionQubo, parseNumberList } from "./partition";
import { bruteForce, evaluate } from "./qubo";
import { Rng } from "./rng";
import type { QuboContext } from "./types";

const noCtx: QuboContext = {
  portfolioQubo: () => Promise.reject(new Error("not used")),
};

function bitsOf(mask: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (mask >> i) & 1);
}

function randomGraph(seed: number): Graph {
  const r = new Rng(seed);
  const n = r.int(5, 12);
  const g = erdosRenyi(n, r.float(0.2, 0.7), seed);
  return seed % 2 === 0 ? withWeights(g, "random", seed) : g;
}

describe("Max-Cut", () => {
  it("f(x) + offset = −cut(x) for every x", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const g = randomGraph(seed);
      const q = maxCutQubo(g);
      for (let m = 0; m < 1 << g.n; m += 7) {
        const bits = bitsOf(m, g.n);
        expect(evaluate(q, bits) + q.offset + cutWeight(g, bits).weight).toBe(0);
      }
    }
  });

  it("the QUBO minimum is exactly the maximum cut (vs direct brute force over cuts)", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = randomGraph(seed);
      const instance = { graph: g, weighted: seed % 2 === 0 };
      const q = await maxcut.toQubo(instance, noCtx);
      let best = 0;
      for (let m = 0; m < 1 << g.n; m++) best = Math.max(best, cutWeight(g, bitsOf(m, g.n)).weight);
      const bf = bruteForce(q);
      expect(-(bf.value + q.offset)).toBe(best);
      const it = maxcut.interpret(instance, bf.bits);
      expect(it.score).toBe(best);
      expect(it.better).toBe("higher");
      expect(it.feasible).toBe(true);
    }
  });

  it("known optima: Petersen 12, even ring 12", () => {
    const pq = maxCutQubo(petersen());
    expect(-bruteForce(pq).value).toBe(12);
    expect(-bruteForce(maxCutQubo(ring(12))).value).toBe(12);
  });

  it("interpret reports cut edges, sides and a readable summary", () => {
    const inst = { graph: ring(4), weighted: false };
    const r = maxcut.interpret(inst, [1, 0, 1, 0]);
    expect(r.score).toBe(4);
    expect(r.summary).toBe("Cuts 4 of 4 edges, splitting 4 nodes into 2 + 2");
    expect(r.metrics.find((m) => m.label === "Cut edges")?.value).toBe("4 / 4");
    expect(r.metrics.find((m) => m.label === "Sides (A | B)")?.value).toBe("2 | 2");
    expect(() => maxcut.interpret(inst, [1, 0])).toThrow(/bits/);
  });

  it("generate is deterministic and honours params", () => {
    const p = { nodes: 25, graph: "erdos", degree: 3, weighted: true };
    expect(maxcut.generate(p, 3)).toEqual(maxcut.generate(p, 3));
    expect(maxcut.generate(p, 3)).not.toEqual(maxcut.generate(p, 4));
    expect(maxcut.generate({ ...p, graph: "petersen" }, 1).graph.n).toBe(10);
    expect(() => maxcut.generate({ ...p, nodes: 1000 }, 1)).toThrow(/Nodes must be between 4 and 400/);
    expect(() => maxcut.generate({ ...p, graph: "hypercube" }, 1)).toThrow(/unknown option/);
  });
});

describe("Number partitioning", () => {
  it("f(x) + offset = difference² / 4 for every x", () => {
    const a = [4, 5, 6, 7, 8, 13];
    const q = partitionQubo(a);
    for (let m = 0; m < 1 << a.length; m++) {
      const bits = bitsOf(m, a.length);
      let d = 0;
      a.forEach((v, i) => (d += bits[i] ? v : -v));
      expect(evaluate(q, bits) + q.offset).toBe((d * d) / 4);
    }
  });

  it("the QUBO minimum is the minimal achievable difference", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = new Rng(seed);
      const n = r.int(4, 13);
      const numbers = Array.from({ length: n }, () => r.int(1, 60));
      const q = await partition.toQubo({ numbers }, noCtx);
      let best = Infinity;
      for (let m = 0; m < 1 << n; m++) {
        let d = 0;
        numbers.forEach((v, i) => (d += (m >> i) & 1 ? v : -v));
        best = Math.min(best, Math.abs(d));
      }
      const bf = bruteForce(q);
      expect(bf.value + q.offset).toBe((best * best) / 4);
      expect(partition.interpret({ numbers }, bf.bits).score).toBe(best);
    }
  });

  it("classic [4, 5, 6, 7, 8] splits perfectly", async () => {
    const inst = partition.generate(partition.presets[0].params, partition.presets[0].seed);
    expect(inst.numbers).toEqual([4, 5, 6, 7, 8]);
    const bf = bruteForce(await partition.toQubo(inst, noCtx));
    const r = partition.interpret(inst, bf.bits);
    expect(r.score).toBe(0);
    expect(r.summary).toBe("Perfect split: 15 vs 15");
    expect(r.metrics.find((m) => m.label === "Perfect split")?.tone).toBe("good");
  });

  it("odd totals count a difference of 1 as perfect", () => {
    const r = partition.interpret({ numbers: [1, 2, 4] }, [0, 0, 1]);
    expect(r.score).toBe(1);
    expect(r.summary).toMatch(/^Perfect split: 3 vs 4 \(the total is odd/);
    const r2 = partition.interpret({ numbers: [1, 2, 4] }, [1, 1, 1]);
    expect(r2.summary).toBe("Splits 3 numbers into sums 7 and 0 (difference 7)");
  });

  it("parses user lists with clear errors and generates deterministically", () => {
    expect(parseNumberList(" 3, 1 1;2\n2 [1] ")).toEqual([3, 1, 1, 2, 2, 1]);
    expect(() => parseNumberList("1, 2.5")).toThrow(/Item 2 \(2\.5\) is not a whole number/);
    expect(() => parseNumberList("1, x")).toThrow(/Item 2 \("x"\) is not a number/);
    expect(() => parseNumberList("1, -3")).toThrow(/must be positive/);
    expect(() => parseNumberList("7")).toThrow(/at least two/);
    const p = { count: 30, maxValue: 500, numbers: "" };
    const a = partition.generate(p, 9);
    expect(a).toEqual(partition.generate(p, 9));
    expect(a.numbers.length).toBe(30);
    expect(a.numbers.every((v) => v >= 1 && v <= 500 && Number.isInteger(v))).toBe(true);
  });
});

describe("Maximum independent set", () => {
  it("the QUBO minimum is −α(G) and its minimizer is independent", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = randomGraph(seed);
      const inst = { graph: g };
      const q = await mis.toQubo(inst, noCtx);
      let alpha = 0;
      for (let m = 0; m < 1 << g.n; m++) {
        const bits = bitsOf(m, g.n);
        if (conflicts(g, bits) === 0) alpha = Math.max(alpha, bits.reduce((s, b) => s + b, 0));
      }
      const bf = bruteForce(q);
      expect(bf.value + q.offset).toBe(-alpha);
      expect(conflicts(g, bf.bits)).toBe(0);
      const r = mis.interpret(inst, bf.bits);
      expect(r.feasible).toBe(true);
      expect(r.score).toBe(alpha);
    }
  });

  it("uses P = 2 and f + offset = −|S| + P·conflicts", () => {
    expect(MIS_PENALTY).toBe(2);
    const g = ring(5);
    const q = misQubo(g);
    const bits = [1, 1, 1, 0, 0]; // two conflicting edges
    expect(evaluate(q, bits) + q.offset).toBe(-3 + 2 * 2);
  });

  it("known optimum: Petersen α = 4", () => {
    expect(bruteForce(misQubo(petersen())).value).toBe(-4);
  });

  it("interpret flags conflicts and reports a deterministic greedy repair", () => {
    const g = ring(6);
    const all = [1, 1, 1, 1, 1, 1];
    const r = mis.interpret({ graph: g }, all);
    expect(r.feasible).toBe(false);
    expect(r.metrics.find((m) => m.label.startsWith("Conflicts"))?.value).toBe("6");
    const repaired = repairIndependentSet(g, all);
    expect(conflicts(g, repaired)).toBe(0);
    expect(r.score).toBe(repaired.reduce((s, b) => s + b, 0));
    expect(r.score).toBeGreaterThanOrEqual(2);
    expect(repairIndependentSet(g, all)).toEqual(repaired);
    expect(r.summary).toMatch(/^Selects 6 nodes but 6 edges have both ends selected; dropping conflicting nodes leaves an independent set of \d$/);
    const ok = mis.interpret({ graph: g }, [1, 0, 1, 0, 1, 0]);
    expect(ok.feasible).toBe(true);
    expect(ok.summary).toBe("Independent set of 3 nodes out of 6");
  });
});
