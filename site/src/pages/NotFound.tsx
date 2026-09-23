import type { CSSProperties } from "react";
import { SplitWords } from "../components/Motion";
import { Link } from "../lib/router";
import "./pages.css";

/**
 * The mark, played out: a trajectory reaches the separatrix and commits to one
 * branch or the other. The road straight ahead, like this URL, has zero
 * amplitude. Now and then a particle retraces a branch, teal then amber.
 */
function Bifurcation404() {
  return (
    <svg className="nf-art" viewBox="0 0 300 120" aria-hidden="true">
      <defs>
        {/* user-space gradients: a horizontal path has a zero-height bounding box */}
        <linearGradient id="nf-g-stem" gradientUnits="userSpaceOnUse" x1="24" x2="132"><stop offset="0" stopColor="#e9f0ee" stopOpacity="0" /><stop offset="1" stopColor="#e9f0ee" /></linearGradient>
        <linearGradient id="nf-g-up" gradientUnits="userSpaceOnUse" x1="132" x2="276"><stop offset="0" stopColor="#e9f0ee" /><stop offset="1" stopColor="#3fd8c0" /></linearGradient>
        <linearGradient id="nf-g-down" gradientUnits="userSpaceOnUse" x1="132" x2="276"><stop offset="0" stopColor="#e9f0ee" /><stop offset="1" stopColor="#f2a25c" /></linearGradient>
        <linearGradient id="nf-g-ghost" gradientUnits="userSpaceOnUse" x1="138" x2="262"><stop offset="0" stopColor="#e9f0ee" stopOpacity="0.45" /><stop offset="1" stopColor="#e9f0ee" stopOpacity="0" /></linearGradient>
      </defs>
      <path className="nf-sep" d="M132 8V112" />
      <path className="nf-ghost" d="M140 60H262" stroke="url(#nf-g-ghost)" />
      <path className="nf-stem" d="M24 60H132" stroke="url(#nf-g-stem)" pathLength={1} />
      <path className="nf-up" d="M132 60C172 60 196 22 276 20" stroke="url(#nf-g-up)" pathLength={1} />
      <path className="nf-down" d="M132 60C172 60 196 98 276 100" stroke="url(#nf-g-down)" pathLength={1} />
      <path className="nf-spark" d="M24 60H132C172 60 196 22 276 20" stroke="url(#nf-g-up)" pathLength={1} />
      <path className="nf-spark down" d="M24 60H132C172 60 196 98 276 100" stroke="url(#nf-g-down)" pathLength={1} />
      <circle className="nf-node" cx={132} cy={60} r={3.6} fill="#e9f0ee" />
      <circle className="nf-end" cx={276} cy={20} r={3.6} fill="#3fd8c0" />
      <circle className="nf-end" cx={276} cy={100} r={3.6} fill="#f2a25c" />
    </svg>
  );
}

export default function NotFound() {
  return (
    <section className="wrap nf" style={{ minHeight: "60vh", display: "grid", placeItems: "center", textAlign: "center" }}>
      <div style={{ display: "grid", gap: 14, justifyItems: "center" }}>
        <Bifurcation404 />
        <h1 style={{ fontSize: 40 }}><SplitWords text="This state has zero amplitude." delay={120} /></h1>
        <p className="muted" data-reveal style={{ "--d": "380ms" } as CSSProperties}>404. The page you asked for doesn't exist, but these do:</p>
        <div data-reveal style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", "--d": "480ms" } as CSSProperties}>
          <Link className="btn primary" href="/solve" data-magnetic="5">Open the solver</Link>
          <Link className="btn ghost" href="/">Back to the home page</Link>
        </div>
      </div>
    </section>
  );
}
