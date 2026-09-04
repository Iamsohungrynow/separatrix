# Roadmap

This roadmap tracks the code that actually exists in the repository, not a vision deck.
A checked box means it is on `main`, verified, and described honestly in the docs.

## Solver (`separatrix/`)

Done:

- [x] bSB / dSB with paper-faithful `ξ₀` scaling, SA, parallel tempering, Gray-code exact
- [x] `QuantizedQubo`: one canonical `i128` objective every solver is scored on
- [x] `portfolio`: selection QUBO with automatic penalty, greedy repair, K-subset enumerator
      returning proven best *and* worst
- [x] Property tests (gauge invariance, QUBO↔Ising equivalence, integer/float agreement,
      no heuristic below the exact ground state)
- [x] `wasm32` build and the browser demo at separatrix.vercel.app/demo
- [x] 0.1.0 on crates.io

Next:

- [ ] Publish 0.2.0 (the tree is ready: `cargo publish --dry-run` passes)
- [ ] MIP (HiGHS) ground truth above the enumeration cap, so gaps stay proven past C(N,K) ≈ 10⁸
- [ ] Additional instance families in the benchmark (MaxCut, Sherrington–Kirkpatrick) so the
      solver is not judged on portfolios alone
- [ ] Criterion benchmarks published alongside the study rather than run ad hoc

## Workbench (`agent/workbench/`)

Done:

- [x] Point-in-time walk-forward on Binance daily closes; 1/N, HRP, momentum, min-variance,
      buy-and-hold baselines at 0/10/30 bps
- [x] Published study: 39 assets, K=8, 234 rebalances, exact ground truth on 100 %
- [x] `gap_norm` as the headline measure; `gap_rel` reported with its instability explained
- [x] Report viewer `dashboard/workbench.html`

Next:

- [ ] Automatic on-chain publication of live rebalances through the `separatrix` program
- [ ] A second universe (equities or a broader crypto set) to check the conclusions transfer

## Verification (`programs/`, bridges, dashboards)

Done:

- [x] `separatrix` program: create / write / seal / publish / reveal with on-chain re-scoring;
      hardened after adversarial review; measured compute units in `docs/onchain.md`
- [x] `leash` program: vault PDA, per-tx cap, daily budget, allowlist, kill switch, withdraw;
      exercised end to end on devnet
- [x] Committed IDLs with deterministic generators, diffed in CI; SBF lockfile guard
- [x] TypeScript bridges for both programs; fail-closed Python client for leash; Python
      commitment client for separatrix
- [x] Owner console (`dashboard/owner.html`) with its encoder byte-checked against Anchor

Next:

- [ ] `close_leash` (reclaim rent, retire an agent)
- [ ] SPL-token vaults (USDC budgets, not just SOL)
- [ ] Rolling-window budgets instead of UTC-day reset; per-recipient caps
- [ ] Packaged TypeScript SDK; native `anchorpy` client to replace the subprocess bridge
- [ ] Event indexer + webhook for spend / block notifications
- [ ] Anchor suites in CI against a local validator

## Quantum (`quantum/`, `scripts/heron_qaoa.py`)

Done:

- [x] SCS Dicke preparation + XY-ring mixer as a verified gate IR; fidelity floor 1 − 10⁻⁹
- [x] Like-for-like compile arms (all-to-all, heavy-hex, linear) with one pass sequence
- [x] Selene backend via generated Guppy, `measure_leaked`, emission self-check
- [x] 35-point committed characterisation; leakage separated from sector loss
- [x] QAOA pipeline for IBM Heron, verified in simulation, `--dry-run` on by default

Next:

- [x] One-level divide-and-conquer Dicke construction (Aktar et al.) alongside SCS, verified
      to the same floor; measured on all-to-all (`docs/primitives.md` §8)
- [ ] Run the divide-and-conquer arm through the full three-architecture noise sweep
- [ ] A cheaper three-qubit controlled-Ry gadget in the IR (the measured gap to published
      CNOT counts is almost entirely that decomposition)
- [ ] Recursive all-to-all-optimal construction (Bärtschi–Eidenbenz 2022, O(k log(n/k)) depth)
- [ ] Transpiler-seed sweep on the heavy-hex arm so the routing tax is a distribution
- [ ] Calibrated `QSystemErrorModel` through Nexus, side by side with the stand-in
- [ ] A hardware run: Helios (Phase 2 of the SG Grand Challenge, finalists only) and/or
      `ibm_kingston` on the IBM Open Plan. Until then every hardware column reads NOT RUN.

## Non-Goals For Now

- Mainnet deployment of either program before an audit
- Custodying user funds beyond devnet experiments
- General-purpose smart-wallet features; leash stays a narrow, auditable spending firewall
- Any claim of quantum advantage or speedup
