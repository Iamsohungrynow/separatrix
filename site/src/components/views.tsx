// Problem-specific pictures of a solution. Every view takes `state`: one value
// per variable in [-1, 1]. During a replay that is the oscillator position
// x_i(t); for a finished solution it is +1 for bit 1 and -1 for bit 0. Teal
// always means bit 1, amber always bit 0.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Graph } from "../problems/graph";
import { prefersReducedMotion } from "../lib/motion";

const NEUTRAL = [74, 90, 95];
const UP = [63, 216, 192];
const DOWN = [242, 162, 92];

export function mixColor(v: number, alpha = 1): string {
  const t = Math.min(1, Math.abs(v));
  const target = v >= 0 ? UP : DOWN;
  const e = Math.pow(t, 0.7);
  const c = NEUTRAL.map((n, i) => Math.round(n + (target[i] - n) * e));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

export function bitsToState(bits: ArrayLike<number>): Float32Array {
  const s = new Float32Array(bits.length);
  for (let i = 0; i < bits.length; i++) s[i] = bits[i] ? 1 : -1;
  return s;
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/* ---------------- graph (Max-Cut, independent set) ---------------- */

const sameState = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * `smooth`: blend to a new state over ~300 ms instead of snapping (each node
 * passes through neutral on its way to the other side, as its oscillator
 * would). Leave it off for replays and scrubbing, which must stay frame-exact.
 */
export function GraphView({ graph, state, mode, height = 440, smooth = false }: { graph: Graph; state: Float32Array | null; mode: "cut" | "mis"; height?: number; smooth?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** what the canvas shows right now, mid-blend included */
  const drawn = useRef<Float32Array | null>(null);
  const blend = useRef(0);
  const w = useSize(box);
  const [hover, setHover] = useState<number | null>(null);
  const deg = useMemo(() => {
    const d = new Array(graph.n).fill(0);
    for (const [i, j] of graph.edges) { d[i]++; d[j]++; }
    return d;
  }, [graph]);
  const maxW = useMemo(() => graph.edges.reduce((m, e) => Math.max(m, Math.abs(e[2])), 0) || 1, [graph]);
  const r = Math.max(2.6, Math.min(9, 13 - Math.sqrt(graph.n) * 0.75));
  const h = Math.min(height, Math.max(300, w * 0.72));

  const toPx = useMemo(() => {
    const pad = r + 10;
    const side = Math.min(w, h);
    const ox = (w - side) / 2, oy = (h - side) / 2;
    return (p: [number, number]): [number, number] => [ox + pad + p[0] * (side - 2 * pad), oy + pad + p[1] * (side - 2 * pad)];
  }, [w, h, r]);

  const draw = useCallback((s: Float32Array | null) => {
    drawn.current = s;
    const c = canvas.current;
    if (!c || w === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // resizing the backing store clears and reallocates it: only when the size really changed
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pts = graph.pos.map(toPx);
    const v = (i: number) => (s ? s[i] : 0);
    const weighted = graph.edges.some((e) => e[2] !== 1);

    // edges: uncut / inside first, highlighted ones on top
    const hi: number[] = [];
    graph.edges.forEach(([i, j, wt], idx) => {
      const vi = v(i), vj = v(j);
      const special = s !== null && (mode === "cut" ? vi * vj < 0 : vi > 0 && vj > 0);
      if (special) { hi.push(idx); return; }
      const touch = hover !== null && (i === hover || j === hover);
      ctx.strokeStyle = touch ? "rgba(233,240,238,0.45)" : `rgba(233,240,238,${s ? 0.07 : 0.14})`;
      ctx.lineWidth = weighted ? 0.6 + (1.8 * Math.abs(wt)) / maxW : 1;
      ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[j][0], pts[j][1]); ctx.stroke();
    });
    for (const idx of hi) {
      const [i, j, wt] = graph.edges[idx];
      const strength = Math.min(1, Math.abs(v(i)) * Math.abs(v(j)) * 1.4);
      ctx.strokeStyle = mode === "cut" ? `rgba(233,240,238,${0.25 + 0.5 * strength})` : `rgba(240,113,103,${0.35 + 0.6 * strength})`;
      ctx.lineWidth = (weighted ? 0.8 + (2 * Math.abs(wt)) / maxW : 1.4) + (mode === "mis" ? 0.8 : 0);
      ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[j][0], pts[j][1]); ctx.stroke();
    }

    // nodes
    for (let i = 0; i < graph.n; i++) {
      const [x, y] = pts[i];
      const vi = v(i);
      ctx.beginPath();
      ctx.arc(x, y, i === hover ? r + 2.5 : r, 0, Math.PI * 2);
      if (mode === "mis") {
        const on = vi > 0;
        ctx.fillStyle = on ? mixColor(vi) : "#0f161a";
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = on ? mixColor(vi) : `rgba(125,142,138,${0.35 + 0.4 * Math.max(0, -vi)})`;
        ctx.stroke();
        if (on && vi > 0.6) {
          ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(63,216,192,0.25)"; ctx.lineWidth = 2; ctx.stroke();
        }
      } else {
        ctx.fillStyle = s ? mixColor(vi) : "rgba(125,142,138,0.8)";
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = "rgba(8,12,14,0.9)";
        ctx.stroke();
      }
    }
    // a neutral ring marks the hovered node (neutral, so it never reads as a bit)
    if (hover !== null && hover < graph.n) {
      const [x, y] = pts[hover];
      ctx.beginPath(); ctx.arc(x, y, r + 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(233,240,238,0.4)"; ctx.lineWidth = 1.25; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r + 11, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(233,240,238,0.1)"; ctx.lineWidth = 1; ctx.stroke();
    }
    if (graph.n <= 24) {
      ctx.font = "600 10px 'JetBrains Mono Variable', ui-monospace, monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let i = 0; i < graph.n; i++) {
        const [x, y] = pts[i];
        ctx.fillStyle = mode === "mis" && v(i) <= 0 ? "rgba(180,194,190,0.8)" : "rgba(3,20,17,0.85)";
        if (r >= 8) ctx.fillText(String(i), x, y + 0.5);
      }
    }
  }, [graph, mode, w, h, r, toPx, hover, maxW]);

  useEffect(() => {
    const from = drawn.current;
    if (!smooth || !state || !from || from.length !== state.length || sameState(from, state) || prefersReducedMotion()) {
      draw(state);
      return;
    }
    // A short imperative blend: no React renders, and it restarts from
    // wherever the picture is if another answer arrives mid-way.
    const a = Float32Array.from(from), mix = new Float32Array(state.length), t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 300), e = 1 - Math.pow(1 - k, 3);
      for (let i = 0; i < mix.length; i++) mix[i] = a[i] + (state[i] - a[i]) * e;
      draw(k < 1 ? mix : state);
      if (k < 1) blend.current = requestAnimationFrame(step);
    };
    blend.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(blend.current);
  }, [draw, state, smooth]);

  const onMove = (e: React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best = -1, bd = (r + 6) ** 2;
    graph.pos.forEach((p, i) => {
      const [x, y] = toPx(p);
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    setHover(best >= 0 ? best : null);
  };

  return (
    <div ref={box} className="viz-box" style={{ height: h }}>
      <canvas ref={canvas} style={{ width: "100%", height: h }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`Graph with ${graph.n} nodes and ${graph.edges.length} edges`} />
      {hover !== null && (
        /* one separator, then the membership on its own line in the colour that
           already means that bit: teal = +1, amber = -1 */
        <div className="viz-tip mono">
          <span>node {hover} · degree {deg[hover]}</span>
          {state && (() => {
            const on = mode === "mis" ? state[hover] > 0 : state[hover] >= 0;
            return <b className={on ? "up" : "down"}>{mode === "mis" ? (on ? "in set" : "not in set") : on ? "side A" : "side B"}</b>;
          })()}
        </div>
      )}
    </div>
  );
}

/* ---------------- number partitioning ---------------- */

export function PartitionView({ numbers, state }: { numbers: number[]; state: Float32Array | null }) {
  const total = numbers.reduce((a, b) => a + b, 0) || 1;
  const side = (i: number) => (state ? (state[i] >= 0 ? 1 : 0) : -1);
  const a = numbers.reduce((s, v, i) => s + (side(i) === 1 ? v : 0), 0);
  const b = numbers.reduce((s, v, i) => s + (side(i) === 0 ? v : 0), 0);
  const diff = a - b;
  const tilt = state ? Math.max(-14, Math.min(14, (-diff / total) * 60)) : 0;
  const order = useMemo(() => numbers.map((v, i) => [v, i] as const).sort((x, y) => y[0] - x[0]), [numbers]);
  const lane = (want: 0 | 1) => order.filter(([, i]) => side(i) === want);
  const unsorted = state ? [] : order;

  // A plain function, not a component defined in here: a nested component is a
  // new type every render, which remounted every block on every replay frame
  // (and left no element alive long enough for its colour to transition).
  const block = ([v, i]: readonly [number, number]) => {
    const s = state ? state[i] : 0;
    return (
      <span key={i} className="pblock" title={`#${i}: ${v}`} style={{ flexGrow: v, background: state ? mixColor(s, 0.22 + 0.5 * Math.min(1, Math.abs(s))) : "rgba(125,142,138,.18)", borderColor: state ? mixColor(s, 0.9) : "rgba(125,142,138,.4)" }}>
        {numbers.length <= 40 && <b>{v}</b>}
      </span>
    );
  };

  return (
    <div className="partition">
      <svg viewBox="0 0 400 120" className="beam" aria-hidden="true">
        <polygon points="200,112 186,120 214,120" fill="#1a252b" />
        <line x1="200" y1="112" x2="200" y2="58" stroke="rgba(214,236,230,.25)" strokeWidth="2" />
        <g style={{ transform: `rotate(${tilt}deg)`, transformOrigin: "200px 58px", transition: "transform .5s cubic-bezier(.3,1.4,.5,1)" }}>
          <line x1="70" y1="58" x2="330" y2="58" stroke="rgba(214,236,230,.5)" strokeWidth="2.5" strokeLinecap="round" />
          <line x1="80" y1="58" x2="80" y2="30" stroke="rgba(63,216,192,.5)" />
          <line x1="320" y1="58" x2="320" y2="30" stroke="rgba(242,162,92,.5)" />
          <rect x="44" y="12" width="72" height="20" rx="6" fill="rgba(63,216,192,.15)" stroke="#3fd8c0" />
          <rect x="284" y="12" width="72" height="20" rx="6" fill="rgba(242,162,92,.15)" stroke="#f2a25c" />
          <text x="80" y="26" textAnchor="middle" className="beam-t" fill="#3fd8c0">{state ? a.toLocaleString() : "?"}</text>
          <text x="320" y="26" textAnchor="middle" className="beam-t" fill="#f2a25c">{state ? b.toLocaleString() : "?"}</text>
        </g>
        <circle cx="200" cy="58" r="4" fill="#e9f0ee" />
      </svg>
      {state ? (
        <>
          <div className="plane"><span className="plane-l up">pile A · {a.toLocaleString()}</span><div className="pblocks">{lane(1).map(block)}</div></div>
          <div className="plane"><span className="plane-l down">pile B · {b.toLocaleString()}</span><div className="pblocks">{lane(0).map(block)}</div></div>
          <p className="pdiff mono">difference <b className={diff === 0 ? "up" : ""}>{Math.abs(diff).toLocaleString()}</b> of {total.toLocaleString()} total</p>
        </>
      ) : (
        <div className="plane"><span className="plane-l">{numbers.length} numbers · total {total.toLocaleString()}</span><div className="pblocks">{unsorted.map(block)}</div></div>
      )}
    </div>
  );
}

/* ---------------- portfolio ---------------- */

export function PortfolioView({ tickers, mu, sigma, state }: { tickers: string[]; mu: number[]; sigma: number[]; state: Float32Array | null }) {
  const n = tickers.length;
  const pts = useMemo(
    () => tickers.map((t, i) => ({ t, i, vol: Math.sqrt(Math.max(0, sigma[i * n + i])), ret: mu[i] })),
    [tickers, mu, sigma, n],
  );
  const W = 900, H = 430, L = 70, R = 18, T = 24, B = 40;
  const vx = pts.map((p) => p.vol), ry = pts.map((p) => p.ret);
  const x0 = Math.min(...vx) * 0.92, x1 = Math.max(...vx) * 1.04;
  const y0 = Math.min(...ry), y1 = Math.max(...ry);
  const padY = (y1 - y0) * 0.1 || 0.1;
  const sx = (v: number) => L + ((v - x0) / (x1 - x0 || 1)) * (W - L - R);
  const sy = (v: number) => T + (1 - (v - (y0 - padY)) / (y1 - y0 + 2 * padY || 1)) * (H - T - B);
  const yTicks = [y0, (y0 + y1) / 2, y1];
  const xTicks = [x0, (x0 + x1) / 2, x1];
  return (
    <div className="portfolio">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Assets by daily volatility and mean daily return">
        {yTicks.map((v) => (
          <g key={`y${v}`}><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="rgba(214,236,230,.06)" /><text x={L - 6} y={sy(v) + 4} textAnchor="end" className="ax">{(v * 100).toFixed(2)}%</text></g>
        ))}
        {xTicks.map((v) => (
          <text key={`x${v}`} x={sx(v)} y={H - B + 15} textAnchor="middle" className="ax">{(v * 100).toFixed(1)}%</text>
        ))}
        {y0 < 0 && y1 > 0 && <line x1={L} x2={W - R} y1={sy(0)} y2={sy(0)} stroke="rgba(214,236,230,.2)" strokeDasharray="2 4" />}
        <text x={L} y={H - 4} className="ax-l">daily volatility →</text>
        <text x={L + 4} y={T - 8} className="ax-l">↑ mean daily return (historical window)</text>
        {pts.map((p) => {
          const s = state ? state[p.i] : -1;
          const on = s > 0;
          // The halo is always there (r = 0 when off) so picking an asset grows it
          // instead of popping it; transitions live in solve.css and are off during replays.
          return (
            <g key={p.t} className="pf-pt" opacity={state ? (on ? 1 : 0.55) : 0.8}>
              <circle className="pf-halo" cx={sx(p.vol)} cy={sy(p.ret)} r={on ? 11 : 0} fill="rgba(63,216,192,.12)" />
              <circle className="pf-dot" cx={sx(p.vol)} cy={sy(p.ret)} r={on ? 5.5 : 3.6} fill={state ? mixColor(s) : "rgba(125,142,138,.8)"} />
              {(on || n <= 16) && <text x={sx(p.vol) + 8} y={sy(p.ret) + 4} className="pt-l" fill={on ? "#e9f0ee" : "#7d8e8a"} fontSize="10.5">{p.t}</text>}
            </g>
          );
        })}
      </svg>
      <div className="tickers">
        {pts.map((p) => {
          const s = state ? state[p.i] : -1;
          return <span key={p.t} className={`ticker ${state && s > 0 ? "on" : ""}`} style={state && s > 0 ? { borderColor: mixColor(s, 0.8) } : undefined}>{p.t}</span>;
        })}
      </div>
    </div>
  );
}

/* ---------------- custom QUBO: matrix heatmap ---------------- */

export function MatrixView({ n, terms, state, labels }: { n: number; terms: [number, number, number][]; state: Float32Array | null; labels?: string[] }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const w = useSize(box);
  const side = Math.min(w, 420);
  const maxAbs = useMemo(() => terms.reduce((m, t) => Math.max(m, Math.abs(t[2])), 0) || 1, [terms]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || side === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(side * dpr); c.height = Math.round(side * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#070a0c"; ctx.fillRect(0, 0, side, side);
    const cell = side / n;
    if (state) {
      for (let i = 0; i < n; i++) if (state[i] > 0) {
        ctx.fillStyle = "rgba(63,216,192,0.07)";
        ctx.fillRect(0, i * cell, side, cell);
        ctx.fillRect(i * cell, 0, cell, side);
      }
    }
    for (const [i, j, v] of terms) {
      const t = Math.pow(Math.abs(v) / maxAbs, 0.6);
      ctx.fillStyle = v < 0 ? `rgba(63,216,192,${0.15 + 0.85 * t})` : `rgba(242,162,92,${0.15 + 0.85 * t})`;
      const active = state ? state[i] > 0 && state[j] > 0 : false;
      ctx.fillRect(j * cell, i * cell, Math.max(1, cell - (cell > 4 ? 1 : 0)), Math.max(1, cell - (cell > 4 ? 1 : 0)));
      if (active && cell >= 6) {
        ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1;
        ctx.strokeRect(j * cell + 0.5, i * cell + 0.5, cell - 2, cell - 2);
      }
    }
  }, [n, terms, state, side, maxAbs]);

  return (
    <div className="matrix" ref={box}>
      <canvas ref={canvas} style={{ width: side, height: side }} role="img" aria-label={`QUBO matrix, ${n} variables, ${terms.length} non-zero terms`} />
      <div className="matrix-legend mono">
        <span><i style={{ background: "#3fd8c0" }} /> negative (rewarded)</span>
        <span><i style={{ background: "#f2a25c" }} /> positive (penalised)</span>
        <span className="muted">{n} × {n} · {terms.length} terms</span>
        <span className="muted">upper triangle</span>
      </div>
      {state && (
        <div className="bitrow" aria-label="Solution bits">
          {Array.from(state).map((s, i) => (
            <span key={i} className={s > 0 ? "on" : ""} title={labels?.[i] ?? `x${i}`}>{s > 0 ? 1 : 0}</span>
          ))}
        </div>
      )}
    </div>
  );
}
