import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BifurcationCanvas, ObjectiveSpark, positionsAt, usePlayback } from "../components/Bifurcation";
import { CodeBlock, copyText } from "../components/Code";
import { SplitWords } from "../components/Motion";
import { prefersReducedMotion } from "../lib/motion";
import { GraphView, MatrixView, PartitionView, PortfolioView, bitsToState } from "../components/views";
import { IconArrow, IconChart, IconCheck, IconDice, IconDots, IconDownload, IconGraph, IconMatrix, IconPause, IconPlay, IconReplay, IconScale, IconShare, IconX } from "../components/icons";
import { binom, fmtCompact, fmtMs, fmtNum, groupDigits } from "../lib/format";
import { navigate, useLocation } from "../lib/router";
import { SITE_URL } from "../lib/site";
import { CancelledError, SOLVERS, solver, type ExactOutcome, type PortfolioReport, type Run, type SolverName, type Trace } from "../solver/client";
import { PROBLEMS, setPortfolioDataset } from "../problems";
import { decodeShare, encodeShare } from "../problems/share";
import { toDimodJson, toJson, toLp, toPythonDimod, toQiskitOptimization, toRust } from "../problems/exporters";
import type { Graph } from "../problems/graph";
import { QUBO_FORMAT_LABELS, type QuboFormat } from "../problems/custom";
import type { Interpretation, ParamSpec, Params, ProblemDef, Qubo, QuboContext } from "../problems/types";
import dataset from "../../public/data/portfolio-2026-07-31.json";
import "./solve.css";

setPortfolioDataset(dataset as Parameters<typeof setPortfolioDataset>[0]);

type Pid = ProblemDef<unknown>["id"];
const ICONS: Record<Pid, ReactNode> = {
  maxcut: <IconGraph size={16} />, partition: <IconScale size={16} />, mis: <IconDots size={16} />, portfolio: <IconChart size={16} />, custom: <IconMatrix size={16} />,
};
const SHORT: Record<Pid, string> = { maxcut: "Max-Cut", partition: "Partition", mis: "Independent set", portfolio: "Portfolio", custom: "Your QUBO" };

interface Settings {
  steps: number;
  replicas: number;
  solvers: SolverName[];
  exact: boolean;
  exactMaxN: number;
  /** portfolio only: max k-subsets exact enumeration may check */
  budget: number;
}
const DEFAULT_SETTINGS: Settings = { steps: 1000, replicas: 8, solvers: ["bSB", "dSB", "SA", "PT"], exact: true, exactMaxN: 24, budget: 70_000_000 };
const EXACT_MAX = 26;
const FRAMES = 180;

interface Row {
  solver: SolverName | "exact";
  bits: number[];
  objective: number;
  millis: number;
  interp: Interpretation;
  optimal: boolean | null;
  /** portfolio: gap / (worst − best) from the Rust report */
  gapNorm: number | null;
}

const defaultsOf = (def: ProblemDef<unknown>): Params => Object.fromEntries(def.params.map((p) => [p.key, p.default]));

function readPid(path: string): Pid {
  const id = path.split("/")[2];
  return (PROBLEMS.find((p) => p.id === id)?.id ?? "maxcut") as Pid;
}

const ctx: QuboContext = {
  async portfolioQubo(mu, sigma, k, riskAversion) {
    const q = await solver().portfolioQubo(mu, sigma, k, riskAversion);
    const terms: [number, number, number][] = q.rows.map((r, i) => [r, q.cols[i], q.vals[i]]);
    return { n: q.n, terms, offset: q.offset };
  },
};

/* ------------------------------------------------------------------ */

function ParamField({ spec, value, onChange, error }: { spec: ParamSpec; value: Params[string]; onChange: (v: Params[string]) => void; error?: string | null }) {
  if (spec.kind === "int" || spec.kind === "float") {
    const v = Number(value);
    const pct = ((v - spec.min) / (spec.max - spec.min || 1)) * 100;
    return (
      <div className="field">
        <div className="field-top"><label htmlFor={`p-${spec.key}`}>{spec.label}</label><span className="val">{spec.kind === "float" ? fmtNum(v, 3) : v}</span></div>
        <input id={`p-${spec.key}`} type="range" min={spec.min} max={spec.max} step={spec.step} value={v} style={{ ["--p" as string]: `${pct}%` }}
          onChange={(e) => onChange(spec.kind === "int" ? parseInt(e.target.value, 10) : parseFloat(e.target.value))} />
        {spec.hint && <span className="hint">{spec.hint}</span>}
      </div>
    );
  }
  if (spec.kind === "select") {
    return (
      <div className="field">
        <label htmlFor={`p-${spec.key}`}>{spec.label}</label>
        <select id={`p-${spec.key}`} className="select" value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {spec.hint && <span className="hint">{spec.hint}</span>}
      </div>
    );
  }
  if (spec.kind === "bool") {
    return (
      <div className="field">
        <label className="switch"><input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /><span className="track" />{spec.label}</label>
        {spec.hint && <span className="hint">{spec.hint}</span>}
      </div>
    );
  }
  return spec.kind === "text" ? <TextParam spec={spec} value={String(value)} onChange={onChange} error={error} /> : null;
}

/** Text params (the custom QUBO) apply on a short pause, not on every keystroke. */
function TextParam({ spec, value, onChange, error }: { spec: Extract<ParamSpec, { kind: "text" }>; value: string; onChange: (v: string) => void; error?: string | null }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChange(draft), 450);
    return () => clearTimeout(t);
  }, [draft, value, onChange]);
  // The message sits under the input it belongs to, not across the page.
  const errId = `p-${spec.key}-err`;
  return (
    <div className="field">
      <label htmlFor={`p-${spec.key}`}>{spec.label}</label>
      <textarea id={`p-${spec.key}`} className={`textarea${error ? " invalid" : ""}`} spellCheck={false} value={draft} placeholder={spec.placeholder}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined}
        onChange={(e) => setDraft(e.target.value)} rows={10} />
      {error && <p id={errId} className="field-err" role="alert"><b>Couldn't read that input.</b> {error}</p>}
      {spec.hint && <span className="hint">{spec.hint}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

const EXPORTS = [
  { id: "python", label: "D-Wave Ocean", file: "solve_dimod.py", lang: "python" as const, make: toPythonDimod },
  { id: "qiskit", label: "Qiskit", file: "solve_qiskit.py", lang: "python" as const, make: toQiskitOptimization },
  { id: "rust", label: "Rust", file: "main.rs", lang: "rust" as const, make: toRust },
  { id: "lp", label: "LP file", file: "problem.lp", lang: "lp" as const, make: toLp },
  { id: "dimod", label: "dimod JSON", file: "problem.dimod.json", lang: "json" as const, make: toDimodJson },
  { id: "json", label: "JSON", file: "problem.json", lang: "json" as const, make: toJson },
];

function ExportModal({ qubo, onClose }: { qubo: Qubo; onClose: () => void }) {
  const [tab, setTab] = useState(EXPORTS[0].id);
  const ex = EXPORTS.find((e) => e.id === tab)!;
  const code = useMemo(() => ex.make(qubo), [ex, qubo]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Export problem">
      <div className="modal card">
        <div className="card-h">
          <h3>Export this problem</h3>
          <span className="sub">{qubo.n} variables · {qubo.terms.length} terms</span>
          <span className="grow" />
          <button className="btn icon sm ghost" onClick={onClose} aria-label="Close"><IconX size={16} /></button>
        </div>
        <div className="card-b" style={{ display: "grid", gap: 14 }}>
          <div className="seg" role="tablist" style={{ flexWrap: "wrap" }}>
            {EXPORTS.map((e) => <button key={e.id} role="tab" aria-selected={tab === e.id} onClick={() => setTab(e.id)}>{e.label}</button>)}
          </div>
          <div key={tab} className="code-swap"><CodeBlock code={code} lang={ex.lang} filename={ex.file} maxHeight={420} /></div>
          <p className="hint" style={{ fontSize: 12.5 }}>
            Minimise f(x) = Σ Qᵢᵢxᵢ + Σᵢ﹤ⱼ Qᵢⱼxᵢxⱼ{qubo.offset ? ` + ${qubo.offset}` : ""} over binary x. Same coefficients the solvers on this page used.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Verdict({ pid, n, k, rows, exact, status }: { pid: Pid; n: number; k: number; rows: Row[]; exact: ExactOutcome | null; status: string }) {
  if (status === "running" && !exact) return null;
  const heur = rows.filter((r) => r.solver !== "exact");
  const ex = rows.find((r) => r.solver === "exact");
  const space = pid === "portfolio" ? `${fmtCompact(binom(n, k))} portfolios` : `2^${n} = ${fmtCompact(Math.pow(2, n))} states`;
  if (ex) {
    const winners = heur.filter((r) => r.optimal).map((r) => r.solver);
    const fastest = heur.reduce<Row | null>((a, b) => (!a || b.millis < a.millis ? b : a), null);
    const exactFaster = fastest ? ex.millis < fastest.millis : false;
    return (
      <div className="verdict">
        <IconCheck size={16} />
        <p>
          Exact enumeration checked <b>{space}</b> in <b>{fmtMs(ex.millis)}</b> and proved the optimum.{" "}
          {winners.length ? <>{winners.join(", ")} found it too. </> : <>No heuristic matched it this time. </>}
          {exactFaster
            ? <>Exact was faster than every heuristic, so at this size it's simply the right tool. Make the problem bigger to see where that stops.</>
            : fastest && fastest.optimal
              ? <>{fastest.solver} got there about {Math.max(1, Math.round(ex.millis / Math.max(fastest.millis, 0.01)))}× faster.</>
              : <>Exact is still affordable here, so the heuristics are competing against a known answer.</>}
        </p>
      </div>
    );
  }
  if (exact?.exactSkipped || (exact && !exact.exact)) {
    return (
      <div className="verdict wall">
        <span className="wall-i">∞</span>
        <p><b>No ground truth here.</b> {space} is past the exact limit{exact.exactReason ? ` (${exact.exactReason.replace(/\.$/, "")})` : ""}. The heuristics can only be compared with each other. This is the regime they exist for, and the one where honest benchmarks stop quoting optimality gaps.</p>
      </div>
    );
  }
  return null;
}

function Results({ rows, pending, exactPending, running, selected, onSelect, best }: { rows: Row[]; pending: string[]; exactPending: boolean; running: string[]; selected: string | null; onSelect: (s: string) => void; best: Row | null }) {
  const ex = rows.find((r) => r.solver === "exact");
  const sorted = [...rows].sort((a, b) => {
    if (a.solver === "exact") return -1;
    if (b.solver === "exact") return 1;
    if (a.interp.feasible !== b.interp.feasible) return a.interp.feasible ? -1 : 1;
    const d = a.interp.better === "higher" ? b.interp.score - a.interp.score : a.interp.score - b.interp.score;
    return d || a.millis - b.millis;
  });
  // [key, pill]: the key changes whenever the verdict does, so the pill pops
  // exactly when its information arrives (e.g. "optimal" once exact lands).
  const quality = (r: Row): [string, ReactNode] => {
    if (r.solver === "exact") return ["proof", <span className="pill up"><IconCheck size={12} /> proof</span>];
    if (!r.interp.feasible) return ["infeasible", <span className="pill bad">infeasible</span>];
    if (r.optimal) return ["optimal", <span className="pill up"><IconCheck size={12} /> optimal</span>];
    if (r.gapNorm !== null) { const t = `${(r.gapNorm * 100).toFixed(1)}% off`; return [t, <span className="pill down">{t}</span>]; }
    if (ex) {
      const a = r.interp.score, o = ex.interp.score;
      if (r.interp.better === "higher" && o > 0) { const t = `${((a / o) * 100).toFixed(1)}% of opt.`; return [t, <span className="pill down">{t}</span>]; }
      const t = `Δ ${fmtNum(Math.abs(a - o), 4)}`;
      return [t, <span className="pill down">{t}</span>];
    }
    return best && r === best ? ["best", <span className="pill">best found</span>] : ["none", <span className="muted" aria-label="no verdict yet">-</span>];
  };
  const name = (s: string) => (s === "exact" ? "Exact" : s);

  // Rows that arrive together (the portfolio report has every heuristic at
  // once) enter one after another. Each row keeps the slot it got on arrival,
  // so the per-frame re-renders of a replay never shift a delay mid-entrance.
  const [slot, setSlot] = useState<Record<string, number>>({});
  const fresh = sorted.filter((r) => !(r.solver in slot));
  if (!rows.length && Object.keys(slot).length) setSlot({});
  else if (fresh.length) setSlot({ ...slot, ...Object.fromEntries(fresh.map((r, j) => [r.solver, j])) });

  // A row that changes place (a better result or the proof lands above it)
  // glides to its new slot instead of jumping. Measured only when the order
  // changes, never on replay frames.
  const box = useRef<HTMLDivElement>(null);
  const tops = useRef(new Map<string, number>());
  const order = sorted.map((r) => r.solver).join();
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const still = prefersReducedMotion();
    box.current?.querySelectorAll<HTMLElement>(":scope > [data-k]").forEach((el) => {
      const k = el.dataset.k!, top = el.offsetTop, was = tops.current.get(k);
      next.set(k, top);
      if (!still && was !== undefined && was !== top) el.animate([{ translate: `0 ${was - top}px` }, { translate: "0 0" }], { duration: 240, easing: "cubic-bezier(0.2, 0, 0.38, 0.9)" });
    });
    tops.current = next;
  }, [order, pending.length, exactPending]);

  // The selected row's highlight is the data-indicator pill, so it slides to
  // whichever row is shown (including when a new best arrives).
  return (
    <div className="results" ref={box} data-indicator>
      <div className="rhead"><span>Solver</span><span>Result</span><span>Quality</span><span>Time</span></div>
      {sorted.map((r) => {
        const [qk, q] = quality(r);
        const sel = selected === r.solver;
        return (
          <button key={r.solver} data-k={r.solver} className={`rrow enter ${sel ? "sel is-active" : ""} ${r.solver === "exact" ? "exact" : ""}`} style={{ "--i": slot[r.solver] ?? 0 } as CSSProperties}
            onClick={() => onSelect(r.solver)} title={SOLVERS.find((s) => s.id === r.solver)?.blurb ?? "Exhaustive enumeration: the proven optimum."}>
            <span className="rname">{name(r.solver)}</span>
            <span className="rres">{r.interp.summary}</span>
            <span className="rq" key={qk}>{q}</span>
            <span className="num rtime">{fmtMs(r.millis)}</span>
          </button>
        );
      })}
      {/* Solvers run one at a time: only the one the worker is on shimmers, the rest wait. */}
      {pending.map((s) => (
        <div key={s} className={`rrow ghost ${running.includes(s) ? "run" : "queued"}`}><span className="rname">{s}</span><span className="skeleton" style={{ height: 10, width: "70%" }} /><span /><span className="spinner" /></div>
      ))}
      {exactPending && (
        <div className={`rrow ghost exact ${running.includes("exact") ? "run" : "queued"}`}><span className="rname">Exact</span><span className="muted" style={{ fontSize: 12.5 }}>enumerating every candidate…</span><span /><span className="spinner" /></div>
      )}
    </div>
  );
}

/**
 * What the race looks like before the first row lands: the same table, the same
 * four columns, one placeholder line per solver that is about to run. A grey
 * slab here would hide the shape the content is about to take.
 */
function ResultsSkeleton({ solvers, exact }: { solvers: SolverName[]; exact: boolean }) {
  const names: string[] = exact ? [...solvers, "exact"] : [...solvers];
  return (
    <div className="results" aria-hidden="true">
      <div className="rhead"><span>Solver</span><span>Result</span><span>Quality</span><span>Time</span></div>
      {names.map((s) => (
        <div key={s} className="rrow ghost queued">
          <span className="rname">{s === "exact" ? "Exact" : s}</span>
          <span className="skeleton" style={{ height: 10, width: "70%" }} />
          <span className="skeleton" style={{ height: 14, width: 52, borderRadius: 99 }} />
          <span className="skeleton" style={{ height: 10, width: 38, justifySelf: "end" }} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Solve() {
  const { path, search } = useLocation();
  const pid = readPid(path);
  const def = PROBLEMS.find((p) => p.id === pid)! as ProblemDef<unknown>;

  const [paramsBy, setParamsBy] = useState<Record<string, Params>>(() => Object.fromEntries(PROBLEMS.map((p) => [p.id, defaultsOf(p as ProblemDef<unknown>)])));
  const [seedBy, setSeedBy] = useState<Record<string, number>>(() => Object.fromEntries(PROBLEMS.map((p) => [p.id, 1])));
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [hydrated, setHydrated] = useState(!new URLSearchParams(search).get("s"));

  const params = paramsBy[pid];
  const seed = seedBy[pid];

  // Which way the problem tabs moved, so the next problem slides in from that side.
  const [tabMove, setTabMove] = useState({ pid, dx: 0 });
  const swap = (delay = 0) => ({ "--sx": `${tabMove.dx * 14}px`, "--sy": tabMove.dx ? "0px" : "10px", "--swap-d": `${delay}ms` }) as CSSProperties;

  useEffect(() => { document.title = `${def.name} solver · Separatrix Studio`; }, [def]);
  useEffect(() => solver().onReady((ok, err) => { setReady(ok); setLoadErr(ok ? null : err ?? null); }), []);
  useEffect(() => { if (path === "/solve") navigate("/solve/maxcut", { replace: true, keepScroll: true }); }, [path]);

  // restore a shared link once
  useEffect(() => {
    const s = new URLSearchParams(search).get("s");
    if (!s) return;
    decodeShare<{ v: number; p: Pid; params: Params; seed: number; st?: Partial<Settings> }>(s)
      .then((d) => {
        if (d && PROBLEMS.some((p) => p.id === d.p)) {
          setParamsBy((all) => ({ ...all, [d.p]: { ...all[d.p], ...d.params } }));
          setSeedBy((all) => ({ ...all, [d.p]: d.seed }));
          if (d.st) setSettings((st) => ({ ...st, ...d.st }));
          navigate(`/solve/${d.p}`, { replace: true, keepScroll: true });
        }
      })
      .catch(() => setToast("That share link couldn't be read."))
      .finally(() => setHydrated(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const built = useMemo(() => {
    try {
      return { instance: def.generate(params, seed) as unknown, error: null as string | null };
    } catch (e) {
      return { instance: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [def, params, seed]);

  /* ---------------- run state ---------------- */
  const [qubo, setQubo] = useState<Qubo | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [exact, setExact] = useState<ExactOutcome | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [runError, setRunError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"replay" | "solution">("solution");
  /** 1 = exactly the dynamics the race's bSB ran (replica 0); 0.5 = slow motion. */
  const [traceScale, setTraceScale] = useState<1 | 0.5>(1);
  const traceScaleRef = useRef(traceScale);
  traceScaleRef.current = traceScale;
  const runSeq = useRef(0);
  const [lastRun, setLastRun] = useState<{ n: number; k: number; exactOn: boolean; solvers: SolverName[] }>({ n: 0, k: 0, exactOn: true, solvers: [] });

  // On a problem switch, drop the previous problem's results in the same
  // render (the run effect would, one commit later) so the new picture never
  // starts from, and eases out of, another problem's answer.
  if (tabMove.pid !== pid) {
    setTabMove({ pid, dx: Math.sign(PROBLEMS.findIndex((p) => p.id === pid) - PROBLEMS.findIndex((p) => p.id === tabMove.pid)) });
    setRows([]); setExact(null); setTrace(null); setSelected(null);
  }

  const interpret = useCallback((bits: ArrayLike<number>) => def.interpret(built.instance, bits), [def, built.instance]);

  useEffect(() => {
    if (!hydrated || !built.instance) {
      // An unreadable input has no results: keeping the last problem's race on
      // screen next to "nothing to draw" would be two panels contradicting.
      if (built.error) {
        runSeq.current++;
        solver().cancel();
        setStatus("error"); setRunError(null);
        setQubo(null); setRows([]); setExact(null); setTrace(null); setSelected(null);
      }
      return;
    }
    const id = ++runSeq.current;
    const client = solver();
    client.cancel();
    setStatus("running");
    setRunError(null);
    setRows([]);
    setExact(null);
    setTrace(null);
    setSelected(null);
    const live = () => id === runSeq.current;

    const t = setTimeout(async () => {
      try {
        const q = await def.toQubo(built.instance, ctx);
        if (!live()) return;
        setQubo(q);
        const instance = built.instance as { k?: number; mu?: number[]; sigma?: number[]; riskAversion?: number };
        const traceOpts = { variant: "bSB" as const, steps: settings.steps, seed, frames: FRAMES, couplingScale: traceScaleRef.current };
        // Only promise an exact row when exact can actually run at this size:
        // otherwise the race said "enumerating every candidate" for a problem
        // the worker was always going to skip.
        const exactRuns = settings.exact && (pid === "portfolio"
          ? binom(q.n, instance.k ?? 0) <= settings.budget
          : q.n <= Math.min(settings.exactMaxN, EXACT_MAX));
        setLastRun({ n: q.n, k: instance.k ?? 0, exactOn: exactRuns, solvers: settings.solvers });

        if (pid === "portfolio") {
          const tr = await client.trace(q, traceOpts);
          if (!live()) return;
          setTrace(tr);
          const base = { mu: instance.mu!, sigma: instance.sigma!, k: instance.k!, riskAversion: instance.riskAversion!, seed, steps: settings.steps };
          const toRows = (rep: PortfolioReport): Row[] => {
            const bitsOf = (sel: number[]) => { const b = new Array(q.n).fill(0); sel.forEach((i) => (b[i] = 1)); return b; };
            const out: Row[] = rep.results
              .filter((r) => settings.solvers.includes(r.solver))
              // Without an exact pass the report's Option fields come through as undefined, not null.
              .map((r) => { const bits = bitsOf(r.selection); return { solver: r.solver, bits, objective: Number(r.objective_int), millis: r.millis, interp: interpret(bits), optimal: r.is_optimal ?? null, gapNorm: r.gap_norm ?? null }; });
            if (rep.exact) {
              const bits = bitsOf(rep.exact.selection);
              out.push({ solver: "exact", bits, objective: Number(rep.exact.objective_int), millis: rep.exact.millis, interp: interpret(bits), optimal: true, gapNorm: 0 });
            }
            return out;
          };
          const quick = await client.solvePortfolio({ ...base, maxSubsets: 0 });
          if (!live()) return;
          setRows(toRows(quick));
          if (settings.exact) {
            const full = await client.solvePortfolio({ ...base, maxSubsets: settings.budget });
            if (!live()) return;
            setRows(toRows(full));
            setExact({
              exact: full.exact ? { bits: [], objective: Number(full.exact.objective_int), millis: full.exact.millis, states: full.exact.subsets } : null,
              exactSkipped: full.exact_skipped,
              exactReason: full.exact_skipped ? `C(${q.n}, ${instance.k}) = ${groupDigits(full.subsets)} exceeds the ${fmtCompact(settings.budget)} budget` : null,
            });
          }
        } else {
          const exactRef: { v: number | null } = { v: null };
          const mk = (r: Run | { solver: "exact"; bits: number[]; objective: number; millis: number }): Row => ({
            solver: r.solver, bits: r.bits, objective: r.objective, millis: r.millis, interp: interpret(r.bits),
            optimal: r.solver === "exact" ? true : exactRef.v === null ? null : Math.abs(r.objective - exactRef.v) <= 1e-9 * Math.max(1, Math.abs(exactRef.v)),
            gapNorm: null,
          });
          await client.solve(q, { seed, steps: settings.steps, replicas: settings.replicas, solvers: settings.solvers, exact: settings.exact, exactMaxN: settings.exactMaxN }, traceOpts, (ev) => {
            if (!live()) return;
            if (ev.type === "trace") setTrace(ev.data);
            else if (ev.type === "run") setRows((rs) => [...rs.filter((x) => x.solver !== ev.data.solver), mk(ev.data)]);
            else if (ev.type === "exact") {
              setExact(ev.data);
              if (ev.data.exact) {
                const e = ev.data.exact;
                exactRef.v = e.objective;
                setRows((rs) => [...rs.map((r) => ({ ...r, optimal: Math.abs(r.objective - e.objective) <= 1e-9 * Math.max(1, Math.abs(e.objective)) })), mk({ solver: "exact", ...e })]);
              }
            }
          });
        }
        if (live()) setStatus("done");
      } catch (e) {
        if (e instanceof CancelledError || !live()) return;
        setStatus("error");
        setRunError(e instanceof Error ? e.message : String(e));
      }
    }, 200);
    return () => clearTimeout(t);
  }, [built, def, pid, seed, settings, nonce, hydrated, interpret]);

  // Changing the replay's coupling re-runs only the trace, not the race.
  const firstScale = useRef(true);
  useEffect(() => {
    if (firstScale.current) { firstScale.current = false; return; }
    if (!qubo || status === "running") return;
    let alive = true;
    solver().trace(qubo, { variant: "bSB", steps: settings.steps, seed, frames: FRAMES, couplingScale: traceScale })
      .then((t) => alive && setTrace(t))
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceScale]);

  const pb = usePlayback(trace?.frames ?? 0, 2600, trace);
  useEffect(() => { if (trace) setView("replay"); }, [trace]);
  useEffect(() => {
    if (trace && !pb.playing && pb.frame >= trace.frames - 1 - 1e-6 && view === "replay") {
      const t = setTimeout(() => setView("solution"), 450);
      return () => clearTimeout(t);
    }
  }, [pb.playing, pb.frame, trace, view]);

  const best = useMemo(() => {
    const ex = rows.find((r) => r.solver === "exact");
    if (ex) return ex;
    const feas = rows.filter((r) => r.interp.feasible);
    const pool = feas.length ? feas : rows;
    return pool.reduce<Row | null>((a, b) => {
      if (!a) return b;
      const better = b.interp.better === "higher" ? b.interp.score > a.interp.score : b.interp.score < a.interp.score;
      return better ? b : a;
    }, null);
  }, [rows]);
  const shown = rows.find((r) => r.solver === selected) ?? best;

  const state: Float32Array | null = useMemo(() => {
    if (view === "replay" && trace) return positionsAt(trace, pb.frame);
    if (shown) return bitsToState(shown.bits);
    return null;
  }, [view, trace, pb.frame, shown]);

  const pending = status === "running" ? lastRun.solvers.filter((s) => !rows.some((r) => r.solver === s)) : [];
  const exactPending = status === "running" && lastRun.exactOn && !exact && (pid !== "portfolio" || rows.length > 0 || pending.length === 0);
  // What the worker is computing right now. It does the trace first, then one
  // solver at a time in order, then exact; the portfolio path runs every
  // heuristic in one call, then the exact pass.
  const running: string[] = status !== "running" || !trace ? []
    : pid === "portfolio" ? (rows.length === 0 ? pending : exactPending ? ["exact"] : [])
    : pending.length ? [pending[0]] : exactPending ? ["exact"] : [];
  const replaying = view === "replay" && !!trace;

  /* ---------------- actions ---------------- */
  const setParam = useCallback((key: string, v: Params[string]) => setParamsBy((all) => ({ ...all, [pid]: { ...all[pid], [key]: v } })), [pid]);
  const reseed = () => setSeedBy((all) => ({ ...all, [pid]: Math.floor(Math.random() * 1e6) + 1 }));
  const share = async () => {
    const code = await encodeShare({ v: 1, p: pid, params, seed, st: settings });
    const url = `${window.location.origin || SITE_URL}/solve/${pid}?s=${code}`;
    setToast((await copyText(url)) ? "Link copied. Anyone who opens it gets this exact problem." : url);
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); setNonce((x) => x + 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------------- rendering ---------------- */
  const instance = built.instance as Record<string, unknown> | null;
  const n = qubo?.n ?? 0;
  const k = (instance?.k as number | undefined) ?? 0;
  const exactCost = pid === "portfolio" ? binom(n, k) : Math.pow(2, n);
  const exactWillRun = pid === "portfolio" ? exactCost <= settings.budget : n <= Math.min(settings.exactMaxN, EXACT_MAX);

  // The input that can carry a parse error (the custom QUBO) shows it under the
  // field; a problem without one has nowhere else to put it, so it stays here.
  const inlineError = def.params.some((p) => p.kind === "text");
  let picture: ReactNode = <div className={`viz-empty skeleton${pid === "custom" ? " square" : ""}`} />;
  if (instance) {
    if (pid === "maxcut") picture = <GraphView graph={instance.graph as Graph} state={state} mode="cut" smooth={!replaying} />;
    else if (pid === "mis") picture = <GraphView graph={instance.graph as Graph} state={state} mode="mis" smooth={!replaying} />;
    else if (pid === "partition") picture = <PartitionView numbers={instance.numbers as number[]} state={state} />;
    else if (pid === "portfolio") picture = <PortfolioView tickers={instance.tickers as string[]} mu={instance.mu as number[]} sigma={instance.sigma as number[]} state={state} />;
    else if (pid === "custom" && qubo) picture = <MatrixView n={qubo.n} terms={qubo.terms} labels={qubo.labels} state={state} />;
  }
  const vizTitle = replaying ? "Replay: the oscillators deciding" : shown ? `Solution: ${shown.solver === "exact" ? "proven optimum" : shown.solver}` : "Problem";
  const isRunning = status === "running";

  return (
    <div className="solve wrap">
      <header className="solve-top">
        <div>
          <h1><SplitWords text="Solver" /></h1>
          <p className="muted" data-reveal style={{ "--d": "90ms" } as CSSProperties}>Pick a problem, adjust it, and watch four solvers race the proven optimum. Everything runs on your device.</p>
        </div>
        {/* keyed so each real state change (loaded, solving, done) swaps in visibly.
            Only the two states where something is actually happening carry motion;
            the idle one is a plain label. */}
        <div className="solve-status" data-reveal="fade" style={{ "--d": "220ms" } as CSSProperties}>
          {loadErr ? <span key="err" className="pill bad wrap" role="alert">{loadErr}</span>
            : !ready ? <span key="load" className="pill"><span className="spinner" style={{ width: 10, height: 10 }} /> loading solver</span>
            : status === "running" ? <span key="run" className="pill up"><span className="spinner" style={{ width: 10, height: 10, borderTopColor: "var(--up)" }} /> solving</span>
            : <span key="ready" className="pill">WebAssembly ready</span>}
        </div>
      </header>

      <nav className="ptabs" aria-label="Problem type" data-indicator data-reveal style={{ "--d": "150ms" } as CSSProperties}>
        {PROBLEMS.map((p) => (
          <button key={p.id} aria-pressed={p.id === pid} onClick={() => navigate(`/solve/${p.id}`, { keepScroll: true })}>
            {ICONS[p.id as Pid]} <span>{SHORT[p.id as Pid]}</span>
          </button>
        ))}
      </nav>

      <div className="solve-grid">
        <aside className="side">
          <div className="card swap" key={pid} style={swap()}>
            <div className="card-b side-about">
              <h2>{def.name}</h2>
              <p>{def.description}</p>
              {def.presets.length > 0 && (
                <div className="chips" style={{ marginTop: 12 }}>
                  {def.presets.map((pr) => (
                    <button key={pr.label} className="chip" onClick={() => { setParamsBy((all) => ({ ...all, [pid]: { ...defaultsOf(def), ...pr.params } })); setSeedBy((all) => ({ ...all, [pid]: pr.seed })); }}>
                      {pr.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <hr className="divider" />
            <div className="card-b side-params">
              {def.params.map((spec) => (
                <ParamField key={spec.key} spec={spec} value={params[spec.key]} onChange={(v) => setParam(spec.key, v)} error={spec.kind === "text" ? built.error : null} />
              ))}
              {def.params.some((p) => p.kind !== "text") && (
                <div className="seed-row">
                  <span className="label">Instance seed <span className="num muted">#{seed}</span></span>
                  <button className="btn sm act-dice" onClick={reseed}><IconDice size={14} /> New instance</button>
                </div>
              )}
            </div>
            <hr className="divider" />
            <div className="card-b">
              <button className="settings-toggle" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings} aria-controls="solver-settings">
                <span>Solver settings</span><span className="muted mono" style={{ fontSize: 12 }}>{settings.steps} steps · {settings.replicas} replicas <span className="caret" aria-hidden="true">▾</span></span>
              </button>
              {/* Always mounted so it can open and close smoothly; inert while closed. */}
              <div id="solver-settings" className={`collapse ${showSettings ? "open" : ""}`} inert={!showSettings}>
                <div className="collapse-in">
                  <div className="side-params" style={{ marginTop: 14 }}>
                    <div className="field">
                      <span className="label">Solvers</span>
                      <div className="chips">
                        {SOLVERS.map((s) => {
                          const on = settings.solvers.includes(s.id);
                          return (
                            <button key={s.id} className="chip" aria-pressed={on} title={s.blurb}
                              onClick={() => setSettings((st) => ({ ...st, solvers: on ? st.solvers.filter((x) => x !== s.id) : SOLVERS.map((x) => x.id).filter((x) => x === s.id || st.solvers.includes(x)) }))}>
                              {s.id}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <ParamField spec={{ key: "steps", label: "Steps / sweeps", kind: "int", min: 100, max: 5000, step: 100, default: 1000, hint: "SB integration steps; SA and PT sweeps." }} value={settings.steps} onChange={(v) => setSettings((s) => ({ ...s, steps: Number(v) }))} />
                    <ParamField spec={{ key: "replicas", label: "Replicas / restarts", kind: "int", min: 1, max: 32, step: 1, default: 8, hint: "Independent runs per solver; the best one counts." }} value={settings.replicas} onChange={(v) => setSettings((s) => ({ ...s, replicas: Number(v) }))} />
                    <div className="field">
                      <label className="switch"><input type="checkbox" checked={settings.exact} onChange={(e) => setSettings((s) => ({ ...s, exact: e.target.checked }))} /><span className="track" />Exact ground truth</label>
                    </div>
                    {settings.exact && pid !== "portfolio" && (
                      <ParamField spec={{ key: "exactMaxN", label: "Exact limit (variables)", kind: "int", min: 12, max: EXACT_MAX, step: 1, default: 24, hint: `Every extra variable doubles the work. 2^${settings.exactMaxN} = ${fmtCompact(Math.pow(2, settings.exactMaxN))} states.` }} value={settings.exactMaxN} onChange={(v) => setSettings((s) => ({ ...s, exactMaxN: Number(v) }))} />
                    )}
                    {settings.exact && pid === "portfolio" && (
                      <div className="field">
                        <label htmlFor="budget">Exact budget (portfolios checked)</label>
                        <select id="budget" className="select" value={settings.budget} onChange={(e) => setSettings((s) => ({ ...s, budget: Number(e.target.value) }))}>
                          {[1e5, 1e6, 1e7, 7e7].map((b) => <option key={b} value={b}>{fmtCompact(b)}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <section className="main-col swap" key={pid} style={swap(60)}>
          <div className="card viz-card">
            <div className="card-h">
              <h3 key={vizTitle} className="swap-t">{vizTitle}</h3>
              <span className="grow" />
              <div className="seg" aria-label="View">
                <button aria-pressed={view === "solution"} onClick={() => { pb.stop(); setView("solution"); }}>Solution</button>
                <button aria-pressed={view === "replay"} disabled={!trace} onClick={() => { setView("replay"); pb.play(0); }}>Replay</button>
              </div>
            </div>
            {/* is-replay: the pictures follow the replay frame-exactly; outside it a new answer blends in */}
            <div className={`card-b viz-body ${replaying ? "is-replay" : ""}`}>
              {!built.error ? picture : inlineError ? (
                <div className="viz-none">
                  <IconMatrix size={22} />
                  <p><b>Nothing to draw.</b></p>
                  <p>The input could not be read. The message under the {def.params.find((p) => p.kind === "text")!.label} field says where.</p>
                </div>
              ) : (
                <div className="parse-err"><b>Couldn't read that input.</b><pre>{built.error}</pre></div>
              )}
            </div>
            <div className="viz-foot">
              <div className="chips-row mono">
                {typeof instance?.notice === "string" && <span className="down">{instance.notice}</span>}
                {pid === "custom" && typeof instance?.format === "string" && <span key={instance.format} className="up swap-t">read as {QUBO_FORMAT_LABELS[instance.format as QuboFormat] ?? instance.format}</span>}
                {qubo && <span>{qubo.n} variables</span>}
                {qubo && <span>{groupDigits(qubo.terms.length)} QUBO terms</span>}
                {qubo && settings.exact && <span className={exactWillRun ? "up" : "down"}>{exactWillRun ? "exact: will prove optimum" : "exact: out of reach"} · {pid === "portfolio" ? `C(${n},${k})` : `2^${n}`} = {fmtCompact(exactCost)}</span>}
              </div>
              <div className="actions">
                <button className="btn sm act-share" onClick={share} disabled={!built.instance}><IconShare size={14} /> Share</button>
                <button className="btn sm act-export" onClick={() => setExporting(true)} disabled={!qubo}><IconDownload size={14} /> Export</button>
                {/* Both labels share one grid cell, so the button keeps its width (and the
                    buttons beside it stay put) while the label rolls between them. */}
                <button className={`btn sm primary solve-btn ${isRunning ? "is-running" : ""}`} data-magnetic="4" onClick={() => setNonce((x) => x + 1)} disabled={!built.instance}>
                  <span className="solve-lbl">
                    <span className="lbl-idle" aria-hidden={isRunning}>Solve again</span>
                    <span className="lbl-run" aria-hidden={!isRunning}><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#03201b" }} /> Solving</span>
                  </span>
                  <span className="kbd" aria-hidden={isRunning}>⌘↵</span>
                </button>
              </div>
            </div>
          </div>

          <div className="two">
            {/* No card-level busy effect: the row the worker is on shimmers and
                spins, which says the same thing about the right row. */}
            <div className="card race">
              <div className="card-h"><h3>Race</h3><span className="sub">click a row to show its answer</span></div>
              <div className="card-b" style={{ display: "grid", gap: 12 }}>
                {runError && <div className="parse-err"><b>The solver stopped.</b><pre>{runError}</pre></div>}
                {(rows.length > 0 || pending.length > 0) ? (
                  <Results rows={rows} pending={pending} exactPending={exactPending} running={running} selected={shown?.solver ?? null} onSelect={(s) => { pb.stop(); setSelected(s); setView("solution"); }} best={best} />
                ) : built.error ? (
                  <p className="empty-note">No results yet. The race runs again as soon as the input reads cleanly.</p>
                ) : <ResultsSkeleton solvers={settings.solvers} exact={settings.exact} />}
                <Verdict pid={pid} n={lastRun.n} k={lastRun.k} rows={rows} exact={exact} status={status} />
                {/* keyed by the answer shown, and each value by itself, so a new answer visibly lands */}
                {shown && (
                  <div className="metrics" key={shown.solver}>
                    {shown.interp.metrics.map((m, i) => (
                      <div key={m.label} className={`metric ${m.tone ?? ""}`} style={{ "--i": i } as CSSProperties}><span>{m.label}</span><b key={m.value} className="num">{m.value}</b></div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="card bif">
              <div className="card-h">
                <h3>Bifurcation</h3>
                <span className="grow" />
                <div className="seg" aria-label="Coupling used for the replay">
                  <button aria-pressed={traceScale === 1} title="Exactly the dynamics the race's bSB run used (replica 0)" onClick={() => setTraceScale(1)}>as solved</button>
                  <button aria-pressed={traceScale === 0.5} title="Half the default coupling c0: the bifurcation happens later and is easier to see" onClick={() => setTraceScale(0.5)}>slow motion</button>
                </div>
                {trace && (
                  <div style={{ display: "flex", gap: 4 }}>
                    <button className="btn icon sm ghost act-play" aria-label={pb.playing ? "Pause" : "Play"} onClick={() => { if (pb.playing) pb.stop(); else { setView("replay"); pb.play(pb.frame >= trace.frames - 1 ? 0 : pb.frame); } }}>
                      {pb.playing ? <IconPause key="pause" size={14} /> : <IconPlay key="play" size={14} />}
                    </button>
                    <button className="btn icon sm ghost act-replay" aria-label="Replay from start" onClick={() => { setView("replay"); pb.play(0); }}><IconReplay size={14} /></button>
                  </div>
                )}
              </div>
              <div className="card-b" style={{ display: "grid", gap: 8 }}>
                {/* the axes are drawn even with no trace, so the empty state is a
                    line of type inside the plot rather than a blank panel */}
                <div className="bif-plot">
                  <BifurcationCanvas trace={trace} frame={view === "replay" ? pb.frame : (trace?.frames ?? 1) - 1} height={220} />
                  {!trace && (
                    <p className="bif-empty">{built.error ? "No run to replay while the input is unreadable." : isRunning ? "Tracing the run…" : "The replay appears once a run finishes."}</p>
                  )}
                </div>
                <ObjectiveSpark trace={trace} frame={view === "replay" ? pb.frame : (trace?.frames ?? 1) - 1} optimum={exact?.exact ? exact.exact.objective : null} />
                {trace && (
                  <input type="range" aria-label="Scrub through the run" min={0} max={trace.frames - 1} step={0.01}
                    value={view === "replay" ? pb.frame : trace.frames - 1}
                    style={{ ["--p" as string]: `${((view === "replay" ? pb.frame : trace.frames - 1) / (trace.frames - 1)) * 100}%` }}
                    onChange={(e) => { setView("replay"); pb.seek(parseFloat(e.target.value)); }} />
                )}
                <p className="hint" style={{ fontSize: 12 }}>
                  {trace && (traceScale === 1 ? <>One bSB replica, seed {seed}, the same dynamics the race ran. </> : <>One bSB replica at half the default coupling c₀, so the split happens later. Not the run the race scored. </>)}
                  Each line is one variable's oscillator. As the pump ramps it crosses the dashed separatrix and settles at +1 (bit 1, teal) or −1 (bit 0, amber).{trace ? " Scrub to watch the picture above make up its mind." : ""}
                </p>
              </div>
            </div>
          </div>

          <div className="cta-strip card spot">
            <div>
              <b>Want this in your own pipeline?</b>
              <span className="muted"> Export the QUBO, or use the Rust crate the page runs on.</span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn sm" onClick={() => setExporting(true)} disabled={!qubo}>Export code</button>
              <a className="btn sm" href="https://crates.io/crates/separatrix" target="_blank" rel="noopener noreferrer">cargo add separatrix <IconArrow size={13} /></a>
            </div>
          </div>
        </section>
      </div>

      {exporting && qubo && <ExportModal qubo={qubo} onClose={() => setExporting(false)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
