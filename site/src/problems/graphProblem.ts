import { buildGraph, GRAPH_KIND_OPTIONS, isGraphKind, type BuiltGraph } from "./graph";
import { ParamReader } from "./params";
import type { ParamSpec, Params } from "./types";

/** Parameters shared by the graph problems (Max-Cut, MIS). */
export function graphParamSpecs(withWeights: boolean): ParamSpec[] {
  const specs: ParamSpec[] = [
    { key: "nodes", label: "Nodes", kind: "int", min: 4, max: 400, step: 1, default: 20, hint: "Exact enumeration proves the optimum up to 24 nodes by default (26 max). Past that, only the heuristics can run." },
    {
      key: "graph",
      label: "Graph type",
      kind: "select",
      options: GRAPH_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      default: "geometric",
    },
    {
      key: "degree",
      label: "Average degree",
      kind: "float",
      min: 1,
      max: 20,
      step: 0.5,
      default: 4,
      hint: "Used by random geometric and Erdős–Rényi graphs; the other families have a fixed structure.",
    },
  ];
  if (withWeights) {
    specs.push({ key: "weighted", label: "Random edge weights (1-9)", kind: "bool", default: false, hint: "Off: every edge counts 1." });
  }
  return specs;
}

export function readGraph(specs: ParamSpec[], params: Params, seed: number, withWeights: boolean): BuiltGraph & { weighted: boolean } {
  const r = new ParamReader(specs, params);
  const kind = r.string("graph");
  if (!isGraphKind(kind)) throw new Error(`Unknown graph type "${kind}"`);
  const weighted = withWeights ? r.bool("weighted") : false;
  const built = buildGraph({ kind, n: r.number("nodes"), avgDegree: r.number("degree"), weighting: weighted ? "random" : "unit" }, seed);
  return { ...built, weighted };
}
