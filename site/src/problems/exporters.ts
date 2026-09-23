import { BRUTE_FORCE_MAX_N } from "./qubo";
import type { Qubo } from "./types";

/**
 * Exporters: every function takes a Qubo in the upper-triangular convention
 * f(x) = Σ Q_ii x_i + Σ_{i<j} Q_ij x_i x_j (+ offset) and returns file text.
 * JSON, dimod JSON, the edge list and the matrix round-trip through
 * `parseQubo`.
 */

/**
 * Version requirement written into the Rust snippet. The snippet uses only the
 * solver core (QuboModel, IsingModel, Solver, SbConfig), which 0.1.0 on
 * crates.io already has; an exported program was compiled and run against the
 * published 0.1.0. Raise this only once a newer version is actually published.
 */
export const SEPARATRIX_CRATE_REQ = "0.1";

/** Shortest round-trip decimal for a finite number (JSON/Python/LP compatible). */
function num(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`Cannot export non-finite coefficient ${v}`);
  return Object.is(v, -0) ? "0" : String(v);
}

/** Rust f64 literal: always has a decimal point or exponent. */
function rustNum(v: number): string {
  const s = num(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

function linearOf(q: Qubo): number[] {
  const lin = new Array<number>(q.n).fill(0);
  for (const [i, j, v] of q.terms) if (i === j) lin[i] += v;
  return lin;
}

function quadraticOf(q: Qubo): [number, number, number][] {
  return q.terms.filter(([i, j]) => i !== j);
}

function nameOf(q: Qubo, i: number): string {
  return q.labels ? q.labels[i] : String(i);
}

/** Wrap comma-separated items into lines of at most ~width characters. */
function wrapItems(items: string[], indent: string, width = 100, sep = ", "): string {
  const lines: string[] = [];
  let cur = "";
  for (const it of items) {
    const piece = cur === "" ? it : `${sep}${it}`;
    if (cur !== "" && indent.length + cur.length + piece.length > width) {
      lines.push(indent + cur + sep.trimEnd());
      cur = it;
    } else cur += piece;
  }
  if (cur !== "") lines.push(indent + cur);
  return lines.join("\n");
}

/** ASCII-only rendering of a note (for formats whose readers may choke on Unicode). */
function ascii(s: string): string {
  const map: Record<string, string> = {
    "−": "-",
    "–": "-",
    "—": "-",
    "Σ": "sum",
    "²": "^2",
    "·": "*",
    "×": "x",
    "√": "sqrt",
    "λ": "lambda",
    "ᵀ": "^T",
    "≤": "<=",
    "≥": ">=",
    "…": "...",
  };
  return s.replace(/[^\x20-\x7e]/g, (c) => map[c] ?? "?");
}

function headerLines(q: Qubo): string[] {
  const quad = quadraticOf(q).length;
  const lines = [
    `Separatrix Studio QUBO export: n = ${q.n}, ${q.n - countZeroLinear(q)} linear and ${quad} quadratic terms`,
    `minimize f(x) = sum_i Q_ii x_i + sum_{i<j} Q_ij x_i x_j over x in {0,1}^n; constant offset = ${num(q.offset)}`,
  ];
  if (q.note) lines.push(ascii(q.note));
  return lines;
}

function countZeroLinear(q: Qubo): number {
  return linearOf(q).filter((v) => v === 0).length;
}

// ---------------------------------------------------------------- JSON

/** Format-1 JSON: {"n", "offset", "labels"?, "note"?, "terms": [[i, j, v], ...]}, one term per line. */
export function toJson(q: Qubo): string {
  const lines: string[] = ["{", `  "n": ${q.n},`, `  "offset": ${num(q.offset)},`];
  if (q.labels) lines.push(`  "labels": [${q.labels.map((l) => JSON.stringify(l)).join(", ")}],`);
  if (q.note) lines.push(`  "note": ${JSON.stringify(q.note)},`);
  if (q.terms.length === 0) lines.push(`  "terms": []`);
  else {
    lines.push(`  "terms": [`);
    q.terms.forEach(([i, j, v], k) => lines.push(`    [${i}, ${j}, ${num(v)}]${k < q.terms.length - 1 ? "," : ""}`));
    lines.push("  ]");
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

/**
 * dimod-style JSON. Every variable appears in "linear" (with 0 when it has
 * no linear term) so the variable order and count survive a round trip.
 * "quadratic" uses the unambiguous list form [[u, v, bias], ...], which
 * `dimod.BinaryQuadraticModel(linear, quadratic, offset, vartype)` accepts as is.
 */
export function toDimodJson(q: Qubo): string {
  const lin = linearOf(q);
  const linEntries = lin.map((v, i) => `${JSON.stringify(nameOf(q, i))}: ${num(v)}`);
  const quadEntries = quadraticOf(q).map(([i, j, v]) => `[${JSON.stringify(nameOf(q, i))}, ${JSON.stringify(nameOf(q, j))}, ${num(v)}]`);
  const lines = [
    "{",
    `  "vartype": "BINARY",`,
    `  "offset": ${num(q.offset)},`,
    `  "linear": {`,
    wrapItems(linEntries, "    "),
    "  },",
    quadEntries.length === 0 ? `  "quadratic": []` : `  "quadratic": [\n${wrapItems(quadEntries, "    ")}\n  ]`,
    "}",
  ];
  return lines.filter((l) => l !== "").join("\n") + "\n";
}

// ---------------------------------------------------------------- text formats

/** Edge list "i j value" (i == j linear), with `# n = …` and `# offset = …` directives so it round-trips. */
export function toEdgeList(q: Qubo): string {
  const lines = headerLines(q).map((l) => `# ${l}`);
  if (q.labels) lines.push(`# labels (index order): ${q.labels.join(", ")}`);
  lines.push("# i j value   (i == j is a linear term)");
  lines.push(`# n = ${q.n}`);
  if (q.offset !== 0) lines.push(`# offset = ${num(q.offset)}`);
  for (const [i, j, v] of q.terms) lines.push(`${i} ${j} ${num(v)}`);
  return lines.join("\n") + "\n";
}

/**
 * Dense upper-triangular matrix M (M_ii = Q_ii, M_ij = Q_ij for i < j, zeros
 * below), so f(x) = xᵀMx, printed numpy-style ([[a b] [c d]] without commas)
 * so that no parser can mistake a 3 × 3 matrix for three [i, j, v] triplets.
 */
export function toMatrix(q: Qubo): string {
  const m = Array.from({ length: q.n }, () => new Array<number>(q.n).fill(0));
  for (const [i, j, v] of q.terms) m[i][j] += v;
  const cells = m.map((row) => row.map(num));
  let width = 1;
  for (const row of cells) for (const c of row) width = Math.max(width, c.length);
  const lines = headerLines(q).map((l) => `# ${l}`);
  lines.push("# f(x) = x^T M x (upper-triangular)");
  if (q.offset !== 0) lines.push(`# offset = ${num(q.offset)}`);
  cells.forEach((row, i) => {
    const body = row.map((c) => c.padStart(width)).join(" ");
    lines.push(`${i === 0 ? "[[" : " ["}${body}]${i === cells.length - 1 ? "]" : ""}`);
  });
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- CPLEX LP

/**
 * CPLEX LP format. Diagonal terms are linear (x² = x for binaries), so the
 * objective is `obj: <linear> + [ <quadratic> ] / 2`, and because of the
 * `/ 2` every coefficient inside the brackets is DOUBLED: Q_ij x_i x_j is
 * written `2Q_ij xi * xj`. Every variable appears in the linear part (with
 * coefficient 0 if needed) so it is declared in index order. The constant
 * offset is not part of the objective (not every LP reader accepts
 * constants); it is recorded in a comment. The constraints section is
 * required by the format and left empty. Lines are wrapped well below the
 * 510-character limit. Variable names are x0 … x(n−1).
 */
export function toLp(q: Qubo): string {
  const out: string[] = headerLines(q).map((l) => `\\ ${l}`);
  if (q.labels) {
    out.push("\\ variables:");
    out.push(wrapItems(q.labels.map((l, i) => `x${i} = ${ascii(l)}`), "\\   ", 90));
  }
  if (q.offset !== 0) out.push(`\\ add the constant ${num(q.offset)} to the LP objective to get f(x) + offset`);
  const lin = linearOf(q);
  const signed = (v: number, body: string, first: boolean): string => {
    if (first) return `${num(v)} ${body}`;
    return v < 0 ? `- ${num(-v)} ${body}` : `+ ${num(v)} ${body}`;
  };
  const pieces: string[] = [];
  lin.forEach((v, i) => pieces.push(signed(v, `x${i}`, i === 0)));
  const quad = quadraticOf(q);
  if (quad.length > 0) {
    const inner = quad.map(([i, j, v], k) => signed(2 * v, `x${i} * x${j}`, k === 0));
    pieces.push("+ [", ...inner, "] / 2");
  }
  out.push("Minimize");
  // Wrap the objective expression into continuation lines.
  const objLines: string[] = [];
  let cur = " obj:";
  for (const p of pieces) {
    if (cur.length + 1 + p.length > 90) {
      objLines.push(cur);
      cur = "     ";
    }
    cur += ` ${p}`;
  }
  objLines.push(cur);
  out.push(...objLines);
  out.push("Subject To");
  out.push("Binaries");
  const names = Array.from({ length: q.n }, (_, i) => `x${i}`);
  out.push(wrapItems(names, " ", 90, " "));
  out.push("End");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- Python

function pyKey(q: Qubo, i: number): string {
  return q.labels ? JSON.stringify(q.labels[i]) : String(i);
}

function pyDicts(q: Qubo): { linear: string; quadratic: string } {
  const lin = linearOf(q);
  const linItems = lin.map((v, i) => `${pyKey(q, i)}: ${num(v)}`);
  const quadItems = quadraticOf(q).map(([i, j, v]) => `(${pyKey(q, i)}, ${pyKey(q, j)}): ${num(v)}`);
  return {
    linear: linItems.length === 0 ? "{}" : `{\n${wrapItems(linItems, "    ")},\n}`,
    quadratic: quadItems.length === 0 ? "{}" : `{\n${wrapItems(quadItems, "    ")},\n}`,
  };
}

/** Runnable Python: build a dimod BinaryQuadraticModel and solve it (exact for n ≤ 20, simulated annealing otherwise). */
export function toPythonDimod(q: Qubo): string {
  const { linear, quadratic } = pyDicts(q);
  const exact = q.n <= BRUTE_FORCE_MAX_N;
  const lines = [
    ...headerLines(q).map((l) => `# ${l}`),
    exact ? "# pip install dimod" : "# pip install dimod dwave-samplers",
    "import dimod",
    "",
    `linear = ${linear}`,
    `quadratic = ${quadratic}`,
    `offset = ${num(q.offset)}`,
    "",
    "bqm = dimod.BinaryQuadraticModel(linear, quadratic, offset, dimod.BINARY)",
  ];
  if (exact) {
    lines.push(`sampleset = dimod.ExactSolver().sample(bqm)  # all 2^${q.n} states`);
  } else {
    lines.push(
      "try:",
      "    from dwave.samplers import SimulatedAnnealingSampler",
      "except ImportError:  # older installs",
      "    from neal import SimulatedAnnealingSampler",
      "sampleset = SimulatedAnnealingSampler().sample(bqm, num_reads=100, seed=1)",
    );
  }
  lines.push(
    "best = sampleset.first",
    'print("energy f(x) + offset:", best.energy)',
    'print("x =", [best.sample[v] for v in bqm.variables])',
  );
  return lines.join("\n") + "\n";
}

/** Qiskit Optimization QuadraticProgram with binary variables x0..x(n−1). */
export function toQiskitOptimization(q: Qubo): string {
  const lin = linearOf(q);
  const linItems = lin.flatMap((v, i) => (v === 0 ? [] : [`"x${i}": ${num(v)}`]));
  const quadItems = quadraticOf(q).map(([i, j, v]) => `("x${i}", "x${j}"): ${num(v)}`);
  const exact = q.n <= BRUTE_FORCE_MAX_N;
  const lines = [
    ...headerLines(q).map((l) => `# ${l}`),
    "# pip install qiskit-optimization",
  ];
  if (q.labels) lines.push(`# variables: ${q.labels.map((l, i) => `x${i} = ${l}`).join(", ")}`);
  if (exact) lines.push("import itertools", "");
  lines.push(
    "from qiskit_optimization import QuadraticProgram",
    "",
    'qp = QuadraticProgram("separatrix_qubo")',
    `for i in range(${q.n}):`,
    '    qp.binary_var(name=f"x{i}")',
    "qp.minimize(",
    `    constant=${num(q.offset)},`,
    linItems.length === 0 ? "    linear={}," : `    linear={\n${wrapItems(linItems, "        ")},\n    },`,
    quadItems.length === 0 ? "    quadratic={}," : `    quadratic={\n${wrapItems(quadItems, "        ")},\n    },`,
    ")",
    "print(qp.prettyprint())",
  );
  if (exact) {
    lines.push(
      "",
      `# Brute force over all 2^${q.n} assignments (fine for small n).`,
      `best = min((list(x) for x in itertools.product([0, 1], repeat=${q.n})), key=qp.objective.evaluate)`,
      'print("x =", best, " objective =", qp.objective.evaluate(best))',
    );
  } else {
    lines.push(
      "",
      "# Too large to enumerate: map to an Ising Hamiltonian for QAOA/VQE, or use a classical solver.",
      "operator, ising_offset = qp.to_ising()",
      'print(operator.num_qubits, "qubits; Ising offset", ising_offset)',
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- Rust

/** Rust program using the separatrix crate (same API as the crate's doc example). */
export function toRust(q: Qubo): string {
  const termItems = q.terms.map(([i, j, v]) => `(${i}, ${j}, ${rustNum(v)})`);
  const lines = [
    ...headerLines(q).map((l) => `// ${l}`),
    `// Cargo.toml: separatrix = "${SEPARATRIX_CRATE_REQ}"`,
    "use separatrix::{IsingModel, QuboModel, SbConfig, Solver};",
    "",
    "// (i, j, Q_ij) with i <= j; i == j is the linear coefficient of x_i.",
    termItems.length === 0 ? "const TERMS: &[(usize, usize, f64)] = &[];" : `const TERMS: &[(usize, usize, f64)] = &[\n${wrapItems(termItems, "    ")},\n];`,
    `const OFFSET: f64 = ${rustNum(q.offset)};`,
    "",
    "fn main() {",
    `    let mut qubo = QuboModel::<f64>::new(${q.n});`,
    "    for &(i, j, v) in TERMS {",
    "        qubo.set_term(i, j, v);",
    "    }",
    "",
    "    let (ising, ising_offset) = IsingModel::from_qubo(&qubo);",
    "    let result = Solver::Sb(SbConfig::default()).solve(&ising).unwrap();",
    "    let bits = result.bits();",
    "    let objective = qubo.objective(&bits);",
    "    assert!((objective - (result.energy + ising_offset)).abs() < 1e-9 * (1.0 + objective.abs()));",
    '    println!("f(x) = {objective}, f(x) + offset = {}", objective + OFFSET);',
    '    println!("x = {bits:?}");',
    "}",
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- registry

export interface ExportFormat {
  id: "json" | "dimod" | "edges" | "matrix" | "lp" | "python" | "qiskit" | "rust";
  label: string;
  /** Suggested file name. */
  filename: string;
  mime: string;
  render(q: Qubo): string;
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: "json", label: "JSON (terms)", filename: "qubo.json", mime: "application/json", render: toJson },
  { id: "dimod", label: "dimod JSON", filename: "qubo.dimod.json", mime: "application/json", render: toDimodJson },
  { id: "edges", label: "Edge list", filename: "qubo.txt", mime: "text/plain", render: toEdgeList },
  { id: "matrix", label: "Dense matrix", filename: "qubo-matrix.txt", mime: "text/plain", render: toMatrix },
  { id: "lp", label: "CPLEX LP", filename: "qubo.lp", mime: "text/plain", render: toLp },
  { id: "python", label: "Python (dimod)", filename: "qubo_dimod.py", mime: "text/x-python", render: toPythonDimod },
  { id: "qiskit", label: "Python (Qiskit Optimization)", filename: "qubo_qiskit.py", mime: "text/x-python", render: toQiskitOptimization },
  { id: "rust", label: "Rust (separatrix)", filename: "main.rs", mime: "text/x-rust", render: toRust },
];
