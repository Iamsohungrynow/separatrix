import { describe, expect, it } from "vitest";
import { EXPORT_FORMATS, SEPARATRIX_CRATE_REQ, toDimodJson, toJson, toLp, toPythonDimod, toQiskitOptimization, toRust } from "./exporters";
import { evaluate, QuboBuilder } from "./qubo";
import { Rng } from "./rng";
import type { Qubo } from "./types";

/** -x0 - x1 + 3 x2 + 2 x0 x1 - 0.5 x1 x2 */
const THREE: Qubo = {
  n: 3,
  terms: [
    [0, 0, -1],
    [0, 1, 2],
    [1, 1, -1],
    [1, 2, -0.5],
    [2, 2, 3],
  ],
  offset: 0,
};

/**
 * Minimal reader for the subset of CPLEX LP that `toLp` writes: evaluates the
 * objective (linear part + [ ... ] / 2) for a bit assignment. Used to check
 * the /2 convention semantically, not just textually.
 */
function evalLp(lp: string, bits: number[]): number {
  const body = lp
    .split("\n")
    .filter((l) => !l.startsWith("\\"))
    .join("\n");
  const obj = /Minimize\s+obj:([\s\S]*?)\nSubject To/.exec(body);
  if (!obj) throw new Error("no objective");
  let expr = obj[1].replace(/\s+/g, " ").trim();
  let quad = 0;
  const br = /\+ \[(.*)\] \/ 2/.exec(expr);
  if (br) {
    expr = expr.replace(br[0], "");
    for (const m of br[1].matchAll(/([+-]?)\s*([\d.e+-]+) x(\d+) \* x(\d+)/g)) {
      const c = Number(m[2]) * (m[1] === "-" ? -1 : 1);
      quad += c * bits[Number(m[3])] * bits[Number(m[4])];
    }
  }
  let lin = 0;
  for (const m of expr.matchAll(/([+-]?)\s*([\d.e+-]+) x(\d+)/g)) {
    const c = Number(m[2]) * (m[1] === "-" ? -1 : 1);
    lin += c * bits[Number(m[3])];
  }
  return lin + quad / 2;
}

describe("toLp", () => {
  it("golden 3-variable example (hand-verified)", () => {
    // Linear: -1 x0, -1 x1, +3 x2. Quadratic 2 x0x1 - 0.5 x1x2 is written
    // doubled inside [ ] / 2: 4 x0*x1 - 1 x1*x2.
    expect(toLp(THREE)).toBe(
      [
        "\\ Separatrix Studio QUBO export: n = 3, 3 linear and 2 quadratic terms",
        "\\ minimize f(x) = sum_i Q_ii x_i + sum_{i<j} Q_ij x_i x_j over x in {0,1}^n; constant offset = 0",
        "Minimize",
        " obj: -1 x0 - 1 x1 + 3 x2 + [ 4 x0 * x1 - 1 x1 * x2 ] / 2",
        "Subject To",
        "Binaries",
        " x0 x1 x2",
        "End",
        "",
      ].join("\n"),
    );
  });

  it("declares every variable, records the offset and labels in comments, and keeps lines short", () => {
    const q: Qubo = { n: 4, terms: [[1, 3, -2]], offset: 1.5, labels: ["a", "b", "c", "d"], note: "f(x) + offset = −(cut weight)" };
    const lp = toLp(q);
    expect(lp).toContain(" obj: 0 x0 + 0 x1 + 0 x2 + 0 x3 + [ -4 x1 * x3 ] / 2");
    expect(lp).toContain("\\ add the constant 1.5 to the LP objective");
    expect(lp).toContain("x3 = d");
    expect(lp).toContain("\\ f(x) + offset = -(cut weight)");
    expect(/[^\x00-\x7f]/.test(lp)).toBe(false);
    const big = new QuboBuilder(200);
    const r = new Rng(3);
    for (let i = 0; i < 200; i++) for (let j = i; j < 200; j += 7) big.add(i, j, r.int(-50, 50) / 8);
    for (const line of toLp(big.build()).split("\n")) expect(line.length).toBeLessThan(510);
  });

  it("is semantically equal to f(x) on random QUBOs", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = new Rng(seed);
      const n = r.int(2, 8);
      const b = new QuboBuilder(n);
      for (let i = 0; i < n; i++) for (let j = i; j < n; j++) if (r.chance(0.5)) b.add(i, j, r.int(-20, 20) / 4);
      const q = b.build();
      const lp = toLp(q);
      for (let m = 0; m < 1 << n; m++) {
        const bits = Array.from({ length: n }, (_, i) => (m >> i) & 1);
        expect(evalLp(lp, bits)).toBeCloseTo(evaluate(q, bits), 12);
      }
    }
  });
});

describe("code exporters", () => {
  it("toJson / toDimodJson are valid JSON with the documented shape", () => {
    const j = JSON.parse(toJson({ ...THREE, labels: ["a", "b", "c"], offset: 2 }));
    expect(j).toEqual({ n: 3, offset: 2, labels: ["a", "b", "c"], terms: THREE.terms });
    const d = JSON.parse(toDimodJson({ ...THREE, labels: ["a", "b", "c"] }));
    expect(d).toEqual({ vartype: "BINARY", offset: 0, linear: { a: -1, b: -1, c: 3 }, quadratic: [["a", "b", 2], ["b", "c", -0.5]] });
    const d2 = JSON.parse(toDimodJson({ n: 2, terms: [], offset: 0 }));
    expect(d2).toEqual({ vartype: "BINARY", offset: 0, linear: { "0": 0, "1": 0 }, quadratic: [] });
  });

  it("toPythonDimod builds a BQM and picks ExactSolver or simulated annealing by size", () => {
    const small = toPythonDimod(THREE);
    expect(small).toContain("import dimod");
    expect(small).toContain("linear = {\n    0: -1, 1: -1, 2: 3,\n}");
    expect(small).toContain("quadratic = {\n    (0, 1): 2, (1, 2): -0.5,\n}");
    expect(small).toContain("bqm = dimod.BinaryQuadraticModel(linear, quadratic, offset, dimod.BINARY)");
    expect(small).toContain("dimod.ExactSolver()");
    const labelled = toPythonDimod({ ...THREE, labels: ["a", "b", 'c"q'] });
    expect(labelled).toContain('("b", "c\\"q"): -0.5');
    const big = toPythonDimod({ n: 21, terms: [[0, 20, 1]], offset: 0 });
    expect(big).toContain("SimulatedAnnealingSampler");
    expect(big).not.toContain("ExactSolver");
  });

  it("toQiskitOptimization declares binaries and calls minimize(linear=…, quadratic=…)", () => {
    const code = toQiskitOptimization({ ...THREE, offset: 1 });
    expect(code).toContain("from qiskit_optimization import QuadraticProgram");
    expect(code).toContain('qp.binary_var(name=f"x{i}")');
    expect(code).toContain("constant=1,");
    expect(code).toContain('"x0": -1, "x1": -1, "x2": 3');
    expect(code).toContain('("x0", "x1"): 2, ("x1", "x2"): -0.5');
    expect(code).toContain("itertools.product([0, 1], repeat=3)");
    expect(toQiskitOptimization({ n: 25, terms: [[0, 1, 1]], offset: 0 })).toContain("qp.to_ising()");
  });

  it("toRust mirrors the crate's doc example API with f64 literals", () => {
    const code = toRust(THREE);
    expect(code).toContain(`// Cargo.toml: separatrix = "${SEPARATRIX_CRATE_REQ}"`);
    expect(code).toContain("use separatrix::{IsingModel, QuboModel, SbConfig, Solver};");
    expect(code).toContain("(0, 0, -1.0), (0, 1, 2.0), (1, 1, -1.0), (1, 2, -0.5), (2, 2, 3.0)");
    expect(code).toContain("let mut qubo = QuboModel::<f64>::new(3);");
    expect(code).toContain("qubo.set_term(i, j, v);");
    expect(code).toContain("let (ising, ising_offset) = IsingModel::from_qubo(&qubo);");
    expect(code).toContain("Solver::Sb(SbConfig::default()).solve(&ising).unwrap()");
    expect(code).toContain("qubo.objective(&bits)");
    expect(code).toContain("const OFFSET: f64 = 0.0;");
    expect(toRust({ n: 1, terms: [[0, 0, 1e-7]], offset: 0 })).toContain("(0, 0, 1e-7)");
  });

  it("every registered format renders", () => {
    for (const f of EXPORT_FORMATS) {
      const text = f.render({ ...THREE, labels: ["a", "b", "c"], note: "note" });
      expect(text.length).toBeGreaterThan(20);
    }
  });
});
