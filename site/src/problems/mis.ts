import { checkBits } from "./format";
import type { Graph } from "./graph";
import { graphParamSpecs, readGraph } from "./graphProblem";
import { QuboBuilder } from "./qubo";
import type { Interpretation, ProblemDef, Qubo } from "./types";

export interface MisInstance {
  graph: Graph;
  /** Set when the requested size was adjusted (e.g. grid rounding). */
  notice?: string;
}

/**
 * Penalty for selecting both endpoints of an edge.
 *
 * Why any P > 1 suffices: take a selection with a conflicting edge (i, j)
 * and drop i. The reward term −Σx rises by exactly 1, while the penalty
 * falls by P times the number of selected neighbours of i, which is at
 * least 1. With P > 1 every such drop strictly lowers f, so no minimizer
 * has a conflict, and on independent sets f = −|S|: minimizing f maximizes
 * the set. (P = 1 would only tie; P = 2 leaves a clear margin without
 * inflating the coefficient range.)
 */
export const MIS_PENALTY = 2;

/**
 * f(x) = −Σ_i x_i + P Σ_{(i,j)∈E} x_i x_j,  offset = 0, so
 * f(x) + offset = −|S| + P·(conflicting edges); on independent sets f = −|S|.
 */
export function misQubo(graph: Graph, penalty = MIS_PENALTY): Qubo {
  const b = new QuboBuilder(graph.n);
  for (let i = 0; i < graph.n; i++) b.add(i, i, -1);
  for (const [i, j] of graph.edges) b.add(i, j, penalty);
  b.setNote(`f(x) + offset = −(set size) + ${penalty}·(edges with both ends selected)`);
  return b.build();
}

/** Edges with both endpoints selected. */
export function conflicts(graph: Graph, bits: ArrayLike<number>): number {
  let c = 0;
  for (const [i, j] of graph.edges) if (bits[i] !== 0 && bits[j] !== 0) c++;
  return c;
}

/**
 * Deterministic greedy repair: walk the edges in order; whenever both ends
 * are still selected, drop the endpoint with more remaining conflicts (ties:
 * the higher index). Returns a new 0/1 array that is an independent set.
 */
export function repairIndependentSet(graph: Graph, bits: ArrayLike<number>): Uint8Array {
  const sel = new Uint8Array(graph.n);
  for (let i = 0; i < graph.n; i++) sel[i] = bits[i] !== 0 ? 1 : 0;
  const conf = new Int32Array(graph.n);
  const adj: number[][] = Array.from({ length: graph.n }, () => []);
  for (const [i, j] of graph.edges) {
    adj[i].push(j);
    adj[j].push(i);
    if (sel[i] && sel[j]) {
      conf[i]++;
      conf[j]++;
    }
  }
  for (const [i, j] of graph.edges) {
    if (!(sel[i] && sel[j])) continue;
    const drop = conf[i] > conf[j] ? i : conf[j] > conf[i] ? j : Math.max(i, j);
    sel[drop] = 0;
    for (const k of adj[drop]) if (sel[k]) conf[k]--;
    conf[drop] = 0;
  }
  return sel;
}

const params = graphParamSpecs(false);

export const mis: ProblemDef<MisInstance> = {
  id: "mis",
  name: "Maximum Independent Set",
  tagline: "Pick as many nodes as possible with no two of them connected.",
  description:
    "Choose the largest group of nodes in a graph such that no two chosen nodes share an edge. " +
    "It models scheduling without clashes, placing radio transmitters that must not interfere, and picking non-overlapping features; it is NP-hard in general. " +
    "Each node is a bit: the QUBO rewards every chosen node with −1 and charges a penalty of +2 for every edge whose two ends are both chosen, " +
    "which is large enough that breaking a conflict always pays.",
  params,
  presets: [
    { label: "Petersen graph", params: { nodes: 10, graph: "petersen", degree: 3 }, seed: 1, note: "The largest independent set has 4 nodes." },
    { label: "Ring of 12", params: { nodes: 12, graph: "ring", degree: 2 }, seed: 1, note: "Every other node: 6." },
    { label: "Random 20 (exact-verifiable)", params: { nodes: 20, graph: "erdos", degree: 4 }, seed: 7 },
    { label: "Geometric 60", params: { nodes: 60, graph: "geometric", degree: 5 }, seed: 3 },
    { label: "Big 250 (beyond exact)", params: { nodes: 250, graph: "geometric", degree: 6 }, seed: 11 },
  ],
  generate(p, seed) {
    const { graph, notice } = readGraph(params, p, seed, false);
    return notice === undefined ? { graph } : { graph, notice };
  },
  async toQubo(instance) {
    return misQubo(instance.graph);
  },
  /**
   * `score` is the size of the independent set the solution yields: the raw
   * selection when it is feasible, otherwise the greedily repaired one
   * (`feasible` is false in that case and the summary says so).
   */
  interpret(instance, bits): Interpretation {
    const g = instance.graph;
    checkBits(bits, g.n);
    let size = 0;
    for (let i = 0; i < g.n; i++) if (bits[i] !== 0) size++;
    const viol = conflicts(g, bits);
    const repaired = viol === 0 ? size : repairIndependentSet(g, bits).reduce((a, b) => a + b, 0);
    const feasible = viol === 0;
    return {
      feasible,
      score: repaired,
      scoreLabel: "independent set size",
      better: "higher",
      metrics: [
        { label: "Selected nodes", value: `${size} of ${g.n}`, tone: "neutral" },
        { label: "Conflicts (edges inside the set)", value: String(viol), tone: feasible ? "good" : "bad" },
        { label: "Greedy repaired size", value: String(repaired), tone: feasible ? "neutral" : "bad" },
      ],
      summary: feasible
        ? `Independent set of ${size} nodes out of ${g.n}`
        : `Selects ${size} nodes but ${viol} edge${viol === 1 ? " has" : "s have"} both ends selected; dropping conflicting nodes leaves an independent set of ${repaired}`,
    };
  },
};
