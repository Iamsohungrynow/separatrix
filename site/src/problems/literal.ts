/**
 * A small parser for the union of JSON and Python literal syntax: dicts with
 * any hashable-looking keys (strings, numbers, tuples), lists, tuples,
 * single- or double-quoted strings, True/False/None and true/false/null,
 * trailing commas, and `#` comments. Unlike JSON.parse it keeps object keys
 * in source order and records line/column for every node, so QUBO parse
 * errors can point at the offending line.
 */

interface Pos {
  line: number;
  col: number;
}

export type LitNode =
  | ({ kind: "object"; entries: { key: LitNode; value: LitNode }[] } & Pos)
  | ({ kind: "array"; items: LitNode[] } & Pos)
  | ({ kind: "tuple"; items: LitNode[] } & Pos)
  | ({ kind: "string"; value: string } & Pos)
  | ({ kind: "number"; value: number; raw: string } & Pos)
  | ({ kind: "bool"; value: boolean } & Pos)
  | ({ kind: "null" } & Pos);

export class LiteralError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`Line ${line}, column ${col}: ${message}`);
    this.name = "LiteralError";
  }
}

type Tok =
  | ({ t: "punct"; v: "{" | "}" | "[" | "]" | "(" | ")" | ":" | "," } & Pos)
  | ({ t: "string"; v: string } & Pos)
  | ({ t: "number"; v: number; raw: string } & Pos)
  | ({ t: "ident"; v: string } & Pos)
  | ({ t: "eof" } & Pos);

const NUM_RE = /^[+-]?\s*(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.]*/;

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const pos = (): Pos => ({ line, col: i - lineStart + 1 });
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c.charCodeAt(0) === 0xfeff) {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if ("{}[]():,".includes(c)) {
      toks.push({ t: "punct", v: c as "{", ...pos() });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = pos();
      i++;
      let out = "";
      for (;;) {
        if (i >= src.length || src[i] === "\n") throw new LiteralError("unterminated string", start.line, start.col);
        const ch = src[i];
        if (ch === c) {
          i++;
          break;
        }
        if (ch === "\\") {
          const e = src[i + 1];
          i += 2;
          if (e === "n") out += "\n";
          else if (e === "t") out += "\t";
          else if (e === "r") out += "\r";
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e === "u" || e === "x") {
            const len = e === "u" ? 4 : 2;
            const hex = src.slice(i, i + len);
            if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new LiteralError(`bad \\${e} escape in string`, start.line, start.col);
            out += String.fromCharCode(parseInt(hex, 16));
            i += len;
          } else if (e === undefined) throw new LiteralError("unterminated string", start.line, start.col);
          else out += e; // \\ \" \' \/ and anything else literally
          continue;
        }
        out += ch;
        i++;
      }
      toks.push({ t: "string", v: out, ...start });
      continue;
    }
    const rest = src.slice(i, i + 512);
    const num = NUM_RE.exec(rest);
    if (num && (/[\d.]/.test(c) || ((c === "-" || c === "+") && /^[+-]\s*[\d.]/.test(rest)))) {
      const raw = num[0];
      const v = Number(raw.replace(/[\s_]/g, ""));
      if (Number.isNaN(v)) throw new LiteralError(`"${raw}" is not a valid number`, line, i - lineStart + 1);
      toks.push({ t: "number", v, raw, ...pos() });
      i += raw.length;
      continue;
    }
    // Signed special floats: -inf, +Infinity, -nan
    const signed = /^([+-]?)\s*(inf|infinity|nan)\b/i.exec(rest);
    if (signed && (c === "-" || c === "+")) {
      toks.push({ t: "number", v: signed[2].toLowerCase() === "nan" ? NaN : signed[1] === "-" ? -Infinity : Infinity, raw: signed[0], ...pos() });
      i += signed[0].length;
      continue;
    }
    const id = IDENT_RE.exec(rest);
    if (id) {
      toks.push({ t: "ident", v: id[0], ...pos() });
      i += id[0].length;
      continue;
    }
    throw new LiteralError(`unexpected character "${c}"`, line, i - lineStart + 1);
  }
  toks.push({ t: "eof", ...pos() });
  return toks;
}

function describe(t: Tok): string {
  switch (t.t) {
    case "eof":
      return "end of input";
    case "string":
      return `string "${t.v}"`;
    case "number":
      return `number ${t.raw}`;
    default:
      return `"${t.v}"`;
  }
}

/** Parse one literal value spanning the whole input. Throws LiteralError. */
export function parseLiteral(src: string): LitNode {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isPunct = (t: Tok, v: string) => t.t === "punct" && t.v === v;

  const parseSeq = (close: "]" | ")"): { items: LitNode[]; trailingComma: boolean } => {
    const items: LitNode[] = [];
    let trailingComma = false;
    for (;;) {
      if (isPunct(peek(), close)) {
        p++;
        return { items, trailingComma };
      }
      items.push(value());
      trailingComma = false;
      const t = peek();
      if (isPunct(t, ",")) {
        p++;
        trailingComma = true;
      } else if (!isPunct(t, close)) throw new LiteralError(`expected "," or "${close}" but found ${describe(t)}`, t.line, t.col);
    }
  };

  const value = (): LitNode => {
    const t = peek();
    p++;
    switch (t.t) {
      case "number":
        return { kind: "number", value: t.v, raw: t.raw, line: t.line, col: t.col };
      case "string":
        return { kind: "string", value: t.v, line: t.line, col: t.col };
      case "ident": {
        const v = t.v;
        if (v === "true" || v === "True") return { kind: "bool", value: true, line: t.line, col: t.col };
        if (v === "false" || v === "False") return { kind: "bool", value: false, line: t.line, col: t.col };
        if (v === "null" || v === "None") return { kind: "null", line: t.line, col: t.col };
        const lower = v.toLowerCase();
        if (lower === "inf" || lower === "infinity") return { kind: "number", value: Infinity, raw: v, line: t.line, col: t.col };
        if (lower === "nan") return { kind: "number", value: NaN, raw: v, line: t.line, col: t.col };
        throw new LiteralError(`unexpected word "${v}"`, t.line, t.col);
      }
      case "eof":
        throw new LiteralError("unexpected end of input", t.line, t.col);
      case "punct": {
        if (t.v === "[") {
          const { items } = parseSeq("]");
          return { kind: "array", items, line: t.line, col: t.col };
        }
        if (t.v === "(") {
          const { items, trailingComma } = parseSeq(")");
          // Python: (x) is just x; (x,) is a 1-tuple.
          if (items.length === 1 && !trailingComma) return items[0];
          return { kind: "tuple", items, line: t.line, col: t.col };
        }
        if (t.v === "{") {
          const entries: { key: LitNode; value: LitNode }[] = [];
          for (;;) {
            if (isPunct(peek(), "}")) {
              p++;
              return { kind: "object", entries, line: t.line, col: t.col };
            }
            const key = value();
            const colon = peek();
            if (!isPunct(colon, ":")) throw new LiteralError(`expected ":" after a key but found ${describe(colon)}`, colon.line, colon.col);
            p++;
            entries.push({ key, value: value() });
            const sep = peek();
            if (isPunct(sep, ",")) p++;
            else if (!isPunct(sep, "}")) throw new LiteralError(`expected "," or "}" but found ${describe(sep)}`, sep.line, sep.col);
          }
        }
        throw new LiteralError(`expected a value but found ${describe(t)}`, t.line, t.col);
      }
    }
  };

  const root = value();
  const end = peek();
  if (end.t !== "eof") throw new LiteralError(`unexpected ${describe(end)} after the end of the value`, end.line, end.col);
  return root;
}

/** Human-readable description of a node for error messages. */
export function nodeDesc(n: LitNode): string {
  switch (n.kind) {
    case "number":
      return n.raw;
    case "string":
      return JSON.stringify(n.value);
    case "bool":
      return String(n.value);
    case "null":
      return "null";
    case "array":
      return "a list";
    case "tuple":
      return "a tuple";
    case "object":
      return "an object";
  }
}
