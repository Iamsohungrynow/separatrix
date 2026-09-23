import { describe, expect, it } from "vitest";
import {
  buildGraph,
  degrees,
  erdosRenyi,
  forceLayout,
  geometric,
  grid,
  isConnected,
  petersen,
  regular3,
  ring,
  torus,
  withWeights,
  type Graph,
  type GraphKind,
} from "./graph";

function assertSimple(g: Graph): void {
  const seen = new Set<string>();
  for (const [i, j, w] of g.edges) {
    expect(i).toBeLessThan(j);
    expect(j).toBeLessThan(g.n);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(w).toBeGreaterThan(0);
    const k = `${i},${j}`;
    expect(seen.has(k)).toBe(false);
    seen.add(k);
  }
}

function assertInBox(g: Graph): void {
  expect(g.pos.length).toBe(g.n);
  for (const [x, y] of g.pos) {
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(0.05 - 1e-12);
    expect(x).toBeLessThanOrEqual(0.95 + 1e-12);
    expect(y).toBeGreaterThanOrEqual(0.05 - 1e-12);
    expect(y).toBeLessThanOrEqual(0.95 + 1e-12);
  }
}

const KINDS: GraphKind[] = ["geometric", "erdos", "regular3", "grid", "torus", "ring", "petersen"];

describe("graph generators", () => {
  it("are deterministic per seed, simple, and laid out inside the unit box", () => {
    for (const kind of KINDS) {
      for (const weighting of ["unit", "random"] as const) {
        const a = buildGraph({ kind, n: 24, avgDegree: 4, weighting }, 9);
        const b = buildGraph({ kind, n: 24, avgDegree: 4, weighting }, 9);
        expect(a).toEqual(b);
        assertSimple(a.graph);
        assertInBox(a.graph);
        if (weighting === "random") for (const e of a.graph.edges) expect(e[2]).toBeGreaterThanOrEqual(1), expect(e[2]).toBeLessThanOrEqual(9);
        else for (const e of a.graph.edges) expect(e[2]).toBe(1);
      }
    }
  });

  it("random families change with the seed", () => {
    for (const kind of ["geometric", "erdos", "regular3"] as const) {
      const a = buildGraph({ kind, n: 30, avgDegree: 4, weighting: "unit" }, 1).graph;
      const b = buildGraph({ kind, n: 30, avgDegree: 4, weighting: "unit" }, 2).graph;
      expect(a.edges).not.toEqual(b.edges);
    }
  });

  it("geometric graphs are connected and near the requested degree", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const g = geometric(80, { avgDegree: 5 }, seed);
      expect(isConnected(g)).toBe(true);
      const avg = (2 * g.edges.length) / g.n;
      expect(avg).toBeGreaterThan(3);
      expect(avg).toBeLessThan(8);
    }
    const byRadius = geometric(30, { radius: 2 }, 1);
    expect(byRadius.edges.length).toBe((30 * 29) / 2);
  });

  it("regular3 is 3-regular and simple; rejects odd n", () => {
    for (const n of [4, 10, 50, 400]) {
      const g = regular3(n, n);
      assertSimple(g);
      expect(degrees(g).every((d) => d === 3)).toBe(true);
      expect(g.edges.length).toBe((3 * n) / 2);
    }
    expect(() => regular3(9, 1)).toThrow(/even/);
    const odd = buildGraph({ kind: "regular3", n: 9, avgDegree: 3, weighting: "unit" }, 1);
    expect(odd.graph.n).toBe(10);
    expect(odd.notice).toMatch(/even/);
  });

  it("grid, torus, ring and Petersen have the textbook edge counts", () => {
    expect(grid(3, 4).edges.length).toBe(3 * 3 + 2 * 4);
    expect(torus(3, 4).edges.length).toBe(2 * 12);
    expect(degrees(torus(4, 5)).every((d) => d === 4)).toBe(true);
    expect(ring(12).edges.length).toBe(12);
    const p = petersen();
    expect(p.n).toBe(10);
    expect(p.edges.length).toBe(15);
    expect(degrees(p).every((d) => d === 3)).toBe(true);
    const rounded = buildGraph({ kind: "grid", n: 30, avgDegree: 4, weighting: "unit" }, 1);
    expect(rounded.graph.n).toBe(30);
    expect(rounded.notice).toBeUndefined();
    const g31 = buildGraph({ kind: "grid", n: 31, avgDegree: 4, weighting: "unit" }, 1);
    expect(g31.notice).toMatch(/rounded/);
  });

  it("erdosRenyi respects p extremes", () => {
    expect(erdosRenyi(10, 0, 1).edges.length).toBe(0);
    expect(erdosRenyi(10, 1, 1).edges.length).toBe(45);
    expect(() => erdosRenyi(10, 1.5, 1)).toThrow();
  });

  it("withWeights keeps structure and is seeded", () => {
    const g = ring(8);
    const a = withWeights(g, "random", 3);
    expect(a.edges.map((e) => [e[0], e[1]])).toEqual(g.edges.map((e) => [e[0], e[1]]));
    expect(withWeights(g, "random", 3)).toEqual(a);
    expect(withWeights(g, "unit", 3).edges.every((e) => e[2] === 1)).toBe(true);
  });
});

describe("forceLayout", () => {
  it("is deterministic, stays inside the box, and places neighbours closer than non-neighbours", () => {
    const g = grid(6, 6);
    const a = forceLayout(g.n, g.edges, 4);
    expect(forceLayout(g.n, g.edges, 4)).toEqual(a);
    assertInBox({ ...g, pos: a });
    const dist = (i: number, j: number) => Math.hypot(a[i][0] - a[j][0], a[i][1] - a[j][1]);
    const adj = new Set(g.edges.map(([i, j]) => `${i},${j}`));
    let eSum = 0;
    let eCnt = 0;
    let nSum = 0;
    let nCnt = 0;
    for (let i = 0; i < g.n; i++) {
      for (let j = i + 1; j < g.n; j++) {
        if (adj.has(`${i},${j}`)) {
          eSum += dist(i, j);
          eCnt++;
        } else {
          nSum += dist(i, j);
          nCnt++;
        }
      }
    }
    expect(eSum / eCnt).toBeLessThan(0.5 * (nSum / nCnt));
  });

  it("handles tiny and edgeless graphs", () => {
    expect(forceLayout(0, [], 1)).toEqual([]);
    expect(forceLayout(1, [], 1)).toEqual([[0.5, 0.5]]);
    const pos = forceLayout(5, [], 1);
    assertInBox({ n: 5, edges: [], pos });
  });
});
