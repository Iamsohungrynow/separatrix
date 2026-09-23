import { custom, type CustomInstance } from "./custom";
import { maxcut, type MaxCutInstance } from "./maxcut";
import { mis, type MisInstance } from "./mis";
import { partition, type PartitionInstance } from "./partition";
import { portfolio, type PortfolioInstance } from "./portfolio";
import type { ProblemDef, ProblemId } from "./types";

/** Instance type per problem id, for UI code that renders instances. */
export interface InstanceMap {
  maxcut: MaxCutInstance;
  partition: PartitionInstance;
  mis: MisInstance;
  portfolio: PortfolioInstance;
  custom: CustomInstance;
}

/**
 * All problems, in display order. Instances are opaque (`unknown`) at this
 * level: generic code passes them from `generate` to `toQubo`/`interpret`;
 * renderers switch on `id` and narrow with `InstanceMap`.
 */
export const PROBLEMS: readonly ProblemDef<unknown>[] = [maxcut, partition, mis, portfolio, custom];

/** Typed lookup by id. */
export const PROBLEM_BY_ID: { [K in ProblemId]: ProblemDef<InstanceMap[K]> } = {
  maxcut,
  partition,
  mis,
  portfolio,
  custom,
};

export function getProblem(id: string): ProblemDef<unknown> | undefined {
  return PROBLEMS.find((p) => p.id === id);
}

export * from "./types";
export { Rng } from "./rng";
export * from "./qubo";
export * from "./graph";
export { defaultParams, ParamReader } from "./params";
export { fmtNum, fmtPct } from "./format";
export { maxcut, maxCutQubo, cutWeight, type MaxCutInstance } from "./maxcut";
export { partition, partitionQubo, parseNumberList, type PartitionInstance } from "./partition";
export { mis, misQubo, MIS_PENALTY, conflicts, repairIndependentSet, type MisInstance } from "./mis";
export {
  portfolio,
  setPortfolioDataset,
  getPortfolioDataset,
  portfolioStats,
  type PortfolioDataset,
  type PortfolioInstance,
  type PortfolioStats,
} from "./portfolio";
export {
  custom,
  parseQubo,
  parseQuboDetailed,
  CUSTOM_EXAMPLES,
  QUBO_FORMAT_LABELS,
  type CustomInstance,
  type ParsedQubo,
  type QuboFormat,
} from "./custom";
export * from "./exporters";
export { encodeShare, decodeShare, SHARE_VERSION } from "./share";
