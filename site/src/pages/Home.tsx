import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BifurcationCanvas, usePlayback } from "../components/Bifurcation";
import { CodeBlock, CopyButton } from "../components/Code";
import { SpinField } from "../components/SpinField";
import { StarButton } from "../components/Chrome";
import { IconArrow, IconAtom, IconChart, IconDots, IconGraph, IconMatrix, IconScale } from "../components/icons";
import { CountUp, Marquee, SplitWords, useInView } from "../components/Motion";
import { prefersReducedMotion } from "../lib/motion";
import { Link } from "../lib/router";
import { blob, REPO_URL } from "../lib/site";
import { SolverClient, type Trace } from "../solver/client";
import type { Qubo } from "../problems/types";
import { WORKBENCH } from "../data/benchmarks";
import "./home.css";

/** Inline entrance delay for the motion layer (`--d`). */
const d = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

/** Section label; its hairline draws in from the left when revealed. */
function Eyebrow({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="eyebrow sec-eb" data-reveal="fade">
      {icon}
      <span>{children}</span>
      <span className="eb-rule" aria-hidden="true" />
    </span>
  );
}

/**
 * Scroll position as 0..1 across an element taller than the viewport, read in
 * a rAF loop that only runs while the element is on screen. No scroll
 * listener: those fire ahead of paint and can't be batched.
 */
function useScrollRange(ref: { current: HTMLElement | null }, onProgress: (p: number) => void, enabled: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let raf = 0;
    let live = false;
    const tick = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      onProgress(span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 0);
      if (live) raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      live = e.isIntersecting;
      if (live && !raf) raf = requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [ref, onProgress, enabled]);
}

/**
 * A sentence whose words light up as it scrolls through the viewport. Writes
 * attributes straight to the DOM from a rAF-throttled scroll handler, so it
 * never re-renders. Without JS or with reduced motion it is plain text.
 */
function ScrollLit({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const words = text.split(" ");
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const spans = Array.from(el.querySelectorAll<HTMLElement>(".lit-w"));
    el.setAttribute("data-lit", "");
    let lit = 0, raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // fully lit once the page can't scroll any further (very tall screens)
      const end = window.scrollY + vh >= document.documentElement.scrollHeight - 2;
      const t = end ? 1 : (0.82 * vh - r.top) / (r.height + 0.25 * vh);
      const n = Math.max(0, Math.min(spans.length, Math.round(t * spans.length)));
      // data-on rather than a class: the motion layer's observer ignores it
      for (let i = Math.min(lit, n); i < Math.max(lit, n); i++) spans[i].toggleAttribute("data-on", i < n);
      lit = n;
    };
    let live = false;
    const tick = () => {
      raf = 0;
      update();
      if (live) raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      live = e.isIntersecting;
      if (live && !raf) raf = requestAnimationFrame(tick);
    }, { rootMargin: "20% 0px" });
    io.observe(el);
    update();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      el.removeAttribute("data-lit");
      spans.forEach((s) => s.removeAttribute("data-on"));
    };
  }, [text]);
  return (
    <p ref={ref} className={`scroll-lit ${className}`}>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="lit-w">{w}</span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </p>
  );
}

/** A random Max-Cut instance as a QUBO, generated inline so the hero has no dependencies. */
function heroInstance(seed: number, n = 72, degree = 4) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const edges = new Set<string>();
  const list: [number, number][] = [];
  const target = Math.round((n * degree) / 2);
  while (list.length < target) {
    const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
    if (i === j) continue;
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    if (edges.has(key)) continue;
    edges.add(key);
    list.push(i < j ? [i, j] : [j, i]);
  }
  const lin = new Float64Array(n);
  const terms: [number, number, number][] = [];
  for (const [i, j] of list) { lin[i] -= 1; lin[j] -= 1; terms.push([i, j, 2]); }
  for (let i = 0; i < n; i++) if (lin[i] !== 0) terms.push([i, i, lin[i]]);
  const qubo: Qubo = { n, terms, offset: 0 };
  return { qubo, edges: list };
}

function useHeroTrace() {
  const client = useRef<SolverClient | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [meta, setMeta] = useState<{ cut: number; edges: number; ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState(7);

  useEffect(() => {
    if (!client.current) client.current = new SolverClient();
    const c = client.current;
    let alive = true;
    const { qubo, edges } = heroInstance(seed);
    const t0 = performance.now();
    c.trace(qubo, { variant: "bSB", steps: 1500, seed, frames: 220, couplingScale: 0.5 })
      .then((t) => {
        if (!alive) return;
        const ms = performance.now() - t0;
        const b = t.bits;
        const cut = edges.reduce((acc, [i, j]) => acc + (b[i] !== b[j] ? 1 : 0), 0);
        setTrace(t);
        setMeta({ cut, edges: edges.length, ms });
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [seed]);

  useEffect(() => () => client.current?.cancel(), []);
  return { trace, meta, error, next: () => setSeed((s) => s + 1) };
}

function Hero() {
  const { trace, meta, error, next } = useHeroTrace();
  const pb = usePlayback(trace?.frames ?? 0, 3400, trace);
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // loop: a fresh random instance every few seconds while on screen
  useEffect(() => {
    if (!trace || pb.playing || !visible) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setTimeout(next, 3200);
    return () => clearTimeout(t);
  }, [trace, pb.playing, visible, next]);

  // The section stays position:relative with the grid as its first child, so
  // another backdrop layer can be slotted in beside it.
  return (
    <section className="hero" data-pointer>
      <div className="grid-bg" aria-hidden="true" />
      <SpinField className="hero-field" horizon={0.82} rows={26} />
      <div className="wrap hero-inner">
        <span className="pill hero-in">Open source, Rust to WebAssembly, no sign-up</span>
        <h1>
          <SplitWords text="Solve hard optimization problems" accent="in your browser." delay={90} />
        </h1>
        <div className="hero-row">
          <div className="hero-copy">
            <p className="lede hero-in" style={d(380)}>
              <b>Simulated bifurcation</b>, a quantum-inspired algorithm, races three classical solvers and the <b>proven optimum</b>, on your device.
            </p>
            <div className="hero-cta hero-in" style={d(470)}>
              <Link href="/solve" className="btn primary lg" data-magnetic>Open the solver <IconArrow size={17} /></Link>
              <Link href="/dicke" className="btn lg">Build a Dicke circuit</Link>
            </div>
          </div>

        {/* The ring lives on a wrapper so the card keeps its own ::before glow
            and the ring can spin on the compositor (rotate, not a repainted gradient). */}
        <div className="hero-viz-wrap" data-tilt="3" ref={box}>
          <div className="hero-viz card">
            <div className="hero-viz-h">
              <span className="pill up"><span className="dot live" /> live</span>
              <span className="legend mono"><i className="lg-up" /> spin +1 <i className="lg-down" /> spin −1</span>
            </div>
            <div className="hero-canvas">
              {error ? (
                <div className="hero-err">The live solver couldn't start in this browser: {error}</div>
              ) : (
                <BifurcationCanvas trace={visible ? trace : trace} frame={pb.frame} height={300} variant="hero" />
              )}
            </div>
            <div className="hero-viz-f mono">
              {meta ? (
                // keyed on the run, so the figures fade in when a real result lands
                <Fragment key={meta.ms}>
                  <span>72-node Max-Cut · cut <b>{meta.cut}</b> / {meta.edges} edges</span>
                  <span>ballistic SB, c₀ at ½ default · <b>{meta.ms.toFixed(0)} ms</b> on your device</span>
                </Fragment>
              ) : (
                <span className="muted">loading solver…</span>
              )}
            </div>
          </div>
        </div>
        </div>
      </div>
    </section>
  );
}

// Only things the page itself says are true: solvers, formats, platform.
const CAPABILITIES = [
  "Simulated bifurcation", "Simulated annealing", "Parallel tempering", "Exact enumeration to n = 26",
  "dimod JSON", "D-Wave Q-dict", "CPLEX LP", "Qiskit Optimization", "D-Wave Ocean", "Rust crate",
  "WebAssembly", "OpenQASM 2", "OpenQASM 3", "pytket", "Cirq", "No sign-up", "Nothing uploaded",
];

function Capabilities() {
  return (
    <section className="caps" aria-label="Solvers and formats" data-reveal="fade" style={d(700)}>
      <Marquee seconds={56}>
        {CAPABILITIES.map((c, i) => (
          <span key={c} className={`cap-chip ${i % 2 ? "dn" : ""}`}>{c}</span>
        ))}
      </Marquee>
      <div className="wrap caps-bar">
        <span className="muted">Or use the crate directly:</span>
        <div className="install">
          <code>cargo add separatrix</code>
          <CopyButton text="cargo add separatrix" label="" />
        </div>
      </div>
    </section>
  );
}

const PROBLEM_CARDS: { id: string; name: string; blurb: string; icon: ReactNode; tone: string }[] = [
  { id: "maxcut", name: "Max-Cut", blurb: "Split a network in two so as many links as possible cross the divide. Circuit layout, clustering, the QAOA benchmark.", icon: <IconGraph size={20} />, tone: "up" },
  { id: "partition", name: "Number partitioning", blurb: "Split a list of numbers into two piles with equal sums. Load balancing and scheduling, in miniature.", icon: <IconScale size={20} />, tone: "down" },
  { id: "mis", name: "Independent set", blurb: "Pick the largest set of nodes with no two adjacent. Frequency assignment, scheduling, Rydberg-atom benchmarks.", icon: <IconDots size={20} />, tone: "violet" },
  { id: "portfolio", name: "Portfolio selection", blurb: "Choose exactly k of 39 crypto assets on real historical covariance. Watch exact enumeration hit a wall.", icon: <IconChart size={20} />, tone: "up" },
  { id: "custom", name: "Your own QUBO", blurb: "Paste a D-Wave Q-dict, a dimod JSON, a matrix or an edge list. Solve it, verify it, export it.", icon: <IconMatrix size={20} />, tone: "down" },
];

function Problems() {
  return (
    <section className="section wrap">
      <div className="section-h">
        <h2 data-reveal>Pick a problem. Get an answer you can check.</h2>
        <p className="muted" data-reveal style={d(160)}>Every problem is turned into a QUBO, the format quantum annealers and Ising machines take, and solved on your device. Nothing is uploaded.</p>
      </div>
      <div className="problem-grid" data-spot-group data-reveal-stagger>
        {PROBLEM_CARDS.map((p) => (
          // tone-up/-down/-violet colour the icon and tint the spotlight
          <Link key={p.id} href={`/solve/${p.id}`} className={`problem-card card spot tone-${p.tone}`} data-reveal data-tilt="5">
            <span className="pc-icon">{p.icon}</span>
            <h3>{p.name}</h3>
            <p>{p.blurb}</p>
            <span className="pc-go">Solve <IconArrow size={14} /></span>
          </Link>
        ))}
      </div>
    </section>
  );
}

const STAGES = [
  "The pump is off. Every trajectory jitters around zero and no variable has a side yet.",
  "The pump passes threshold. The single resting point splits in two and each trajectory falls toward one branch.",
  "Settled. The sign of each trajectory is its bit, and those bits are the answer you can read off.",
];

/**
 * One real bSB run, scrubbed by the page scroll: the section is taller than the
 * viewport and its progress picks the frame. The point is the algorithm itself,
 * so the motion is the content. Narrow screens and reduced motion get the
 * finished frame and the same three captions.
 */
function Think() {
  const box = useRef<HTMLElement>(null);
  const client = useRef<SolverClient | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [frame, setFrame] = useState(0);
  const [p, setP] = useState(0);
  const [scrub, setScrub] = useState(false);

  useEffect(() => {
    setScrub(!prefersReducedMotion() && window.matchMedia("(min-width: 861px)").matches);
    if (!client.current) client.current = new SolverClient();
    const c = client.current;
    let alive = true;
    const { qubo } = heroInstance(21, 96, 4);
    c.trace(qubo, { variant: "bSB", steps: 1600, seed: 21, frames: 240, couplingScale: 0.5 })
      .then((t) => alive && setTrace(t))
      .catch(() => {});
    return () => { alive = false; c.cancel(); };
  }, []);

  const onProgress = useMemo(() => (v: number) => {
    setP(v);
    setFrame(Math.round(v * ((trace?.frames ?? 1) - 1)));
  }, [trace]);
  useScrollRange(box, onProgress, scrub && !!trace);
  useEffect(() => { if (trace && !scrub) { setFrame(trace.frames - 1); setP(1); } }, [trace, scrub]);

  const stage = p < 0.34 ? 0 : p < 0.72 ? 1 : 2;
  return (
    <section className={`think ${scrub ? "is-scrub" : ""}`} ref={box}>
      <div className="think-sticky">
        <div className="wrap think-grid">
          <div className="think-copy">
            <h2 data-reveal>Every variable is an oscillator.</h2>
            <p className="muted" data-reveal style={d(120)}>
              Simulated bifurcation gives each bit a position and a velocity, then ramps a pump until the landscape splits in two.
              Where a trajectory lands is the bit.
            </p>
            <ol className="think-steps" data-indicator>
              {STAGES.map((t, i) => (
                <li key={i} className={i === stage ? "is-active" : ""} aria-current={i === stage ? "step" : undefined}>{t}</li>
              ))}
            </ol>
            <p className="think-meta mono">96-node Max-Cut, ballistic SB with c₀ at half the default so the split is visible</p>
          </div>
          <div className="think-viz card">
            {trace ? (
              <BifurcationCanvas trace={trace} frame={frame} height={430} variant="hero" />
            ) : (
              <div className="think-wait skeleton" aria-hidden="true" />
            )}
            <div className="think-bar" aria-hidden="true"><i style={{ scale: `${p} 1` }} /></div>
          </div>
        </div>
      </div>
    </section>
  );
}

const FORMATS = ["dimod JSON", "D-Wave Ocean", "Qiskit Optimization", "CPLEX LP", "Rust program", "Share link"];

function Bento() {
  // Real measured medians from the committed portfolio study, lower is better.
  const solvers = WORKBENCH.solvers.filter((x) => x.id !== "exact");
  const worst = Math.max(...solvers.map((x) => x.medianGap));
  return (
    <section className="section wrap">
      <div className="bento" data-spot-group>
        <article className="bento-cell card spot b-proof" data-reveal>
          <h3>Race against the proof</h3>
          <p>
            Up to 26 variables, exact enumeration checks every possible answer, so each heuristic's result carries its
            distance from the true optimum. Past that size the page says there is no ground truth instead of pretending.
          </p>
          <div className="gapbars">
            {solvers.map((x, i) => (
              <div className="gapbar" key={x.id} style={d(i * 90)}>
                <span>{x.name}</span>
                <i aria-hidden="true"><b style={{ "--w": `${(x.medianGap / worst) * 100}%` } as CSSProperties} /></i>
                <span className="num">{x.medianGap.toFixed(3)}</span>
              </div>
            ))}
          </div>
          <span className="stat-s mono">median gap to the proven optimum over {WORKBENCH.rebalances} rebalances, measured</span>
        </article>

        <article className="bento-cell card spot tone-down b-export" data-reveal style={d(90)}>
          <h3>Take it with you</h3>
          <p>Every problem exports as the exact instance you solved, or as a link that rebuilds it.</p>
          <div className="fmt-list">
            {FORMATS.map((f) => <span key={f}>{f}</span>)}
          </div>
        </article>

        <article className="bento-cell card spot tone-violet b-local" data-reveal style={d(180)}>
          <h3><span className="b-zero num">0</span> bytes of your problem leave the tab</h3>
          <p>The solvers are the Rust crate compiled to WebAssembly, running in a worker on your own device. No account, no upload, no queue.</p>
        </article>
      </div>
    </section>
  );
}

function QuantumTeaser() {
  // A small, static SCS-style circuit sketch (illustrative only).
  const wires = 5;
  const gates = useMemo(
    () => [
      { x: 60, q: [0], k: "X" }, { x: 60, q: [1], k: "X" },
      { x: 120, q: [1, 2], k: "cry" }, { x: 170, q: [0, 1, 2], k: "ccry" }, { x: 220, q: [2, 1], k: "cx" },
      { x: 280, q: [2, 3], k: "cry" }, { x: 330, q: [1, 2, 3], k: "ccry" }, { x: 380, q: [3, 2], k: "cx" },
      { x: 440, q: [3, 4], k: "cry" }, { x: 490, q: [2, 3, 4], k: "ccry" },
    ],
    [],
  );
  const y = (q: number) => 22 + q * 30;
  // Pauses the travelling packet while the card is off screen.
  const [card, onScreen] = useInView<HTMLDivElement>({ once: false, margin: "0px", threshold: 0 });
  return (
    <section className="section wrap">
      <div className={`quantum card ${onScreen ? "q-live" : ""}`} ref={card}>
        <div className="q-copy">
          <Eyebrow icon={<IconAtom size={14} />}>Quantum</Eyebrow>
          <h2 data-reveal style={d(60)}>Dicke-state circuits, verified before you copy them.</h2>
          <p className="muted" data-reveal style={d(160)}>
            Choose n qubits and k excitations and get the Bärtschi–Eidenbenz circuit that prepares |D<sup>n</sup><sub>k</sub>⟩, simulated in your
            browser and checked amplitude by amplitude against the exact state. Copy it as OpenQASM 2/3, Qiskit, pytket or Cirq.
          </p>
          <div className="hero-cta" data-reveal style={{ marginTop: 22, ...d(260) }}>
            <Link href="/dicke" className="btn primary">Open the circuit builder <IconArrow size={16} /></Link>
            <a className="btn ghost" href={blob("docs/primitives.md")} target="_blank" rel="noopener noreferrer">Read the characterisation</a>
          </div>
        </div>
        {/* Builds itself on reveal: wires draw left to right, then each gate
            appears roughly when the wire front passes its column. */}
        <svg className="q-art" viewBox="0 0 540 160" aria-hidden="true" data-reveal="fade">
          {Array.from({ length: wires }, (_, q) => (
            <g key={q}>
              <text x="4" y={y(q) + 4} fontSize="11" fill="#56655f" fontFamily="JetBrains Mono Variable, monospace">q{q}</text>
              <path className="draw" pathLength={1} d={`M28 ${y(q)}H530`} stroke="rgba(214,236,230,.16)" style={{ "--i": q } as CSSProperties} />
            </g>
          ))}
          {/* decoration only: a glowing packet runs along q2 now and then, under the gates */}
          <g className="q-packet">
            <circle cy={y(2)} r="7" fill="rgba(63,216,192,.16)" />
            <circle cy={y(2)} r="2.6" fill="#3fd8c0" />
          </g>
          {gates.map((g, i) => {
            const qs = g.q;
            const t = qs[qs.length - 1];
            return (
              <g key={i} className="q-gate" style={d(Math.round(200 + ((g.x - 28) / 502) * 900))}>
                {qs.length > 1 && <line x1={g.x} x2={g.x} y1={y(Math.min(...qs))} y2={y(Math.max(...qs))} stroke="rgba(63,216,192,.7)" strokeWidth="1.5" />}
                {qs.slice(0, -1).map((c) => <circle key={c} cx={g.x} cy={y(c)} r="4" fill="#3fd8c0" />)}
                {g.k === "cx" ? (
                  <g><circle cx={g.x} cy={y(t)} r="9" fill="#0f161a" stroke="#3fd8c0" strokeWidth="1.5" /><path d={`M${g.x - 9} ${y(t)}h18M${g.x} ${y(t) - 9}v18`} stroke="#3fd8c0" strokeWidth="1.5" /></g>
                ) : (
                  <g>
                    <rect x={g.x - 15} y={y(t) - 11} width="30" height="22" rx="5" fill={g.k === "X" ? "#1a252b" : "rgba(242,162,92,.14)"} stroke={g.k === "X" ? "rgba(214,236,230,.3)" : "#f2a25c"} />
                    <text x={g.x} y={y(t) + 4} textAnchor="middle" fontSize="10.5" fill={g.k === "X" ? "#e9f0ee" : "#f2a25c"} fontFamily="JetBrains Mono Variable, monospace">{g.k === "X" ? "X" : "Ry"}</text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

const RUST = `use separatrix::{IsingModel, QuboModel, SbConfig, Solver};

fn main() {
    // minimise  -x0 - x1 + 2·x0·x1 - x2
    let mut qubo = QuboModel::<f64>::new(3);
    qubo.set_term(0, 0, -1.0);
    qubo.set_term(1, 1, -1.0);
    qubo.set_term(0, 1, 2.0);
    qubo.set_term(2, 2, -1.0);

    let (ising, _offset) = IsingModel::from_qubo(&qubo);
    let result = Solver::Sb(SbConfig::default()).solve(&ising).unwrap();
    println!("{:?} -> {}", result.bits(), qubo.objective(&result.bits()));
}`;

function CodeSection() {
  return (
    <section className="section wrap">
      <div className="code-split">
        <div data-reveal="left">
          <h2>The same solver, in your code.</h2>
          <p className="muted" style={{ marginTop: 12 }}>
            The Studio runs the <a className="link" href="https://crates.io/crates/separatrix" target="_blank" rel="noopener noreferrer">separatrix</a> crate compiled to WebAssembly.
            Pure Rust, no unsafe, deterministic for a given seed, and it compiles to <code>wasm32</code>. Every solver scores answers on a quantized integer
            objective, so a result can be replayed and checked bit for bit.
          </p>
          <ul className="ticks" data-reveal-stagger style={d(280)}>
            <li data-reveal="left">Ballistic and discrete simulated bifurcation (Goto et al., 2019 and 2021)</li>
            <li data-reveal="left">Simulated annealing, parallel tempering and a Gray-code exact solver</li>
            <li data-reveal="left">Property tests: no heuristic may ever report an energy below the exact ground state</li>
          </ul>
        </div>
        <div className="code-side" data-reveal="right" style={d(120)}>
          <CodeBlock code={RUST} lang="rust" filename="main.rs" />
        </div>
      </div>
    </section>
  );
}

function Honesty() {
  const stats = [
    { n: "234 / 234", l: "weekly rebalances with a proven optimum, up to 61.5M portfolios each", s: "portfolio study · measured" },
    { n: "0.031", l: "median ballistic-SB gap. Exact enumeration still wins outright at this size, and the study says so", s: "portfolio study · measured" },
    { n: "1.96×", l: "heavy-hex routing tax in two-qubit gates versus all-to-all for Dicke + XY circuits", s: "Selene sweep · measured" },
    { n: "0", l: "claims of quantum advantage. Simulated bifurcation is a classical algorithm", s: "honesty contract" },
  ];
  return (
    <section className="section wrap">
      <div className="section-h">
        <h2 data-reveal>Numbers with receipts.</h2>
        <ScrollLit className="muted" text="Every figure is labelled measured, estimated or not run, and comes with the artifact it was read from." />
      </div>
      <div className="stat-grid" data-spot-group data-reveal-stagger>
        {stats.map((s) => (
          <div key={s.n} className={`stat card spot ${s.s === "honesty contract" ? "tone-violet" : ""}`} data-reveal>
            {/* counts up to exactly s.n; screen readers only ever get s.n */}
            <div className="stat-n num"><CountUp value={s.n} /></div>
            <p>{s.l}</p>
            <span className="stat-s mono">{s.s}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 18, ...d(320) }} data-reveal>
        <Link href="/benchmarks" className="btn">See the full benchmarks <IconArrow size={15} /></Link>
      </div>
    </section>
  );
}

function StarBand() {
  return (
    <section className="section wrap">
      <div className="star-band card" data-reveal="scale">
        <div>
          <h2>Found it useful? Help others find it.</h2>
          <p className="muted">Separatrix is built in the open. A star, an issue or a pull request helps more than you'd think, and so does telling one person who works with QUBOs.</p>
        </div>
        <div className="hero-cta">
          <StarButton size="lg" />
          <a className="btn lg" href={`${REPO_URL}/issues/new/choose`} target="_blank" rel="noopener noreferrer">Open an issue</a>
          <a className="btn lg ghost" href={blob("CONTRIBUTING.md")} target="_blank" rel="noopener noreferrer">Contribute</a>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  useEffect(() => { document.title = "Separatrix Studio: quantum-inspired optimisation in your browser"; }, []);
  return (
    <>
      <Hero />
      <Capabilities />
      <Problems />
      <Think />
      <Bento />
      <QuantumTeaser />
      <CodeSection />
      <Honesty />
      <StarBand />
    </>
  );
}
