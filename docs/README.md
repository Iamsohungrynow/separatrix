# Documentation Index

Use this folder as the stable entrypoint for project context.

## Start Here

- [`../README.md`](../README.md): public overview, live devnet addresses, and quick start
- [`../AGENT.md`](../AGENT.md): contributor and coding-agent operating guide
- [`HACKATHON_DEV_GUIDE.md`](HACKATHON_DEV_GUIDE.md): fastest path to ship changes

## Architecture And Scope

- [`design.md`](design.md): program model, bridge model, demo-agent model
- [`security.md`](security.md): threat model, enforcement properties, known limitations
- [`ROADMAP.md`](ROADMAP.md): delivery phases and non-goals
- [`workbench.md`](workbench.md): Separatrix portfolio formulation, walk-forward
  rules, evaluation standards, and the Python/Rust solver protocol
- [`onchain.md`](onchain.md): the separatrix program's byte-level contract —
  account sizes and rent, both hash preimages, the LSB-first bitmap, measured
  compute units, and what the program does *not* prove
- [`quantum.md`](quantum.md): the *only* genuinely quantum step in the project
  (`scripts/heron_qaoa.py`) — what QAOA does here, what will and will not be
  claimed, current IBM Quantum access/pricing, and how to run it on hardware

## When To Read What

- Working on the Anchor program:
  Read `design.md`, `security.md`, and `tests/anchor/leash.ts`; note the IDL rule in `AGENT.md` (update `scripts/gen-idl.js` with any interface change)
- Working on the Python runtime:
  Read `design.md`, then `HACKATHON_DEV_GUIDE.md`
- Working on the solver or the portfolio study:
  Read `workbench.md` first — it is the binding contract for the formulation,
  the walk-forward rules, and the JSON protocol; then `separatrix/README.md`
- Working on docs or demos:
  Read `README.md` and `ROADMAP.md`

## Current Validation Surface

Green by default:

- `python -m unittest discover -s tests -v`
- `cmd /c npm run lint:ts`
- `npm run devnet:smoke` (live enforcement against the deployed devnet program)
- `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings`, run inside `separatrix/`

Not default-green yet:

- `npm run test:anchor` (needs a local validator)
- `anchor build`'s IDL step (host-toolchain sensitive; the committed IDL + `npm run gen:idl` is the supported path)

Treat that distinction seriously when updating docs or PR descriptions.
