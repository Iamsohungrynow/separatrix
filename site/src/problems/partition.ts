import { checkBits, fmtNum } from "./format";
import { ParamReader } from "./params";
import { QuboBuilder } from "./qubo";
import { Rng } from "./rng";
import type { Interpretation, ParamSpec, ProblemDef, Qubo } from "./types";

export interface PartitionInstance {
  /** Positive integers to split into two groups (bit 1 = group A). */
  numbers: number[];
}

export const PARTITION_MAX_COUNT = 120;
export const PARTITION_MAX_VALUE = 1_000_000;

/**
 * With spins s_i = 2x_i − 1 and S = Σ a_i, the signed difference is
 * D = Σ a_i s_i = 2·Σ a_i x_i − S. We encode D²/4 (dividing by 4 keeps every
 * coefficient an integer, so the QUBO is exact in floating point):
 *
 *     D²/4 = Σ_i (a_i² − S·a_i) x_i + Σ_{i<j} 2 a_i a_j x_i x_j + S²/4
 *
 * i.e. terms as above and offset = S²/4, so
 *     f(x) + offset = difference² / 4.
 */
export function partitionQubo(numbers: number[]): Qubo {
  const n = numbers.length;
  const S = numbers.reduce((a, b) => a + b, 0);
  const b = new QuboBuilder(n);
  for (let i = 0; i < n; i++) {
    const a = numbers[i];
    b.add(i, i, a * a - S * a);
    for (let j = i + 1; j < n; j++) b.add(i, j, 2 * a * numbers[j]);
  }
  b.addOffset((S * S) / 4);
  b.setNote("f(x) + offset = (sum of group A − sum of group B)² / 4");
  return b.build();
}

/** Parse "4, 5 6;7" style lists of positive integers. */
export function parseNumberList(text: string): number[] {
  const tokens = text
    .replace(/[[\]()]/g, " ")
    .split(/[\s,;]+/)
    .filter((t) => t.length > 0);
  const out: number[] = [];
  for (const [idx, t] of tokens.entries()) {
    const v = Number(t);
    if (!Number.isFinite(v)) throw new Error(`Item ${idx + 1} ("${t}") is not a number`);
    if (!Number.isInteger(v)) throw new Error(`Item ${idx + 1} (${t}) is not a whole number; number partitioning here uses whole numbers`);
    if (v <= 0) throw new Error(`Item ${idx + 1} (${t}) must be positive`);
    if (v > PARTITION_MAX_VALUE) throw new Error(`Item ${idx + 1} (${t}) is larger than ${PARTITION_MAX_VALUE.toLocaleString("en-US")}`);
    out.push(v);
  }
  if (out.length < 2) throw new Error("Enter at least two numbers to split");
  if (out.length > PARTITION_MAX_COUNT) throw new Error(`At most ${PARTITION_MAX_COUNT} numbers (got ${out.length})`);
  return out;
}

const params: ParamSpec[] = [
  { key: "count", label: "How many numbers", kind: "int", min: 4, max: PARTITION_MAX_COUNT, step: 1, default: 20, hint: "Exact brute force is feasible up to about 20." },
  { key: "maxValue", label: "Largest value", kind: "int", min: 2, max: 10000, step: 1, default: 100, hint: "Numbers are drawn uniformly from 1 to this value." },
  {
    key: "numbers",
    label: "Your own numbers (optional)",
    kind: "text",
    default: "",
    placeholder: "e.g. 4, 5, 6, 7, 8",
    hint: "Whole numbers separated by commas or spaces. When filled in, this replaces the random numbers.",
  },
];

export const partition: ProblemDef<PartitionInstance> = {
  id: "partition",
  name: "Number Partitioning",
  tagline: "Split a pile of numbers into two groups with sums as equal as possible.",
  description:
    "Given a list of whole numbers, divide them into two groups whose sums are as close as possible. " +
    "It is the idealized version of balancing loads across two machines, splitting a bill, or dividing assets fairly, and one of Karp's original NP-complete problems. " +
    "Each number gets a bit for its group; with spins s = 2x − 1 the squared difference (Σ a_i s_i)² expands into a QUBO whose minimum is the most even split.",
  params,
  presets: [
    { label: "Classic [4, 5, 6, 7, 8]", params: { count: 5, maxValue: 8, numbers: "4, 5, 6, 7, 8" }, seed: 1, note: "Total 30: 4 + 5 + 6 = 7 + 8 = 15." },
    { label: "Textbook [3, 1, 1, 2, 2, 1]", params: { count: 6, maxValue: 3, numbers: "3, 1, 1, 2, 2, 1" }, seed: 1, note: "Total 10: {1, 1, 1, 2} vs {2, 3}." },
    { label: "Random 16 (exact-verifiable)", params: { count: 16, maxValue: 100, numbers: "" }, seed: 5 },
    { label: "40 numbers up to 1000", params: { count: 40, maxValue: 1000, numbers: "" }, seed: 8 },
    { label: "Big 120 (beyond exact)", params: { count: 120, maxValue: 10000, numbers: "" }, seed: 13, note: "Wide value ranges are notoriously hard for annealing-style solvers." },
  ],
  generate(p, seed) {
    const r = new ParamReader(params, p);
    const own = r.string("numbers").trim();
    if (own !== "") return { numbers: parseNumberList(own) };
    const count = r.number("count");
    const maxValue = r.number("maxValue");
    const rng = new Rng(seed);
    const numbers: number[] = [];
    for (let i = 0; i < count; i++) numbers.push(rng.int(1, maxValue));
    return { numbers };
  },
  async toQubo(instance) {
    return partitionQubo(instance.numbers);
  },
  interpret(instance, bits): Interpretation {
    const a = instance.numbers;
    checkBits(bits, a.length);
    let sumA = 0;
    let sumB = 0;
    let countA = 0;
    for (let i = 0; i < a.length; i++) {
      if (bits[i] !== 0) {
        sumA += a[i];
        countA++;
      } else sumB += a[i];
    }
    const total = sumA + sumB;
    const diff = Math.abs(sumA - sumB);
    const bestPossible = total % 2;
    const perfect = diff === bestPossible;
    const lo = Math.min(sumA, sumB);
    const hi = Math.max(sumA, sumB);
    return {
      feasible: true,
      score: diff,
      scoreLabel: "difference",
      better: "lower",
      metrics: [
        { label: "Group A", value: `${fmtNum(sumA)} (${countA} numbers)`, tone: "neutral" },
        { label: "Group B", value: `${fmtNum(sumB)} (${a.length - countA} numbers)`, tone: "neutral" },
        { label: "Difference", value: fmtNum(diff), tone: perfect ? "good" : "neutral" },
        { label: "Perfect split", value: perfect ? (bestPossible === 1 ? "yes (odd total, 1 is the best possible)" : "yes") : "no", tone: perfect ? "good" : "neutral" },
      ],
      summary: perfect
        ? `Perfect split: ${fmtNum(lo)} vs ${fmtNum(hi)}${bestPossible === 1 ? " (the total is odd, so a difference of 1 is the best possible)" : ""}`
        : `Splits ${a.length} numbers into sums ${fmtNum(sumA)} and ${fmtNum(sumB)} (difference ${fmtNum(diff)})`,
    };
  },
};
