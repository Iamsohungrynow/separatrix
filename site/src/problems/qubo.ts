import type { Qubo } from "./types";

/** Largest QUBO the library accepts anywhere (parser, builders). */
export const MAX_QUBO_N = 512;

/** Largest n `bruteForce` will enumerate (2^20 ≈ 1M states). */
export const BRUTE_FORCE_MAX_N = 20;

/**
 * Accumulates QUBO terms given in any order into the upper triangle
 * (the coefficient of x_i x_j lands at (min, max)), summing duplicates.
 * `build()` drops terms whose merged value is exactly zero and returns terms
 * sorted by (i, j).
 */
export class QuboBuilder {
  readonly n: number;
  private readonly acc = new Map<number, number>();
  private constant = 0;
  private labels?: string[];
  private note?: string;

  constructor(n: number, labels?: string[]) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`QUBO size must be a non-negative integer (got ${n})`);
    this.n = n;
    if (labels !== undefined) {
      if (labels.length !== n) throw new Error(`Expected ${n} labels, got ${labels.length}`);
      this.labels = labels.slice();
    }
  }

  /** Add v to the coefficient of x_i x_j (i === j: linear coefficient of x_i). */
  add(i: number, j: number, v: number): this {
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= this.n || j >= this.n) {
      throw new Error(`QUBO index (${i}, ${j}) out of range for n = ${this.n}`);
    }
    if (!Number.isFinite(v)) throw new Error(`QUBO coefficient for (${i}, ${j}) is not finite (${v})`);
    if (v === 0) return this;
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const key = a * this.n + b;
    this.acc.set(key, (this.acc.get(key) ?? 0) + v);
    return this;
  }

  /** Add v to the linear coefficient of x_i. */
  addLinear(i: number, v: number): this {
    return this.add(i, i, v);
  }

  /** Add a constant to the offset. */
  addOffset(v: number): this {
    if (!Number.isFinite(v)) throw new Error(`QUBO offset is not finite (${v})`);
    this.constant += v;
    return this;
  }

  setNote(note: string): this {
    this.note = note;
    return this;
  }

  build(): Qubo {
    const keys = [...this.acc.keys()].sort((x, y) => x - y);
    const terms: [number, number, number][] = [];
    for (const key of keys) {
      const v = this.acc.get(key) ?? 0;
      if (v === 0) continue;
      terms.push([Math.floor(key / this.n), key % this.n, v]);
    }
    const q: Qubo = { n: this.n, terms, offset: this.constant };
    if (this.labels) q.labels = this.labels.slice();
    if (this.note !== undefined) q.note = this.note;
    return q;
  }
}

function assertBits(q: Qubo, bits: ArrayLike<number>): void {
  if (bits.length !== q.n) throw new Error(`Bit vector has length ${bits.length}, expected ${q.n}`);
}

/** f(x) = Σ Q_ii x_i + Σ_{i<j} Q_ij x_i x_j. Does NOT include `offset`. Nonzero entries count as 1. */
export function evaluate(q: Qubo, bits: ArrayLike<number>): number {
  assertBits(q, bits);
  let total = 0;
  for (const [i, j, v] of q.terms) {
    if (bits[i] !== 0 && bits[j] !== 0) total += v;
  }
  return total;
}

/** f(x) + offset. */
export function evaluateWithOffset(q: Qubo, bits: ArrayLike<number>): number {
  return evaluate(q, bits) + q.offset;
}

export interface BruteForceResult {
  /** A minimizer (the first one met in Gray-code order). */
  bits: Uint8Array;
  /** min f(x), excluding offset; recomputed exactly for the returned bits. */
  value: number;
  /** Number of states within `tol` of the minimum. */
  degeneracy: number;
}

/**
 * Exhaustive minimization over all 2ⁿ states (n ≤ 20) using Gray-code order,
 * so each step is one bit flip with an O(degree) energy update.
 */
export function bruteForce(q: Qubo, tol = 1e-9): BruteForceResult {
  const n = q.n;
  if (n > BRUTE_FORCE_MAX_N) throw new Error(`bruteForce is limited to n <= ${BRUTE_FORCE_MAX_N} (got ${n})`);
  const linear = new Float64Array(n);
  const nbrs: { j: number; v: number }[][] = Array.from({ length: n }, () => []);
  for (const [i, j, v] of q.terms) {
    if (i === j) linear[i] += v;
    else {
      nbrs[i].push({ j, v });
      nbrs[j].push({ j: i, v });
    }
  }
  const x = new Uint8Array(n);
  let value = 0;
  let best = 0;
  let bestBits = new Uint8Array(n);
  let degeneracy = 1;
  const total = 2 ** n;
  for (let step = 1; step < total; step++) {
    // Bit to flip: index of the lowest set bit of `step`.
    let k = 0;
    while (((step >>> k) & 1) === 0) k++;
    let delta = linear[k];
    for (const { j, v } of nbrs[k]) if (x[j]) delta += v;
    if (x[k]) {
      x[k] = 0;
      value -= delta;
    } else {
      x[k] = 1;
      value += delta;
    }
    if (value < best - tol) {
      best = value;
      bestBits = x.slice();
      degeneracy = 1;
    } else if (Math.abs(value - best) <= tol) {
      degeneracy++;
    }
  }
  return { bits: bestBits, value: evaluate(q, bestBits), degeneracy };
}

/** Dense n×n upper-triangular matrix: M[i][i] = Q_ii, M[i][j] = Q_ij (i < j), zeros below. */
export function toDense(q: Qubo): number[][] {
  const m = Array.from({ length: q.n }, () => new Array<number>(q.n).fill(0));
  for (const [i, j, v] of q.terms) m[i][j] += v;
  return m;
}

/** Fraction of the n(n−1)/2 off-diagonal pairs that carry a nonzero coupling. */
export function density(q: Qubo): number {
  if (q.n < 2) return 0;
  let quad = 0;
  for (const [i, j] of q.terms) if (i !== j) quad++;
  return quad / ((q.n * (q.n - 1)) / 2);
}

/** Largest absolute coefficient (linear or quadratic); 0 for an empty QUBO. */
export function maxAbs(q: Qubo): number {
  let m = 0;
  for (const t of q.terms) m = Math.max(m, Math.abs(t[2]));
  return m;
}

export interface QuboStats {
  n: number;
  linearTerms: number;
  quadraticTerms: number;
  density: number;
  maxAbs: number;
}

export function quboStats(q: Qubo): QuboStats {
  let linearTerms = 0;
  for (const [i, j] of q.terms) if (i === j) linearTerms++;
  return {
    n: q.n,
    linearTerms,
    quadraticTerms: q.terms.length - linearTerms,
    density: density(q),
    maxAbs: maxAbs(q),
  };
}
