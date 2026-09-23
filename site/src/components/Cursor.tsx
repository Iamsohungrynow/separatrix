// A cursor companion: a ring that glides after the pointer and wraps whatever
// is clickable, a spark trail on quick moves, and a pulse on click. The native
// cursor stays (precision matters on sliders and graphs); this only decorates
// it. Fine pointers only, off under prefers-reduced-motion, and out of the way
// over canvases and text fields.
//
// Sparks and pulses are short-lived elements that delete themselves on a timer,
// not marks painted on a canvas, so nothing can outlive a dropped frame or a
// lost event. The ring hides whenever the pointer stops being reported (the
// scrollbar, the window edge, another tab) or simply rests, because that is
// when a follower would otherwise be stranded on screen.
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/motion";

const CLICKABLE = 'a, button, [role="button"], [role="tab"], label.switch, .chip, summary';
const NATIVE = 'canvas, input, textarea, select, [contenteditable="true"], [data-cursor="native"]';
const RING = 30;
const IDLE_MS = 2200;
const SPARK_MS = 520;
const PULSE_MS = 520;
const SPARK_GAP = 26;   // ms between sparks
const SPARK_MOVE = 5;   // px the pointer must travel before the next one
const MAX_SPARKS = 48;

export function Cursor() {
  const ringRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prefersReducedMotion() || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const ring = ringRef.current!;
    const layer = layerRef.current!;
    const root = document.documentElement;

    const ptr = { x: -100, y: -100 };
    // ring state: current and target centre, size and corner radius
    const cur = { x: -100, y: -100, w: RING, h: RING, r: RING / 2 };
    const tgt = { ...cur };
    let hover: Element | null = null;
    let hoverRadius = 8;
    let hoverMoves = false;
    let native = false;
    let down = false;
    let seen = false;
    let raf = 0;
    let last = 0;
    let asleep = true;
    let mode = "";
    let idle = 0;
    let lastSpark = 0;
    let sparkX = 0;
    let sparkY = 0;
    let flip = false;

    const setMode = (m: string) => {
      if (m === mode) return;
      mode = m;
      ring.className = `cursor-ring ${m}`;
    };

    const spawn = (cls: string, x: number, y: number, life: number) => {
      const el = document.createElement("i");
      el.className = cls;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      layer.append(el);
      // a timer, not animationend: it fires even if the animation never does
      window.setTimeout(() => el.remove(), life + 80);
      while (layer.childElementCount > MAX_SPARKS) layer.firstElementChild?.remove();
    };

    const retarget = (el: Element | null) => {
      native = !!el?.closest(NATIVE);
      const next = native ? null : el?.closest(CLICKABLE) ?? null;
      if (next !== hover && next) {
        hoverRadius = parseFloat(getComputedStyle(next).borderTopLeftRadius) || 8;
        // magnetic and tilted controls move under a still pointer; keep tracking them
        hoverMoves = !!next.closest("[data-magnetic], [data-tilt]");
      }
      hover = next;
    };

    const aim = () => {
      const press = down ? 0.86 : 1;
      if (!seen || native) {
        tgt.x = ptr.x; tgt.y = ptr.y; tgt.w = tgt.h = 8; tgt.r = 4;
        setMode(seen ? "on hide" : "");
        return;
      }
      if (hover) {
        const b = hover.getBoundingClientRect();
        const inPill = hover.closest("[data-hover-indicator]");
        if (!inPill && b.width <= 320 && b.height <= 72) {
          // wrap the control, leaning slightly toward the pointer
          const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
          tgt.x = cx + (ptr.x - cx) * 0.1;
          tgt.y = cy + (ptr.y - cy) * 0.14;
          tgt.w = (b.width + 10) * press;
          tgt.h = (b.height + 10) * press;
          tgt.r = Math.min(hoverRadius + 5, tgt.h / 2);
          setMode("on snap");
          return;
        }
        tgt.x = ptr.x; tgt.y = ptr.y;
        tgt.w = tgt.h = (inPill ? 18 : 52) * press;
        tgt.r = tgt.w / 2;
        setMode(inPill ? "on dot" : "on big");
        return;
      }
      tgt.x = ptr.x; tgt.y = ptr.y;
      tgt.w = tgt.h = RING * press;
      tgt.r = tgt.w / 2;
      setMode("on");
    };

    const frame = (now: number) => {
      raf = 0;
      // a rAF timestamp can predate the event that woke the loop, so after a
      // sleep assume one frame instead of trusting now - last
      const dt = asleep ? 16 : Math.min(64, Math.max(1, now - last));
      asleep = false;
      last = now;
      aim();

      // exponential smoothing: frame-rate independent glide
      const k = 1 - Math.exp(-dt / 55);
      const ks = 1 - Math.exp(-dt / 70);
      cur.x += (tgt.x - cur.x) * k;
      cur.y += (tgt.y - cur.y) * k;
      cur.w += (tgt.w - cur.w) * ks;
      cur.h += (tgt.h - cur.h) * ks;
      cur.r += (tgt.r - cur.r) * ks;
      ring.style.transform = `translate3d(${(cur.x - cur.w / 2).toFixed(1)}px, ${(cur.y - cur.h / 2).toFixed(1)}px, 0)`;
      ring.style.width = `${cur.w.toFixed(1)}px`;
      ring.style.height = `${cur.h.toFixed(1)}px`;
      ring.style.borderRadius = `${cur.r.toFixed(1)}px`;

      const settling = Math.abs(tgt.x - cur.x) + Math.abs(tgt.y - cur.y) + Math.abs(tgt.w - cur.w) + Math.abs(tgt.h - cur.h) > 0.3;
      if (settling || (hover && hoverMoves)) wake();
      else asleep = true;
    };
    const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };

    // Browsers stop sending pointer events over the scrollbar, while it is
    // dragged, and sometimes when the pointer leaves the window through it.
    const hide = () => {
      window.clearTimeout(idle);
      seen = false;
      down = false;
      hover = null;
      layer.replaceChildren();
      setMode("");
      wake();
    };
    const inGutter = (e: PointerEvent) => e.clientX >= root.clientWidth || e.clientY >= root.clientHeight;

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      if (inGutter(e)) { hide(); return; }
      window.clearTimeout(idle);
      idle = window.setTimeout(hide, IDLE_MS);
      ptr.x = e.clientX; ptr.y = e.clientY;
      if (!seen) {
        seen = true;
        cur.x = tgt.x = ptr.x; cur.y = tgt.y = ptr.y;
        sparkX = ptr.x; sparkY = ptr.y;
      }
      retarget(e.target instanceof Element ? e.target : null);
      const now = performance.now();
      if (!native && now - lastSpark > SPARK_GAP && Math.abs(ptr.x - sparkX) + Math.abs(ptr.y - sparkY) > SPARK_MOVE) {
        lastSpark = now;
        sparkX = ptr.x; sparkY = ptr.y;
        flip = !flip;
        spawn(flip ? "spark" : "spark b", ptr.x, ptr.y, SPARK_MS);
      }
      wake();
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      if (inGutter(e)) { hide(); return; }
      down = true;
      if (!native && seen) spawn("pulse", e.clientX, e.clientY, PULSE_MS);
      wake();
    };
    const onUp = () => { down = false; wake(); };
    const onLeave = (e: PointerEvent) => { if (!e.relatedTarget) hide(); };
    const onHidden = () => { if (document.hidden) hide(); };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("pointercancel", onUp, { passive: true });
    document.addEventListener("pointerout", onLeave);
    root.addEventListener("mouseleave", hide);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", onHidden);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(idle);
      layer.replaceChildren();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.removeEventListener("pointerout", onLeave);
      root.removeEventListener("mouseleave", hide);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  return (
    <>
      <div ref={layerRef} className="cursor-sparks" aria-hidden="true" />
      <div ref={ringRef} className="cursor-ring" aria-hidden="true" />
    </>
  );
}
