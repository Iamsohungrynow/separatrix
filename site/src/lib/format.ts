export const groupDigits = (s: string | number) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Compact, human number: 61,523,748 -> "61.5M", 0.000123 -> "1.23e-4". */
export function fmtCompact(v: number): string {
  if (!Number.isFinite(v)) return "-";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e15)) return v.toExponential(2);
  if (a >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return fmtNum(v);
}

/** Up to 6 significant digits without trailing zeros; integers stay integers. */
export function fmtNum(v: number, sig = 6): string {
  if (!Number.isFinite(v)) return "-";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return groupDigits(v);
  const s = Number(v.toPrecision(sig)).toString();
  return s.includes("e") ? v.toExponential(3) : s;
}

export function fmtPct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/** C(n, k) as a float, for display and for rough cost estimates. */
export function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}
