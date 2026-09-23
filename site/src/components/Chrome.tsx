import { useEffect, useState } from "react";
import { Link, useLocation } from "../lib/router";
import { CRATE_URL, DOCS_URL, REPO, REPO_URL, blob } from "../lib/site";
import { IconGithub, IconMenu, IconStar, IconX, Logo } from "./icons";

const NAV = [
  { href: "/solve", label: "Solver" },
  { href: "/dicke", label: "Dicke circuits" },
  { href: "/benchmarks", label: "Benchmarks" },
  { href: "/learn", label: "How it works" },
];

/**
 * Live star count, fetched once per session and shared by every button. The
 * repo can be private (the API then answers 404), in which case the buttons
 * still link to GitHub and simply show no number.
 */
let starsPromise: Promise<number | null> | null = null;
function fetchStars(): Promise<number | null> {
  if (starsPromise) return starsPromise;
  try {
    const cached = JSON.parse(sessionStorage.getItem("gh-stars") || "null");
    if (cached && Date.now() - cached.t < 10 * 60_000) return (starsPromise = Promise.resolve(cached.v));
  } catch { /* storage unavailable */ }
  starsPromise = fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && typeof d.stargazers_count === "number" ? d.stargazers_count : null))
    .catch(() => null)
    .then((v: number | null) => {
      try { sessionStorage.setItem("gh-stars", JSON.stringify({ v, t: Date.now() })); } catch { /* private mode */ }
      return v;
    });
  return starsPromise;
}

function useStars(): number | null {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    fetchStars().then((v) => alive && setStars(v));
    return () => { alive = false; };
  }, []);
  return stars;
}

export function StarButton({ size = "" }: { size?: "" | "lg" }) {
  const stars = useStars();
  return (
    <a className={`btn star-btn ${size}`} href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="Star Separatrix on GitHub">
      <span><IconGithub /> Star<IconStar /></span>
      {stars !== null && <span className="count">{stars.toLocaleString()}</span>}
    </a>
  );
}

export function Nav() {
  const { path } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  return (
    <header className="nav">
      <div className="wrap">
        <Link href="/" className="brand brand-anim" aria-label="Separatrix home">
          <Logo /> Separatrix <span className="tag">studio</span>
        </Link>
        <nav className={`nav-links ${open ? "open" : ""}`} aria-label="Main" data-indicator data-hover-indicator>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href || path.startsWith(n.href + "/") ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="nav-spacer" />
        <StarButton />
        <button className="btn icon ghost nav-burger" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? <IconX /> : <IconMenu />}
        </button>
      </div>
      <div className="scroll-progress" aria-hidden="true" />
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap" data-reveal-stagger>
        <div data-reveal style={{ display: "grid", gap: 10, maxWidth: 360 }}>
          <Link href="/" className="brand" style={{ color: "var(--ink)" }}><Logo size={22} /> Separatrix</Link>
          <p>Quantum-inspired optimisation you can check. Open source, MIT, built by{" "}
            <a href="https://github.com/Iamsohungrynow" target="_blank" rel="noopener noreferrer" style={{ color: "var(--ink-2)" }}>Martina</a>.</p>
          <p style={{ color: "var(--ink-4)", fontSize: 12.5 }}>Simulated bifurcation is a classical algorithm. No quantum advantage is claimed anywhere on this site.</p>
        </div>
        <div className="cols" data-reveal-stagger>
          <div className="col" data-reveal>
            <b>Studio</b>
            <Link href="/solve">Solver</Link>
            <Link href="/dicke">Dicke circuits</Link>
            <Link href="/benchmarks">Benchmarks</Link>
            <Link href="/learn">How it works</Link>
          </div>
          <div className="col" data-reveal>
            <b>Project</b>
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href={CRATE_URL} target="_blank" rel="noopener noreferrer">crates.io</a>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">docs.rs</a>
            <a href={blob("CONTRIBUTING.md")} target="_blank" rel="noopener noreferrer">Contribute</a>
          </div>
          <div className="col" data-reveal>
            <b>Research</b>
            <a href={blob("docs/workbench.md")} target="_blank" rel="noopener noreferrer">Portfolio study</a>
            <a href={blob("docs/primitives.md")} target="_blank" rel="noopener noreferrer">Quantum primitives</a>
            <a href={blob("docs/onchain.md")} target="_blank" rel="noopener noreferrer">On-chain verification</a>
            <a href={blob("CITATION.cff")} target="_blank" rel="noopener noreferrer">Cite</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
