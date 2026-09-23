// The motion layer: one set of document-level listeners instead of a hook per
// element. Components opt in with attributes and classes, so pages stay
// declarative and nothing here knows about any particular page.
//
//   data-reveal[="up"|"fade"|"scale"|"left"|"right"|"blur"]
//                         animate in the first time the element scrolls into view
//   data-reveal-stagger   on a parent: its revealing children enter one after another
//   .spot                 a spotlight and a border glow that follow the pointer
//   data-spot-group       on a parent: every .spot inside lights its border near the pointer
//   data-pointer          exposes --mx / --my (pointer position, px) to CSS, no styling
//   data-tilt[="6"]       tilts toward the pointer, max angle in degrees
//   data-magnetic[="6"]   drifts toward the pointer, max offset in px
//   .seg, data-indicator  a pill that slides to the selected child
//                         ([aria-pressed=true], [aria-selected=true], [aria-current=page], .is-active);
//                         the pill is drawn behind the children, so opaque siblings hide it mid-slide
//   data-hover-indicator  a pill that follows the hovered child
//
// Channels, so effects compose on one element: entrances animate `translate`,
// `scale` and `opacity`; tilt, lift and magnetic use `transform`.
//
// Everything is decoration. Under prefers-reduced-motion the pointer effects
// are off and every reveal is shown immediately.

const REVEAL = "[data-reveal]";
const INDICATOR = ".seg, [data-indicator]";
const SELECTED = ':scope > [aria-pressed="true"], :scope > [aria-selected="true"], :scope > [aria-current="page"], :scope > .is-active';

const mq = (q: string) => typeof window !== "undefined" && window.matchMedia(q).matches;
export const prefersReducedMotion = () => mq("(prefers-reduced-motion: reduce)");
const finePointer = () => mq("(hover: hover) and (pointer: fine)");

let started = false;

export function initMotion() {
  if (started || typeof window === "undefined") return;
  started = true;
  const root = document.documentElement;
  root.classList.add("motion");

  const reduced = prefersReducedMotion();
  const io = !reduced && "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            e.target.setAttribute("data-in", "");
            io!.unobserve(e.target);
          }
        },
        { rootMargin: "0px 0px -40px 0px", threshold: 0.06 },
      )
    : null;

  const indicators = new Set<HTMLElement>();
  const ro = "ResizeObserver" in window ? new ResizeObserver((es) => es.forEach((e) => placeIndicator(e.target as HTMLElement))) : null;

  const each = (node: ParentNode, sel: string, fn: (el: HTMLElement) => void) => {
    if (node instanceof HTMLElement && node.matches(sel)) fn(node);
    node.querySelectorAll<HTMLElement>(sel).forEach(fn);
  };
  const scan = (node: ParentNode) => {
    each(node, `${REVEAL}:not([data-in]):not([data-watch])`, (el) => {
      el.setAttribute("data-watch", "");
      if (io) io.observe(el);
      else el.setAttribute("data-in", "");
    });
    each(node, INDICATOR, (el) => {
      if (!indicators.has(el)) {
        indicators.add(el);
        ro?.observe(el);
      }
      placeIndicator(el);
    });
  };

  // React renders after this runs; watch the DOM so new pages, rows and tabs
  // are picked up without any component having to register itself.
  let pending = false;
  const dirty = new Set<Element>();
  const flush = () => {
    pending = false;
    for (const el of indicators) if (!el.isConnected) { indicators.delete(el); ro?.unobserve(el); }
    for (const n of dirty) {
      if (!n.isConnected) continue;
      scan(n);
      const ind = n.parentElement?.closest<HTMLElement>(INDICATOR);
      if (ind) placeIndicator(ind);
    }
    dirty.clear();
  };
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") dirty.add(r.target as Element);
      else r.addedNodes.forEach((n) => n.nodeType === 1 && dirty.add(n as Element));
    }
    if (!pending && dirty.size) { pending = true; requestAnimationFrame(flush); }
  });
  mo.observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["aria-pressed", "aria-selected", "aria-current", "class", "data-reveal"],
  });
  scan(document);
  window.addEventListener("resize", () => indicators.forEach(placeIndicator), { passive: true });
  document.fonts?.ready.then(() => indicators.forEach(placeIndicator));

  // Scroll: a flag for the nav, and the reading-progress hairline.
  let scrollQueued = false;
  const onScroll = () => {
    scrollQueued = false;
    const y = window.scrollY;
    root.toggleAttribute("data-scrolled", y > 8);
    const bar = document.querySelector<HTMLElement>(".scroll-progress");
    if (bar) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
    }
  };
  window.addEventListener("scroll", () => { if (!scrollQueued) { scrollQueued = true; requestAnimationFrame(onScroll); } }, { passive: true });
  window.addEventListener("app:navigate", () => requestAnimationFrame(onScroll));
  onScroll();

  if (!reduced) setupPointer();
}

/** Put a container's sliding pill under its selected child. */
function placeIndicator(c: HTMLElement) {
  const sel = c.querySelector<HTMLElement>(SELECTED);
  if (!sel || sel.offsetWidth === 0) { c.style.setProperty("--ind-o", "0"); return; }
  c.style.setProperty("--ind-x", `${sel.offsetLeft}px`);
  c.style.setProperty("--ind-y", `${sel.offsetTop}px`);
  c.style.setProperty("--ind-w", `${sel.offsetWidth}px`);
  c.style.setProperty("--ind-h", `${sel.offsetHeight}px`);
  c.style.setProperty("--ind-o", "1");
  // Place it once without animating, then let it slide from there on.
  if (!c.hasAttribute("data-ind")) requestAnimationFrame(() => requestAnimationFrame(() => c.setAttribute("data-ind", "")));
}

function setupPointer() {
  let last: PointerEvent | null = null;
  let raf = 0;
  let tilted: HTMLElement | null = null;
  let magnet: HTMLElement | null = null;

  const xy = (el: HTMLElement, e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${(e.clientX - r.left).toFixed(1)}px`);
    el.style.setProperty("--my", `${(e.clientY - r.top).toFixed(1)}px`);
    return r;
  };
  const release = (el: HTMLElement | null, props: string[]) => el && props.forEach((p) => el.style.removeProperty(p));

  const apply = () => {
    raf = 0;
    const e = last;
    if (!e) return;
    const t = e.target instanceof Element ? e.target : null;

    const group = t?.closest<HTMLElement>("[data-spot-group]");
    if (group) group.querySelectorAll<HTMLElement>(".spot").forEach((el) => xy(el, e));
    else {
      const s = t?.closest<HTMLElement>(".spot");
      if (s) xy(s, e);
    }
    const p = t?.closest<HTMLElement>("[data-pointer]");
    if (p) xy(p, e);

    if (!finePointer()) return;

    const tilt = t?.closest<HTMLElement>("[data-tilt]") ?? null;
    if (tilt !== tilted) { release(tilted, ["--rx", "--ry"]); tilted = tilt; }
    if (tilt) {
      const r = tilt.getBoundingClientRect();
      const max = Number(tilt.dataset.tilt) || 6;
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      tilt.style.setProperty("--rx", `${(-py * max).toFixed(2)}deg`);
      tilt.style.setProperty("--ry", `${(px * max).toFixed(2)}deg`);
    }

    const mag = t?.closest<HTMLElement>("[data-magnetic]") ?? null;
    if (mag !== magnet) { release(magnet, ["--tx", "--ty"]); magnet = mag; }
    if (mag) {
      const r = mag.getBoundingClientRect();
      const max = Number(mag.dataset.magnetic) || 6;
      const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      mag.style.setProperty("--tx", `${(dx * max).toFixed(1)}px`);
      mag.style.setProperty("--ty", `${(dy * max * 0.6).toFixed(1)}px`);
    }
  };

  document.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    last = e;
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: true });

  const leaveAll = () => {
    release(tilted, ["--rx", "--ry"]); tilted = null;
    release(magnet, ["--tx", "--ty"]); magnet = null;
  };
  document.addEventListener("pointerout", (e) => { if (!e.relatedTarget) leaveAll(); });
  window.addEventListener("blur", leaveAll);

  // A pill that follows whichever child is hovered.
  document.addEventListener("pointerover", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const c = t?.closest<HTMLElement>("[data-hover-indicator]");
    if (!c) return;
    let item: Element | null = t;
    while (item && item.parentElement !== c) item = item.parentElement;
    if (!(item instanceof HTMLElement)) return;
    c.style.setProperty("--hov-x", `${item.offsetLeft}px`);
    c.style.setProperty("--hov-y", `${item.offsetTop}px`);
    c.style.setProperty("--hov-w", `${item.offsetWidth}px`);
    c.style.setProperty("--hov-h", `${item.offsetHeight}px`);
    if (c.style.getPropertyValue("--hov-o") !== "1") {
      c.setAttribute("data-hov-jump", "");
      c.style.setProperty("--hov-o", "1");
      requestAnimationFrame(() => c.removeAttribute("data-hov-jump"));
    }
  });
  document.addEventListener("pointerout", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const c = t?.closest<HTMLElement>("[data-hover-indicator]");
    if (!c) return;
    const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    if (to && c.contains(to)) return;
    c.style.setProperty("--hov-o", "0");
  });
}
