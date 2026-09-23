/** Deterministic, locale-independent number formatting for summaries and metrics. */

/** Integers verbatim; other values to `digits` significant digits, trailing zeros trimmed. */
export function fmtNum(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const s = Number(v.toPrecision(digits));
  return String(s);
}

/** Fraction → percentage string, e.g. 0.01234 → "1.23%". */
export function fmtPct(fraction: number, decimals = 2): string {
  if (!Number.isFinite(fraction)) return String(fraction);
  const v = fraction * 100;
  const s = v.toFixed(decimals);
  return `${s === `-${(0).toFixed(decimals)}` ? (0).toFixed(decimals) : s}%`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Validates a solution vector against the instance size. */
export function checkBits(bits: ArrayLike<number>, n: number): void {
  if (bits.length !== n) throw new Error(`Solution has ${bits.length} bits but the instance has ${n} variables`);
}
