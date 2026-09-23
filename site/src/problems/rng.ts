/**
 * Small seeded PRNG (mulberry32, seed scrambled through splitmix32) so every
 * generator in the problem library is deterministic for a given seed.
 * Not cryptographic; plenty for instance generation and layouts.
 */
export class Rng {
  private state: number;
  private spare: number | null = null;

  constructor(seed: number) {
    // Accept any finite number: fold the fractional part in, then scramble so
    // that nearby seeds (1, 2, 3, ...) give unrelated streams.
    const s = Number.isFinite(seed) ? seed : 0;
    const lo = s >>> 0;
    const hi = Math.floor(s / 4294967296) >>> 0;
    const frac = Math.floor((s - Math.floor(s)) * 4294967296) >>> 0;
    this.state = splitmix32(lo ^ splitmix32(hi ^ splitmix32(frac)));
  }

  /** Next raw 32-bit unsigned integer. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [lo, hi) (default [0, 1)). */
  float(lo = 0, hi = 1): number {
    return lo + (hi - lo) * (this.next() / 4294967296);
  }

  /** Uniform integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number {
    const a = Math.ceil(Math.min(lo, hi));
    const b = Math.floor(Math.max(lo, hi));
    if (b < a) throw new Error(`Rng.int: empty range [${lo}, ${hi}]`);
    return a + Math.floor(this.float() * (b - a + 1));
  }

  /** Standard normal sample (Box-Muller, caching the second value). */
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const z = this.spare;
      this.spare = null;
      return mean + sd * z;
    }
    let u = 0;
    while (u === 0) u = this.float();
    const v = this.float();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return mean + sd * r * Math.cos(2 * Math.PI * v);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  /** In-place Fisher-Yates shuffle; returns the same array. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}

function splitmix32(x: number): number {
  let z = (x + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}
