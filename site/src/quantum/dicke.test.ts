import { describe, expect, it } from "vitest";

import fixtureJson from "./__fixtures__/dicke_ops.json";
import {
  CONSTRUCTIONS,
  DECOMPOSITION_BASIS,
  FIDELITY_TOLERANCE,
  MAX_N,
  VerificationError,
  analyticDicke,
  assertVerified,
  binomial,
  dcSplitAmplitudes,
  decompose,
  dickeCircuit,
  dickeOps,
  dickeOpsDc,
  fidelity,
  gateCounts,
  inConstraintProbability,
  layers,
  scsUnitaryOps,
  simulate,
  toCirq,
  toOpenQasm2,
  toOpenQasm3,
  toPytket,
  toQiskit,
  verifyDicke,
  weightDistribution,
  type Construction,
  type Gate,
  type GateName,
  type SimGate,
} from "./dicke";

// ---------------------------------------------------------------------------
// Fixture: IR dumped from quantum/dicke_xy.py (see meta.generator)
// ---------------------------------------------------------------------------

type FixtureOp = [string, number[], number[]];
interface Fixture {
  meta: Record<string, string>;
  cases: { n: number; k: number; construction: Construction; ops: FixtureOp[] }[];
  dcCuts: { n: number; k: number; m1: number; ops: FixtureOp[] }[];
  simCases: { label: string; n: number; ops: FixtureOp[]; state: number[] }[];
}
const fixture = fixtureJson as unknown as Fixture;

function toGates(ops: FixtureOp[]): Gate[] {
  return ops.map(([name, params, qubits]) => ({ name: name as GateName, params, qubits }));
}

/** Every disagreement between a TS circuit and a Python one (empty when they agree). */
function opMismatches(actual: readonly Gate[], expected: readonly FixtureOp[], tol = 1e-12): string[] {
  const out: string[] = [];
  if (actual.length !== expected.length) out.push(`length ${actual.length} != ${expected.length}`);
  const m = Math.min(actual.length, expected.length);
  for (let i = 0; i < m; i++) {
    const g = actual[i];
    const [name, params, qubits] = expected[i];
    const sameQubits = g.qubits.length === qubits.length && g.qubits.every((q, j) => q === qubits[j]);
    const sameParams =
      g.params.length === params.length && g.params.every((p, j) => Math.abs(p - params[j]) <= tol);
    if (g.name !== name || !sameQubits || !sameParams) {
      out.push(`op ${i}: ${JSON.stringify(g)} != ${JSON.stringify(expected[i])}`);
    }
  }
  return out;
}

const PREFIX_TOL = 1e-12;

function allPoints(maxN: number): [number, number][] {
  const out: [number, number][] = [];
  for (let n = 1; n <= maxN; n++) for (let k = 0; k <= n; k++) out.push([n, k]);
  return out;
}

// ---------------------------------------------------------------------------
// Correctness against the analytic state
// ---------------------------------------------------------------------------

describe("every construction prepares |D^n_k>", () => {
  for (const construction of CONSTRUCTIONS) {
    it(`${construction}: fidelity >= 1 - 1e-12 and weight concentrated on k, all 1 <= n <= 12`, () => {
      const failures: string[] = [];
      for (const [n, k] of allPoints(12)) {
        const state = simulate(n, dickeCircuit(n, k, construction));
        const f = fidelity(analyticDicke(n, k), state);
        const weights = weightDistribution(n, state);
        let off = 0;
        weights.forEach((p, w) => {
          if (w !== k) off += p;
        });
        if (!(f >= 1 - PREFIX_TOL) || !(weights[k] >= 1 - PREFIX_TOL) || !(off <= PREFIX_TOL)) {
          failures.push(`(${n},${k}) F=${f} P(k)=${weights[k]} off-sector=${off}`);
        }
        if (Math.abs(inConstraintProbability(n, k, state) - weights[k]) > 1e-15) {
          failures.push(`(${n},${k}) inConstraintProbability disagrees with weightDistribution`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${construction}: larger registers (n = 14, 16)`, () => {
      for (const [n, k] of [
        [14, 7],
        [14, 3],
        [16, 8],
        [16, 1],
        [16, 15],
      ]) {
        const v = verifyDicke(n, k, dickeCircuit(n, k, construction));
        expect(v.fidelity).toBeGreaterThanOrEqual(1 - PREFIX_TOL);
        expect(v.inConstraintProbability).toBeGreaterThanOrEqual(1 - PREFIX_TOL);
        expect(v.passed).toBe(true);
      }
    });
  }

  it("dc verifies for every cut position m1 at n <= 8", () => {
    const failures: string[] = [];
    for (const [n, k] of allPoints(8)) {
      for (let m1 = 0; m1 <= n; m1++) {
        const f = fidelity(analyticDicke(n, k), simulate(n, dickeOpsDc(n, k, m1)));
        if (!(f >= 1 - PREFIX_TOL)) failures.push(`(${n},${k},m1=${m1}) F=${f}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("a flipped controlled-Ry sign is caught, and assertVerified refuses it", () => {
    // The negated angle is one of the three conventions that has been wrong before.
    const flipped = dickeOps(6, 3).map((g) =>
      g.name === "cnry" ? { ...g, params: [-g.params[0]] } : g,
    );
    const v = verifyDicke(6, 3, flipped);
    expect(v.passed).toBe(false);
    expect(v.fidelity).toBeLessThan(0.99);
    expect(() => assertVerified(v)).toThrow(VerificationError);
    expect(() => assertVerified(verifyDicke(6, 3, dickeOps(6, 3)))).not.toThrow();
  });

  it("X on the bottom k qubits instead of the top k is caught", () => {
    const n = 6;
    const k = 2;
    const wrong: Gate[] = [
      ...Array.from({ length: k }, (_, q): Gate => ({ name: "x", params: [], qubits: [q] })),
      ...scsUnitaryOps(0, n, k),
    ];
    expect(verifyDicke(n, k, wrong).passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate-for-gate agreement with the Python reference
// ---------------------------------------------------------------------------

describe("gate-for-gate agreement with quantum/dicke_xy.py", () => {
  it("fixture covers what it claims", () => {
    expect(fixture.meta.generator).toContain("quantum/dicke_xy.py");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(2 * 44 + 6);
  });

  it("dickeCircuit matches dicke_ops / dicke_ops_dc: names, qubits, params to 1e-12", () => {
    const failures: string[] = [];
    for (const c of fixture.cases) {
      const bad = opMismatches(dickeCircuit(c.n, c.k, c.construction), c.ops);
      if (bad.length) failures.push(`${c.construction} (${c.n},${c.k}): ${bad.slice(0, 3).join("; ")}`);
    }
    expect(failures).toEqual([]);
  });

  it("dickeOpsDc matches dicke_ops_dc for non-default cuts", () => {
    for (const c of fixture.dcCuts) {
      expect(opMismatches(dickeOpsDc(c.n, c.k, c.m1), c.ops)).toEqual([]);
    }
  });

  it("simulate matches the Python simulator amplitude by amplitude on non-symmetric states", () => {
    // |D^n_k> is permutation-symmetric, so only these cases can catch an endianness slip.
    for (const c of fixture.simCases) {
      const state = simulate(c.n, toGates(c.ops));
      expect(state.length).toBe(c.state.length);
      let worst = 0;
      state.forEach((a, i) => (worst = Math.max(worst, Math.abs(a - c.state[i]))));
      expect(worst, c.label).toBeLessThanOrEqual(1e-12);
    }
  });

  it("the X layer plus scsUnitaryOps(0, n, k) is exactly dickeOps(n, k)", () => {
    for (const [n, k] of allPoints(10)) {
      const composed: Gate[] = [];
      for (let q = n - k; q < n; q++) composed.push({ name: "x", params: [], qubits: [q] });
      composed.push(...scsUnitaryOps(0, n, k));
      expect(composed).toEqual(dickeOps(n, k));
    }
  });

  it("dcSplitAmplitudes squares sum to one (Vandermonde)", () => {
    for (const [n, k] of allPoints(24)) {
      const split = dcSplitAmplitudes(n, k, Math.floor(n / 2));
      const total = split.reduce((s, [, a]) => s + a * a, 0);
      expect(Math.abs(total - 1)).toBeLessThan(1e-14);
    }
  });
});

// ---------------------------------------------------------------------------
// Simulator conventions and speed
// ---------------------------------------------------------------------------

describe("simulator", () => {
  it("is big-endian: qubit q is bit n-1-q of the index", () => {
    const s = simulate(3, [{ name: "x", params: [], qubits: [0] }]);
    expect(s[0b100]).toBe(1);
    const t = simulate(3, [
      { name: "x", params: [], qubits: [2] },
      { name: "cx", params: [], qubits: [2, 1] },
    ]);
    expect(t[0b011]).toBe(1);
  });

  it("cnry applies Ry(theta) = [[c, -s], [s, c]] only when every control is 1", () => {
    const theta = 0.83;
    const on = simulate(3, [
      { name: "x", params: [], qubits: [0] },
      { name: "x", params: [], qubits: [1] },
      { name: "cnry", params: [theta], qubits: [0, 1, 2] },
    ]);
    expect(on[0b110]).toBeCloseTo(Math.cos(theta / 2), 15);
    expect(on[0b111]).toBeCloseTo(Math.sin(theta / 2), 15);
    const off = simulate(3, [
      { name: "x", params: [], qubits: [0] },
      { name: "cnry", params: [theta], qubits: [0, 1, 2] },
    ]);
    expect(off[0b100]).toBe(1);
  });

  it("n = 16 runs well inside the 150 ms budget", () => {
    const gates = dickeCircuit(16, 8);
    simulate(16, gates); // warm-up (JIT)
    const t0 = performance.now();
    const state = simulate(16, gates);
    const elapsed = performance.now() - t0;
    expect(fidelity(analyticDicke(16, 8), state)).toBeGreaterThanOrEqual(1 - PREFIX_TOL);
    expect(elapsed).toBeLessThan(150);
  });

  it("rejects malformed gates", () => {
    expect(() => simulate(3, [{ name: "x", params: [], qubits: [3] }])).toThrow(RangeError);
    expect(() => simulate(3, [{ name: "cx", params: [], qubits: [1, 1] }])).toThrow(RangeError);
    expect(() => simulate(3, [{ name: "cnry", params: [], qubits: [0, 1] }])).toThrow(RangeError);
    expect(() => simulate(0, [])).toThrow(RangeError);
    expect(() => simulate(25, [])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Decomposition and gate counts
// ---------------------------------------------------------------------------

describe("decomposition and gate counts", () => {
  it("the decomposed circuit prepares exactly the same state", () => {
    for (const construction of CONSTRUCTIONS) {
      for (const [n, k] of [
        [2, 1],
        [4, 2],
        [7, 3],
        [9, 4],
        [10, 7],
        [12, 6],
      ]) {
        const gates = dickeCircuit(n, k, construction);
        const a = simulate(n, gates);
        const b = simulate(n, decompose(gates));
        let worst = 0;
        a.forEach((x, i) => (worst = Math.max(worst, Math.abs(x - b[i]))));
        expect(worst, `${construction} (${n},${k})`).toBeLessThan(1e-13);
      }
    }
  });

  it("the CRy and CCRy decompositions are exact unitaries (every basis column)", () => {
    const cases: Gate[] = [
      { name: "cnry", params: [1.234], qubits: [2, 0] },
      { name: "cnry", params: [-2.9], qubits: [0, 3] },
      { name: "cnry", params: [0.77], qubits: [3, 1, 0] },
      { name: "cnry", params: [-1.91], qubits: [0, 2, 3] },
    ];
    const n = 4;
    for (const g of cases) {
      for (let col = 0; col < 1 << n; col++) {
        const e = new Float64Array(1 << n);
        e[col] = 1;
        const a = simulate(n, [g], e);
        const b = simulate(n, decompose([g]), e);
        a.forEach((x, i) => expect(Math.abs(x - b[i])).toBeLessThan(1e-15));
      }
    }
  });

  it("SCS block counts equal Baertschi-Eidenbenz 2019 (proof of Thm. 1) for all 1 <= k <= n <= 24", () => {
    // The paper: U_{n,k} uses n-1 two-qubit gates (i) and
    // (n-k)(k-1) + sum_{i=3..k}(i-2) three-qubit gates (ii), and compiles to
    // "at most 5kn + O(n) CNOT-gates", charging 5 CNOTs per (ii) after
    // cancelling one against the preceding gadget (Fig. 3). The textbook count
    // here does not cancel, so it spends 6 per (ii) and 4 per (i).
    for (let n = 1; n <= MAX_N; n++) {
      for (let k = 1; k <= n; k++) {
        const c = gateCounts(dickeOps(n, k));
        const gatesI = n - 1;
        const gatesII = (n - k) * (k - 1) + ((k - 2) * (k - 1)) / 2;
        expect(c.ir.x).toBe(k);
        expect(c.ir.cry).toBe(gatesI);
        expect(c.ir.ccry).toBe(gatesII);
        expect(c.ir.cx).toBe(2 * (gatesI + gatesII));
        expect(c.decomposed.cx).toBe(4 * gatesI + 6 * gatesII);
        expect(c.decomposed.oneQubit).toBe(k + 2 * gatesI + 4 * gatesII);
        // With the paper's one-per-gadget cancellation the (ii) part is 5 per gadget:
        expect(c.decomposed.cx - gatesII).toBeLessThanOrEqual(5 * k * n + 4 * n);
      }
    }
  });

  it("DC counts are the ladder plus the two half-cascades", () => {
    for (const [n, k] of allPoints(16)) {
      const m1 = Math.floor(n / 2);
      const m2 = n - m1;
      if (k === 0 || k === n || m1 === 0) continue;
      const split = dcSplitAmplitudes(n, k, m1);
      const lMin = split[0][0];
      const lMax = split[split.length - 1][0];
      const ladder = lMax - lMin; // one CRy gadget, then CCRy gadgets
      const lower = gateCounts(scsUnitaryOps(0, m1, lMax)).decomposed.cx;
      const upper = gateCounts(scsUnitaryOps(m1, m2, k - lMin)).decomposed.cx;
      const ladderCx = ladder === 0 ? 0 : 4 + 6 * (ladder - 1);
      expect(gateCounts(dickeOpsDc(n, k)).decomposed.cx).toBe(ladderCx + lower + upper);
    }
  });

  it("matches a hand count for |D^2_1>", () => {
    // x q1; cx q1,q0; [ry q1; cx q0,q1; ry q1; cx q0,q1]; cx q1,q0
    const c = gateCounts(dickeCircuit(2, 1));
    expect(c.ir).toEqual({ x: 1, cx: 2, cnry: 1, cry: 1, ccry: 0, total: 4, depth: 4 });
    expect(c.decomposed.basis).toBe(DECOMPOSITION_BASIS);
    expect(c.decomposed.basis).toBe("textbook CX+1q decomposition (uncompiled)");
    expect(c.decomposed.cx).toBe(4);
    expect(c.decomposed.oneQubit).toBe(3);
    expect(c.decomposed.twoQubitDepth).toBe(4);
    expect(c.decomposed.depth).toBe(7);
  });

  it("pins the decomposed counts of a few reference points (regression)", () => {
    const expected: Record<string, [number, number, number]> = {
      // "construction n k": [CX, CX depth, depth]
      "scs 6 3": [62, 56, 92],
      "scs 10 3": [126, 112, 184],
      "scs 16 8": [522, 220, 370],
      "dc 6 3": [44, 28, 45],
      "dc 10 3": [108, 56, 91],
      "dc 16 8": [354, 131, 216],
    };
    for (const [key, [cx, d2, d]] of Object.entries(expected)) {
      const [construction, n, k] = key.split(" ");
      const c = gateCounts(dickeCircuit(Number(n), Number(k), construction as Construction));
      expect([c.decomposed.cx, c.decomposed.twoQubitDepth, c.decomposed.depth], key).toEqual([cx, d2, d]);
    }
  });

  it("depths are consistent with counts", () => {
    for (const construction of CONSTRUCTIONS) {
      for (const [n, k] of allPoints(9)) {
        const c = gateCounts(dickeCircuit(n, k, construction));
        expect(c.decomposed.total).toBe(c.decomposed.cx + c.decomposed.oneQubit);
        expect(c.decomposed.twoQubitDepth).toBeLessThanOrEqual(c.decomposed.cx);
        expect(c.decomposed.depth).toBeLessThanOrEqual(c.decomposed.total);
        expect(c.decomposed.depth).toBeGreaterThanOrEqual(c.decomposed.twoQubitDepth);
        expect(c.ir.depth).toBeLessThanOrEqual(c.ir.total);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

describe("layers", () => {
  function wires(g: SimGate, span: boolean): number[] {
    if (!span) return [...g.qubits];
    const lo = Math.min(...g.qubits);
    const hi = Math.max(...g.qubits);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }

  for (const span of [true, false]) {
    it(`ASAP, dependency-respecting, non-overlapping (span=${span})`, () => {
      for (const construction of CONSTRUCTIONS) {
        for (const [n, k] of [
          [5, 2],
          [8, 4],
          [11, 3],
        ]) {
          const gates = dickeCircuit(n, k, construction);
          const cols = layers(gates, { span });
          const where = new Map<Gate, number>();
          cols.forEach((col, l) => {
            expect(col.length).toBeGreaterThan(0);
            const used = new Set<number>();
            for (const g of col) {
              where.set(g, l);
              for (const w of wires(g, span)) {
                expect(used.has(w)).toBe(false);
                used.add(w);
              }
            }
          });
          expect(where.size).toBe(gates.length);
          // Every gate sits right after the latest earlier gate it overlaps (ASAP).
          gates.forEach((g, i) => {
            let earliest = 0;
            for (let j = 0; j < i; j++) {
              const shared = wires(gates[j], span).some((w) => wires(g, span).includes(w));
              if (shared) earliest = Math.max(earliest, (where.get(gates[j]) as number) + 1);
            }
            expect(where.get(g)).toBe(earliest);
          });
          if (!span) expect(cols.length).toBe(gateCounts(gates).ir.depth);
        }
      }
    });
  }

  it("defaults to wire-span semantics", () => {
    const gates: Gate[] = [
      { name: "cx", params: [], qubits: [0, 2] },
      { name: "x", params: [], qubits: [1] },
    ];
    expect(layers(gates).length).toBe(2);
    expect(layers(gates, { span: false }).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

function countLines(src: string, re: RegExp): number {
  return src.split("\n").filter((l) => re.test(l)).length;
}

const EMIT_POINTS: [number, number, Construction][] = [
  [1, 0, "scs"],
  [2, 1, "scs"],
  [4, 2, "scs"],
  [5, 5, "dc"],
  [6, 3, "dc"],
  [9, 4, "scs"],
];

describe("emitters", () => {
  for (const [n, k, construction] of EMIT_POINTS) {
    const gates = dickeCircuit(n, k, construction);
    const counts = gateCounts(gates);
    const v = verifyDicke(n, k, gates);
    const meta = { k, construction, fidelity: v.fidelity, inConstraintProbability: v.inConstraintProbability };

    it(`OpenQASM 2 (${construction}, n=${n}, k=${k})`, () => {
      const src = toOpenQasm2(n, gates, meta);
      expect(src.startsWith("OPENQASM 2.0;\n")).toBe(true);
      expect(src).toContain('include "qelib1.inc";');
      expect(src).toContain(`qreg q[${n}];`);
      expect(src).toContain(`|D^${n}_${k}>`);
      expect(src).toContain(`Construction: ${construction}`);
      expect(src).toContain("Verified in the browser by exact statevector simulation");
      expect(countLines(src, /^(x|cx|c1ry\(|c2ry\()/)).toBe(counts.ir.total);
      expect(countLines(src, /^c1ry\(/)).toBe(counts.ir.cry);
      expect(countLines(src, /^c2ry\(/)).toBe(counts.ir.ccry);
      expect(src.includes("gate c1ry")).toBe(counts.ir.cry > 0);
      expect(src.includes("gate c2ry")).toBe(counts.ir.ccry > 0);
      // Angles are written at full precision, in order.
      const angles = [...src.matchAll(/^c[12]ry\(([^)]*)\)/gm)].map((m) => Number(m[1]));
      expect(angles).toEqual(gates.filter((g) => g.name === "cnry").map((g) => g.params[0]));
      const body = src.slice(src.indexOf(`qreg q[${n}];`) + `qreg q[${n}];`.length);
      for (const m of body.matchAll(/q\[(\d+)\]/g)) expect(Number(m[1])).toBeLessThan(n);
    });

    it(`OpenQASM 3 (${construction}, n=${n}, k=${k})`, () => {
      const src = toOpenQasm3(n, gates, meta);
      expect(src.startsWith("OPENQASM 3.0;\n")).toBe(true);
      expect(src).toContain('include "stdgates.inc";');
      expect(src).toContain(`qubit[${n}] q;`);
      expect(countLines(src, /^(x |cx |cry\(|ctrl\(2\) @ ry\()/)).toBe(counts.ir.total);
      expect(countLines(src, /^ctrl\(2\) @ ry\(/)).toBe(counts.ir.ccry);
    });

    it(`Qiskit (${construction}, n=${n}, k=${k})`, () => {
      const src = toQiskit(n, k, gates, meta);
      expect(src).toContain(`n, k = ${n}, ${k}`);
      expect(src).toContain("qc = QuantumCircuit(n");
      expect(src).toContain("little-endian");
      expect(countLines(src, /^qc\.(x|cx|cry|append)\(/)).toBe(counts.ir.total);
      expect(countLines(src, /^qc\.append\(RYGate\(.*\)\.control\(2\)/)).toBe(counts.ir.ccry);
      expect(src).toContain("fidelity = abs(np.vdot(dicke, psi)) ** 2");
    });

    it(`pytket (${construction}, n=${n}, k=${k})`, () => {
      const src = toPytket(n, k, gates, meta);
      expect(src).toContain("circ = Circuit(n");
      expect(countLines(src, /^circ\.(X|CX|add_gate)\(/)).toBe(counts.ir.total);
      // Half-turns: every CnRy angle is the IR radian angle divided by pi, as in ops_to_tket.
      const angles = [...src.matchAll(/^circ\.add_gate\(OpType\.CnRy, \[(\S+) \/ math\.pi\]/gm)].map((m) =>
        Number(m[1]),
      );
      expect(angles).toEqual(gates.filter((g) => g.name === "cnry").map((g) => g.params[0]));
      expect(src).not.toMatch(/OpType\.CRy/);
    });

    it(`Cirq (${construction}, n=${n}, k=${k})`, () => {
      const src = toCirq(n, k, gates, meta);
      expect(src).toContain("q = cirq.LineQubit.range(n)");
      expect(countLines(src, /^ {4}cirq\.(X|CNOT|ry)\(/)).toBe(counts.ir.total);
      expect(src).toContain("qubit_order=q");
    });
  }

  it("says so when no verification result was supplied", () => {
    const gates = dickeCircuit(4, 2);
    for (const src of [
      toOpenQasm2(4, gates),
      toOpenQasm3(4, gates),
      toQiskit(4, 2, gates),
      toPytket(4, 2, gates),
      toCirq(4, 2, gates),
    ]) {
      expect(src).toContain("NOT verified in the browser");
      expect(src).not.toContain("Verified in the browser");
    }
    // k is inferred from the X layer when the QASM caller omits it.
    expect(toOpenQasm2(4, gates)).toContain("|D^4_2>");
  });

  it("refuses to emit a circuit whose supplied fidelity is below the floor", () => {
    const gates = dickeCircuit(4, 2);
    const bad = { k: 2, construction: "scs" as const, fidelity: 1 - 10 * FIDELITY_TOLERANCE };
    expect(() => toOpenQasm2(4, gates, bad)).toThrow(VerificationError);
    expect(() => toOpenQasm3(4, gates, bad)).toThrow(VerificationError);
    expect(() => toQiskit(4, 2, gates, bad)).toThrow(VerificationError);
    expect(() => toPytket(4, 2, gates, bad)).toThrow(VerificationError);
    expect(() => toCirq(4, 2, gates, bad)).toThrow(VerificationError);
    expect(() => toQiskit(4, 2, gates, { fidelity: Number.NaN })).toThrow(VerificationError);
  });

  it("never writes -0 or an exponent without a decimal point", () => {
    const gates: Gate[] = [
      { name: "cnry", params: [-0], qubits: [0, 1] },
      { name: "cnry", params: [1e-7], qubits: [0, 1] },
      { name: "cnry", params: [-3], qubits: [0, 1] },
    ];
    const src = toOpenQasm2(2, gates, { k: 1 });
    expect(src).toContain("c1ry(0.0)");
    expect(src).toContain("c1ry(1.0e-7)");
    expect(src).toContain("c1ry(-3.0)");
  });
});

// ---------------------------------------------------------------------------
// Validation and helpers
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("dickeCircuit enforces 1 <= n <= 24 and 0 <= k <= n", () => {
    expect(() => dickeCircuit(0, 0)).toThrow(RangeError);
    expect(() => dickeCircuit(25, 1)).toThrow(RangeError);
    expect(() => dickeCircuit(4, 5)).toThrow(RangeError);
    expect(() => dickeCircuit(4, -1)).toThrow(RangeError);
    expect(() => dickeCircuit(4.5, 1)).toThrow(RangeError);
    expect(() => dickeCircuit(4, 1, "xyz" as Construction)).toThrow(RangeError);
    expect(dickeCircuit(24, 12).length).toBeGreaterThan(0);
    expect(dickeCircuit(24, 12, "dc").length).toBeGreaterThan(0);
  });

  it("binomial is exact and refuses to round", () => {
    expect(binomial(24, 12)).toBe(2704156);
    expect(binomial(50, 25)).toBe(126410606437752);
    expect(binomial(5, 7)).toBe(0);
    expect(() => binomial(60, 30)).toThrow(RangeError);
  });

  it("analyticDicke is normalised with the right support", () => {
    const d = analyticDicke(6, 2);
    expect(d.filter((a) => a !== 0).length).toBe(15);
    expect(fidelity(d, d)).toBeCloseTo(1, 15);
  });
});
