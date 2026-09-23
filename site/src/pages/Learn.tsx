import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from "react";
import { IconArrow } from "../components/icons";
import { SplitWords } from "../components/Motion";
import { prefersReducedMotion } from "../lib/motion";
import { Link } from "../lib/router";
import { blob, DOCS_URL } from "../lib/site";
import "./pages.css";

/** The article's sections, for the "On this page" rail. Titles mirror the h2s. */
const SECTIONS = [
  { id: "qubo", title: "Everything becomes a QUBO" },
  { id: "oscillators", title: "Bits become spins become oscillators" },
  { id: "checked", title: "Every answer gets checked" },
  { id: "quantum", title: "And the quantum part?" },
  { id: "reading", title: "Further reading" },
] as const;

/**
 * Scroll-spy: the active section is the last heading above a line 30% down the
 * viewport, or the last one once the end of the article is on screen. The
 * observers only fire when a heading crosses that line, so nothing runs per frame.
 */
function useActiveSection(end: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  useEffect(() => {
    const heads = SECTIONS.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el !== null);
    if (!heads.length || !("IntersectionObserver" in window)) return;
    let atEnd = false;
    const pick = () => {
      const line = window.innerHeight * 0.3;
      let cur = heads[0].id;
      for (const h of heads) if (h.getBoundingClientRect().top <= line) cur = h.id;
      setActive(atEnd ? heads[heads.length - 1].id : cur);
    };
    const band = new IntersectionObserver(pick, { rootMargin: "0px 0px -70% 0px" });
    heads.forEach((h) => band.observe(h));
    const tail = new IntersectionObserver(([e]) => { atEnd = e.isIntersecting; pick(); });
    if (end.current) tail.observe(end.current);
    return () => { band.disconnect(); tail.disconnect(); };
  }, [end]);
  return active;
}

function jumpTo(id: string, smooth = true) {
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto", block: "start" });
  window.history.replaceState(window.history.state, "", `#${id}`);
  return true;
}

export default function Learn() {
  const end = useRef<HTMLDivElement>(null);
  const active = useActiveSection(end);
  useEffect(() => { document.title = "How it works · Separatrix"; }, []);
  // The page is lazy-loaded, so the browser's own jump to #section happened before it existed.
  useEffect(() => { const id = window.location.hash.slice(1); if (id) jumpTo(id, false); }, []);
  const onJump = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (jumpTo(id)) e.preventDefault();
  };
  return (
    <div className="wrap page learn">
      <header className="page-h">
        <h1><SplitWords text="From a real problem to a string of bits." delay={60} /></h1>
        <p className="muted" data-reveal style={{ "--d": "260ms" } as CSSProperties}>A ten-minute tour of what happens when you press Solve: the QUBO, the physics behind simulated bifurcation, and why every answer is checked.</p>
      </header>

      <div className="learn-body">
        <article className="prose">
          <section data-reveal>
            <h2 id="qubo">Everything becomes a QUBO</h2>
            <p>
              A <b>QUBO</b> (quadratic unconstrained binary optimisation) asks for the bit string <code>x ∈ {"{0,1}"}ⁿ</code> that minimises a quadratic function:
            </p>
            <div className="eq" data-reveal="fade">f(x) = Σᵢ Qᵢᵢ xᵢ + Σᵢ﹤ⱼ Qᵢⱼ xᵢ xⱼ</div>
            <p>
              It looks narrow, but a surprising amount of combinatorial optimisation fits. <b>Max-Cut</b> rewards each edge whose endpoints land on different sides. <b>Number
              partitioning</b> squares the difference between two sums. <b>Independent set</b> rewards picked nodes and penalises picked neighbours. A <b>portfolio</b> trades
              expected return against covariance risk and adds a penalty that is smallest when exactly k assets are held. The Studio builds each of these for you and shows the
              resulting matrix in the export panel.
            </p>
            <p>
              QUBO is also the input format of quantum annealers, of Ising machines like Toshiba's SQBM+, and of QAOA on gate-based quantum computers. A problem you build
              here can be exported to D-Wave's Ocean, Qiskit Optimization or a CPLEX LP file unchanged.
            </p>
          </section>

          <section data-reveal>
            <h2 id="oscillators">Bits become spins become oscillators</h2>
            <p>
              Substituting <code>xᵢ = (1 + sᵢ)/2</code> turns the QUBO into an <b>Ising model</b> over spins <code>sᵢ = ±1</code>, with couplings <code>J</code> and fields <code>h</code>:
            </p>
            <div className="eq" data-reveal="fade">E(s) = −½ Σᵢ≠ⱼ Jᵢⱼ sᵢ sⱼ − Σᵢ hᵢ sᵢ</div>
            <p>
              <b>Simulated bifurcation</b> (Goto, Tatsumura and Dixon, <i>Science Advances</i> 2019; Goto et al. 2021) replaces each spin with a classical nonlinear oscillator
              with position <code>xᵢ</code> and momentum <code>yᵢ</code>, and integrates Hamilton's equations while a pump <code>a(t)</code> ramps from 0 to <code>a₀</code>:
            </p>
            <div className="eq" data-reveal="fade">ẏᵢ = −(a₀ − a(t))·xᵢ + c₀·(Σⱼ Jᵢⱼ xⱼ + hᵢ)&nbsp;&nbsp;&nbsp;&nbsp;ẋᵢ = a₀·yᵢ&nbsp;&nbsp;&nbsp;&nbsp;with walls at |xᵢ| = 1</div>
            <p>
              Early on, the <code>−(a₀ − a)·x</code> term holds every oscillator near zero. As the pump grows that restoring force fades, the couplings take over, and each
              oscillator crosses the <b>separatrix</b>, the boundary between the two basins of attraction, and commits to +1 or −1. Reading out the signs gives the answer. That
              crossing is what the teal and amber lines in the Studio show, and it's where the project gets its name.
            </p>
            <ul>
              <li><b>Ballistic SB (bSB)</b> couples through positions <code>xⱼ</code>, which gives smooth, fast dynamics.</li>
              <li><b>Discrete SB (dSB)</b> couples through <code>sign(xⱼ)</code>, which is aimed at harder instances.</li>
            </ul>
            <p>
              It is called <i>quantum-inspired</i> because it descends from networks of Kerr parametric oscillators, a proposed quantum annealer. The algorithm itself is
              <b> entirely classical</b>: ordinary floating point and no qubits. Nothing on this site claims a quantum speed-up.
            </p>
          </section>

          <section data-reveal>
            <h2 id="checked">Every answer gets checked</h2>
            <p>
              A heuristic returning a number proves nothing on its own. The Studio runs three classical baselines next to SB, simulated annealing and parallel tempering, and when the
              problem is small enough (up to about two dozen variables, or tens of millions of k-subsets for portfolios) it runs <b>exact enumeration</b> over every possible
              bit string. You then see each solver's distance from the <b>proven optimum</b>, not just which heuristic did best.
            </p>
            <p>
              Beyond that size the page tells you plainly that there's no ground truth. That point, where exact enumeration stops being affordable, is the only regime where a
              heuristic earns its keep. On small instances exact is fast and correct, and the benchmarks say so.
            </p>
            <p>
              Scores are computed on a <b>quantized integer objective</b> in the portfolio path, so any result can be replayed bit for bit. The same arithmetic runs inside a
              Solana program that re-scores committed answers on-chain.
            </p>
          </section>

          <section data-reveal>
            <h2 id="quantum">And the quantum part?</h2>
            <p>
              "Exactly k of n" constraints appear everywhere, from picking k assets to choosing k facilities. On a quantum computer they can be enforced by <b>symmetry instead of a
              penalty</b>: start in a Dicke state, the equal superposition of all weight-k bit strings, and mix with an XY Hamiltonian that conserves Hamming weight. The{" "}
              <Link href="/dicke" className="link">circuit builder</Link> generates and verifies the Dicke-state preparation, and the{" "}
              <Link href="/benchmarks" className="link">benchmarks</Link> show what those circuits cost on real hardware connectivity.
            </p>
          </section>

          <section data-reveal>
            <h2 id="reading">Further reading</h2>
            <ul>
              <li>H. Goto, K. Tatsumura, A. R. Dixon, “Combinatorial optimization by simulating adiabatic bifurcations in nonlinear Hamiltonian systems,” <i>Sci. Adv.</i> 5, eaav2372 (2019).</li>
              <li>H. Goto et al., “High-performance combinatorial optimization based on classical mechanics,” <i>Sci. Adv.</i> 7, eabe7953 (2021).</li>
              <li>A. Bärtschi, S. Eidenbenz, “Deterministic preparation of Dicke states,” FCT 2019, arXiv:1904.07358.</li>
              <li>A. Lucas, “Ising formulations of many NP problems,” <i>Front. Phys.</i> 2, 5 (2014).</li>
              <li>The crate's API documentation on <a className="link" href={DOCS_URL} target="_blank" rel="noopener noreferrer">docs.rs</a> and the <a className="link" href={blob("docs/workbench.md")} target="_blank" rel="noopener noreferrer">portfolio formulation</a>.</li>
            </ul>
          </section>

          <div ref={end} className="learn-cta" data-reveal style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 36 }}>
            <Link href="/solve" className="btn primary lg" data-magnetic="5">Try it on a problem <IconArrow size={16} /></Link>
            <Link href="/dicke" className="btn lg" data-magnetic="5">Build a Dicke circuit</Link>
          </div>
        </article>

        {/* Wide screens only: a sticky rail whose teal bar slides to the section being read. */}
        <aside className="toc">
          <nav aria-label="On this page" data-reveal="fade" style={{ "--d": "400ms" } as CSSProperties}>
            <span className="toc-h">On this page</span>
            <div className="toc-list" data-indicator>
              {SECTIONS.map((s) => (
                <a key={s.id} href={`#${s.id}`} onClick={onJump(s.id)} className={active === s.id ? "is-active" : undefined} aria-current={active === s.id ? "true" : undefined}>
                  {s.title}
                </a>
              ))}
            </div>
          </nav>
        </aside>
      </div>
    </div>
  );
}
