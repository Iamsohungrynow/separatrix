/**
 * Dicke-state circuit engine for Separatrix Studio.
 *
 * A dependency-free TypeScript port of the verified Python reference
 * `quantum/dicke_xy.py`: the same gate IR, the same two constructions, the
 * same big-endian statevector convention, plus the analytic reference state,
 * the metrics, a gate-count estimator, an ASAP layerer for the circuit
 * diagram, and code emitters for OpenQASM 2/3, Qiskit, pytket and Cirq.
 *
 * Conventions (identical to `quantum/dicke_xy.py`; each one has been wrong at
 * least once over there, so do not "tidy" them):
 *
 * - **IR.** A gate is `{ name, params, qubits }`, mirroring the Python
 *   `GateOp = (name, params_in_radians, qubits)`. Names: `x`, `cx`
 *   (control, target) and `cnry` (controls..., target last). The Python IR
 *   also has `xxphase` / `yyphase` for the XY mixer; no Dicke construction
 *   emits them, so they are not part of this port.
 * - **Angles** are in **radians** (the paper's and qiskit's unit). pytket takes
 *   half-turns; the division by pi happens only in {@link toPytket}, exactly
 *   as in `ops_to_tket`.
 * - **Qubit order** is **big-endian**: qubit q is bit (n-1-q) of a statevector
 *   index (pytket's and Cirq's convention). |D^n_k> is invariant under qubit
 *   permutations, so the Dicke fidelity is convention-free; the convention
 *   matters for any non-symmetric intermediate state and for reading bitstrings.
 * - **SCS** starts from |1^k 0^{n-k}> with X on the *top* k qubits, applies
 *   SCS_{l, min(k, l-1)} for l = n, n-1, ..., 2 (descending), and the
 *   controlled-Ry angle is *negated*: theta = -2 arccos(sqrt(i / l)).
 *
 * Every gate either construction emits is real (X, CX, controlled Ry), so the
 * simulator works with real amplitudes (`Float64Array`).
 *
 * Terminology: the probability of measuring Hamming weight exactly k is the
 * **in-constraint probability** (Niroula et al. 2022). It is never called
 * "leakage", which on trapped ions means an ion leaving the qubit manifold.
 */

// ---------------------------------------------------------------------------
// Gate IR
// ---------------------------------------------------------------------------

/** Op names of the Python IR that the Dicke constructions emit. */
export type GateName = "x" | "cx" | "cnry";

/**
 * One IR op, mirroring Python's `GateOp = (name, params, qubits)`.
 *
 * - `x`: `params = []`, `qubits = [q]`
 * - `cx`: `params = []`, `qubits = [control, target]`
 * - `cnry`: `params = [theta]` (radians), `qubits = [...controls, target]`;
 *   applies Ry(theta) = [[cos(theta/2), -sin(theta/2)], [sin(theta/2), cos(theta/2)]]
 *   to the target iff every control is |1>. The constructions emit one or two
 *   controls.
 */
export interface Gate {
  readonly name: GateName;
  readonly params: readonly number[];
  readonly qubits: readonly number[];
}

/** Gates of the {CX, single-qubit} basis produced by {@link decompose}. */
export type BasisGateName = "x" | "ry" | "cx";

export interface BasisGate {
  readonly name: BasisGateName;
  readonly params: readonly number[];
  readonly qubits: readonly number[];
}

/** Anything {@link simulate} and {@link layers} accept. */
export type SimGate = Gate | BasisGate;

/** The constructions this module can build (both verified; see the tests). */
export const CONSTRUCTIONS = ["scs", "dc"] as const;
export type Construction = (typeof CONSTRUCTIONS)[number];

/** Human-readable provenance for each construction (for the page and the emitted headers). */
export const CONSTRUCTION_INFO: Readonly<
  Record<Construction, { readonly label: string; readonly reference: string; readonly summary: string }>
> = {
  scs: {
    label: "Split-and-cyclic-shift (SCS)",
    reference: "Baertschi & Eidenbenz, arXiv:1904.07358 (FCT 2019)",
    summary:
      "X on the top k qubits, then SCS_{l,min(k,l-1)} for l = n..2. O(kn) gates, O(n) depth, " +
      "no ancillas, and the bounds hold on linear nearest-neighbour hardware.",
  },
  dc: {
    label: "Divide-and-conquer (one level)",
    reference: "Aktar, Baertschi, Badawy & Eidenbenz, arXiv:2112.12435",
    summary:
      "A hypergeometric weight-split ladder across the floor(n/2) cut, then the SCS unitary on both " +
      "halves in parallel. One level of recursion only: not the O(k log(n/k))-depth construction " +
      "of arXiv:2207.09998.",
  },
};

/** Largest register {@link dickeCircuit} builds (the page's range). */
export const MAX_N = 24;

/**
 * Largest register {@link simulate} accepts: 2^24 doubles = 128 MB. Measured
 * {@link verifyDicke} wall time for SCS |D^n_{n/2}> in Node 24 on the dev box:
 * n=16 ~11 ms, 18 ~60 ms, 20 ~0.3 s, 22 ~1.7 s, 24 ~8 s (about 5x per two
 * qubits), so the page should verify n >= 20 off the main thread.
 */
export const MAX_SIMULATE_N = 24;

/** Same floor as `DEFAULT_FIDELITY_TOLERANCE` in `quantum/dicke_xy.py`. */
export const FIDELITY_TOLERANCE = 1e-9;

/** A circuit failed its own correctness check. Never downgraded to a warning. */
export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

function xGate(q: number): Gate {
  return { name: "x", params: [], qubits: [q] };
}

function cxGate(control: number, target: number): Gate {
  return { name: "cx", params: [], qubits: [control, target] };
}

function cnryGate(theta: number, qubits: readonly number[]): Gate {
  return { name: "cnry", params: [theta], qubits: [...qubits] };
}

function checkNK(n: number, k: number, maxN: number = Number.POSITIVE_INFINITY): void {
  if (!Number.isInteger(n) || n < 1 || n > maxN) {
    const range = Number.isFinite(maxN) ? `1 <= n <= ${maxN}` : "n >= 1";
    throw new RangeError(`need an integer ${range}, got n=${n}`);
  }
  if (!Number.isInteger(k) || k < 0 || k > n) {
    throw new RangeError(`need an integer 0 <= k <= n, got k=${k}, n=${n}`);
  }
}

/**
 * Exact binomial coefficient C(n, k). Throws rather than silently rounding if
 * any intermediate product leaves the exactly representable integers (never
 * the case for any k when n <= 51, far above {@link MAX_N}).
 */
export function binomial(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0) {
    throw new RangeError(`binomial needs integers n >= 0 and k, got n=${n}, k=${k}`);
  }
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let c = 1;
  for (let i = 1; i <= kk; i++) {
    const product = c * (n - kk + i);
    if (!Number.isSafeInteger(product)) {
      throw new RangeError(`C(${n}, ${k}) is not exactly representable as a double`);
    }
    c = product / i; // exact: this is C(n - kk + i, i)
  }
  return c;
}

// ---------------------------------------------------------------------------
// Constructions (ports of dicke_ops, _scs_unitary_ops, dc_split_amplitudes,
// dicke_ops_dc)
// ---------------------------------------------------------------------------

/**
 * Baertschi-Eidenbenz SCS circuit for |D^n_k>: a line-for-line port of
 * `dicke_ops` in `quantum/dicke_xy.py`, pinned to it gate for gate by the
 * fixture test.
 */
export function dickeOps(n: number, k: number): Gate[] {
  checkNK(n, k);
  const ops: Gate[] = [];
  for (let q = n - k; q < n; q++) ops.push(xGate(q));
  for (let width = n; width > 1; width--) {
    const iMax = Math.min(k, width - 1);
    for (let i = 1; i <= iMax; i++) {
      const theta = -2.0 * Math.acos(Math.sqrt(i / width));
      const top = width - 1;
      const low = top - i;
      ops.push(cxGate(top, low));
      if (i === 1) {
        ops.push(cnryGate(theta, [low, top]));
      } else {
        ops.push(cnryGate(theta, [low, width - i, top]));
      }
      ops.push(cxGate(top, low));
    }
  }
  return ops;
}

/**
 * The Dicke unitary U_{width,kMax} on qubits `base .. base+width-1` (port of
 * `_scs_unitary_ops`): the gadget cascade of {@link dickeOps} minus the X
 * layer, translated by `base`. It maps the unary input |0^{width-l} 1^l> to
 * |D^width_l> for every l <= kMax at once.
 */
export function scsUnitaryOps(base: number, width: number, kMax: number): Gate[] {
  const ops: Gate[] = [];
  for (let w = width; w > 1; w--) {
    const iMax = Math.min(kMax, w - 1);
    for (let i = 1; i <= iMax; i++) {
      const theta = -2.0 * Math.acos(Math.sqrt(i / w));
      const top = base + w - 1;
      const low = top - i;
      ops.push(cxGate(top, low));
      if (i === 1) {
        ops.push(cnryGate(theta, [low, top]));
      } else {
        ops.push(cnryGate(theta, [low, base + w - i, top]));
      }
      ops.push(cxGate(top, low));
    }
  }
  return ops;
}

/**
 * Hypergeometric weight split of |D^n_k> across an (m1, n - m1) cut (port of
 * `dc_split_amplitudes`): `[l, a_l]` pairs in increasing l with
 * a_l = sqrt(C(m1,l) C(n-m1,k-l) / C(n,k)). The ratio is formed from exact
 * integers before the single square root, as in Python.
 */
export function dcSplitAmplitudes(n: number, k: number, m1: number): Array<[number, number]> {
  if (
    !Number.isInteger(n) || n < 1 ||
    !Number.isInteger(k) || k < 0 || k > n ||
    !Number.isInteger(m1) || m1 < 0 || m1 > n
  ) {
    throw new RangeError(`need 1 <= n, 0 <= k <= n, 0 <= m1 <= n; got n=${n}, k=${k}, m1=${m1}`);
  }
  const m2 = n - m1;
  const total = binomial(n, k);
  const out: Array<[number, number]> = [];
  for (let weight = Math.max(0, k - m2); weight <= Math.min(k, m1); weight++) {
    out.push([weight, Math.sqrt((binomial(m1, weight) * binomial(m2, k - weight)) / total)]);
  }
  return out;
}

/**
 * Python 3.12's built-in `sum()` over floats (Neumaier-compensated). Used
 * where `dicke_ops_dc` calls `sum()`, so the DC angles match the Python
 * reference to the last bit rather than merely to rounding error.
 */
function pythonFloatSum(values: Iterable<number>): number {
  let result = 0.0;
  let compensation = 0.0;
  for (const x of values) {
    const t = result + x;
    if (Math.abs(result) >= Math.abs(x)) compensation += result - t + x;
    else compensation += x - t + result;
    result = t;
  }
  if (compensation !== 0 && Number.isFinite(compensation)) result += compensation;
  return result;
}

/**
 * One level of divide-and-conquer Dicke preparation (port of `dicke_ops_dc`;
 * Aktar et al., arXiv:2112.12435). `m1` is the size of the lower half and
 * defaults to floor(n / 2), as in Python.
 *
 * 1. X on the top k qubits (the SCS convention).
 * 2. A ladder of CX-CnRy-CX split gadgets moves ones across the cut in
 *    superposition with the conditional hypergeometric "stay" amplitudes,
 *    leaving a superposition of products of two unary states.
 * 3. The SCS unitaries U_{m1,l_max} and U_{m2,k-l_min} act on the halves in
 *    parallel.
 */
export function dickeOpsDc(n: number, k: number, m1?: number): Gate[] {
  checkNK(n, k);
  const cut = m1 ?? Math.floor(n / 2);
  if (!Number.isInteger(cut) || cut < 0 || cut > n) {
    throw new RangeError(`need an integer 0 <= m1 <= n, got m1=${cut}, n=${n}`);
  }
  const m2 = n - cut;

  const ops: Gate[] = [];
  for (let q = n - k; q < n; q++) ops.push(xGate(q));
  if (k === 0 || k === n || cut === 0 || m2 === 0) {
    // Nothing to split: |0^n>, |1^n>, or a degenerate cut, for which the
    // whole-register SCS cascade is the honest fallback.
    if (k > 0 && k < n) ops.push(...scsUnitaryOps(0, n, k));
    return ops;
  }

  const split = dcSplitAmplitudes(n, k, cut);
  const probabilities = new Map<number, number>();
  for (const [weight, a] of split) probabilities.set(weight, a * a);
  const lMin = split[0][0];
  const lMax = split[split.length - 1][0];
  // Ones initially in the upper half: k - lMin = min(k, m2), on the top
  // qubits n-(k-lMin)..n-1. The lower half already holds lMin of them.
  const blockBottom = n - (k - lMin);
  let tail = pythonFloatSum(probabilities.values()); // P(l >= lMin), i.e. 1
  for (let j = 1; j <= lMax - lMin; j++) {
    const p = probabilities.get(lMin + j - 1) as number;
    // P(l = lMin+j-1 | l >= lMin+j-1): the amplitude^2 for the one at the
    // bottom of the block to stay where it is.
    let stay = p / tail;
    stay = Math.min(1.0, Math.max(0.0, stay));
    const theta = -2.0 * Math.acos(Math.sqrt(stay));
    const source = blockBottom + j - 1; // bottom of the upper half's block
    const target = cut - lMin - j; // next free slot at the top of the lower half
    ops.push(cxGate(source, target));
    if (j === 1) {
      ops.push(cnryGate(theta, [target, source]));
    } else {
      const previous = cut - lMin - (j - 1);
      ops.push(cnryGate(theta, [target, previous, source]));
    }
    ops.push(cxGate(source, target));
    tail -= p;
  }

  ops.push(...scsUnitaryOps(0, cut, lMax));
  ops.push(...scsUnitaryOps(cut, m2, k - lMin));
  return ops;
}

/**
 * The circuit preparing |D^n_k> with the chosen construction, for
 * 1 <= n <= {@link MAX_N} and 0 <= k <= n. Unverified until checked with
 * {@link verifyDicke} (or {@link simulate} + {@link fidelity}).
 */
export function dickeCircuit(n: number, k: number, construction: Construction = "scs"): Gate[] {
  checkNK(n, k, MAX_N);
  if (construction === "scs") return dickeOps(n, k);
  if (construction === "dc") return dickeOpsDc(n, k);
  throw new RangeError(
    `unknown Dicke construction ${JSON.stringify(construction)}; choose from ${CONSTRUCTIONS.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Statevector simulator (real amplitudes, big-endian, in place)
// ---------------------------------------------------------------------------

/** [qubit count, parameter count] of the fixed-arity gates. */
const GATE_SHAPES: Readonly<Record<string, readonly [number, number]>> = {
  x: [1, 0],
  ry: [1, 1],
  cx: [2, 0],
};

function checkQubits(n: number, g: SimGate): void {
  if (g.name === "cnry") {
    if (g.qubits.length < 2 || g.params.length !== 1) {
      throw new RangeError(`cnry needs >= 1 control, a target and one angle, got ${JSON.stringify(g)}`);
    }
  } else {
    const shape = GATE_SHAPES[g.name];
    if (!shape) throw new RangeError(`unknown gate ${JSON.stringify((g as { name: unknown }).name)}`);
    if (g.qubits.length !== shape[0] || g.params.length !== shape[1]) {
      throw new RangeError(`malformed ${g.name} gate ${JSON.stringify(g)}`);
    }
  }
  for (let a = 0; a < g.qubits.length; a++) {
    const q = g.qubits[a];
    if (!Number.isInteger(q) || q < 0 || q >= n) {
      throw new RangeError(`qubit ${q} out of range for n=${n} in ${JSON.stringify(g)}`);
    }
    for (let b = 0; b < a; b++) {
      if (g.qubits[b] === q) throw new RangeError(`repeated qubit ${q} in ${JSON.stringify(g)}`);
    }
  }
  for (const p of g.params) {
    if (!Number.isFinite(p)) throw new RangeError(`non-finite angle in ${JSON.stringify(g)}`);
  }
}

/**
 * Apply one gate in place. The target's bit is t = 1 << (n-1-target); pairs
 * (i, i+t) with the target bit clear are visited block by block, and only
 * pairs whose control bits are all set are touched.
 */
function applyInPlace(state: Float64Array, n: number, g: SimGate): void {
  const dim = state.length;
  const qs = g.qubits;
  const tq = qs[qs.length - 1];
  const tBit = 1 << (n - 1 - tq);
  let cMask = 0;
  for (let a = 0; a < qs.length - 1; a++) cMask |= 1 << (n - 1 - qs[a]);

  let rotate = false;
  let c = 1;
  let s = 0;
  if (g.name === "cnry" || g.name === "ry") {
    rotate = true;
    c = Math.cos(g.params[0] / 2);
    s = Math.sin(g.params[0] / 2);
  }
  const step = tBit << 1;
  for (let block = 0; block < dim; block += step) {
    const end = block + tBit;
    for (let i = block; i < end; i++) {
      if ((i & cMask) !== cMask) continue;
      const j = i + tBit;
      const a0 = state[i];
      const a1 = state[j];
      if (rotate) {
        state[i] = c * a0 - s * a1;
        state[j] = s * a0 + c * a1;
      } else {
        state[i] = a1;
        state[j] = a0;
      }
    }
  }
}

/**
 * Exact statevector of a real-gate circuit, from |0...0> (or from a copy of
 * `initial`). Same convention as `simulate` in `quantum/dicke_xy.py`: qubit q
 * is bit (n-1-q) of the index, so the result compares amplitude by amplitude
 * with the Python reference and with pytket.
 */
export function simulate(n: number, gates: readonly SimGate[], initial?: Float64Array): Float64Array {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SIMULATE_N) {
    throw new RangeError(`simulate needs an integer 1 <= n <= ${MAX_SIMULATE_N}, got n=${n}`);
  }
  const dim = 2 ** n;
  let state: Float64Array;
  if (initial) {
    if (initial.length !== dim) {
      throw new RangeError(`initial state has ${initial.length} amplitudes, expected ${dim}`);
    }
    state = Float64Array.from(initial);
  } else {
    state = new Float64Array(dim);
    state[0] = 1;
  }
  for (const g of gates) {
    checkQubits(n, g);
    applyInPlace(state, n, g);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Analytic reference and metrics
// ---------------------------------------------------------------------------

function popcount(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function checkState(n: number, state: ArrayLike<number>): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SIMULATE_N) {
    throw new RangeError(`need an integer 1 <= n <= ${MAX_SIMULATE_N}, got n=${n}`);
  }
  if (state.length !== 2 ** n) {
    throw new RangeError(`state has ${state.length} amplitudes, expected ${2 ** n} for n=${n}`);
  }
}

/**
 * |D^n_k> from its definition, not from a circuit: amplitude 1/sqrt(C(n,k))
 * on every index of Hamming weight k (convention-free).
 */
export function analyticDicke(n: number, k: number): Float64Array {
  checkNK(n, k, MAX_SIMULATE_N);
  const dim = 2 ** n;
  const out = new Float64Array(dim);
  const amplitude = 1 / Math.sqrt(binomial(n, k));
  for (let i = 0; i < dim; i++) if (popcount(i) === k) out[i] = amplitude;
  return out;
}

/**
 * Neumaier-compensated accumulation of `x` into slot `i` of (`sum`, `comp`).
 * The metrics below add up to 2^24 terms, where a plain running sum would
 * lose ~1e-12 and blur a 1e-12 verification threshold.
 */
function accumulate(sum: Float64Array, comp: Float64Array, i: number, x: number): void {
  const s = sum[i];
  const t = s + x;
  comp[i] += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
  sum[i] = t;
}

/** |<a|b>|^2 for two real pure states (no renormalisation, like `state_fidelity`). */
export function fidelity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new RangeError(`states have different lengths: ${a.length} vs ${b.length}`);
  }
  const sum = new Float64Array(1);
  const comp = new Float64Array(1);
  for (let i = 0; i < a.length; i++) {
    const x = a[i] * b[i];
    if (x !== 0) accumulate(sum, comp, 0, x);
  }
  const overlap = sum[0] + comp[0];
  return overlap * overlap;
}

/** P(Hamming weight = w) for w = 0..n, from real amplitudes. */
export function weightDistribution(n: number, state: ArrayLike<number>): Float64Array {
  checkState(n, state);
  const sum = new Float64Array(n + 1);
  const comp = new Float64Array(n + 1);
  for (let i = 0; i < state.length; i++) {
    const a = state[i];
    if (a !== 0) accumulate(sum, comp, popcount(i), a * a);
  }
  for (let w = 0; w <= n; w++) sum[w] += comp[w];
  return sum;
}

/**
 * Probability that a measurement returns Hamming weight exactly k: the
 * in-constraint probability (Niroula et al., Sci. Rep. 12:17171, 2022).
 */
export function inConstraintProbability(n: number, k: number, state: ArrayLike<number>): number {
  checkState(n, state);
  checkNK(n, k);
  const sum = new Float64Array(1);
  const comp = new Float64Array(1);
  for (let i = 0; i < state.length; i++) {
    const a = state[i];
    if (a !== 0 && popcount(i) === k) accumulate(sum, comp, 0, a * a);
  }
  return sum[0] + comp[0];
}

export interface DickeVerification {
  readonly n: number;
  readonly k: number;
  /** |<D^n_k|psi>|^2 against {@link analyticDicke}. */
  readonly fidelity: number;
  /** P(weight = k). */
  readonly inConstraintProbability: number;
  /** P(weight = w), w = 0..n. */
  readonly weights: Float64Array;
  /** Both numbers are at least 1 - tolerance. */
  readonly passed: boolean;
  readonly tolerance: number;
}

/**
 * Simulate `gates` and score the state against the analytic |D^n_k>. Never
 * throws on a failed check (the page must be able to show the failure); use
 * {@link assertVerified} where a failure must stop the pipeline.
 */
export function verifyDicke(
  n: number,
  k: number,
  gates: readonly SimGate[],
  tolerance: number = FIDELITY_TOLERANCE,
): DickeVerification {
  const state = simulate(n, gates);
  const f = fidelity(analyticDicke(n, k), state);
  const weights = weightDistribution(n, state);
  const pk = weights[k];
  return {
    n,
    k,
    fidelity: f,
    inConstraintProbability: pk,
    weights,
    passed: f >= 1 - tolerance && pk >= 1 - tolerance,
    tolerance,
  };
}

/** Throw {@link VerificationError} unless the verification passed. */
export function assertVerified(v: DickeVerification): void {
  if (!v.passed) {
    throw new VerificationError(
      `|D^${v.n}_${v.k}> fidelity ${v.fidelity.toFixed(12)} / in-constraint probability ` +
        `${v.inConstraintProbability.toFixed(12)} is below the ${(1 - v.tolerance).toFixed(12)} floor. ` +
        "The circuit is not the state it claims to be.",
    );
  }
}

// ---------------------------------------------------------------------------
// Decomposition and gate counts
// ---------------------------------------------------------------------------

/** The label every decomposed count carries. */
export const DECOMPOSITION_BASIS = "textbook CX+1q decomposition (uncompiled)" as const;

/**
 * Human-readable statement of the decompositions used by {@link decompose}.
 * Each is an exact operator identity (no global or relative phase):
 *
 * - `x` -> 1 single-qubit gate; `cx` -> 1 CX.
 * - `cnry` with one control (CRy(theta), control c, target t) -> 2 CX + 2 Ry:
 *   ry(theta/2) t; cx c,t; ry(-theta/2) t; cx c,t. The textbook body of `cry`
 *   (same operator as Qiskit's CRYGate and OpenQASM 3's stdgates `cry`).
 * - `cnry` with two controls (CCRy(theta), controls c1 c2, target t) -> 4 CX + 4 Ry:
 *   ry(theta/4) t; cx c2,t; ry(-theta/4) t; cx c1,t; ry(theta/4) t; cx c2,t;
 *   ry(-theta/4) t; cx c1,t. This is the uniformly-controlled-rotation
 *   (multiplexor) decomposition of Mottonen et al., PRL 93, 130502 (2004);
 *   it is exact because X Ry(a) X = Ry(-a), so the four quarter-angles add to
 *   theta only when c1 = c2 = 1. Same cost as the CCRy of Baertschi &
 *   Eidenbenz 2019, Fig. 3 (four quarter-angle Ry + four CNOTs).
 *
 * No gate cancellation or merging is applied. In particular the paper's
 * Fig. 3 trick that cancels one CNOT per three-qubit gadget against the
 * preceding gadget (5 instead of 6 CNOTs per gadget) is NOT applied, so the
 * counts here are an upper bound on what a compiler would emit.
 */
export const DECOMPOSITION_NOTES: readonly string[] = [
  "x -> 1 single-qubit gate; cx -> 1 CX",
  "CRy(theta) c,t -> ry(theta/2) t; cx c,t; ry(-theta/2) t; cx c,t  (2 CX + 2 Ry)",
  "CCRy(theta) c1,c2,t -> ry(theta/4) t; cx c2,t; ry(-theta/4) t; cx c1,t; ry(theta/4) t; " +
    "cx c2,t; ry(-theta/4) t; cx c1,t  (4 CX + 4 Ry; Mottonen et al. 2004 multiplexor, " +
    "same cost as Baertschi-Eidenbenz 2019 Fig. 3)",
  "no cancellation or merging across gates (uncompiled upper bound)",
];

function ry(theta: number, q: number): BasisGate {
  return { name: "ry", params: [theta], qubits: [q] };
}

function bcx(control: number, target: number): BasisGate {
  return { name: "cx", params: [], qubits: [control, target] };
}

/**
 * The IR expanded into {X, Ry, CX} with the decompositions in
 * {@link DECOMPOSITION_NOTES}. Exact: simulating the result gives the same
 * state as simulating the IR (a test checks this).
 */
export function decompose(gates: readonly Gate[]): BasisGate[] {
  const out: BasisGate[] = [];
  for (const g of gates) {
    if (g.name === "x") {
      out.push({ name: "x", params: [], qubits: [g.qubits[0]] });
    } else if (g.name === "cx") {
      out.push(bcx(g.qubits[0], g.qubits[1]));
    } else if (g.name === "cnry") {
      const theta = g.params[0];
      const t = g.qubits[g.qubits.length - 1];
      if (g.qubits.length === 2) {
        const c = g.qubits[0];
        out.push(ry(theta / 2, t), bcx(c, t), ry(-theta / 2, t), bcx(c, t));
      } else if (g.qubits.length === 3) {
        const [c1, c2] = g.qubits;
        out.push(
          ry(theta / 4, t), bcx(c2, t),
          ry(-theta / 4, t), bcx(c1, t),
          ry(theta / 4, t), bcx(c2, t),
          ry(-theta / 4, t), bcx(c1, t),
        );
      } else {
        throw new RangeError(`no decomposition for cnry with ${g.qubits.length - 1} controls`);
      }
    } else {
      throw new RangeError(`unknown gate ${JSON.stringify((g as { name: unknown }).name)}`);
    }
  }
  return out;
}

function wireCount(gates: readonly SimGate[]): number {
  let m = 0;
  for (const g of gates) for (const q of g.qubits) m = Math.max(m, q + 1);
  return m;
}

/** ASAP depth; with `twoQubitOnly`, single-qubit gates are transparent (pytket's depth_2q). */
function asapDepth(gates: readonly SimGate[], twoQubitOnly: boolean): number {
  const front = new Int32Array(wireCount(gates));
  let depth = 0;
  for (const g of gates) {
    if (twoQubitOnly && g.qubits.length < 2) continue;
    let layer = 0;
    for (const q of g.qubits) layer = Math.max(layer, front[q]);
    layer += 1;
    for (const q of g.qubits) front[q] = layer;
    depth = Math.max(depth, layer);
  }
  return depth;
}

export interface GateCounts {
  /** Raw IR op counts. `cry` + `ccry` = `cnry` (split by number of controls). */
  readonly ir: {
    readonly x: number;
    readonly cx: number;
    readonly cnry: number;
    readonly cry: number;
    readonly ccry: number;
    readonly total: number;
    /** ASAP depth of the IR, every op one layer, qubits-only (not wire-span) semantics. */
    readonly depth: number;
  };
  /** Estimate after {@link decompose}; see {@link DECOMPOSITION_NOTES}. */
  readonly decomposed: {
    readonly basis: typeof DECOMPOSITION_BASIS;
    readonly notes: readonly string[];
    readonly cx: number;
    /** X + Ry gates. */
    readonly oneQubit: number;
    readonly total: number;
    /** ASAP depth counting only CX (single-qubit gates transparent). */
    readonly twoQubitDepth: number;
    /** ASAP depth counting every gate as one layer. */
    readonly depth: number;
  };
}

/** Raw IR counts plus the textbook {CX, 1q} estimate with ASAP depths. */
export function gateCounts(gates: readonly Gate[]): GateCounts {
  let x = 0;
  let cx = 0;
  let cry = 0;
  let ccry = 0;
  for (const g of gates) {
    if (g.name === "x") x++;
    else if (g.name === "cx") cx++;
    else if (g.name === "cnry") {
      if (g.qubits.length === 2) cry++;
      else if (g.qubits.length === 3) ccry++;
      else throw new RangeError(`no decomposition for cnry with ${g.qubits.length - 1} controls`);
    }
  }
  const basis = decompose(gates);
  let bcxCount = 0;
  for (const g of basis) if (g.name === "cx") bcxCount++;
  return {
    ir: {
      x,
      cx,
      cnry: cry + ccry,
      cry,
      ccry,
      total: gates.length,
      depth: asapDepth(gates, false),
    },
    decomposed: {
      basis: DECOMPOSITION_BASIS,
      notes: DECOMPOSITION_NOTES,
      cx: bcxCount,
      oneQubit: basis.length - bcxCount,
      total: basis.length,
      twoQubitDepth: asapDepth(basis, true),
      depth: asapDepth(basis, false),
    },
  };
}

// ---------------------------------------------------------------------------
// Layering for the circuit diagram
// ---------------------------------------------------------------------------

export interface LayerOptions {
  /**
   * `true` (default): a gate occupies every wire from its lowest to its
   * highest qubit, so a diagram can draw its vertical connector without
   * crossing another gate in the same column. `false`: a gate occupies only
   * its own qubits (true circuit moments; the column count is the IR depth).
   */
  readonly span?: boolean;
}

/**
 * ASAP moment assignment of the gate list, in order. Returns the gates grouped
 * by column; within a column, gates keep their original relative order. With
 * the default wire-span semantics no two gates in a column overlap vertically.
 */
export function layers<G extends SimGate>(gates: readonly G[], options: LayerOptions = {}): G[][] {
  const span = options.span ?? true;
  const front = new Int32Array(wireCount(gates));
  const out: G[][] = [];
  for (const g of gates) {
    let lo = g.qubits[0];
    let hi = g.qubits[0];
    for (const q of g.qubits) {
      lo = Math.min(lo, q);
      hi = Math.max(hi, q);
    }
    let layer = 0;
    if (span) {
      for (let w = lo; w <= hi; w++) layer = Math.max(layer, front[w]);
      for (let w = lo; w <= hi; w++) front[w] = layer + 1;
    } else {
      for (const q of g.qubits) layer = Math.max(layer, front[q]);
      for (const q of g.qubits) front[q] = layer + 1;
    }
    (out[layer] ??= []).push(g);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Code emitters
// ---------------------------------------------------------------------------

/** Provenance stamped into an emitted snippet's header. */
export interface EmitMeta {
  /** Hamming weight. The QASM emitters infer it from the X layer when omitted. */
  readonly k?: number;
  /** Construction the gates came from (stated in the header). */
  readonly construction?: Construction;
  /**
   * Fidelity against the analytic |D^n_k> that the caller actually measured
   * with {@link simulate}/{@link verifyDicke}. Omit it when no simulation ran:
   * the header then says the circuit was not verified. A value below
   * 1 - {@link FIDELITY_TOLERANCE} makes the emitter throw
   * {@link VerificationError} instead of producing code.
   */
  readonly fidelity?: number;
  /** Measured in-constraint probability, stated alongside the fidelity when given. */
  readonly inConstraintProbability?: number;
}

/**
 * Radians as a literal every target parses: shortest round-trip decimal (the
 * same digits Python's repr prints), always with a decimal point, never "-0".
 */
function num(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`non-finite angle ${x}`);
  let s = Object.is(x, -0) ? "0" : String(x);
  if (!/[.eE]/.test(s)) s += ".0";
  else if (/[eE]/.test(s) && !s.includes(".")) s = s.replace(/[eE]/, ".0e");
  return s;
}

function inferK(gates: readonly Gate[]): number {
  let k = 0;
  for (const g of gates) if (g.name === "x") k++;
  return k;
}

function checkEmit(n: number, k: number, gates: readonly Gate[], meta: EmitMeta): void {
  checkNK(n, k);
  for (const g of gates) {
    checkQubits(n, g);
    if (g.name === "cnry" && g.qubits.length > 3) {
      throw new RangeError(`emitters support cnry with 1 or 2 controls, got ${g.qubits.length - 1}`);
    }
  }
  if (meta.fidelity !== undefined && !(meta.fidelity >= 1 - FIDELITY_TOLERANCE)) {
    throw new VerificationError(
      `refusing to emit code: |D^${n}_${k}> fidelity ${meta.fidelity} is below the ` +
        `${(1 - FIDELITY_TOLERANCE).toFixed(12)} floor`,
    );
  }
  if (
    meta.inConstraintProbability !== undefined &&
    !(meta.inConstraintProbability >= 1 - FIDELITY_TOLERANCE)
  ) {
    throw new VerificationError(
      `refusing to emit code: in-constraint probability ${meta.inConstraintProbability} is below ` +
        `the ${(1 - FIDELITY_TOLERANCE).toFixed(12)} floor`,
    );
  }
}

type Target = "qasm2" | "qasm3" | "qiskit" | "pytket" | "cirq";

function headerLines(n: number, k: number, gates: readonly Gate[], meta: EmitMeta, target: Target): string[] {
  const counts = gateCounts(gates);
  const construction = meta.construction;
  const lines: string[] = [];
  lines.push(
    `|D^${n}_${k}>: Dicke state on n=${n} qubits, Hamming weight k=${k} ` +
      `(uniform superposition of all C(${n},${k})=${binomial(n, k)} weight-${k} bitstrings).`,
  );
  if (construction) {
    const info = CONSTRUCTION_INFO[construction];
    lines.push(`Construction: ${construction} = ${info.label}, ${info.reference}.`);
  } else {
    lines.push("Construction: not stated by the caller.");
  }
  lines.push("Generated by Separatrix Studio from a TypeScript port of quantum/dicke_xy.py (same gate IR).");
  if (meta.fidelity !== undefined) {
    const pk =
      meta.inConstraintProbability !== undefined
        ? `, in-constraint probability ${meta.inConstraintProbability.toFixed(12)}`
        : "";
    lines.push(
      "Verified in the browser by exact statevector simulation before emission:",
      `  fidelity with the analytic |D^${n}_${k}> = ${meta.fidelity.toFixed(12)}${pk} (floor 1 - 1e-9).`,
    );
  } else {
    lines.push(
      "NOT verified in the browser for this emission (no simulation result was supplied).",
      target === "qasm2" || target === "qasm3"
        ? "  Check it with a statevector simulator before relying on it."
        : "  The check at the bottom of this script verifies it.",
    );
  }
  lines.push(
    target === "pytket"
      ? "Conventions: IR angles are radians; pytket takes half-turns, so each is written radians / pi."
      : "Conventions: angles in radians.",
    "  Qubit q is qubit q of the IR, which is big-endian (qubit 0 = most significant bit of a",
    "  statevector index), like pytket and Cirq. Qiskit is little-endian, but |D^n_k> is invariant",
    "  under qubit permutations, so the prepared state is the same.",
  );
  const gateSet: Record<Target, string> = {
    qasm2:
      "Gates: x, cx, c1ry = controlled-Ry, c2ry = doubly-controlled Ry (both defined below from ry/cx).",
    qasm3: "Gates: x, cx, cry (stdgates.inc), ctrl(2) @ ry = doubly-controlled Ry.",
    qiskit: "Gates: x, cx, cry, RYGate(theta).control(2) = doubly-controlled Ry.",
    pytket: "Gates: X, CX, OpType.CnRy for both 1 and 2 controls (exactly as ops_to_tket).",
    cirq: "Gates: X, CNOT, cirq.ry(theta).controlled(num_controls=1 or 2).",
  };
  lines.push(
    gateSet[target],
    `IR: ${counts.ir.x} X, ${counts.ir.cx} CX, ${counts.ir.cry} CRy, ${counts.ir.ccry} CCRy. ` +
      `Textbook CX+1q decomposition (uncompiled): ${counts.decomposed.cx} CX, ` +
      `${counts.decomposed.oneQubit} 1q, CX depth ${counts.decomposed.twoQubitDepth}.`,
  );
  return lines;
}

function commented(prefix: string, lines: readonly string[]): string[] {
  return lines.map((l) => (l.length ? `${prefix} ${l}` : prefix));
}

/**
 * OpenQASM 2.0 with `include "qelib1.inc"`. The standard qelib1.inc of the
 * OpenQASM 2.0 paper has no `cry` (only Qiskit's extended copy does, and
 * `qiskit.qasm2.loads` rejects it by default), so the controlled rotations are
 * defined in the program as `c1ry` / `c2ry` from `ry` and `cx`, with exactly
 * the decompositions of {@link decompose}. Names are chosen not to collide
 * with any reader's built-ins.
 */
export function toOpenQasm2(n: number, gates: readonly Gate[], meta: EmitMeta = {}): string {
  const k = meta.k ?? inferK(gates);
  checkEmit(n, k, gates, meta);
  const uses1 = gates.some((g) => g.name === "cnry" && g.qubits.length === 2);
  const uses2 = gates.some((g) => g.name === "cnry" && g.qubits.length === 3);
  const out: string[] = ["OPENQASM 2.0;", ...commented("//", headerLines(n, k, gates, meta, "qasm2"))];
  out.push('include "qelib1.inc";');
  if (uses1) {
    out.push(
      "",
      "// c1ry(theta) c, t: Ry(theta) on t iff c = 1. Same matrix as Qiskit's CRYGate and",
      "// OpenQASM 3's stdgates cry (the OpenQASM 2.0 paper's qelib1.inc has no cry).",
      "gate c1ry(theta) c, t",
      "{",
      "  ry(theta/2) t;",
      "  cx c, t;",
      "  ry(-theta/2) t;",
      "  cx c, t;",
      "}",
    );
  }
  if (uses2) {
    out.push(
      "",
      "// c2ry(theta) c1, c2, t: Ry(theta) on t iff c1 = c2 = 1, exactly (no phase).",
      "// Quarter-angle multiplexor, 4 cx + 4 ry: X ry(a) X = ry(-a), so the angles sum to theta",
      "// only when both controls are 1.",
      "gate c2ry(theta) c1, c2, t",
      "{",
      "  ry(theta/4) t;",
      "  cx c2, t;",
      "  ry(-theta/4) t;",
      "  cx c1, t;",
      "  ry(theta/4) t;",
      "  cx c2, t;",
      "  ry(-theta/4) t;",
      "  cx c1, t;",
      "}",
    );
  }
  out.push("", `qreg q[${n}];`);
  for (const g of gates) {
    const q = g.qubits.map((i) => `q[${i}]`).join(", ");
    if (g.name === "x") out.push(`x ${q};`);
    else if (g.name === "cx") out.push(`cx ${q};`);
    else if (g.qubits.length === 2) out.push(`c1ry(${num(g.params[0])}) ${q};`);
    else out.push(`c2ry(${num(g.params[0])}) ${q};`);
  }
  return out.join("\n") + "\n";
}

/**
 * OpenQASM 3.0 with `include "stdgates.inc"`: `cry` from stdgates.inc (whose
 * body is exactly the IR's single-control op) and `ctrl(2) @ ry(theta)` for
 * the doubly-controlled rotation. No measurement is appended, so the program
 * loads straight into a statevector simulator.
 */
export function toOpenQasm3(n: number, gates: readonly Gate[], meta: EmitMeta = {}): string {
  const k = meta.k ?? inferK(gates);
  checkEmit(n, k, gates, meta);
  const out: string[] = ["OPENQASM 3.0;", ...commented("//", headerLines(n, k, gates, meta, "qasm3"))];
  out.push('include "stdgates.inc";', "", `qubit[${n}] q;`);
  for (const g of gates) {
    const q = g.qubits.map((i) => `q[${i}]`).join(", ");
    if (g.name === "x") out.push(`x ${q};`);
    else if (g.name === "cx") out.push(`cx ${q};`);
    else if (g.qubits.length === 2) out.push(`cry(${num(g.params[0])}) ${q};`);
    else out.push(`ctrl(2) @ ry(${num(g.params[0])}) ${q};`);
  }
  return out.join("\n") + "\n";
}

/** The analytic-Dicke check shared by the Python emitters; expects `psi`, `n`, `k`. */
const PYTHON_CHECK: readonly string[] = [
  "# --- check: exact statevector against the analytic |D^n_k> ---------------------------",
  "# (builds 2^n amplitudes; |D^n_k> is permutation-symmetric, so no qubit reordering is needed)",
  "index = np.arange(2**n)",
  "weight = np.zeros(2**n, dtype=np.int64)",
  "for b in range(n):",
  "    weight += (index >> b) & 1",
  "dicke = (weight == k).astype(float)",
  "dicke /= np.linalg.norm(dicke)",
  "fidelity = abs(np.vdot(dicke, psi)) ** 2",
  "in_constraint = float(np.sum(np.abs(psi[weight == k]) ** 2))",
  'print(f"|D^{n}_{k}> fidelity = {fidelity:.12f}, in-constraint probability = {in_constraint:.12f}")',
  'assert fidelity > 1 - 1e-9, "the circuit does not prepare |D^n_k>"',
];

/** Qiskit: builds a `QuantumCircuit`, then checks `Statevector` against |D^n_k> and prints the fidelity. */
export function toQiskit(n: number, k: number, gates: readonly Gate[], meta: EmitMeta = {}): string {
  checkEmit(n, k, gates, meta);
  const uses2 = gates.some((g) => g.name === "cnry" && g.qubits.length === 3);
  const out: string[] = commented("#", headerLines(n, k, gates, meta, "qiskit"));
  out.push("import numpy as np", "from qiskit import QuantumCircuit");
  if (uses2) out.push("from qiskit.circuit.library import RYGate");
  out.push("from qiskit.quantum_info import Statevector", "", `n, k = ${n}, ${k}`);
  out.push(`qc = QuantumCircuit(n, name="D^${n}_${k}")`);
  for (const g of gates) {
    const [a, b, c] = g.qubits;
    if (g.name === "x") out.push(`qc.x(${a})`);
    else if (g.name === "cx") out.push(`qc.cx(${a}, ${b})`);
    else if (g.qubits.length === 2) out.push(`qc.cry(${num(g.params[0])}, ${a}, ${b})`);
    else out.push(`qc.append(RYGate(${num(g.params[0])}).control(2), [${a}, ${b}, ${c}])`);
  }
  out.push("", "psi = np.asarray(Statevector(qc).data)", "", ...PYTHON_CHECK);
  return out.join("\n") + "\n";
}

/**
 * pytket: `OpType.CnRy` for every controlled rotation with the angle in
 * half-turns (`radians / math.pi`), exactly as `ops_to_tket`. The check uses
 * `Circuit.get_statevector()` (big-endian, like the IR) and, above pytket's
 * built-in simulator limit (about 11 qubits), falls back to qiskit with
 * `reverse_qargs()`, as `tket_statevector` does.
 */
export function toPytket(n: number, k: number, gates: readonly Gate[], meta: EmitMeta = {}): string {
  checkEmit(n, k, gates, meta);
  const out: string[] = commented("#", headerLines(n, k, gates, meta, "pytket"));
  out.push(
    "import math",
    "",
    "import numpy as np",
    "from pytket.circuit import Circuit, OpType",
    "",
    `n, k = ${n}, ${k}`,
    `circ = Circuit(n, name="D^${n}_${k}")`,
  );
  for (const g of gates) {
    if (g.name === "x") out.push(`circ.X(${g.qubits[0]})`);
    else if (g.name === "cx") out.push(`circ.CX(${g.qubits[0]}, ${g.qubits[1]})`);
    else out.push(`circ.add_gate(OpType.CnRy, [${num(g.params[0])} / math.pi], [${g.qubits.join(", ")}])`);
  }
  out.push(
    "",
    "try:",
    "    psi = np.asarray(circ.get_statevector())  # big-endian, same order as the IR",
    "except RuntimeError:  # pytket's built-in simulator stops at about 11 qubits",
    "    from pytket.extensions.qiskit import tk_to_qiskit",
    "    from qiskit.quantum_info import Statevector",
    "",
    "    psi = np.asarray(Statevector(tk_to_qiskit(circ)).reverse_qargs().data)",
    "",
    ...PYTHON_CHECK,
  );
  return out.join("\n") + "\n";
}

/** Cirq: `LineQubit`s, `cirq.ry(theta).controlled(...)`, and a complex128 statevector check. */
export function toCirq(n: number, k: number, gates: readonly Gate[], meta: EmitMeta = {}): string {
  checkEmit(n, k, gates, meta);
  const out: string[] = commented("#", headerLines(n, k, gates, meta, "cirq"));
  out.push("import cirq", "import numpy as np", "", `n, k = ${n}, ${k}`, "q = cirq.LineQubit.range(n)");
  out.push("ops = [");
  for (const g of gates) {
    const qs = g.qubits.map((i) => `q[${i}]`).join(", ");
    if (g.name === "x") out.push(`    cirq.X(${qs}),`);
    else if (g.name === "cx") out.push(`    cirq.CNOT(${qs}),`);
    else {
      out.push(`    cirq.ry(${num(g.params[0])}).controlled(num_controls=${g.qubits.length - 1}).on(${qs}),`);
    }
  }
  out.push(
    "]",
    "circuit = cirq.Circuit(ops)",
    "",
    "# qubit_order=q: big-endian like the IR, and keeps idle qubits in the register",
    "result = cirq.Simulator(dtype=np.complex128).simulate(circuit, qubit_order=q)",
    "psi = np.asarray(result.final_state_vector)",
    "",
    ...PYTHON_CHECK,
  );
  return out.join("\n") + "\n";
}
