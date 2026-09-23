// The signature visual: every oscillator's position x_i(t) from a real
// simulated-bifurcation run, drawn as the pump ramps. Each line starts near
// zero, crosses the separatrix and commits to +1 (teal) or -1 (amber). The
// data comes straight from the WASM solver's trace; nothing here is faked.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Trace } from "../solver/client";

const UP = [63, 216, 192];
const DOWN = [242, 162, 92];

function useCanvas(height: number) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: height, dpr: 1 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      setSize({ w, h: height, dpr });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);
  return { ref, size };
}

/** Playback state for a trace: frame advances from 0 to frames-1 over `duration` ms. */
export function usePlayback(frames: number, duration = 2600, autoKey?: unknown) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);
  const start = useRef(0);
  const from = useRef(0);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    setPlaying(false);
  }, []);

  const play = useCallback(
    (fromFrame?: number) => {
      if (frames < 2) return;
      cancelAnimationFrame(raf.current);
      const f0 = fromFrame ?? 0;
      from.current = f0;
      start.current = performance.now();
      setPlaying(true);
      const remaining = ((frames - 1 - f0) / (frames - 1)) * duration;
      const tick = (now: number) => {
        const t = Math.min(1, (now - start.current) / Math.max(remaining, 1));
        // ease-out: the interesting part (the bifurcation) gets more time
        const e = 1 - Math.pow(1 - t, 1.6);
        setFrame(f0 + e * (frames - 1 - f0));
        if (t < 1) raf.current = requestAnimationFrame(tick);
        else setPlaying(false);
      };
      raf.current = requestAnimationFrame(tick);
    },
    [frames, duration],
  );

  useEffect(() => {
    if (autoKey === undefined || frames < 2) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setFrame(frames - 1); return; }
    setFrame(0);
    play(0);
    return () => cancelAnimationFrame(raf.current);
  }, [autoKey, frames, play]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const seek = useCallback((f: number) => { stop(); setFrame(f); }, [stop]);
  return { frame, playing, play, stop, seek };
}

/** Positions of every oscillator at a (possibly fractional) frame. */
export function positionsAt(trace: Trace, frame: number): Float32Array {
  const n = trace.n;
  const f0 = Math.max(0, Math.min(trace.frames - 1, Math.floor(frame)));
  const f1 = Math.min(trace.frames - 1, f0 + 1);
  const a = frame - f0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = trace.x[f0 * n + i] * (1 - a) + trace.x[f1 * n + i] * a;
  return out;
}

interface Props {
  trace: Trace | null;
  frame: number;
  height?: number;
  /** "hero": borderless, glowing, no axes. "chart": axes + labels. */
  variant?: "hero" | "chart";
  highlight?: number | null;
}

export function BifurcationCanvas({ trace, frame, height = 260, variant = "chart", highlight = null }: Props) {
  const { ref, size } = useCanvas(height);

  useEffect(() => {
    const c = ref.current;
    if (!c || size.w === 0) return;
    const { w, h, dpr } = size;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const hero = variant === "hero";
    const padL = hero ? 0 : 34, padR = hero ? 0 : 10, padT = hero ? 14 : 12, padB = hero ? 14 : 22;
    const pw = w - padL - padR, ph = h - padT - padB;
    const yOf = (x: number) => padT + ((1 - x) / 2) * ph;

    // walls and the separatrix
    ctx.lineWidth = 1;
    if (!hero) {
      ctx.strokeStyle = "rgba(214,236,230,0.07)";
      for (const v of [1, -1]) {
        ctx.beginPath(); ctx.moveTo(padL, yOf(v)); ctx.lineTo(padL + pw, yOf(v)); ctx.stroke();
      }
      ctx.fillStyle = "rgba(180,194,190,0.7)";
      ctx.font = "11px 'JetBrains Mono Variable', ui-monospace, monospace";
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText("+1", padL - 8, yOf(1));
      ctx.fillText("0", padL - 8, yOf(0));
      ctx.fillText("−1", padL - 8, yOf(-1));
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "rgba(125,142,138,0.9)";
      ctx.fillText("pump a(t): 0 → a₀", padL, h - 5);
      ctx.textAlign = "right";
      ctx.fillText("separatrix", padL + pw - 2, yOf(0) - 6);
    }
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = hero ? "rgba(214,236,230,0.14)" : "rgba(214,236,230,0.22)";
    ctx.beginPath(); ctx.moveTo(padL, yOf(0)); ctx.lineTo(padL + pw, yOf(0)); ctx.stroke();
    ctx.setLineDash([]);

    if (!trace || trace.frames < 2) return;
    const { n, frames, x } = trace;
    const last = frames - 1;
    const fEnd = Math.max(0, Math.min(last, frame));
    const fInt = Math.floor(fEnd);
    const xOf = (f: number) => padL + (f / last) * pw;

    const alpha = hero ? Math.max(0.28, Math.min(0.7, 14 / Math.sqrt(n))) : Math.max(0.16, Math.min(0.85, 9 / Math.sqrt(n)));
    ctx.lineWidth = hero ? 1.6 : n > 150 ? 0.9 : 1.25;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (hero) { ctx.shadowBlur = 8; }

    const drawLine = (i: number, a: number, width?: number) => {
      const sign = x[last * n + i] >= 0 ? UP : DOWN;
      ctx.strokeStyle = `rgba(${sign[0]},${sign[1]},${sign[2]},${a})`;
      if (hero) ctx.shadowColor = `rgba(${sign[0]},${sign[1]},${sign[2]},0.55)`;
      if (width) ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(x[i]));
      for (let f = 1; f <= fInt; f++) ctx.lineTo(xOf(f), yOf(x[f * n + i]));
      if (fEnd > fInt && fInt < last) {
        const t = fEnd - fInt;
        const v = x[fInt * n + i] * (1 - t) + x[(fInt + 1) * n + i] * t;
        ctx.lineTo(xOf(fEnd), yOf(v));
      }
      ctx.stroke();
    };

    for (let i = 0; i < n; i++) if (i !== highlight) drawLine(i, alpha);
    if (highlight !== null && highlight >= 0 && highlight < n) {
      ctx.shadowBlur = 10; ctx.shadowColor = "rgba(255,255,255,0.6)";
      drawLine(highlight, 1, 2.4);
    }
    ctx.shadowBlur = 0;

    // leading-edge dots
    if (fEnd < last - 0.01) {
      for (let i = 0; i < n; i++) {
        const t = fEnd - fInt;
        const v = x[fInt * n + i] * (1 - t) + x[Math.min(last, fInt + 1) * n + i] * t;
        const sign = v >= 0 ? UP : DOWN;
        ctx.fillStyle = `rgba(${sign[0]},${sign[1]},${sign[2]},0.95)`;
        ctx.beginPath(); ctx.arc(xOf(fEnd), yOf(v), hero ? 1.8 : 1.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }, [trace, frame, size, variant, highlight, ref]);

  return <canvas ref={ref} style={{ width: "100%", height, display: "block" }} aria-label="Oscillator positions over time during simulated bifurcation" role="img" />;
}

/** Objective of sign(x) per frame, with the proven optimum (if known) as a reference line. */
export function ObjectiveSpark({ trace, frame, optimum, height = 64 }: { trace: Trace | null; frame: number; optimum: number | null; height?: number }) {
  const { ref, size } = useCanvas(height);
  useEffect(() => {
    const c = ref.current;
    if (!c || size.w === 0) return;
    const { w, h, dpr } = size;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!trace || trace.frames < 2) return;
    const obj = trace.objective;
    let lo = Infinity, hi = -Infinity;
    for (const v of obj) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (optimum !== null) { lo = Math.min(lo, optimum); hi = Math.max(hi, optimum); }
    if (hi - lo < 1e-12) { hi = lo + 1; }
    const padL = 34, padR = 10, padT = 6, padB = 6;
    const pw = w - padL - padR, ph = h - padT - padB;
    const last = trace.frames - 1;
    const xOf = (f: number) => padL + (f / last) * pw;
    const yOf = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * ph;
    const fEnd = Math.min(last, Math.floor(frame));

    if (optimum !== null) {
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(63,216,192,0.55)";
      ctx.beginPath(); ctx.moveTo(padL, yOf(optimum)); ctx.lineTo(padL + pw, yOf(optimum)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(63,216,192,0.8)";
      ctx.font = "10px 'JetBrains Mono Variable', ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.fillText("optimum", padL + pw - 2, yOf(optimum) - 4);
    }
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ph);
    grad.addColorStop(0, "rgba(165,148,249,0.25)");
    grad.addColorStop(1, "rgba(165,148,249,0)");
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(obj[0]));
    for (let f = 1; f <= fEnd; f++) ctx.lineTo(xOf(f), yOf(obj[f]));
    ctx.strokeStyle = "rgba(165,148,249,0.95)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(xOf(fEnd), padT + ph); ctx.lineTo(xOf(0), padT + ph); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.fillStyle = "rgba(125,142,138,0.9)";
    ctx.font = "10px 'JetBrains Mono Variable', ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.fillText("f(x)", padL - 8, padT + 9);
  }, [trace, frame, optimum, size, ref]);
  return <canvas ref={ref} style={{ width: "100%", height, display: "block" }} aria-hidden="true" />;
}
