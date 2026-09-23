# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The repository has
no release tags yet, so sections are keyed by the date the work landed on
`main`; commit hashes are given in parentheses so every line can be traced.

Two things are versioned separately from this file:

- the `separatrix` crate on crates.io (semver in `separatrix/Cargo.toml`)
- the two Solana programs, which are identified by their devnet addresses,
  not by version numbers

## [Unreleased]

### Separatrix Studio (2026-09-22)

#### Added

- `site/` is rebuilt as **Separatrix Studio**, a Vite + React + TypeScript app that
  replaces the static landing page and the single-purpose `/demo` page (old links
  redirect to `/solve/portfolio`).
  - **Solver**: Max-Cut, number partitioning, maximum independent set, cardinality-
    constrained portfolio selection and a paste-your-own-QUBO mode (JSON, dimod JSON,
    Python `Q` dict, dense matrix, edge list). All four heuristics stream their results
    from a worker, exact enumeration proves the optimum where affordable, and the page
    says plainly when it isn't. Includes a bifurcation replay synced to the problem
    picture, QUBO export (dimod JSON, CPLEX LP, D-Wave Ocean, Qiskit Optimization, Rust)
    and compressed share links.
  - **Dicke circuit builder**: a TypeScript port of `quantum/dicke_xy.py` (SCS and
    one-level DC), pinned gate-for-gate to the Python by a committed fixture, simulated
    and fidelity-checked in the browser, with Qiskit / pytket / Cirq / OpenQASM 2 / 3
    exports. The QASM, Qiskit and pytket exports were each run in `.venv-quantinuum` and
    prepared |D^n_k> to within about 2e-15.
  - **Benchmarks** and **How it works** pages; a social preview image.
  - A motion layer on IBM Carbon's motion tokens (`src/lib/motion.ts`, `src/motion.css`):
    scroll reveals, pointer spotlights on cards, sliding tab indicators, page transitions,
    a WebGL spin-lattice hero, circuits and charts that draw themselves, race rows that
    animate as results arrive, and a cursor companion (a ring that wraps controls, a
    spark trail, a click pulse; the native cursor stays). It is all decoration and turns off
    under `prefers-reduced-motion`.
  - A design pass against an anti-slop checklist: Geist replaces Inter, the hero headline
    runs across the measure over an 18-word lede, numbered section eyebrows are gone, the
    three equal feature cards became a bento of three cells with real measured bars, and a
    new scroll-scrubbed section plays one real bSB run frame by frame as the page scrolls.
- `separatrix-wasm`: `solve_qubo` (arbitrary QUBO, all heuristics, exact up to n = 26),
  `trace_sb` (positions and objective per frame, optional display-only `couplingScale`)
  and `portfolio_qubo`. `solve_portfolio` and `subsets` are unchanged.
- `separatrix` crate (additive): `sb::trace` / `SbTrace`, a recorded single-replica run
  that shares the integration loop with `sb::solve`, and `sb::default_coupling`.
- CI: a `studio` job (vitest, type-check, production build). Dependabot watches
  `site/`.

#### Changed

- `scripts/build-wasm-demo.sh` now writes to `site/public/pkg`.

### The settling pass (2026-09-04)

The settling pass that prepares the repository for open source.

#### Changed

- The repository is now presented as one project, **Separatrix**, with a
  rewritten top-level `README.md`. Leash (the spending firewall) and the
  quantum primitives work are chapters of it rather than competing identities.
- Stale "not built" claims corrected across `AGENT.md`, `separatrix/README.md`,
  `site/index.html` and the docs index: the browser WASM demo and the
  on-chain commitment program have been live since August and now say so.
- `separatrix` crate metadata updated (repository URL, homepage,
  documentation, authors, readme) and version bumped to **0.2.0**. The bump
  is unpublished until the maintainer runs `cargo publish`; crates.io still
  serves 0.1.0, which predates the `portfolio` module.
- `package.json` renamed from `leash` and given author, repository and
  license fields.

#### Added

- Open-source scaffolding: `CONTRIBUTING.md` (absorbing the old
  `docs/HACKATHON_DEV_GUIDE.md`), `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  `CITATION.cff`, this changelog, `.editorconfig`, GitHub issue and pull
  request templates, and a Dependabot configuration.
- `docs/primitives.md`: the reference document for the `quantum/` package.
- CI: `ruff check`, `cargo fmt --check`, and the quantum primitive tests
  (`tests/test_quantum_dicke.py`) now run on every push alongside the
  existing Python, TypeScript, IDL-sync, lockfile and crate jobs.
- `dicke_ops_dc`: one level of the divide-and-conquer Dicke construction
  (Aktar et al., arXiv:2112.12435) alongside the 2019 SCS cascade, verified
  against the analytic Dicke vector to 1 − 1.3e-15 for every (n, k) up to
  n = 12; `--construction {scs,dc}` in `quantum.characterise`, recorded in the
  artifact and the report header. Measured on all-to-all: about half the
  two-qubit depth of SCS and 10–37 % fewer ZZPhase, still ≈ 1.8× the published
  CNOT counts because of the three-qubit gadget decomposition
  (`docs/primitives.md` §8). Quantum tests 56 → 68.

#### Removed

- Dead requirement pins: `requirements-x402.txt` and
  `requirements-devnet.txt`. Nothing in the tree imports `x402` or
  `anchorpy`; the roadmap still lists both as future work.
- `.dockerignore`, which had no `Dockerfile` to serve.

## 2026-08-17

### Added

- `quantum/` package: Dicke-state preparation plus XY-ring mixer,
  characterised across an (n, k) grid on three coupling graphs
  (`quantum/dicke_xy.py`, `quantum/characterise.py`), with a Selene
  emulator backend that reaches Quantinuum's emulator through a generated
  Guppy program (`quantum/selene_backend.py`) (117dd83).
- The 35-point report (n = 4..16, fidelity 1.0 against the analytic Dicke
  vector everywhere; 20 points also emulated under noise) committed under
  `reports/examples/dicke-characterisation/`, including one emitted Guppy
  program as provenance.
- `requirements-quantinuum.txt`: pytket 2.18.1, pytket-quantinuum 0.59.2,
  guppylang 1.0.1, selene-sim 0.3.0 and qnexus 0.48.1, pinned to what was
  actually installed and exercised.
- `tests/test_quantum_dicke.py`: 56 tests, split so the construction itself is
  pinned by a numpy-only reference simulator and the pytket/qiskit layers are
  skipped cleanly where the stack is absent.

## 2026-08-16

### Added

- `scripts/heron_qaoa.py`: a QAOA pipeline for a real cardinality-constrained
  instance from the study, XY mixer on a Dicke state, parameters optimised in
  noiseless simulation, one job submitted at most, `--dry-run` on by default.
  Documented in `docs/quantum.md`; the simulated-only artifact is committed
  under `reports/examples/heron-simulation/`. No hardware job has been
  submitted (1dc1a1c).
- Browser demo at <https://separatrix.vercel.app/demo>: the solver crate
  compiled to WebAssembly (`separatrix/wasm`) running exact enumeration,
  bSB/dSB, SA and PT in a Web Worker against real study covariance
  (`site/demo`). The generated `pkg/` is committed so the site deploys without
  a wasm toolchain; rebuild with `scripts/build-wasm-demo.sh` (b6e5d6c).

## 2026-08-14

### Added

- `programs/separatrix`: an Anchor program deployed on devnet at
  `CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp` with `create_study`,
  `write_coefficients`, `seal_study`, `publish_allocation` and
  `reveal_allocation`; a committed allocation's objective is re-derived
  on-chain in integer arithmetic (774a87f).
- `docs/onchain.md`: account layout, both hash preimages byte by byte, the
  LSB-first bitmap, and measured compute units.
- `scripts/devnet-separatrix.ts` (`npm run separatrix:*`), the committed IDL
  `idl/separatrix.json` with its generator, the Anchor test suite
  `tests/anchor/separatrix.ts`, and `agent/workbench/onchain.py`, the Python
  commitment client (eaafc32).
- CI guards: `npm run check:sbf-lockfile` (lockfile v4 regression and
  host-crate leakage into the SBF workspace) and IDL-vs-generator diffs for
  both programs.

### Changed

- The program was hardened after an adversarial review and redeployed at the
  same address: `create_study` requires the agent to sign,
  `MAX_CARDINALITY = 40`, penalty offset bounded to `i64`, and
  `write_coefficients` range-compares instead of calling `abs()` (eaafc32).

## 2026-08-11

### Added

- `separatrix::portfolio`: the cardinality-constrained selection QUBO with
  automatic penalty, greedy repair to exactly K, and a K-subset enumerator
  that returns the proven best and worst; `separatrix/cli`, the JSON bridge
  the Python side shells out to (3299bc4).
- `agent/workbench/`: point-in-time walk-forward harness with 1/N, HRP,
  momentum, min-variance and buy-and-hold baselines at 0/10/30 bps
  (03f9c14); `docs/workbench.md` as its binding contract;
  `dashboard/workbench.html` with the committed report (34b40aa, b4143e6).
- The published study: 39 assets, K = 8, 234 weekly rebalances, exact ground
  truth on 100% of them. bSB median `gap_norm` 0.031, SA 0.079, PT 0.110,
  dSB 0.325; exact enumeration wins outright at this size and the docs say so.

### Changed

- Optimality gaps normalised by the portfolio objective rather than the
  penalised QUBO, and `gap_norm` (gap over the best-to-worst spread) adopted
  as the headline measure because it stays defined when the optimum crosses
  zero (67ad545, ad30302).

### Published

- `separatrix` 0.1.0 on crates.io (2026-08-11T06:22Z). That release contains
  the solver core only; the `portfolio` module landed on `main` later the
  same day.

## 2026-08-10

### Added

- `separatrix/`: a pure-Rust simulated-bifurcation crate (ballistic and
  discrete SB) with simulated annealing, parallel tempering and Gray-code
  exact enumeration as built-in baselines, plus `QuantizedQubo`, the canonical
  `i128` objective every solver is scored on. Its own cargo workspace,
  deliberately excluded from the SBF workspace (303e1c6, 09da825).
- CI job for the crate: tests, clippy with warnings as errors, and a
  `wasm32-unknown-unknown` check (25ee4bf).
- `price_history` table, per-cycle price recording, and a Binance bulk-kline
  backfill with the RNDR/RENDER rebrand handled (2601135).
- Landing page for <https://separatrix.vercel.app> under `site/`, with
  COOP/COEP headers pre-configured for the later WASM demo (4866856).

### Fixed

- Open positions are marked to market in PnL snapshots instead of carried at
  cost (d9c4260).
- Price client migrated from the dead Jupiter Price v2 endpoint to Price API
  v3 (24b767e).

## 2026-07-15

The Leash pivot: the repository stopped being a trading-signal project and
became an on-chain spending firewall for AI agents.

### Added

- `programs/leash`: vault PDA, per-transaction cap, daily budget with UTC day
  roll, recipient allowlist (max 8), owner kill switch and withdraw; deployed
  on devnet at `EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV` and exercised
  end to end (86da78f).
- `scripts/devnet-leash.ts` bridge CLI (init / status / deposit / spend /
  halt / resume / withdraw / smoke), devnet scripts, and the Anchor test
  suite (40b0ca6).
- Fail-closed Python client (`AnchorLeashClient`) and local simulator
  (`LocalLeashClient`); the demo agent's buys routed through the leash
  (4d6510e).
- Live monitor dashboard (`dashboard/index.html`) (01b66bb) and the owner
  console `dashboard/owner.html`, a wallet-adapter page whose instruction
  encoder is byte-compared against Anchor by `npm run verify:owner-ix`
  (f35f7e5).

### Changed

- README and docs rewritten for Leash (9918d95); the previous
  `policy_controller` program replaced (86da78f, ae246a7).

## 2026-06-21

### Changed

- `policy_controller` (the predecessor of `leash`) made to build on the
  Solana 1.18 SBF toolchain, including the lockfile-v3 workaround, and
  deployed to devnet (0fc7022, d7f5bc9).

## 2026-04-06

Initial scaffold, then called QubitAlpha.

### Added

- Local paper-trading agent: arXiv/RSS ingestion, LLM scoring, signal
  validation, SQLite persistence, FastAPI status API (0a100e2).
- Anchor `policy_controller` scaffold and devnet setup/deploy scripts
  (b4677bf, a20a5f1, 7b27107).
- README, dashboard shell, CI, and contributor guidance (0b1227b, 2c15198,
  22c702f, 4930bad).
