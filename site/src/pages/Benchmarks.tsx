import { useEffect, useId, useState, type CSSProperties } from "react";
import { CodeBlock } from "../components/Code";
import { IconExternal } from "../components/icons";
import { CountUp, SplitWords } from "../components/Motion";
import { Link } from "../lib/router";
import { blob } from "../lib/site";
import { ONCHAIN, QAOA, ROUTING, WORKBENCH } from "../data/benchmarks";
import "./pages.css";

const TONE: Record<string, string> = { exact: "#e9f0ee", bSB: "#3fd8c0", dSB: "#7fb8ad", SA: "#f2a25c", PT: "#a594f9" };

/** Custom properties for stagger timings (React passes them through untouched). */
const cssVars = (o: Record<string, string | number>) => o as CSSProperties;

/**
 * Charts are drawn landscape on wide screens and close to square on phones.
 * A chart's type is measured in user units, so one viewBox for both would
 * either be unreadable on a phone or oversized on a desktop.
 */
const WIDE = "(min-width: 900px)";
function useWide() {
  const [wide, setWide] = useState(() => typeof window === "undefined" || window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide;
}

function Source({ path, label }: { path: string; label?: string }) {
  return (
    <a className="source" href={blob(path)} target="_blank" rel="noopener noreferrer">
      {label ?? path} <IconExternal size={12} />
    </a>
  );
}

/**
 * The line under a section headline: how the numbers were produced, then the
 * committed artifact they were copied from. This is where the honesty label
 * lives now, so no section needs an eyebrow to carry it.
 */
function Meta({ status, path, label }: { status: string; path: string; label: string }) {
  return (
    <p className="meta">
      <span className="status">{status}</span>
      <Source path={path} label={label} />
    </p>
  );
}

/**
 * Speed (log x) vs quality (median gap, y) for the five solvers. On first view
 * the grid draws in, then the points land one by one; the hovered solver is
 * shared with the table below so either one highlights the other.
 */
function SpeedQuality({ wide, hover, setHover }: { wide: boolean; hover: string | null; setHover: (id: string | null) => void }) {
  const W = wide ? 980 : 400, H = wide ? 280 : 330;
  const L = wide ? 66 : 54, R = wide ? 26 : 16, T = 20, B = wide ? 42 : 40;
  const xs = (ms: number) => L + ((Math.log10(ms) - Math.log10(1)) / (Math.log10(500) - Math.log10(1))) * (W - L - R);
  const ys = (g: number) => T + (g / 0.35) * (H - T - B);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart bench-chart" data-reveal="fade" role="img" aria-label="Median optimality gap against mean runtime per solver">
      {[0, 0.1, 0.2, 0.3].map((g, i) => (
        <g key={g} style={cssVars({ "--i": i })}>
          <path d={`M${L} ${ys(g)}H${W - R}`} pathLength={1} className="draw" stroke="rgba(214,236,230,.07)" />
          <text x={L - 8} y={ys(g) + 4} textAnchor="end" className="ax">{g.toFixed(1)}</text>
        </g>
      ))}
      {[1, 3, 10, 30, 100, 300].map((ms, i) => (
        <g key={ms} style={cssVars({ "--i": i })}>
          <path d={`M${xs(ms)} ${H - B}V${T}`} pathLength={1} className="draw" stroke="rgba(214,236,230,.05)" />
          <text x={xs(ms)} y={H - B + 16} textAnchor="middle" className="ax">{ms} ms</text>
        </g>
      ))}
      <text x={L} y={H - 6} className="ax-l">mean runtime per rebalance (log) →</text>
      <text x={wide ? 16 : 10} y={T + 4} className="ax-l" transform={`rotate(90 ${wide ? 16 : 10} ${T + 4})`}>median gap_norm ↓ better</text>
      {WORKBENCH.solvers.map((s, i) => {
        const cx = xs(s.meanMs), cy = ys(s.medianGap);
        const on = hover === s.id;
        return (
          <g key={s.id} className={`sq-pt${on ? " on" : ""}`} style={cssVars({ "--i": i, color: TONE[s.id] })} onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)}>
            <circle className="sq-ring" cx={cx} cy={cy} r={17} fill="none" stroke={TONE[s.id]} />
            <circle className="sq-halo pop" cx={cx} cy={cy} r={on ? 11 : 8} fill={TONE[s.id]} fillOpacity={0.18} stroke={TONE[s.id]} strokeWidth={1.6} />
            <circle className="pop" cx={cx} cy={cy} r={2.6} fill={TONE[s.id]} />
            <text x={cx + (s.id === "exact" ? -14 : 14)} y={cy + 4} textAnchor={s.id === "exact" ? "end" : "start"} className="pt-l" fill={TONE[s.id]}>
              {s.id}{on ? ` · ${s.medianGap.toFixed(3)} gap, ${s.meanMs.toFixed(1)} ms` : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Compiled two-qubit gates on heavy-hex / linear vs all-to-all (log-log). */
function RoutingChart({ wide }: { wide: boolean }) {
  // The dashed 1x / 2x guides draw through a mask, so they keep their dash pattern.
  const mid = `rt${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const W = wide ? 560 : 400, H = wide ? 320 : 340;
  const L = wide ? 52 : 44, R = wide ? 18 : 14, T = 16, B = wide ? 40 : 38;
  const lo = Math.log10(10), hi = Math.log10(2000);
  const sx = (v: number) => L + ((Math.log10(v) - lo) / (hi - lo)) * (W - L - R);
  const sy = (v: number) => H - B - ((Math.log10(v) - lo) / (hi - lo)) * (H - T - B);
  const ticks = [10, 30, 100, 300, 1000];
  const line = (m: number) => {
    const a = 10, b = 2000 / m;
    return `M${sx(a)} ${sy(a * m)} L${sx(b)} ${sy(b * m)}`;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart bench-chart" data-reveal="fade" role="img" aria-label="Compiled two-qubit gate counts per coupling graph">
      <defs>
        {[1, 2].map((m) => (
          <mask key={m} id={`${mid}-${m}`} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
            <path d={line(m)} stroke="#fff" strokeWidth={6} fill="none" pathLength={1} className="draw" style={cssVars({ "--d": `${250 + m * 150}ms` })} />
          </mask>
        ))}
      </defs>
      {ticks.map((t, i) => (
        <g key={t} style={cssVars({ "--i": i })}>
          <path d={`M${sx(t)} ${H - B}V${T}`} pathLength={1} className="draw" stroke="rgba(214,236,230,.05)" />
          <path d={`M${L} ${sy(t)}H${W - R}`} pathLength={1} className="draw" stroke="rgba(214,236,230,.05)" />
          <text x={sx(t)} y={H - B + 16} textAnchor="middle" className="ax">{t}</text>
          <text x={L - 8} y={sy(t) + 4} textAnchor="end" className="ax">{t}</text>
        </g>
      ))}
      <path d={line(1)} stroke="rgba(214,236,230,.35)" strokeDasharray="3 5" mask={`url(#${mid}-1)`} />
      <path d={line(2)} stroke="rgba(214,236,230,.26)" strokeDasharray="3 5" mask={`url(#${mid}-2)`} />
      <text x={sx(700)} y={sy(700) + 16} className="ax">1×</text>
      <text x={sx(420)} y={sy(840) - 8} className="ax">2×</text>
      {/* points land left to right, in order of their all-to-all count */}
      {ROUTING.points.map(([n, k, a, hh, ln]) => (
        <g key={`${n}-${k}`} style={cssVars({ "--t": ((sx(a) - L) / (W - L - R)).toFixed(3) })}>
          <circle className="rt-pt pop" cx={sx(a)} cy={sy(ln)} r={3.2} fill="#f2a25c" fillOpacity={0.75} stroke="#f2a25c" strokeOpacity={0.3} strokeWidth={0}><title>{`n=${n}, k=${k}: linear ${ln} vs all-to-all ${a}`}</title></circle>
          <circle className="rt-pt pop" cx={sx(a)} cy={sy(hh)} r={3.2} fill="#3fd8c0" fillOpacity={0.85} stroke="#3fd8c0" strokeOpacity={0.3} strokeWidth={0}><title>{`n=${n}, k=${k}: heavy-hex ${hh} vs all-to-all ${a}`}</title></circle>
        </g>
      ))}
      <text x={L} y={H - 6} className="ax-l">two-qubit gates, all-to-all (log) →</text>
      <g className="rt-legend" transform={`translate(${L + 12} ${T + 8})`}>
        <circle r={4} fill="#3fd8c0" /><text x={10} y={4} className="pt-l" fill="#b4c2be">heavy-hex (IBM Heron map)</text>
        <circle cy={18} r={4} fill="#f2a25c" /><text x={10} y={22} className="pt-l" fill="#b4c2be">linear</text>
      </g>
    </svg>
  );
}

/**
 * The speed/quality chart above its ladder, sharing one hovered solver: the
 * chart shows the trade-off, the ladder gives the exact figures. Only the
 * header keeps a rule, and the rows alternate tint instead of being boxed in.
 */
function QualityViz({ wide }: { wide: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <>
      <figure className="fig" data-reveal>
        <div className="chartbox spot"><SpeedQuality wide={wide} hover={hover} setHover={setHover} /></div>
        <figcaption className="fine">gap_norm = (objective − optimum) / (worst − optimum): 0 is optimal, 1 is the worst portfolio available.</figcaption>
      </figure>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Solver</th><th>Median gap</th><th>At optimum</th><th>Mean time</th></tr></thead>
          <tbody data-reveal-stagger>
            {WORKBENCH.solvers.map((s) => (
              <tr key={s.id} data-reveal="row" className={hover === s.id ? "on" : undefined} onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)}>
                <td><span className="sw" style={{ background: TONE[s.id], color: TONE[s.id] }} />{s.name}</td>
                <td className="num" data-label="Median gap">{s.medianGap.toFixed(3)}</td>
                <td className="num" data-label="At optimum">{s.pctOptimal.toFixed(1)}%</td>
                <td className="num" data-label="Mean time">{s.meanMs.toFixed(1)} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Benchmarks() {
  useEffect(() => { document.title = "Benchmarks · Separatrix"; }, []);
  const wide = useWide();
  return (
    <div className="wrap page bench-page">
      <header className="page-h">
        <h1><SplitWords text="Numbers with receipts." delay={60} /></h1>
        <p className="muted" data-reveal style={cssVars({ "--d": "220ms" })}>
          Everything below is copied from an artifact committed to the repository, and each figure links to where it came from.
          Where a classical method wins, this page says so. Where something was not run, it says <b className="down">NOT RUN</b>.
        </p>
      </header>

      {/* the study: headline and lede, then the chart and its ladder at full width */}
      <section className="bsec">
        <div className="sec-head two" data-reveal>
          <div>
            <h2>Against a proven optimum, 234 times.</h2>
            <Meta status="Measured" path={WORKBENCH.source} label={`workbench report, run ${WORKBENCH.runId}`} />
          </div>
          <div className="sec-lede">
            <p>
              A walk-forward study on {WORKBENCH.assets} crypto assets picks exactly K = {WORKBENCH.k} every week ({WORKBENCH.period}). Every one of the {WORKBENCH.rebalances} rebalances
              was also solved by exhaustive enumeration, up to C(39, 8) = {WORKBENCH.maxSubsets} portfolios, so each heuristic's answer has a known distance from the best possible one.
            </p>
            <div className="callout">
              <b>Read it straight.</b> At this size exact enumeration is affordable and <b>wins outright</b>. Ballistic SB is about 127× faster on mean runtime and lands about 3% of the way along
              the achievable objective range. Discrete SB is poor on these instances. Heuristics only start to matter once C(N, K) can't be enumerated any more, and the{" "}
              <Link href="/solve/portfolio" className="link">portfolio solver</Link> lets you push past that point yourself.
            </div>
          </div>
        </div>
        <QualityViz wide={wide} />
      </section>

      {/* the routing tax: the three figures lead, the story follows */}
      <section className="bsec">
        <div className="stats lead" data-reveal-stagger>
          <div data-reveal>
            <CountUp value={`${ROUTING.heavyHexMedian.toFixed(2)}×`} duration={1200} className="num kpi-count" />
            <small>heavy-hex tax (median)<br />range {ROUTING.heavyHexRange[0].toFixed(2)}-{ROUTING.heavyHexRange[1].toFixed(2)}×</small>
          </div>
          <div data-reveal>
            <CountUp value={`${ROUTING.linearMedian.toFixed(2)}×`} duration={1200} className="num kpi-count" />
            <small>linear tax (median)<br />range {ROUTING.linearRange[0].toFixed(2)}-{ROUTING.linearRange[1].toFixed(2)}×</small>
          </div>
          {/* only the mantissa counts; the power of ten is not a quantity */}
          <div data-reveal>
            <span className="num kpi-count"><CountUp value="6.8" duration={1200} />×10⁻⁴</span>
            <small>weight-sector loss per two-qubit gate (depolarising model)</small>
          </div>
        </div>
        <div className="sec-head one" data-reveal>
          <h2>What hardware connectivity costs a constraint-preserving circuit.</h2>
          <p>
            Dicke-state preparation plus an XY-ring mixer, compiled with identical passes and native gates for three coupling graphs across 35 (n, k) points, n = 4 to 16.
            Every circuit passed a fidelity check at 1 − 10⁻⁹ before any number was recorded.
          </p>
          <Meta status="Emulated" path={ROUTING.source} label={`characterisation report, run ${ROUTING.runId}`} />
        </div>
        <div className="sec-split">
          <figure className="fig" data-reveal>
            <div className="chartbox spot"><RoutingChart wide={wide} /></div>
            <figcaption className="fine">Hover a point for its (n, k). Dashed lines mark 1× and 2× the all-to-all count.</figcaption>
          </figure>
          <p className="fine side-note" data-reveal>
            The tax does not visibly widen with n at n ≤ 16. Physical ion leakage and Hamming-weight sector loss are reported separately. Hardware: <b className="down">NOT RUN</b>.
          </p>
        </div>
      </section>

      {/* three samplers, three figures each: a comparison, not a table */}
      <section className="bsec">
        <div className="sec-head two" data-reveal>
          <div>
            <h2>The only defensible claim is a distribution shift.</h2>
            <Meta status="Simulated" path={QAOA.source} label="heron simulation report" />
          </div>
          <div className="sec-lede">
            <p>
              QAOA at p = 2 on n = 10, k = 3, noiseless. With only 120 feasible portfolios, "QAOA found the optimum" means nothing, because random guessing finds it too.
              What the XY mixer on a Dicke state does do is move probability mass towards better answers, and it keeps every shot feasible.
            </p>
            <p className="fine">IBM Heron hardware run: <b className="down">NOT RUN</b>. The pipeline defaults to dry-run.</p>
          </div>
        </div>
        <div className="compare" data-reveal-stagger>
          {QAOA.rows.map((r) => (
            <div key={r.name} className={`cmp${r.highlight ? " on" : ""}`} data-reveal>
              <h3>{r.name}</h3>
              <dl>
                <div><dt>Mean gap / shot</dt><dd className="num">{r.gap.toFixed(3)}</dd></div>
                <div><dt>P(optimum)</dt><dd className="num">{r.pOpt.toFixed(3)}</dd></div>
                <div><dt>Feasible</dt><dd className="num">{r.feasible}%</dd></div>
              </dl>
            </div>
          ))}
        </div>
      </section>

      {/* on-chain: the claim, then the measured cost, then the accounts */}
      <section className="bsec">
        <div className="sec-head one" data-reveal>
          <h2>The chain re-scores the answer instead of trusting it.</h2>
          <p>
            An Anchor program seals a problem's coefficients, accepts a hash commitment to an allocation before anything executes, then re-derives the revealed allocation's
            integer objective on-chain. In the verified reveal, the chain's objective equalled the solver's exactly. Both programs are unaudited devnet software.
          </p>
          <Meta status="Measured on Solana devnet" path={ONCHAIN.source} label="on-chain contract & measured compute" />
        </div>
        <div className="stats" data-reveal-stagger>
          {ONCHAIN.revealCu.map((r) => (
            <div key={r.k} data-reveal>
              <CountUp value={r.cu} duration={1200} className="num kpi-count" />
              <small>compute units to reveal at k = {r.k}</small>
            </div>
          ))}
          <div data-reveal>
            <CountUp value={String(ONCHAIN.maxCardinality)} duration={1200} className="num kpi-count" />
            <small>max cardinality, because reveal exceeds the 200k CU budget at k ≥ 46</small>
          </div>
        </div>
        <div className="links-list" data-reveal>
          <a href={`https://explorer.solana.com/address/${ONCHAIN.program}?cluster=devnet`} target="_blank" rel="noopener noreferrer">separatrix program <IconExternal size={12} /></a>
          <a href={`https://explorer.solana.com/tx/${ONCHAIN.revealTx}?cluster=devnet`} target="_blank" rel="noopener noreferrer">verified reveal transaction <IconExternal size={12} /></a>
          <a href={`https://explorer.solana.com/address/${ONCHAIN.leash}?cluster=devnet`} target="_blank" rel="noopener noreferrer">leash spending firewall <IconExternal size={12} /></a>
        </div>
      </section>

      <section className="bsec run-row" data-reveal>
        <div>
          <h2>Run it yourself.</h2>
          <p>The solver tests and benchmarks need only a Rust toolchain. The full study backfills public Binance daily closes first; the quantum sweep runs offline on Quantinuum's Selene emulator.</p>
        </div>
        <CodeBlock lang="shell" code={`git clone https://github.com/Iamsohungrynow/separatrix
cd separatrix/separatrix
cargo test --workspace      # unit, property, doc and CLI tests
cargo bench                 # criterion throughput on dense spin glasses`} />
      </section>
    </div>
  );
}
