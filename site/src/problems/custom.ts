import { checkBits, fmtNum } from "./format";
import { LiteralError, nodeDesc, parseLiteral, type LitNode } from "./literal";
import { ParamReader } from "./params";
import { evaluate, MAX_QUBO_N, QuboBuilder } from "./qubo";
import type { Interpretation, ParamSpec, ProblemDef, Qubo } from "./types";

/**
 * "Bring your own QUBO": a tolerant, auto-detecting parser.
 *
 * Supported formats (see `parseQubo`):
 *  - json:   {"n"?: 3, "terms": [[i, j, v], ...], "offset"?: c, "labels"?: [...]} or a bare [[i, j, v], ...]
 *  - dimod:  {"linear": {...}, "quadratic": {...} | [[u, v, bias], ...], "offset"?: c, "vartype"?: "BINARY" | "SPIN"}
 *            and dimod's `bqm.to_serializable(use_bytes=False)` output
 *  - python: {(0, 0): -1, (0, 1): 2, ('x', 'y'): 0.5}  (optionally prefixed by `Q = `)
 *  - matrix: square rows of numbers (whitespace/commas, optional [ ]), read as xᵀ M x
 *  - edges:  one `i j v` per line (i == j is linear), `#` comments
 * Text formats (matrix, edges) also accept directive comments `# n = 5` and `# offset = 1.5`.
 */
export type QuboFormat = "json" | "dimod" | "python" | "matrix" | "edges";

export const QUBO_FORMAT_LABELS: Record<QuboFormat, string> = {
  json: "JSON terms",
  dimod: "dimod JSON",
  python: "Python dict",
  matrix: "Dense matrix",
  edges: "Edge list",
};

export interface ParsedQubo {
  qubo: Qubo;
  format: QuboFormat;
}

type VarKey = number | string;

interface RawTerm {
  a: VarKey;
  b: VarKey;
  v: number;
  /** Where the term came from, for error messages, e.g. "line 4". */
  where: string;
}

class QuboParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuboParseError";
  }
}

function fail(message: string): never {
  throw new QuboParseError(message);
}

const at = (n: { line: number }) => `line ${n.line}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function isIntLike(k: VarKey): boolean {
  return typeof k === "number" ? Number.isInteger(k) && k >= 0 : /^(0|[1-9]\d*)$/.test(k);
}

function checkIndexRange(idx: number, where: string): void {
  if (idx >= MAX_QUBO_N) fail(`${cap(where)}: index ${idx} is too large; the studio supports at most ${MAX_QUBO_N} variables (indices 0..${MAX_QUBO_N - 1})`);
}

function checkValue(v: number, where: string): void {
  if (!Number.isFinite(v)) fail(`${cap(where)}: coefficient ${v} is not a finite number`);
}

interface AssembleOpts {
  /** Variables in declaration order (fixes label order and n even without terms). */
  declared?: VarKey[];
  offset?: number;
}

/**
 * Turn raw (label, label, value) terms into a Qubo. If every label is a
 * non-negative integer (or an integer string), labels are used as indices
 * directly; otherwise labels get indices in first-seen order and are kept in
 * `labels`.
 */
function assemble(raw: RawTerm[], opts: AssembleOpts): Qubo {
  const order: VarKey[] = [];
  const seen = new Set<string>();
  const keyOf = (k: VarKey) => String(k);
  const note = (k: VarKey) => {
    const s = keyOf(k);
    if (!seen.has(s)) {
      seen.add(s);
      order.push(k);
    }
  };
  for (const k of opts.declared ?? []) note(k);
  for (const t of raw) {
    note(t.a);
    note(t.b);
  }
  const intMode = order.every(isIntLike);
  let n: number;
  let index: (k: VarKey) => number;
  let labels: string[] | undefined;
  if (intMode) {
    let max = -1;
    for (const k of order) max = Math.max(max, Number(k));
    n = max + 1;
    index = (k) => Number(k);
  } else {
    n = order.length;
    const map = new Map<string, number>();
    order.forEach((k, i) => map.set(keyOf(k), i));
    index = (k) => map.get(keyOf(k)) ?? -1;
    labels = order.map(keyOf);
  }
  if (n > MAX_QUBO_N) fail(`The QUBO has ${n} variables; the studio supports at most ${MAX_QUBO_N}`);
  if (n === 0) fail("The QUBO has no variables");
  const b = new QuboBuilder(n, labels);
  for (const t of raw) {
    checkValue(t.v, t.where);
    b.add(index(t.a), index(t.b), t.v);
  }
  b.addOffset(opts.offset ?? 0);
  return b.build();
}

// ---------------------------------------------------------------- literal helpers

type ObjNode = Extract<LitNode, { kind: "object" }>;

function field(obj: ObjNode, name: string): LitNode | undefined {
  for (const e of obj.entries) if (e.key.kind === "string" && e.key.value === name) return e.value;
  return undefined;
}

function hasField(obj: ObjNode, ...names: string[]): boolean {
  return names.some((nm) => field(obj, nm) !== undefined);
}

function num(node: LitNode, what: string): number {
  if (node.kind !== "number") fail(`${cap(at(node))}: ${what} should be a number, found ${nodeDesc(node)}`);
  return node.value;
}

function finiteNum(node: LitNode, what: string): number {
  const v = num(node, what);
  if (!Number.isFinite(v)) fail(`${cap(at(node))}: ${what} ${node.kind === "number" ? node.raw : ""} is not a finite number`);
  return v;
}

function index(node: LitNode, what: string): number {
  const v = num(node, what);
  if (!Number.isInteger(v) || v < 0) fail(`${cap(at(node))}: ${what} ${node.kind === "number" ? node.raw : ""} must be a non-negative whole number`);
  checkIndexRange(v, at(node));
  return v;
}

function isSeq(node: LitNode): node is Extract<LitNode, { kind: "array" | "tuple" }> {
  return node.kind === "array" || node.kind === "tuple";
}

/** Label from a scalar node: numbers stay numbers (so integer labels can be indices), strings stay strings. */
function label(node: LitNode, what: string): VarKey {
  if (node.kind === "number") {
    if (!Number.isFinite(node.value)) fail(`${cap(at(node))}: ${what} ${node.raw} is not a valid variable`);
    return node.value;
  }
  if (node.kind === "string") return node.value;
  return fail(`${cap(at(node))}: ${what} should be a variable name or index, found ${nodeDesc(node)}`);
}

// ---------------------------------------------------------------- format 1: JSON terms

function tripletRows(rows: LitNode[], explicitN: number | undefined): RawTerm[] {
  const raw: RawTerm[] = [];
  rows.forEach((row, k) => {
    const where = `term ${k + 1} (line ${row.line})`;
    if (!isSeq(row) || row.items.length !== 3) {
      fail(`${cap(where)}: expected [i, j, value], found ${isSeq(row) ? `${row.items.length} entries` : nodeDesc(row)}`);
    }
    const i = index(row.items[0], "index i");
    const j = index(row.items[1], "index j");
    const v = finiteNum(row.items[2], "value");
    if (explicitN !== undefined && (i >= explicitN || j >= explicitN)) {
      fail(`${cap(where)}: index ${Math.max(i, j)} is out of range for n = ${explicitN}`);
    }
    raw.push({ a: i, b: j, v, where });
  });
  return raw;
}

function fromTermsObject(obj: ObjNode): Qubo {
  const termsNode = field(obj, "terms");
  if (!termsNode) fail(`${cap(at(obj))}: missing "terms"`);
  if (!isSeq(termsNode)) fail(`${cap(at(termsNode))}: "terms" should be a list of [i, j, value], found ${nodeDesc(termsNode)}`);
  const nNode = field(obj, "n");
  let explicitN: number | undefined;
  if (nNode) {
    const v = num(nNode, '"n"');
    if (!Number.isInteger(v) || v < 1) fail(`${cap(at(nNode))}: "n" must be a positive whole number`);
    if (v > MAX_QUBO_N) fail(`${cap(at(nNode))}: n = ${v} is too large; the studio supports at most ${MAX_QUBO_N} variables`);
    explicitN = v;
  }
  const offNode = field(obj, "offset");
  const offset = offNode ? finiteNum(offNode, '"offset"') : 0;
  const raw = tripletRows(termsNode.items, explicitN);
  let n = explicitN ?? 0;
  for (const t of raw) n = Math.max(n, Number(t.a) + 1, Number(t.b) + 1);
  if (n === 0) fail(`${cap(at(obj))}: no terms and no "n"; cannot tell how many variables there are`);
  let labels: string[] | undefined;
  const labNode = field(obj, "labels");
  if (labNode && labNode.kind !== "null") {
    if (!isSeq(labNode)) fail(`${cap(at(labNode))}: "labels" should be a list of names`);
    if (labNode.items.length !== n) fail(`${cap(at(labNode))}: "labels" has ${labNode.items.length} names but there are ${n} variables`);
    labels = labNode.items.map((it) => {
      if (it.kind !== "string" && it.kind !== "number") fail(`${cap(at(it))}: labels should be strings`);
      return String(it.value);
    });
  }
  const b = new QuboBuilder(n, labels);
  for (const t of raw) b.add(Number(t.a), Number(t.b), t.v);
  b.addOffset(offset);
  return b.build();
}

// ---------------------------------------------------------------- format 4 from nodes / numbers

function fromMatrix(rows: number[][], rowWhere: string[]): Qubo {
  const n = rows.length;
  if (n === 0) fail("The matrix is empty");
  if (n > MAX_QUBO_N) fail(`The matrix has ${n} rows; the studio supports at most ${MAX_QUBO_N} variables`);
  rows.forEach((r, i) => {
    if (r.length !== n) {
      fail(`${cap(rowWhere[i])}: matrix row ${i + 1} has ${r.length} entries but there are ${n} rows; a QUBO matrix must be square`);
    }
    r.forEach((v) => checkValue(v, rowWhere[i]));
  });
  const b = new QuboBuilder(n);
  for (let i = 0; i < n; i++) {
    b.add(i, i, rows[i][i]);
    for (let j = i + 1; j < n; j++) b.add(i, j, rows[i][j] + rows[j][i]);
  }
  return b.build();
}

function matrixFromNodes(rows: LitNode[]): Qubo {
  const nums: number[][] = [];
  const where: string[] = [];
  for (const row of rows) {
    if (!isSeq(row)) fail(`${cap(at(row))}: expected a matrix row like [1, 2, 3], found ${nodeDesc(row)}`);
    nums.push(row.items.map((it) => num(it, "matrix entry")));
    where.push(at(row));
  }
  return fromMatrix(nums, where);
}

function looksLikeTriplets(rows: LitNode[]): boolean {
  return (
    rows.length > 0 &&
    rows.every(
      (r) =>
        isSeq(r) &&
        r.items.length === 3 &&
        r.items.every((x) => x.kind === "number") &&
        [r.items[0], r.items[1]].every((x) => x.kind === "number" && Number.isInteger(x.value) && x.value >= 0),
    )
  );
}

function fromArray(arr: Extract<LitNode, { kind: "array" | "tuple" }>, forced: QuboFormat | "auto"): ParsedQubo {
  if (forced === "matrix") return { qubo: matrixFromNodes(arr.items), format: "matrix" };
  if (forced === "json" || looksLikeTriplets(arr.items)) {
    const raw = tripletRows(arr.items, undefined);
    return { qubo: assemble(raw, {}), format: "json" };
  }
  const rows = arr.items;
  const numericRows = rows.length > 0 && rows.every((r) => isSeq(r) && r.items.every((x) => x.kind === "number"));
  if (numericRows && rows.every((r) => isSeq(r) && r.items.length === rows.length)) {
    return { qubo: matrixFromNodes(rows), format: "matrix" };
  }
  // Neither reading fits; report the precise problem against the likelier
  // one, judged by the first row: as long as the row count → matrix, 3 → triplets.
  const first = rows[0];
  const firstLen = first && isSeq(first) ? first.items.length : -1;
  if (firstLen === 3 && rows.length !== 3) {
    const raw = tripletRows(rows, undefined);
    return { qubo: assemble(raw, {}), format: "json" };
  }
  if (numericRows) return { qubo: matrixFromNodes(rows), format: "matrix" };
  return fail(`${cap(at(arr))}: a list should hold [i, j, value] triplets or the rows of a square matrix`);
}

// ---------------------------------------------------------------- format 2: dimod JSON

function parsePairKey(node: Extract<LitNode, { kind: "string" }>): [VarKey, VarKey] {
  let s = node.value.trim();
  if ((s.startsWith("(") && s.endsWith(")")) || (s.startsWith("[") && s.endsWith("]"))) s = s.slice(1, -1);
  const parts = s.split(",").map((p) => p.trim());
  if (parts.length === 3 && parts[2] === "") parts.pop(); // "(a, b,)"
  if (parts.length !== 2 || parts.some((p) => p === "")) {
    fail(`${cap(at(node))}: quadratic key ${JSON.stringify(node.value)} should name two variables like "a,b" or "(0, 1)"; for labels containing commas use the list form [["u", "v", bias], ...]`);
  }
  return [unquote(parts[0]), unquote(parts[1])];
}

function unquote(s: string): string {
  if (s.length >= 2 && (s[0] === "'" || s[0] === '"') && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

function readVartype(obj: ObjNode): boolean {
  const vt = field(obj, "vartype") ?? field(obj, "variable_type");
  if (!vt || vt.kind === "null") return false;
  if (vt.kind !== "string") fail(`${cap(at(vt))}: "vartype" should be "BINARY" or "SPIN"`);
  const v = vt.value.toUpperCase().replace(/^VARTYPE\./, "");
  if (v === "BINARY") return false;
  if (v === "SPIN") return true;
  return fail(`${cap(at(vt))}: unknown vartype ${JSON.stringify(vt.value)}; expected "BINARY" or "SPIN"`);
}

function fromDimod(obj: ObjNode): Qubo {
  if (hasField(obj, "linear_biases", "quadratic_biases", "variable_labels")) return fromDimodSerializable(obj);
  const spin = readVartype(obj);
  const declared: VarKey[] = [];
  const linear: RawTerm[] = [];
  const quadratic: RawTerm[] = [];
  const dup = new Set<string>();
  const lin = field(obj, "linear");
  if (lin && lin.kind !== "null") {
    if (lin.kind === "object") {
      for (const e of lin.entries) {
        const k = label(e.key, "variable");
        if (dup.has(String(k))) fail(`${cap(at(e.key))}: variable ${JSON.stringify(String(k))} appears twice in "linear"`);
        dup.add(String(k));
        declared.push(k);
        linear.push({ a: k, b: k, v: finiteNum(e.value, `linear bias of ${JSON.stringify(String(k))}`), where: at(e.value) });
      }
    } else if (isSeq(lin)) {
      for (const it of lin.items) {
        if (!isSeq(it) || it.items.length !== 2) fail(`${cap(at(it))}: "linear" entries should be [variable, bias]`);
        const k = label(it.items[0], "variable");
        declared.push(k);
        linear.push({ a: k, b: k, v: finiteNum(it.items[1], "linear bias"), where: at(it) });
      }
    } else fail(`${cap(at(lin))}: "linear" should be an object like {"a": -1}`);
  }
  const quad = field(obj, "quadratic");
  if (quad && quad.kind !== "null") {
    if (quad.kind === "object") {
      for (const e of quad.entries) {
        let pair: [VarKey, VarKey];
        if (e.key.kind === "string") pair = parsePairKey(e.key);
        else if (isSeq(e.key) && e.key.items.length === 2) pair = [label(e.key.items[0], "variable"), label(e.key.items[1], "variable")];
        else pair = fail(`${cap(at(e.key))}: quadratic keys should look like "a,b"`);
        quadratic.push({ a: pair[0], b: pair[1], v: finiteNum(e.value, "quadratic bias"), where: at(e.value) });
      }
    } else if (isSeq(quad)) {
      for (const it of quad.items) {
        if (!isSeq(it) || it.items.length !== 3) fail(`${cap(at(it))}: "quadratic" entries should be [u, v, bias]`);
        quadratic.push({ a: label(it.items[0], "variable"), b: label(it.items[1], "variable"), v: finiteNum(it.items[2], "quadratic bias"), where: at(it) });
      }
    } else fail(`${cap(at(quad))}: "quadratic" should be an object like {"a,b": 1} or a list of [u, v, bias]`);
  }
  const offNode = field(obj, "offset");
  const offset = offNode && offNode.kind !== "null" ? finiteNum(offNode, '"offset"') : 0;
  if (spin) return isingToQubo(linear, quadratic, declared, offset);
  return assemble([...linear, ...quadratic], { declared, offset });
}


function fromDimodSerializable(obj: ObjNode): Qubo {
  const spin = readVartype(obj);
  const get = (name: string): LitNode[] => {
    const nd = field(obj, name);
    if (!nd || nd.kind === "null") return [];
    if (nd.kind === "string") fail(`${cap(at(nd))}: "${name}" is base64-encoded; export with bqm.to_serializable(use_bytes=False)`);
    if (!isSeq(nd)) fail(`${cap(at(nd))}: "${name}" should be a list`);
    return nd.items;
  };
  const labelsNodes = get("variable_labels");
  const lin = get("linear_biases");
  const head = get("quadratic_head");
  const tail = get("quadratic_tail");
  const qb = get("quadratic_biases");
  const labels = labelsNodes.length > 0 ? labelsNodes.map((l) => label(l, "variable label")) : lin.map((_, i) => i);
  if (lin.length !== labels.length) fail(`"linear_biases" has ${lin.length} entries but there are ${labels.length} variables`);
  if (head.length !== tail.length || head.length !== qb.length) fail(`"quadratic_head", "quadratic_tail" and "quadratic_biases" must have the same length`);
  const raw: RawTerm[] = [];
  lin.forEach((nd, i) => raw.push({ a: labels[i], b: labels[i], v: finiteNum(nd, "linear bias"), where: at(nd) }));
  const linearCount = raw.length;
  for (let k = 0; k < qb.length; k++) {
    const hi = index(head[k], "quadratic_head entry");
    const ti = index(tail[k], "quadratic_tail entry");
    if (hi >= labels.length || ti >= labels.length) fail(`${cap(at(head[k]))}: quadratic index out of range`);
    raw.push({ a: labels[hi], b: labels[ti], v: finiteNum(qb[k], "quadratic bias"), where: at(qb[k]) });
  }
  const offNode = field(obj, "offset");
  const offset = offNode && offNode.kind !== "null" ? finiteNum(offNode, '"offset"') : 0;
  if (!spin) return assemble(raw, { declared: labels, offset });
  return isingToQubo(raw.slice(0, linearCount), raw.slice(linearCount), labels, offset);
}

/**
 * Ising (dimod convention E = Σ h_i s_i + Σ J_uv s_u s_v + c) to QUBO with
 * s = 2x − 1:  h s = 2h x − h;  J s_u s_v = 4J x_u x_v − 2J x_u − 2J x_v + J;
 * a (u, u) coupling is the constant J.
 */
function isingToQubo(linear: RawTerm[], quadratic: RawTerm[], declared: VarKey[], offset: number): Qubo {
  let c = offset;
  const bin: RawTerm[] = [];
  for (const t of linear) {
    bin.push({ ...t, v: 2 * t.v });
    c -= t.v;
  }
  const withSpinPairs = assembleSpinPairs(quadratic);
  return assemble([...bin, ...withSpinPairs.terms], { declared, offset: c + withSpinPairs.constant });
}

function assembleSpinPairs(quadratic: RawTerm[]): { terms: RawTerm[]; constant: number } {
  const terms: RawTerm[] = [];
  let constant = 0;
  for (const t of quadratic) {
    checkValue(t.v, t.where);
    if (String(t.a) === String(t.b)) {
      constant += t.v;
      continue;
    }
    terms.push({ ...t, v: 4 * t.v });
    terms.push({ a: t.a, b: t.a, v: -2 * t.v, where: t.where });
    terms.push({ a: t.b, b: t.b, v: -2 * t.v, where: t.where });
    constant += t.v;
  }
  return { terms, constant };
}

// ---------------------------------------------------------------- format 3: Python dict

function fromPythonDict(obj: ObjNode): Qubo {
  const raw: RawTerm[] = [];
  const seen = new Map<string, number>();
  for (const e of obj.entries) {
    let pair: [VarKey, VarKey];
    if (isSeq(e.key)) {
      if (e.key.items.length !== 2) fail(`${cap(at(e.key))}: key should be a pair like (0, 1), found ${e.key.items.length} items`);
      pair = [label(e.key.items[0], "variable"), label(e.key.items[1], "variable")];
    } else {
      const k = label(e.key, "key");
      pair = [k, k];
    }
    const canon = JSON.stringify([typeof pair[0], pair[0], typeof pair[1], pair[1]]);
    const prev = seen.get(canon);
    if (prev !== undefined) fail(`${cap(at(e.key))}: key (${pair.map((p) => JSON.stringify(p)).join(", ")}) repeats line ${prev}; Python would silently keep only the last value`);
    seen.set(canon, e.key.line);
    raw.push({ a: pair[0], b: pair[1], v: finiteNum(e.value, "coefficient"), where: at(e.value) });
  }
  if (raw.length === 0) fail("The dictionary is empty");
  return assemble(raw, {});
}

// ---------------------------------------------------------------- text formats

interface TextLine {
  line: number;
  tokens: string[];
}

interface TextDoc {
  lines: TextLine[];
  n?: number;
  offset?: number;
}

const DIRECTIVE_RE = /^\s*#\s*(n|offset)\s*[=:]\s*(\S+)\s*$/i;

function readText(text: string, splitSemicolons: boolean): TextDoc {
  const doc: TextDoc = { lines: [] };
  text.split(/\r?\n/).forEach((rawLine, k) => {
    const lineNo = k + 1;
    const d = DIRECTIVE_RE.exec(rawLine);
    if (d) {
      const v = Number(d[2]);
      if (d[1].toLowerCase() === "n") {
        if (!Number.isInteger(v) || v < 1) fail(`Line ${lineNo}: "# n = ${d[2]}" should give a positive whole number`);
        if (v > MAX_QUBO_N) fail(`Line ${lineNo}: n = ${v} is too large; the studio supports at most ${MAX_QUBO_N} variables`);
        doc.n = v;
      } else {
        if (!Number.isFinite(v)) fail(`Line ${lineNo}: "# offset = ${d[2]}" should give a finite number`);
        doc.offset = v;
      }
      return;
    }
    const body = rawLine.replace(/#.*$/, "");
    const segments = splitSemicolons ? body.split(";") : [body];
    for (const seg of segments) {
      const tokens = seg
        .replace(/[[\]]/g, " ")
        .split(/[\s,]+/)
        .filter((t) => t.length > 0);
      if (tokens.length > 0) doc.lines.push({ line: lineNo, tokens });
    }
  });
  return doc;
}

function parseNumberToken(tok: string, lineNo: number): number {
  const v = Number(tok);
  if (tok.trim() === "" || Number.isNaN(v)) fail(`Line ${lineNo}: "${tok}" is not a number`);
  if (!Number.isFinite(v)) fail(`Line ${lineNo}: ${tok} is not a finite number`);
  return v;
}

function fromEdgeList(doc: TextDoc): Qubo {
  if (doc.lines.length === 0 && doc.n === undefined) fail("No terms found; write one `i j value` per line");
  let n = doc.n ?? 0;
  const terms: [number, number, number][] = [];
  for (const { line, tokens } of doc.lines) {
    if (tokens.length !== 3) fail(`Line ${line}: expected "i j value" (3 items), found ${tokens.length} item${tokens.length === 1 ? "" : "s"}`);
    const idx = tokens.slice(0, 2).map((tok) => {
      const v = Number(tok);
      if (!/^[+-]?\d+(\.0*)?$/.test(tok) || !Number.isInteger(v) || v < 0) fail(`Line ${line}: index "${tok}" must be a non-negative whole number`);
      checkIndexRange(v, `line ${line}`);
      return v;
    });
    const v = parseNumberToken(tokens[2], line);
    if (doc.n !== undefined && (idx[0] >= doc.n || idx[1] >= doc.n)) fail(`Line ${line}: index ${Math.max(idx[0], idx[1])} is out of range for n = ${doc.n}`);
    n = Math.max(n, idx[0] + 1, idx[1] + 1);
    terms.push([idx[0], idx[1], v]);
  }
  if (n > MAX_QUBO_N) fail(`The QUBO has ${n} variables; the studio supports at most ${MAX_QUBO_N}`);
  const b = new QuboBuilder(n);
  for (const [i, j, v] of terms) b.add(i, j, v);
  b.addOffset(doc.offset ?? 0);
  return b.build();
}

/**
 * Rows of a matrix written as text. With brackets, each innermost [...] is
 * one row (numpy may wrap a long row over several lines); `;` also separates
 * rows (MATLAB style). `#` comments are ignored.
 */
function matrixRowsFromText(text: string): { rows: number[][]; where: string[] } {
  const noComments = text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, ""))
    .join("\n");
  const rows: number[][] = [];
  const where: string[] = [];
  const pushRow = (seg: string, lineNo: number) => {
    const tokens = seg.split(/[\s,]+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return;
    rows.push(tokens.map((t) => parseNumberToken(t, lineNo)));
    where.push(`line ${lineNo}`);
  };
  if (noComments.includes("[")) {
    const re = /\[([^[\]]*)\]/g;
    let lineNo = 1;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(noComments)) !== null) {
      for (let k = last; k < m.index; k++) if (noComments.charCodeAt(k) === 10) lineNo++;
      last = m.index;
      for (const seg of m[1].split(";")) pushRow(seg, lineNo);
    }
    const leftover = noComments.replace(re, " ").replace(/[\s,;[\]]/g, "");
    if (leftover.length > 0) fail(`Unexpected text outside the matrix brackets: "${leftover.slice(0, 20)}"`);
  } else {
    noComments.split("\n").forEach((line, k) => {
      for (const seg of line.split(";")) pushRow(seg, k + 1);
    });
  }
  return { rows, where };
}

function fromMatrixText(text: string): Qubo {
  const { rows, where } = matrixRowsFromText(text);
  return fromMatrix(rows, where);
}

function validEdgeRows(doc: TextDoc): boolean {
  return doc.lines.every((l) => l.tokens.length === 3 && l.tokens.slice(0, 2).every((t) => /^\d+$/.test(t) && Number(t) < MAX_QUBO_N));
}

function autoText(text: string): ParsedQubo {
  const doc = readText(text, false);
  if (doc.lines.length === 0) fail("No numbers found. Paste a QUBO in one of the supported formats (see the presets for examples).");
  const widths = doc.lines.map((l) => l.tokens.length);
  const rowsCount = doc.lines.length;
  const allThree = widths.every((w) => w === 3);
  const square = widths.every((w) => w === rowsCount);
  if (allThree && (rowsCount !== 3 || validEdgeRows(doc))) return { qubo: fromEdgeList(doc), format: "edges" };
  if (square) return { qubo: fromMatrixText(text), format: "matrix" };
  // Neither fits. Non-numbers first, then report against the closer reading.
  for (const { line, tokens } of doc.lines) for (const t of tokens) parseNumberToken(t, line);
  const threes = widths.filter((w) => w === 3).length;
  if (threes * 2 >= widths.length) return { qubo: fromEdgeList(doc), format: "edges" };
  const counts = new Map<number, number>();
  for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = widths[0];
  for (const [w, c] of counts) if (c > (counts.get(common) ?? 0)) common = w;
  const odd = doc.lines.find((l) => l.tokens.length !== common);
  const hint = "A dense matrix must be square; an edge list needs exactly 3 items (i j value) per line.";
  return fail(
    odd
      ? `Line ${odd.line}: has ${odd.tokens.length} numbers, but the other rows have ${common}. ${hint}`
      : `The matrix has ${rowsCount} row${rowsCount === 1 ? "" : "s"} of ${common} numbers. ${hint}`,
  );
}

// ---------------------------------------------------------------- entry points

function stripAssignment(text: string): string {
  // `Q = {...}` (possibly after comment lines) → blank the prefix so
  // positions and line numbers stay put.
  const m = /^((?:[ \t]*(?:#[^\n]*)?\r?\n)*)([ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=)(?!=)/.exec(text);
  if (!m) return text;
  const start = m[1].length;
  return text.slice(0, start) + " ".repeat(m[2].length) + text.slice(start + m[2].length);
}

function literalOrFail(text: string): LitNode {
  try {
    return parseLiteral(text);
  } catch (e) {
    if (e instanceof LiteralError) fail(e.message);
    throw e;
  }
}

function fromObject(obj: ObjNode, forced: QuboFormat | "auto"): ParsedQubo {
  const hasTupleKey = obj.entries.some((e) => isSeq(e.key));
  if (forced === "json" || (forced === "auto" && hasField(obj, "terms"))) return { qubo: fromTermsObject(obj), format: "json" };
  if (forced === "dimod" || (forced === "auto" && hasField(obj, "linear", "quadratic", "linear_biases", "quadratic_biases", "variable_labels"))) {
    return { qubo: fromDimod(obj), format: "dimod" };
  }
  if (forced === "python" || (forced === "auto" && hasTupleKey)) return { qubo: fromPythonDict(obj), format: "python" };
  if (forced === "matrix" || forced === "edges") fail(`The input is an object/dictionary, not a ${QUBO_FORMAT_LABELS[forced].toLowerCase()}`);
  if (obj.entries.length === 0) fail("The object is empty");
  return fail(
    `${cap(at(obj))}: unrecognised object. Expected a "terms" list (JSON), "linear"/"quadratic" (dimod), or (i, j) keys (Python dict).`,
  );
}

/**
 * Parse a QUBO from text, auto-detecting the format unless one is forced.
 * Throws an Error with a user-readable message (with line numbers where
 * possible) on malformed input. Enforces n ≤ 512 and finite numbers.
 *
 * Ambiguities, resolved in auto mode as follows:
 *  - A bracketed list whose rows all hold 3 numbers with valid indices in the
 *    first two columns is a triplet list, even when it is 3 × 3.
 *  - Plain text with 3 items on every line is an edge list, except a 3 × 3
 *    block whose first two columns are not valid indices, which is a matrix.
 * Force the format to override.
 */
export function parseQuboDetailed(text: string, format: QuboFormat | "auto" = "auto"): ParsedQubo {
  const src = unwrapArrayCall(stripAssignment(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  // Detect on the text without full-line comments (headers may precede the data).
  const trimmed = src.replace(/^\s*#.*$/gm, "").trim();
  const directives = readText(src.split(/\r?\n/).filter((l) => DIRECTIVE_RE.test(l)).join("\n"), false);
  if (trimmed === "" && directives.n === undefined) fail("Nothing to parse: paste a QUBO (see the presets for examples of each format).");
  // Matrices carry their constant in a `# offset = …` directive.
  const matrix = (q: Qubo): ParsedQubo => ({ qubo: directives.offset ? { ...q, offset: directives.offset } : q, format: "matrix" });
  if (format === "edges" || trimmed === "") return { qubo: fromEdgeList(readText(src, false)), format: "edges" };
  if (trimmed.startsWith("{")) {
    const node = literalOrFail(src);
    if (node.kind !== "object") fail("Expected a single object");
    return fromObject(node, format);
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("(")) {
    let node: LitNode | undefined;
    let litErr: Error | undefined;
    try {
      node = parseLiteral(src);
    } catch (e) {
      if (!(e instanceof LiteralError)) throw e;
      litErr = e;
    }
    if (node && isSeq(node)) {
      const r = fromArray(node, format);
      return r.format === "matrix" ? matrix(r.qubo) : r;
    }
    if (format === "json" || format === "python" || format === "dimod") fail(litErr ? litErr.message : "Expected a list of [i, j, value] triplets");
    // Not a literal: numpy-style printed matrix without commas, or garbage.
    try {
      return matrix(fromMatrixText(src));
    } catch (e) {
      if (litErr && /,/.test(src) && !(e instanceof QuboParseError && /square/.test(e.message))) fail(litErr.message);
      throw e;
    }
  }
  if (format === "json" || format === "dimod" || format === "python") {
    fail(`This does not look like ${QUBO_FORMAT_LABELS[format]}: it should start with "{"${format === "json" ? ' or "["' : ""}`);
  }
  if (format === "matrix") return matrix(fromMatrixText(src));
  const r = autoText(src);
  return r.format === "matrix" ? matrix(r.qubo) : r;
}

/** `np.array([[...]], dtype=float)` → `[[...]]`, blanking the wrapper so positions stay put. */
function unwrapArrayCall(text: string): string {
  const m = /^((?:[ \t]*(?:#[^\n]*)?\r?\n)*[ \t]*)((?:np\.|numpy\.)?(?:array|asarray|matrix)[ \t]*\()/.exec(text);
  if (!m) return text;
  const close = text.lastIndexOf(")");
  if (close < m[0].length) return text;
  const start = m[1].length;
  const inner = text.slice(m[0].length, close).replace(/,\s*dtype\s*=\s*[\w.'"]+\s*$/, (s) => " ".repeat(s.length));
  return text.slice(0, start) + " ".repeat(m[2].length) + inner + " " + text.slice(close + 1);
}

/** Parse a QUBO from text (see `parseQuboDetailed`). */
export function parseQubo(text: string, format: QuboFormat | "auto" = "auto"): Qubo {
  return parseQuboDetailed(text, format).qubo;
}

// ---------------------------------------------------------------- the problem

export interface CustomInstance {
  qubo: Qubo;
  /** Format the text was read as. */
  format: QuboFormat;
}

export const CUSTOM_EXAMPLES: Record<QuboFormat, string> = {
  json: `{
  "n": 3,
  "terms": [[0, 0, -1], [1, 1, -1], [0, 1, 2], [2, 2, -1]]
}`,
  dimod: `{
  "linear": {"a": -1, "b": -1, "c": -1},
  "quadratic": {"a,b": 2},
  "offset": 0,
  "vartype": "BINARY"
}`,
  python: `# D-Wave style: Q[(i, j)] is the coefficient of x_i x_j
Q = {(0, 0): -1, (1, 1): -1, (0, 1): 2,
     ('x', 'x'): -1.5, ('x', 0): 0.5}`,
  matrix: `# f(x) = x^T M x; off-diagonal M_ij and M_ji add up
-1  1  0  0
 1 -1  0  0
 0  0 -1  2
 0  0  0 -1`,
  edges: `# i j value   (i == j is a linear term)
# n = 4
0 0 -1
1 1 -1
0 1 2
2 3 -0.5`,
};

const params: ParamSpec[] = [
  {
    key: "text",
    label: "Your QUBO",
    kind: "text",
    default: CUSTOM_EXAMPLES.json,
    placeholder: '{"terms": [[0, 0, -1], [0, 1, 2], [1, 1, -1]]}',
    hint:
      "Minimize f(x) = Σ Q_ii x_i + Σ_{i<j} Q_ij x_i x_j over bits x. Accepts JSON triplets, dimod JSON, a Python dict {(i, j): v}, a square matrix (read as xᵀMx), or an edge list \"i j value\". Up to 512 variables.",
  },
  {
    key: "format",
    label: "Format",
    kind: "select",
    options: [
      { value: "auto", label: "Detect automatically" },
      ...(Object.keys(QUBO_FORMAT_LABELS) as QuboFormat[]).map((k) => ({ value: k, label: QUBO_FORMAT_LABELS[k] })),
    ],
    default: "auto",
  },
];

function isFormat(v: string): v is QuboFormat | "auto" {
  return v === "auto" || v in QUBO_FORMAT_LABELS;
}

export const custom: ProblemDef<CustomInstance> = {
  id: "custom",
  name: "Your own QUBO",
  tagline: "Paste any QUBO: from dimod, Qiskit, a paper, or your own model.",
  description:
    "A QUBO (quadratic unconstrained binary optimization) asks for the bit string x that minimizes f(x) = Σ Q_ii x_i + Σ_{i<j} Q_ij x_i x_j. " +
    "Scheduling, routing, graph problems and many constrained models can be rewritten this way, usually by turning constraints into penalty terms. " +
    "Paste coefficients in any of the supported formats (the presets show each one) and the solvers will minimize it directly.",
  params,
  presets: (Object.keys(CUSTOM_EXAMPLES) as QuboFormat[]).map((f) => ({
    label: `${QUBO_FORMAT_LABELS[f]} example`,
    params: { text: CUSTOM_EXAMPLES[f], format: "auto" },
    seed: 1,
  })),
  generate(p) {
    const r = new ParamReader(params, p);
    const fmt = r.string("format");
    if (!isFormat(fmt)) throw new Error(`Unknown format "${fmt}"`);
    const { qubo, format } = parseQuboDetailed(r.string("text"), fmt);
    qubo.note = "f(x) + offset is the objective exactly as entered";
    return { qubo, format };
  },
  async toQubo(instance) {
    const q = instance.qubo;
    return { ...q, terms: q.terms.map((t) => [t[0], t[1], t[2]] as [number, number, number]), ...(q.labels ? { labels: q.labels.slice() } : {}) };
  },
  interpret(instance, bits): Interpretation {
    const q = instance.qubo;
    checkBits(bits, q.n);
    const value = evaluate(q, bits) + q.offset;
    let ones = 0;
    const on: string[] = [];
    for (let i = 0; i < q.n; i++) {
      if (bits[i] !== 0) {
        ones++;
        on.push(q.labels ? q.labels[i] : `x${i}`);
      }
    }
    const shown = on.length === 0 ? "none" : on.length <= 12 ? on.join(", ") : `${on.slice(0, 12).join(", ")}, …`;
    return {
      feasible: true,
      score: value,
      scoreLabel: "objective",
      better: "lower",
      metrics: [
        { label: "Objective f(x) + offset", value: fmtNum(value, 6), tone: "neutral" },
        { label: "Bits set to 1", value: `${ones} of ${q.n}`, tone: "neutral" },
        { label: "Read as", value: QUBO_FORMAT_LABELS[instance.format], tone: "neutral" },
      ],
      summary: `Objective ${fmtNum(value, 6)} with ${ones} of ${q.n} bits set (${shown})`,
    };
  },
};
