import { checkBits, fmtNum, fmtPct } from "./format";
import type { Graph } from "./graph";
import { graphParamSpecs, readGraph } from "./graphProblem";
import { QuboBuilder } from "./qubo";
import type { Interpretation, ProblemDef, Qubo } from "./types";

export interface MaxCutInstance {
  graph: Graph;
  weighted: boolean;
  /** Set when the requested size was adjusted (e.g. grid rounding). */
  notice?: string;
}

/**
 * QUBO (sign convention): an edge (i, j) is cut iff x_i ≠ x_j, i.e. iff
 * x_i + x_j − 2 x_i x_j = 1. Maximizing the cut weight is minimizing
 *
 *     f(x) = Σ_{(i,j)∈E} w_ij (2 x_i x_j − x_i − x_j),   offset = 0,
 *
 * so  cut weight = −(f(x) + offset)  for every x. `interpret` never uses f;
 * it counts cut edges directly from the graph.
 */
export function maxCutQubo(graph: Graph): Qubo {
  const b = new QuboBuilder(graph.n);
  for (const [i, j, w] of graph.edges) {
    b.add(i, i, -w);
    b.add(j, j, -w);
    b.add(i, j, 2 * w);
  }
  b.setNote("f(x) + offset = −(cut weight); x_i = 1 puts node i on side A");
  return b.build();
}

/** Cut weight of a bit assignment, computed from the graph. */
export function cutWeight(graph: Graph, bits: ArrayLike<number>): { weight: number; edges: number } {
  let weight = 0;
  let edges = 0;
  for (const [i, j, w] of graph.edges) {
    if ((bits[i] !== 0) !== (bits[j] !== 0)) {
      weight += w;
      edges++;
    }
  }
  return { weight, edges };
}

const params = graphParamSpecs(true);

export const maxcut: ProblemDef<MaxCutInstance> = {
  id: "maxcut",
  name: "Max-Cut",
  tagline: "Split a network in two so that as many connections as possible cross the divide.",
  description:
    "Colour every node of a graph one of two colours so that the total weight of edges joining different colours is as large as possible. " +
    "It is a textbook NP-hard problem that shows up in circuit layout, clustering, and statistical physics (finding ground states of spin glasses), " +
    "and it is the standard benchmark for quantum and quantum-inspired optimizers. " +
    "Each node becomes one bit (its side), and each edge (i, j) contributes w·(2·x_i·x_j − x_i − x_j), which is −w exactly when the edge is cut.",
  params,
  presets: [
    { label: "Petersen graph", params: { nodes: 10, graph: "petersen", degree: 3, weighted: false }, seed: 1, note: "10 nodes, 15 edges; the best cut has 12 edges." },
    { label: "Ring of 12", params: { nodes: 12, graph: "ring", degree: 2, weighted: false }, seed: 1, note: "An even cycle: alternate colours to cut every edge." },
    { label: "Random 20 (exact-verifiable)", params: { nodes: 20, graph: "erdos", degree: 4, weighted: true }, seed: 7, note: "Small enough to check every one of the 2^20 colourings." },
    { label: "Geometric 60", params: { nodes: 60, graph: "geometric", degree: 5, weighted: false }, seed: 3 },
    { label: "Big 250 (beyond exact)", params: { nodes: 250, graph: "geometric", degree: 6, weighted: true }, seed: 11, note: "2^250 colourings: only heuristics can play here." },
  ],
  generate(p, seed) {
    const { graph, notice, weighted } = readGraph(params, p, seed, true);
    return notice === undefined ? { graph, weighted } : { graph, weighted, notice };
  },
  async toQubo(instance) {
    return maxCutQubo(instance.graph);
  },
  interpret(instance, bits): Interpretation {
    const g = instance.graph;
    checkBits(bits, g.n);
    const { weight, edges } = cutWeight(g, bits);
    let totalWeight = 0;
    for (const e of g.edges) totalWeight += e[2];
    let sideA = 0;
    for (let i = 0; i < g.n; i++) if (bits[i] !== 0) sideA++;
    const sideB = g.n - sideA;
    const m = g.edges.length;
    const metrics: Interpretation["metrics"] = [];
    if (instance.weighted) {
      metrics.push({ label: "Cut weight", value: `${fmtNum(weight)} of ${fmtNum(totalWeight)}`, tone: "neutral" });
    }
    metrics.push({ label: "Cut edges", value: `${edges} / ${m}`, tone: "neutral" });
    metrics.push({ label: "Share cut", value: m === 0 ? "n/a" : fmtPct(instance.weighted ? weight / totalWeight : edges / m, 1), tone: "neutral" });
    metrics.push({ label: "Sides (A | B)", value: `${sideA} | ${sideB}`, tone: "neutral" });
    const summary = instance.weighted
      ? `Cuts ${edges} of ${m} edges (weight ${fmtNum(weight)} of ${fmtNum(totalWeight)}), splitting ${g.n} nodes into ${sideA} + ${sideB}`
      : `Cuts ${edges} of ${m} edges, splitting ${g.n} nodes into ${sideA} + ${sideB}`;
    return {
      feasible: true,
      score: instance.weighted ? weight : edges,
      scoreLabel: instance.weighted ? "cut weight" : "cut edges",
      better: "higher",
      metrics,
      summary,
    };
  },
};
