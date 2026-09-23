// React-side motion primitives. The attribute-driven effects (reveals, spotlight,
// tilt, indicators) live in lib/motion.ts; these are the few that need state.
import { Children, Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { prefersReducedMotion } from "../lib/motion";

/** True once the element has scrolled into view (and stays true). */
export function useInView<T extends Element>(opts: { once?: boolean; margin?: string; threshold?: number } = {}): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  const { once = true, margin = "0px 0px -8% 0px", threshold = 0.1 } = opts;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) { setInView(true); return; }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setInView(true); if (once) io.disconnect(); }
      else if (!once) setInView(false);
    }, { rootMargin: margin, threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [once, margin, threshold]);
  return [ref, inView];
}

const NUM = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

function tween(text: string, p: number) {
  return text.replace(NUM, (m) => {
    const grouped = m.includes(",");
    const raw = Number(m.replace(/,/g, ""));
    const dec = (m.split(".")[1] ?? "").length;
    const v = raw * p;
    return grouped
      ? v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })
      : v.toFixed(dec);
  });
}

/**
 * Counts every number in `value` up from zero when it scrolls into view. The
 * text it settles on is exactly `value`, and screen readers only ever get
 * `value`.
 */
export function CountUp({ value, duration = 1400, className, style }: { value: string; duration?: number; className?: string; style?: CSSProperties }) {
  const [ref, inView] = useInView<HTMLSpanElement>();
  const animate = typeof window !== "undefined" && !prefersReducedMotion() && "IntersectionObserver" in window;
  const [text, setText] = useState(() => (animate ? tween(value, 0) : value));

  useEffect(() => {
    if (!animate) { setText(value); return; }
    if (!inView) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - k, 4);
      setText(k < 1 ? tween(value, eased) : value);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [inView, value, duration, animate]);

  return (
    <span ref={ref} className={className} style={style}>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

/**
 * An endless horizontal ticker. The content is rendered twice and the track
 * slides by exactly one copy, so the loop has no seam. Pauses on hover.
 */
export function Marquee({ children, seconds = 40, reverse = false, className = "" }: { children: ReactNode; seconds?: number; reverse?: boolean; className?: string }) {
  const items = Children.toArray(children);
  return (
    <div className={`marquee ${reverse ? "reverse" : ""} ${className}`} style={{ "--marquee-dur": `${seconds}s` } as CSSProperties}>
      <div className="marquee-track">
        <div className="marquee-group">{items}</div>
        <div className="marquee-group" aria-hidden="true">{items}</div>
      </div>
    </div>
  );
}

/**
 * Words that rise out of a mask one after another, for display headings.
 * Pass `accent` to style a trailing run of words (e.g. the gradient phrase);
 * each word carries the class itself so background-clip text survives the
 * per-word transforms.
 */
export function SplitWords({ text, accent, accentClass = "grad", delay = 0, stagger = 55 }: { text: string; accent?: string; accentClass?: string; delay?: number; stagger?: number }) {
  const words = text.split(/\s+/).filter(Boolean).map((w) => ({ w, cls: "", style: {} as CSSProperties }));
  const acc = (accent ?? "").split(/\s+/).filter(Boolean);
  // Stretch one gradient across the accent run: each word shows its slice.
  const extra = acc.map((w, j) => ({
    w, cls: accentClass,
    style: { backgroundSize: `${acc.length * 100}% 100%`, backgroundPosition: `${acc.length > 1 ? (j / (acc.length - 1)) * 100 : 0}% 0` } as CSSProperties,
  }));
  const all = [...words, ...extra];
  return (
    <span className="split">
      <span className="sr-only">{[text, accent].filter(Boolean).join(" ")}</span>
      {all.map(({ w, cls, style }, i) => (
        <Fragment key={i}>
          <span className="split-w" aria-hidden="true">
            <span className={cls} style={{ ...style, animationDelay: `${delay + i * stagger}ms` }}>{w}</span>
          </span>
          {i < all.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>
  );
}
