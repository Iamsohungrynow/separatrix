import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { CodeBlock } from "../components/Code";
import { IconAtom, IconCheck, IconX } from "../components/icons";
import { SplitWords, useInView } from "../components/Motion";
import { binom, groupDigits } from "../lib/format";
import { blob } from "../lib/site";
import {
  analyticDicke, CONSTRUCTION_INFO, CONSTRUCTIONS, dickeCircuit, FIDELITY_TOLERANCE, fidelity, gateCounts, layers, simulate, toCirq, toOpenQasm2, toOpenQasm3,
  toPytket, toQiskit, weightDistribution, type Construction, type DickeVerification, type EmitMeta, type Gate,
} from "../quantum/dicke";
import "./pages.css";
import "./dicke.css";

/** Auto-verify up to here on the main thread; beyond it, verify on request. */
const AUTO_VERIFY_N = 18;
const MAX_VERIFY_N = 22;
/** Above this many wires the post-verification pulse would be noise, so it's skipped. */
const PULSE_MAX_N = 12;

/** Custom properties for the stagger timings (React passes them through untouched). */
const cssVars = (o: Record<string, string | number>) => o as CSSProperties;

function readQuery(): { n: number; k: number; c: Construction } {
  const q = new URLSearchParams(window.location.search);
  const n = Math.min(24, Math.max(1, parseInt(q.get("n") ?? "6", 10) || 6));
  const k = Math.min(n, Math.max(0, parseInt(q.get("k") ?? "3", 10) || 0));
  const c = (CONSTRUCTIONS as readonly string[]).includes(q.get("c") ?? "") ? (q.get("c") as Construction) : "scs";
  return { n, k, c };
}

/** Simulate once, then score: the page needs the statevector itself for the amplitude chart. */
function runVerification(n: number, k: number, gates: Gate[]) {
  const t0 = performance.now();
  const state = simulate(n, gates);
  const f = fidelity(analyticDicke(n, k), state);
  const weights = weightDistribution(n, state);
  const v: DickeVerification = {
    n, k, fidelity: f, inConstraintProbability: weights[k], weights,
    passed: f >= 1 - FIDELITY_TOLERANCE && weights[k] >= 1 - FIDELITY_TOLERANCE, tolerance: FIDELITY_TOLERANCE,
  };
  return { v, state, ms: performance.now() - t0 };
}

function fmtAngle(theta: number): string {
  const r = theta / Math.PI;
  return `${r.toFixed(3)}π`;
}

function fmtOneMinus(v: number): string {
  const d = 1 - v;
  if (Math.abs(d) < 1e-16) return "1.000000000000";
  if (d > 0 && d < 1e-6) return `1 − ${d.toExponential(1)}`;
  return v.toFixed(12);
}

/**
 * The circuit draws itself on every rebuild: wires first, then gates column by
 * column. The svg is keyed on the build, so a new (n, k, construction) replays
 * it; the stagger per column shrinks with depth so even n = 24 lands in ~0.8 s.
 * Nothing plays until the card has been scrolled to once.
 */
function Circuit({ n, gates, build, pulse }: { n: number; gates: Gate[]; build: string; pulse: boolean }) {
  const cols = useMemo(() => layers(gates, { span: true }), [gates]);
  const [box, seen] = useInView<HTMLDivElement>();
  const dx = 44, dy = 34, left = 44, top = 22;
  const W = left + cols.length * dx + 24;
  const H = top + (n - 1) * dy + 26;
  const y = (q: number) => top + q * dy;
  const step = Math.min(34, 520 / Math.max(1, cols.length));
  const timing = cssVars({
    "--step": `${step.toFixed(2)}ms`, "--wstep": `${Math.min(22, 140 / n).toFixed(2)}ms`, "--built": `${Math.round(160 + cols.length * step + 260)}ms`,
    // wires use pathLength = 1, so a ~36px pulse is this fraction of one
    "--dash": (36 / (W - left - 2)).toFixed(4),
  });
  return (
    <div className="circuit-scroll" ref={box}>
      <svg key={build} className={`circ${seen ? " play" : ""}`} style={timing} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Circuit with ${gates.length} gates on ${n} qubits`}>
        {Array.from({ length: n }, (_, q) => (
          <g key={q} className="dk-wire" style={cssVars({ "--q": q })}>
            <text x={8} y={y(q) + 4} className="wire-l">q{q}</text>
            <path d={`M${left - 10} ${y(q)}H${W - 12}`} pathLength={1} stroke="rgba(214,236,230,.16)" />
          </g>
        ))}
        {/* One pulse per wire once the gates are in, only for a circuit that just passed its check. */}
        {pulse && Array.from({ length: n }, (_, q) => (
          <path key={`p${q}`} className="dk-pulse" d={`M${left - 10} ${y(q)}H${W - 12}`} pathLength={1} style={cssVars({ "--q": q })} />
        ))}
        {cols.map((col, ci) => (
          <g key={ci} style={cssVars({ "--c": ci })}>
            {col.map((g, gi) => {
              const x = left + ci * dx + dx / 2;
              const qs = g.qubits;
              const t = qs[qs.length - 1];
              const lo = Math.min(...qs), hi = Math.max(...qs);
              const title = g.name === "cnry" ? `${qs.length === 2 ? "CRy" : "CCRy"}(θ = ${g.params[0].toFixed(6)} rad = ${fmtAngle(g.params[0])}) · controls ${qs.slice(0, -1).map((c) => `q${c}`).join(", ")} → target q${t}` : g.name === "cx" ? `CX q${qs[0]} → q${qs[1]}` : `X on q${qs[0]}`;
              // The link draws from the far control towards the target.
              const [ya, yb] = t === lo ? [y(hi), y(lo)] : [y(lo), y(hi)];
              return (
                <g key={gi} className={`dk-gate g-${g.name}`}>
                  <title>{title}</title>
                  {qs.length > 1 && <path className="dk-link" d={`M${x} ${ya}V${yb}`} pathLength={1} stroke={g.name === "cx" ? "#3fd8c0" : "#f2a25c"} strokeWidth={1.5} />}
                  {qs.slice(0, -1).map((c) => <circle key={c} cx={x} cy={y(c)} r={4.2} fill={g.name === "cx" ? "#3fd8c0" : "#f2a25c"} />)}
                  {g.name === "x" && (<g className="dk-tgt"><rect x={x - 12} y={y(t) - 12} width={24} height={24} rx={6} fill="#1a252b" stroke="rgba(214,236,230,.35)" /><text x={x} y={y(t) + 4} textAnchor="middle" className="g-l">X</text></g>)}
                  {g.name === "cx" && (<g className="dk-tgt"><circle cx={x} cy={y(t)} r={10} fill="#0b1114" stroke="#3fd8c0" strokeWidth={1.5} /><path d={`M${x - 10} ${y(t)}h20M${x} ${y(t) - 10}v20`} stroke="#3fd8c0" strokeWidth={1.5} /></g>)}
                  {g.name === "cnry" && (<g className="dk-tgt"><rect x={x - 16} y={y(t) - 12} width={32} height={24} rx={6} fill="rgba(242,162,92,.13)" stroke="#f2a25c" /><text x={x} y={y(t) + 4} textAnchor="middle" className="g-l" fill="#f2a25c">Ry</text></g>)}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}

function Amplitudes({ n, k, state, build }: { n: number; k: number; state: Float64Array; build: string }) {
  const [box, seen] = useInView<HTMLDivElement>();
  const entries = useMemo(() => {
    const out: { idx: number; a: number }[] = [];
    for (let i = 0; i < state.length; i++) if (Math.abs(state[i]) > 1e-9) out.push({ idx: i, a: state[i] });
    return out;
  }, [state]);
  const show = entries.slice(0, 70);
  const max = Math.max(...show.map((e) => Math.abs(e.a)), 1e-12);
  const ideal = 1 / Math.sqrt(binom(n, k));
  // Bars grow from the baseline when a new state arrives; the whole row lands within ~1 s.
  const step = Math.min(14, 420 / Math.max(1, show.length));
  return (
    <div className="amps" ref={box}>
      <div key={build} className={`amp-bars${seen ? " play" : ""}`} style={cssVars({ "--step": `${step.toFixed(2)}ms` })} role="img" aria-label={`${entries.length} non-zero amplitudes`}>
        {show.map((e, i) => (
          <div key={e.idx} className="amp" style={cssVars({ "--i": i })} title={`|${e.idx.toString(2).padStart(n, "0")}⟩  amplitude ${e.a.toFixed(12)}`}>
            <span style={{ height: `${(Math.abs(e.a) / max) * 100}%`, background: e.a >= 0 ? "var(--up)" : "var(--down)" }} />
          </div>
        ))}
      </div>
      <p className="fine">
        {groupDigits(entries.length)} non-zero amplitude{entries.length === 1 ? "" : "s"} (expected C({n},{k}) = {groupDigits(binom(n, k))}), each ≈ {ideal.toFixed(6)} = 1/√C(n,k).
        {entries.length > show.length && ` Showing the first ${show.length}.`}
        {n <= 8 && ` Hover a bar for its bitstring.`}
      </p>
    </div>
  );
}

function Weights({ v, build }: { v: DickeVerification; build: string }) {
  const [box, seen] = useInView<HTMLDivElement>();
  const step = Math.min(30, 300 / v.weights.length);
  return (
    <div ref={box} className={`weights${seen ? " play" : ""}`} style={cssVars({ "--step": `${step.toFixed(2)}ms` })} role="img" aria-label="Probability by Hamming weight">
      {Array.from(v.weights).map((p, w) => (
        <div key={`${build}:${w}`} className={`wcol ${w === v.k ? "on" : ""}`} style={cssVars({ "--i": w })} title={`P(weight = ${w}) = ${p.toExponential(3)}`}>
          <div className="wbar"><span style={{ height: `${Math.max(p > 1e-12 ? 3 : 0, p * 100)}%` }} /></div>
          <small>{w}</small>
        </div>
      ))}
    </div>
  );
}

const LANGS = [
  { id: "qiskit", label: "Qiskit", lang: "python" as const, file: "dicke_qiskit.py" },
  { id: "pytket", label: "pytket", lang: "python" as const, file: "dicke_pytket.py" },
  { id: "cirq", label: "Cirq", lang: "python" as const, file: "dicke_cirq.py" },
  { id: "qasm2", label: "OpenQASM 2", lang: "qasm" as const, file: "dicke.qasm" },
  { id: "qasm3", label: "OpenQASM 3", lang: "qasm" as const, file: "dicke3.qasm" },
];

export default function Dicke() {
  const init = useMemo(readQuery, []);
  const [n, setN] = useState(init.n);
  const [k, setK] = useState(init.k);
  const [c, setC] = useState<Construction>(init.c);
  const [lang, setLang] = useState("qiskit");
  const [manual, setManual] = useState<{ key: string; v: DickeVerification; state: Float64Array; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { document.title = "Dicke-state circuit builder · Separatrix"; }, []);
  useEffect(() => { if (k > n) setK(n); }, [n, k]);
  useEffect(() => {
    const url = `/dicke?n=${n}&k=${Math.min(k, n)}${c !== "scs" ? `&c=${c}` : ""}`;
    window.history.replaceState(null, "", url);
  }, [n, k, c]);

  const kk = Math.min(k, n);
  const key = `${n}-${kk}-${c}`;
  const gates = useMemo(() => dickeCircuit(n, kk, c), [n, kk, c]);
  const counts = useMemo(() => gateCounts(gates), [gates]);

  const auto = useMemo(() => (n > AUTO_VERIFY_N ? null : { key, ...runVerification(n, kk, gates) }), [n, kk, gates, key]);
  const result = auto ?? (manual?.key === key ? manual : null);

  const runManual = () => {
    setBusy(true);
    setTimeout(() => {
      setManual({ key, ...runVerification(n, kk, gates) });
      setBusy(false);
    }, 30);
  };

  const verified = result?.v.passed ?? false;
  const failed = result !== null && !result.v.passed;
  const code = useMemo(() => {
    // Emitters stamp "verified" only when handed a measured fidelity, and
    // refuse (throw) below the floor, so a failed circuit never gets code.
    if (failed) return null;
    const meta: EmitMeta = {
      k: kk,
      construction: c,
      ...(result?.v.passed ? { fidelity: result.v.fidelity, inConstraintProbability: result.v.inConstraintProbability } : {}),
    };
    switch (lang) {
      case "qasm2": return toOpenQasm2(n, gates, meta);
      case "qasm3": return toOpenQasm3(n, gates, meta);
      case "pytket": return toPytket(n, kk, gates, meta);
      case "cirq": return toCirq(n, kk, gates, meta);
      default: return toQiskit(n, kk, gates, meta);
    }
  }, [lang, n, kk, gates, c, result, failed]);
  const L = LANGS.find((l) => l.id === lang)!;
  const pctN = ((n - 1) / 23) * 100;
  const pctK = n === 0 ? 0 : (kk / n) * 100;

  return (
    <div className="wrap page dicke">
      <header className="page-h">
        <span className="eyebrow" data-reveal="fade"><IconAtom size={14} /> Quantum · state preparation</span>
        <h1><SplitWords text="Dicke-state circuit builder" delay={60} /></h1>
        <p className="muted" data-reveal style={cssVars({ "--d": "220ms" })}>
          |D<sup>n</sup><sub>k</sub>⟩ is the equal superposition of every n-qubit bitstring with exactly k ones. It's the natural starting state for "choose k of n" problems,
          because an XY mixer then keeps every shot feasible. Pick n and k, get the circuit, and check that it's correct before you copy it.
        </p>
      </header>

      <div className="dk-grid" data-reveal-stagger>
        <div className="card dk-controls" data-reveal style={cssVars({ "--d": "280ms" })}>
          <div className="card-b" style={{ display: "grid", gap: 20 }}>
            <div className="field">
              <div className="field-top"><label htmlFor="dn">Qubits n</label><span key={n} className="val dk-tick">{n}</span></div>
              <input id="dn" type="range" min={1} max={24} value={n} style={{ ["--p" as string]: `${pctN}%` }} onChange={(e) => setN(parseInt(e.target.value, 10))} />
            </div>
            <div className="field">
              <div className="field-top"><label htmlFor="dk">Excitations k</label><span key={kk} className="val dk-tick">{kk}</span></div>
              <input id="dk" type="range" min={0} max={n} value={kk} style={{ ["--p" as string]: `${pctK}%` }} onChange={(e) => setK(parseInt(e.target.value, 10))} />
              <span className="hint">k = 1 gives the W state. C({n},{kk}) = {groupDigits(binom(n, kk))} basis states in superposition.</span>
            </div>
            <div className="field">
              <span className="label">Construction</span>
              <div className="seg">
                {CONSTRUCTIONS.map((x) => <button key={x} aria-pressed={c === x} onClick={() => setC(x)}>{x === "scs" ? "SCS (2019)" : "Divide & conquer"}</button>)}
              </div>
              <span className="hint">{CONSTRUCTION_INFO[c].summary} <i>{CONSTRUCTION_INFO[c].reference}.</i></span>
            </div>
          </div>
        </div>

        <div className={`card dk-verify${busy ? " is-busy" : ""}`} data-reveal style={cssVars({ "--d": "280ms" })}>
          {/* indeterminate: the simulation reports no progress, so this doesn't pretend to */}
          {busy && <span className="dk-scan" aria-hidden="true"><i /></span>}
          <div className="card-h">
            <h3>Verification</h3>
            <span className="grow" />
            {/* keyed on the build: each re-simulated circuit earns its own confirmation */}
            {result ? (
              verified ? <span key={`ok-${key}`} className="pill up dk-pass"><IconCheck size={12} /> verified</span> : <span key={`bad-${key}`} className="pill bad dk-fail"><IconX size={12} /> failed</span>
            ) : <span className="pill">not simulated</span>}
          </div>
          <div className="card-b" style={{ display: "grid", gap: 14 }}>
            {result ? (
              <>
                <div key={key} className="kpis dk-swap">
                  <div><span className="num">{fmtOneMinus(result.v.fidelity)}</span><small>fidelity |⟨D<sup>n</sup><sub>k</sub>|ψ⟩|² against the exact state</small></div>
                  <div><span className="num">{fmtOneMinus(result.v.inConstraintProbability)}</span><small>in-constraint probability P(weight = {kk})</small></div>
                </div>
                <Weights v={result.v} build={key} />
                <p className="fine">Statevector simulation of all 2<sup>{n}</sup> = {groupDigits(2 ** n)} amplitudes in your browser, {result.ms.toFixed(0)} ms. Pass threshold 1 − 10⁻⁹, the same floor the Python pipeline aborts on.</p>
              </>
            ) : n <= MAX_VERIFY_N ? (
              <div className="dk-note">
                <p>At n = {n} the statevector has {groupDigits(2 ** n)} amplitudes, so simulation runs only when you ask. It can take a few seconds.</p>
                <button className="btn primary" onClick={runManual} disabled={busy}>{busy ? <><span className="spinner" /> Simulating…</> : "Verify in browser"}</button>
              </div>
            ) : (
              <div className="dk-note wall">
                <span className="dk-note-i" aria-hidden="true">∞</span>
                <p>
                  At n = {n} the statevector ({groupDigits(2 ** n)} amplitudes) is too large to simulate in a browser tab, so this circuit is <b>not verified here</b>.
                  The construction is verified for every n ≤ 12 (all k) and several larger cases in the repository's test suite. The exported code says so too.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }} data-reveal>
        <div className="card-h">
          <h3>Circuit</h3>
          <span className="sub">{counts.ir.total} gates · depth {counts.ir.depth}</span>
        </div>
        <div className="card-b">
          <div className="counts">
            {/* each number is keyed on its value, so only the counts that changed roll over */}
            <div><b key={counts.ir.x} className="num dk-tick">{counts.ir.x}</b><span>X</span></div>
            <div><b key={counts.ir.cx} className="num dk-tick">{counts.ir.cx}</b><span>CX</span></div>
            <div><b key={counts.ir.cry} className="num dk-tick">{counts.ir.cry}</b><span>CRy</span></div>
            <div><b key={counts.ir.ccry} className="num dk-tick">{counts.ir.ccry}</b><span>CCRy</span></div>
            <div className="sep" />
            <div><b key={counts.decomposed.cx} className="num dk-tick">{counts.decomposed.cx}</b><span>CX after decomposition</span></div>
            <div><b key={counts.decomposed.twoQubitDepth} className="num dk-tick">{counts.decomposed.twoQubitDepth}</b><span>two-qubit depth</span></div>
            <div><b key={counts.decomposed.total} className="num dk-tick">{counts.decomposed.total}</b><span>gates in {"{CX, 1q}"}</span></div>
          </div>
          <Circuit n={n} gates={gates} build={key} pulse={verified && n <= PULSE_MAX_N} />
          <p className="fine circ-cap">Hover a gate for its angle.</p>
          <details className="notes">
            <summary>How the decomposed counts are estimated</summary>
            <p className="fine" style={{ marginTop: 8 }}>{counts.decomposed.basis}. These are textbook decompositions, not the output of an optimising compiler. A compiler (and native gates like ZZPhase or ECR) will change them.</p>
            <ul>{counts.decomposed.notes.map((note) => <li key={note} className="fine">{note}</li>)}</ul>
          </details>
        </div>
      </div>

      {result && (
        <div className="card" style={{ marginTop: 16 }} data-reveal>
          <div className="card-h"><h3>Amplitudes</h3><span className="sub">real, non-zero entries of the prepared state</span></div>
          <div className="card-b"><Amplitudes n={n} k={kk} state={result.state} build={key} /></div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }} data-reveal>
        <div className="card-h">
          <h3>Code</h3>
          <span className="grow" />
          <div className="seg" style={{ flexWrap: "wrap" }}>
            {LANGS.map((l) => <button key={l.id} aria-pressed={lang === l.id} onClick={() => setLang(l.id)}>{l.label}</button>)}
          </div>
        </div>
        <div className="card-b">
          {code === null ? (
            <div key={`err-${key}`} className="parse-err dk-fail"><b>This circuit failed its own check, so no code is offered.</b> Please open an issue with n = {n}, k = {kk}, construction {c}.</div>
          ) : (
            // keyed on the language only: switching tabs fades the new export in, a rebuild just updates it
            <div key={lang} className="dk-swap">
              {!result && <p className="fine" style={{ marginBottom: 10 }}>Not simulated at this size, so the exported header says <b>NOT verified</b>.</p>}
              <CodeBlock code={code} lang={L.lang} filename={L.file} maxHeight={520} />
              {lang === "cirq" && <p className="fine" style={{ marginTop: 8 }}>The Cirq export is generated the same way as the others but has only been smoke-tested; the Qiskit, pytket and OpenQASM exports were each run and checked against the exact state.</p>}
            </div>
          )}
        </div>
      </div>

      <section className="prose" style={{ marginTop: 20 }} data-reveal>
        <h2>Conventions</h2>
        <ul>
          <li><b>Qubit order.</b> Qubit q is bit n−1−q of a statevector index (big-endian, pytket's convention). Qiskit is little-endian, but |D<sup>n</sup><sub>k</sub>⟩ is symmetric under any permutation of qubits, so every export prepares the same state.</li>
          <li><b>Angles</b> are in radians throughout. pytket takes half-turns, and the pytket export divides by π once, at the boundary.</li>
          <li><b>SCS construction:</b> X on the top k qubits (not the bottom k), then SCS<sub>l, min(k, l−1)</sub> for l = n down to 2, with a negated controlled-Ry angle θ = −2·arccos(√(i/l)). Each of those details has been wrong at least once in the project's history, which is why every circuit here is simulated before it is shown as verified.</li>
        </ul>
        <p>
          This tool is a port of the verified Python reference in <a className="link" href={blob("quantum/dicke_xy.py")} target="_blank" rel="noopener noreferrer">quantum/dicke_xy.py</a>, pinned gate-for-gate to it by a test.
          The repository also characterises these circuits, with an XY-ring mixer, on all-to-all, heavy-hex and linear connectivity: see the{" "}
          <a className="link" href={blob("docs/primitives.md")} target="_blank" rel="noopener noreferrer">primitives write-up</a>.
        </p>
      </section>
    </div>
  );
}
