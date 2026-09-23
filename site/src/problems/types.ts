/**
 * Shared types for the Separatrix Studio problem library.
 *
 * QUBO convention (identical to `separatrix/src/model.rs`): bits x ∈ {0,1}ⁿ,
 *
 *     f(x) = Σ_i Q_ii x_i + Σ_{i<j} Q_ij x_i x_j
 *
 * upper-triangular, the diagonal holds the linear terms, and every solver
 * minimizes. Each problem documents how its native objective relates to
 * `f(x) + offset`.
 */

export interface Qubo {
  n: number;
  /** Merged upper-triangular terms [i, j, v] with i <= j; i === j is linear. No zero-valued terms. */
  terms: [number, number, number][];
  /** Constant so that the problem-native objective relates to f(x) + offset where the problem defines it. */
  offset: number;
  labels?: string[];
  /**
   * Optional one-line, human-readable statement of how `f(x) + offset`
   * relates to the problem's own objective, e.g.
   * "f(x) + offset = −(cut weight)". Exporters copy it into a header comment.
   */
  note?: string;
}

export type ParamSpec =
  | { key: string; label: string; kind: "int" | "float"; min: number; max: number; step: number; default: number; hint?: string }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[]; default: string; hint?: string }
  | { key: string; label: string; kind: "bool"; default: boolean; hint?: string }
  | { key: string; label: string; kind: "text"; default: string; placeholder?: string; hint?: string };

export type Params = Record<string, number | string | boolean>;

export interface Metric {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
}

export interface Interpretation {
  feasible: boolean;
  /** Problem-native score, e.g. cut weight. */
  score: number;
  /** E.g. "cut weight". */
  scoreLabel: string;
  better: "higher" | "lower";
  metrics: Metric[];
  /** One plain-English line, e.g. "Cuts 23 of 31 edges (weight 41.5)". */
  summary: string;
}

export interface Preset {
  label: string;
  params: Params;
  seed: number;
  /** Optional one-line explanation shown next to the preset. */
  note?: string;
}

export interface QuboContext {
  /** Provided by the app (calls WASM). Tests pass a mock. */
  portfolioQubo(mu: number[], sigma: number[], k: number, riskAversion: number): Promise<Qubo>;
}

export type ProblemId = "maxcut" | "partition" | "mis" | "portfolio" | "custom";

export interface ProblemDef<I> {
  id: ProblemId;
  /** "Max-Cut" */
  name: string;
  /** One line for cards. */
  tagline: string;
  /** 2-4 sentences for newcomers: what it is, where it shows up in real life, how it maps to a QUBO. */
  description: string;
  params: ParamSpec[];
  presets: Preset[];
  /** Throws Error with a user-readable message on bad input. */
  generate(params: Params, seed: number): I;
  toQubo(instance: I, ctx: QuboContext): Promise<Qubo>;
  interpret(instance: I, bits: ArrayLike<number>): Interpretation;
}
