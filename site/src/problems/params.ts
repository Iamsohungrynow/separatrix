import type { ParamSpec, Params } from "./types";

/** Default value of every parameter, keyed by `key`. */
export function defaultParams(specs: ParamSpec[]): Params {
  const out: Params = {};
  for (const s of specs) out[s.key] = s.default;
  return out;
}

/**
 * Typed, validating access to a Params bag. Missing keys fall back to the
 * spec default; numeric strings are accepted; out-of-range or malformed
 * values throw an Error whose message names the parameter by its label.
 */
export class ParamReader {
  private readonly specs = new Map<string, ParamSpec>();

  constructor(specs: ParamSpec[], private readonly params: Params) {
    for (const s of specs) this.specs.set(s.key, s);
  }

  private spec(key: string): ParamSpec {
    const s = this.specs.get(key);
    if (!s) throw new Error(`Unknown parameter "${key}"`);
    return s;
  }

  /** Numeric parameter (int specs are rounded to the nearest integer). */
  number(key: string): number {
    const s = this.spec(key);
    if (s.kind !== "int" && s.kind !== "float") throw new Error(`Parameter "${key}" is not numeric`);
    const raw = this.params[key] ?? s.default;
    const v = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(v)) throw new Error(`${s.label} must be a number (got "${String(raw)}")`);
    const val = s.kind === "int" ? Math.round(v) : v;
    if (val < s.min || val > s.max) throw new Error(`${s.label} must be between ${s.min} and ${s.max} (got ${val})`);
    return val;
  }

  bool(key: string): boolean {
    const s = this.spec(key);
    if (s.kind !== "bool") throw new Error(`Parameter "${key}" is not a toggle`);
    const raw = this.params[key] ?? s.default;
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === 1) return true;
    if (raw === "false" || raw === 0) return false;
    throw new Error(`${s.label} must be on or off (got "${String(raw)}")`);
  }

  /** Select value (validated against the options) or free text. */
  string(key: string): string {
    const s = this.spec(key);
    const raw = this.params[key] ?? s.default;
    const v = String(raw);
    if (s.kind === "select" && !s.options.some((o) => o.value === v)) {
      throw new Error(`${s.label}: unknown option "${v}"`);
    }
    return v;
  }
}
