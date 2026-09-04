# Documentation Index

Use this folder as the stable entrypoint for project context.

## Start Here

- [`../README.md`](../README.md): what Separatrix is, live addresses, results, quick starts
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): setup for the three toolchains, the check
  matrix, the rules for claims
- [`../AGENT.md`](../AGENT.md): the denser operating guide for humans and coding agents,
  invariants first
- [`../CHANGELOG.md`](../CHANGELOG.md): what landed when
- [`../SECURITY.md`](../SECURITY.md): how to report a vulnerability

## Binding Contracts

Each of these governs a surface; read the contract before changing the surface.

- [`workbench.md`](workbench.md): portfolio formulation, walk-forward rules, metrics
  (`gap_norm` is the headline), and the JSON protocol between Python and `separatrix-cli`
- [`onchain.md`](onchain.md): the `separatrix` program byte by byte — account sizes and rent,
  both hash preimages, the LSB-first bitmap, measured compute units, and what the program
  does *not* prove
- [`design.md`](design.md) and [`security.md`](security.md): the `leash` program model,
  bridge model, demo-agent model, threat model, and known limitations
- [`primitives.md`](primitives.md): the `quantum/` package — Dicke + XY-ring conventions,
  the three-arm compile protocol, the Selene route, the committed 35-point run, prior art,
  and the two corrections that must not be re-introduced
- [`quantum.md`](quantum.md): `scripts/heron_qaoa.py` — what QAOA does here, what will and
  will not be claimed, IBM access and pricing, how to run it on hardware

## Planning

- [`ROADMAP.md`](ROADMAP.md): per-pillar done / next lists and the non-goals

## When To Read What

- Working on the Anchor programs: `design.md`, `security.md`, `onchain.md`, the relevant
  `tests/anchor/*.ts`, and the IDL rule in `AGENT.md` (update the generator with any
  interface change)
- Working on the solver or the study: `workbench.md` first, then `separatrix/README.md`
- Working on the Python runtime: `design.md`, then `CONTRIBUTING.md`
- Working on the quantum side: `primitives.md` (characterisation) or `quantum.md` (QAOA),
  then the module docstrings, which are the source of truth for conventions
- Working on docs or demos: `README.md` and `ROADMAP.md`, and keep every claim narrower
  than the evidence

## Current Validation Surface

Green in CI on every push:

- `python -m ruff check agent quantum scripts tests` and
  `python -m unittest discover -s tests -v` (406 tests)
- the pytket layer of `tests/test_quantum_dicke.py` (68 tests; Selene-dependent ones skip
  in CI and run locally)
- `npm run lint:ts`, `npm run check:sbf-lockfile`, and IDL-vs-generator diffs
- inside `separatrix/`: `cargo fmt --check`, `cargo test --workspace`,
  `cargo clippy --workspace --all-targets -- -D warnings`, the `wasm32` check, and
  `cargo doc` with warnings as errors

Run locally, not in CI:

- the full quantum suite in `.venv-quantinuum` (needs `requirements-quantinuum.txt`)
- `npm run devnet:smoke` and `npm run separatrix:smoke` (they move real devnet SOL)
- `npm run test:anchor` (needs a local validator)
- `anchor build`'s IDL step (host-toolchain sensitive; the committed IDL + generators is the
  supported path)

Treat that distinction seriously when updating docs or PR descriptions.
