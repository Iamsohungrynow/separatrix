import { describe, expect, it } from "vitest";
import { CUSTOM_EXAMPLES, custom, parseQubo, parseQuboDetailed, type QuboFormat } from "./custom";
import { toDimodJson, toEdgeList, toJson, toMatrix } from "./exporters";
import { bruteForce, evaluate, QuboBuilder } from "./qubo";
import { Rng } from "./rng";
import type { Qubo } from "./types";

const DOC_EXAMPLE: Qubo = { n: 3, terms: [[0, 0, -1], [0, 1, 2], [1, 1, -1], [2, 2, -1]], offset: 0 };

function strip(q: Qubo): Qubo {
  const out: Qubo = { n: q.n, terms: q.terms, offset: q.offset };
  if (q.labels) out.labels = q.labels;
  return out;
}

function randomQubo(seed: number, labelled: boolean): Qubo {
  const r = new Rng(seed);
  const n = r.int(1, 14);
  const b = new QuboBuilder(n, labelled ? Array.from({ length: n }, (_, i) => `v_${String.fromCharCode(97 + i)}${i}`) : undefined);
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) if (r.chance(0.4)) b.add(i, j, Math.round(r.normal() * 1000) / 64);
  if (r.chance(0.5)) b.addOffset(r.int(-10, 10) / 4);
  b.setNote("f(x) + offset = −(something)");
  return b.build();
}

describe("parseQubo: the five formats", () => {
  it("format 1: JSON terms object and bare triplet array", () => {
    expect(parseQuboDetailed('{"n": 3, "terms": [[0,0,-1],[1,1,-1],[0,1,2],[2,2,-1]]}')).toEqual({ qubo: DOC_EXAMPLE, format: "json" });
    expect(parseQubo("[[0,0,-1],[1,1,-1],[1,0,2],[2,2,-1]]")).toEqual(DOC_EXAMPLE);
    // n larger than the indices used; duplicates are summed; offset and labels are read
    expect(parseQubo('{"n": 4, "offset": 1.5, "labels": ["a","b","c","d"], "terms": [[0,1,1],[1,0,1],[3,3,-2e-3]]}')).toEqual({
      n: 4,
      terms: [[0, 1, 2], [3, 3, -0.002]],
      offset: 1.5,
      labels: ["a", "b", "c", "d"],
    });
  });

  it("format 2: dimod-style JSON with string labels in first-seen order", () => {
    const q = parseQuboDetailed('{"linear": {"a": -1, "0": 2}, "quadratic": {"a,b": 1, "(0, b)": -3}, "offset": 0.5}');
    expect(q.format).toBe("dimod");
    expect(q.qubo).toEqual({
      n: 3,
      terms: [[0, 0, -1], [0, 2, 1], [1, 1, 2], [1, 2, -3]],
      offset: 0.5,
      labels: ["a", "0", "b"],
    });
    // integer labels map straight to indices; list-form quadratic
    expect(parseQubo('{"linear": {"0": -1, "1": -1, "2": -1}, "quadratic": [["0", "1", 2]]}')).toEqual(DOC_EXAMPLE);
    expect(parseQubo('{"quadratic": {"(\'x\', \'y\')": 4}, "vartype": "BINARY"}')).toEqual({ n: 2, terms: [[0, 1, 4]], offset: 0, labels: ["x", "y"] });
  });

  it("format 2: SPIN models are converted with s = 2x − 1", () => {
    const text = '{"linear": {"a": 0.5, "b": -1}, "quadratic": {"a,b": 2}, "offset": 1, "vartype": "SPIN"}';
    const q = parseQubo(text);
    const energy = (sa: number, sb: number) => 0.5 * sa - 1 * sb + 2 * sa * sb + 1;
    for (const [xa, xb] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      expect(evaluate(q, [xa, xb]) + q.offset).toBeCloseTo(energy(2 * xa - 1, 2 * xb - 1), 12);
    }
  });

  it("format 2: dimod to_serializable(use_bytes=False) output", () => {
    const text = JSON.stringify({
      type: "BinaryQuadraticModel",
      version: { bqm_schema: "3.0.0" },
      use_bytes: false,
      num_variables: 3,
      variable_labels: ["p", "q", "r"],
      variable_type: "BINARY",
      offset: 2,
      linear_biases: [-1, 0, 3],
      quadratic_head: [0, 1],
      quadratic_tail: [2, 2],
      quadratic_biases: [1.5, -2],
    });
    expect(parseQubo(text)).toEqual({ n: 3, terms: [[0, 0, -1], [0, 2, 1.5], [1, 2, -2], [2, 2, 3]], offset: 2, labels: ["p", "q", "r"] });
  });

  it("format 3: Python dict literals as in D-Wave examples", () => {
    expect(parseQuboDetailed("Q = {(0, 0): -1, (1, 1): -1, (0, 1): 2, (2, 2): -1}")).toEqual({ qubo: DOC_EXAMPLE, format: "python" });
    const q = parseQubo(`# comment first
Q = {
    ('x', 'x'): -1.5e0,
    ("x", "y"): .5,
    ('y','z'): -2,   # inline comment
    ('y', 'x'): +1E-1,
}`);
    expect(q).toEqual({ n: 3, terms: [[0, 0, -1.5], [0, 1, 0.6], [1, 2, -2]], offset: 0, labels: ["x", "y", "z"] });
    // scalar keys are linear terms
    expect(parseQubo("{0: -1, 1: -1, (0, 1): 2, 2: -1}")).toEqual(DOC_EXAMPLE);
  });

  it("format 4: dense matrix, read as xᵀMx", () => {
    const text = `1 2 3 4
                  0 5 0 1
                  1 0 -1 0
                  0 0 0 2`;
    expect(parseQuboDetailed(text)).toEqual({
      qubo: { n: 4, terms: [[0, 0, 1], [0, 1, 2], [0, 2, 4], [0, 3, 4], [1, 1, 5], [1, 3, 1], [2, 2, -1], [3, 3, 2]], offset: 0 },
      format: "matrix",
    });
    // commas, brackets (JSON-style non-triplet rows), numpy print style, MATLAB semicolons
    const two: Qubo = { n: 2, terms: [[0, 0, 1], [0, 1, 5], [1, 1, 4]], offset: 0 };
    expect(parseQubo("[[1, 2], [3, 4]]")).toEqual(two);
    expect(parseQubo("[[1. 2.]\n [3. 4.]]")).toEqual(two);
    expect(parseQubo("1, 2\n3, 4")).toEqual(two);
    expect(parseQubo("[1 2; 3 4]")).toEqual(two);
    expect(parseQubo("np.array([[1, 2], [3, 4]])")).toEqual(two);
    // a 3×3 whose first columns cannot be indices is a matrix; forcing works too
    expect(parseQuboDetailed("-1 2 0\n0 -1 0\n0 0 -1").format).toBe("matrix");
    expect(parseQuboDetailed("1 2 0\n0 3 1\n0 0 1", "matrix").qubo).toEqual({
      n: 3,
      terms: [[0, 0, 1], [0, 1, 2], [1, 1, 3], [1, 2, 1], [2, 2, 1]],
      offset: 0,
    });
  });

  it("format 5: edge list with comments and directives", () => {
    const text = `# my model
# n = 5
# offset = -2
0 0 -1
1 1 -1   # trailing comment
0 1 2
2 2 -1
`;
    expect(parseQuboDetailed(text)).toEqual({ qubo: { ...DOC_EXAMPLE, n: 5, offset: -2 }, format: "edges" });
    expect(parseQubo("0 0 -1\n1 1 -1\n0 1 2\n2 2 -1\n1 0 0")).toEqual(DOC_EXAMPLE);
    expect(parseQubo("0,1,2.5")).toEqual({ n: 2, terms: [[0, 1, 2.5]], offset: 0 });
    // 3 lines of 3 valid-index columns: edge list wins in auto mode
    expect(parseQuboDetailed("0 0 1\n0 1 2\n1 1 3").format).toBe("edges");
  });

  it("every built-in example parses in auto mode as its own format", () => {
    for (const [fmt, text] of Object.entries(CUSTOM_EXAMPLES) as [QuboFormat, string][]) {
      expect(parseQuboDetailed(text).format).toBe(fmt);
    }
  });
});

describe("parseQubo: round trips through the exporters", () => {
  it("JSON, dimod JSON and edge list reproduce the QUBO exactly", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const q = randomQubo(seed, seed % 3 === 0);
      expect(strip(parseQubo(toJson(q)))).toEqual(strip(q));
      expect(strip(parseQubo(toDimodJson(q)))).toEqual(strip(q));
      if (!q.labels) expect(strip(parseQubo(toEdgeList(q)))).toEqual(strip(q));
      else expect(strip(parseQubo(toEdgeList(q)))).toEqual({ n: q.n, terms: q.terms, offset: q.offset });
    }
  });

  it("dense matrix export round-trips (labels are not part of the format)", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const q = randomQubo(seed, false);
      const back = parseQuboDetailed(toMatrix(q));
      expect(back.format).toBe("matrix");
      expect(strip(back.qubo)).toEqual(strip(q));
    }
  });

  it("the 3×3 corner case survives: exported matrices are never read as triplets", () => {
    const q = new QuboBuilder(3).add(0, 0, 1).add(0, 1, 2).add(1, 1, 3).add(1, 2, 1).add(2, 2, 1).build();
    expect(parseQuboDetailed(toMatrix(q)).qubo).toEqual(q);
  });
});

describe("parseQubo: error messages", () => {
  const cases: [string, RegExp][] = [
    ["", /Nothing to parse/],
    ["   # only a comment\n", /Nothing to parse/],
    ['{"n": 3, "terms": [[0, 0, -1], [0, 1]]}', /Term 2 \(line 1\): expected \[i, j, value\], found 2 entries/],
    ['{"terms": [[0, 0, -1],\n [0, -1, 2]]}', /Line 2: index j -1 must be a non-negative whole number/],
    ['{"n": 2, "terms": [[0, 5, 1]]}', /index 5 is out of range for n = 2/],
    ['{"terms": [[0, 0, "a"]]}', /value should be a number, found "a"/],
    ['{"terms": [[0, 0, 1]],\n "n": 600}', /Line 2: n = 600 is too large; the studio supports at most 512/],
    ['{"terms": [[0, 1, 1e999]]}', /not a finite number/],
    ['{"terms": [[0, 0, 1]', /Line 1, column \d+: expected "," or "\]" but found end of input/],
    ['{"foo": 1}', /unrecognised object/],
    ["{(0, 1): 2,\n (0, 1): 3}", /Line 2: key \(0, 1\) repeats line 1/],
    ["{(0, 1, 2): 2}", /key should be a pair like \(0, 1\), found 3 items/],
    ["{(0, 1): nan}", /not a finite number/],
    ['{"linear": {"a": 1}, "quadratic": {"a": 2}}', /quadratic key "a" should name two variables/],
    ['{"linear": {"a": 1}, "vartype": "INTEGER"}', /unknown vartype "INTEGER"/],
    ['{"linear_biases": "AAAA", "variable_labels": []}', /base64-encoded/],
    ["0 0 1\n0 1\n1 1 1\n2 2 1", /Line 2: expected "i j value" \(3 items\), found 2 items/],
    ["0 0 1\n0 x 2\n1 1 1\n2 2 1", /Line 2: index "x" must be a non-negative whole number/],
    ["0 0 1\n0 1 abc\n1 1 1\n2 2 1", /Line 2: "abc" is not a number/],
    ["0 600 1", /index 600 is too large/],
    ["1 2\n3 4 5 6\n7 8", /Line 2: has 4 numbers, but the other rows have 2/],
    ["[[1, 2], [3, 4, 5]]", /matrix row 2 has 3 entries but there are 2 rows; a QUBO matrix must be square/],
    ["[[0, 0, 1], [1, 2]]", /Term 2 \(line 1\): expected \[i, j, value\], found 2 entries/],
    ["{(0, 1): 2, (1, 1): }", /Line 1, column 21: expected a value but found "}"/],
    ["# n = 0\n0 0 1", /should give a positive whole number/],
    ["hello world", /Line 1: expected "i j value" \(3 items\), found 2 items|not a number/],
  ];
  for (const [text, re] of cases) {
    it(`rejects ${JSON.stringify(text.slice(0, 40))}`, () => {
      expect(() => parseQubo(text)).toThrow(re);
    });
  }

  it("enforces n ≤ 512 for every format", () => {
    const big = Array.from({ length: 513 }, (_, i) => `[${i}, ${i}, 1]`).join(",");
    expect(() => parseQubo(`[${big}]`)).toThrow(/at most 512/);
    const labels = Array.from({ length: 513 }, (_, i) => `"v${i}": 1`).join(",");
    expect(() => parseQubo(`{"linear": {${labels}}}`)).toThrow(/513 variables; the studio supports at most 512/);
    expect(() => parseQubo("0 0 1", "json")).toThrow(/does not look like JSON terms/);
  });
});

describe("custom problem", () => {
  it("presets cover every format and solve to their documented optimum", async () => {
    expect(custom.presets.length).toBe(5);
    const ctx = { portfolioQubo: () => Promise.reject(new Error("unused")) };
    for (const p of custom.presets) {
      const inst = custom.generate(p.params, p.seed);
      const q = await custom.toQubo(inst, ctx);
      const bf = bruteForce(q);
      const r = custom.interpret(inst, bf.bits);
      expect(r.feasible).toBe(true);
      expect(r.better).toBe("lower");
      expect(r.score).toBeCloseTo(bf.value + q.offset, 12);
    }
    const doc = custom.generate({ text: CUSTOM_EXAMPLES.json, format: "auto" }, 1);
    const r = custom.interpret(doc, [1, 0, 1]);
    expect(r.score).toBe(-2);
    expect(r.summary).toBe("Objective -2 with 2 of 3 bits set (x0, x2)");
    const lab = custom.generate({ text: CUSTOM_EXAMPLES.dimod, format: "auto" }, 1);
    expect(custom.interpret(lab, [0, 1, 1]).summary).toBe("Objective -2 with 2 of 3 bits set (b, c)");
  });

  it("the format selector forces a reading", () => {
    const text = "0 0 1\n0 1 2\n1 1 3";
    expect(custom.generate({ text, format: "auto" }, 1).format).toBe("edges");
    expect(custom.generate({ text, format: "matrix" }, 1).format).toBe("matrix");
    expect(() => custom.generate({ text, format: "python" }, 1)).toThrow(/does not look like Python dict/);
  });
});
