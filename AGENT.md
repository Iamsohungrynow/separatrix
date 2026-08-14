# Leash Agent Guide

This file is the operating guide for humans and coding agents working in this repository.

## Mission

Leash is an on-chain spending firewall for AI agents on Solana devnet:

1. an owner funds a program-owned vault and sets limits (per-tx cap, daily budget, allowlist, kill switch)
2. an agent can only move value through the program's `spend` instruction, which enforces every rule fail-closed
3. a demo agent (research-driven paper trader) shows the guardrails working live

The repo is intentionally narrow. Keep changes honest, incremental, and demoable.

## Read This First

Start in this order:

1. [`README.md`](README.md) for project scope, live devnet addresses, and quick start
2. [`docs/README.md`](docs/README.md) for documentation map
3. [`docs/design.md`](docs/design.md) and [`docs/security.md`](docs/security.md) before touching program or policy logic

## Repo Map

- [`programs/leash/`](programs/leash/) contains the Anchor program (single `lib.rs`)
- [`idl/leash.json`](idl/leash.json) is the committed IDL; regenerate with `npm run gen:idl`
- [`scripts/devnet-leash.ts`](scripts/devnet-leash.ts) is the owner/agent CLI bridge
- [`scripts/gen-idl.js`](scripts/gen-idl.js) deterministically generates the IDL from the program interface
- [`agent/`](agent/) contains the Python demo agent (ingestion, scoring, executor, leash client, API)
- [`agent/trading/leash_client.py`](agent/trading/leash_client.py) owns the local simulator and the devnet bridge client
- [`tests/`](tests/) contains Python tests and the Anchor TypeScript test suite
- [`dashboard/`](dashboard/) is the static live monitor (`index.html`) and the owner console (`owner.html`)
- [`dashboard/leash-ix.js`](dashboard/leash-ix.js) is the shared browser/Node instruction encoder + account decoder
- [`scripts/verify-owner-ix.js`](scripts/verify-owner-ix.js) byte-checks that encoder against Anchor (`npm run verify:owner-ix`)
- [`docs/`](docs/) holds architecture, security, and roadmap docs

Separatrix (the second project in this repo):

- [`separatrix/`](separatrix/) is the solver crate — **its own cargo workspace**, deliberately excluded from the root one
- [`separatrix/cli/`](separatrix/cli/) is the JSON solver bridge the Python workbench shells out to
- [`programs/separatrix/`](programs/separatrix/) is its Anchor program; [`idl/separatrix.json`](idl/separatrix.json) the committed IDL
- [`scripts/devnet-separatrix.ts`](scripts/devnet-separatrix.ts) drives studies and allocations (`npm run separatrix:smoke`)
- [`agent/workbench/`](agent/workbench/) is the walk-forward harness; [`docs/workbench.md`](docs/workbench.md) is its binding contract
- [`docs/onchain.md`](docs/onchain.md) documents the preimages, account layout, and measured compute units
- [`tests/test_onchain_vectors.py`](tests/test_onchain_vectors.py) pins both on-chain preimages in a third independent implementation

## Current Truth

This repo now holds **two** projects sharing one history. Keep both descriptions honest.

**Leash** — on-chain spending guardrails:

- `leash` program deployed on devnet at `EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV`
- real SOL enforcement verified live: approved spend, per-tx cap rejection, allowlist rejection, halt/resume
- committed IDL loaded by the bridge (no anchor build needed to use the deployed program)
- fail-closed Python spend path through the TypeScript bridge
- demo agent, FastAPI observability endpoints, live dashboard

**Separatrix** — quantum-inspired portfolio solver, plus a Solana program that verifies committed allocations:

- `separatrix` crate published on crates.io: simulated bifurcation (bSB/dSB) plus SA, parallel tempering, and exact enumeration as ground truth
- walk-forward workbench: 39 assets, K=8, 234 weekly rebalances with a proven optimum on 100% of them (see `docs/workbench.md`, `dashboard/workbench.html`). **This study is off-chain** — a published report, no part of it recorded on the separatrix program
- `separatrix` program deployed on devnet at `CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp`: commit-before-execution plus on-chain re-derivation of an allocation's objective, with measured compute units in `docs/onchain.md`. Limits are `n <= 48` and `k <= MAX_CARDINALITY = 40`; `create_study` requires the authority **and** the agent to sign
- the studies that exist on-chain are separate and much smaller, created to exercise and measure the program — they are not the walk-forward study
- verified end to end on devnet against the hardened build: the objective the chain computed equals the solver's, exactly (n=8, k=4, reveal `DoNokzvPXDyMkq8V42wERNr5PCZRizAbKwJrDCJ2GZjoADSi8hWR2bGfnC3gsTvh2LdNoqG4SZMDPnUVPPav7MB`)

Repo-wide: 338 Python tests, 26 Rust tests, TypeScript type-check, and the 19-test Anchor suite for separatrix all green.

Not implemented yet:

- npm-packaged SDK, native `anchorpy` client, SPL-token vaults, x402 flow, hosted dashboard
- the workbench does not yet publish its live rebalances to the separatrix program automatically
- no browser WASM demo, no real-quantum-hardware run, no solver bounty

Do not write docs or commit messages that imply those pieces already work.

## Critical Invariant: IDL Sync

`anchor build`'s IDL generation is broken on this host (rustc-version sensitivity), so each committed IDL is generated by a hand-mirrored script:

| Program | Source | Generator | Command | Byte-check |
| --- | --- | --- | --- | --- |
| leash | `programs/leash/src/lib.rs` | `scripts/gen-idl.js` | `npm run gen:idl` | `npm run verify:owner-ix` |
| separatrix | `programs/separatrix/src/lib.rs` | `scripts/gen-separatrix-idl.js` | `npm run gen:idl:separatrix` | `npm run verify:separatrix-idl` |

**If you change any instruction, account, event, or error in either program, you MUST update that program's generator to match, regenerate, rebuild, and redeploy.** A stale IDL produces wrong discriminators and every bridge call fails. CI diffs both committed IDLs against their generators, so drift fails the build rather than surfacing on devnet.

Two more build invariants worth knowing before you touch Rust:

- The SBF toolchain's cargo 1.75 reads **lockfile v3 only**, and any modern host cargo touching the workspace silently rewrites `Cargo.lock` to v4. `npm run check:sbf-lockfile` catches that (and any host-side crate leaking into the program workspace) — it runs in CI. The fix is in the error message.
- The `separatrix/` solver crate is a **separate cargo workspace**, excluded from the root one on purpose. Its dependency tree must never enter the SBF lockfile.

The owner console's `dashboard/leash-ix.js` also hardcodes discriminators and the `LeashState` byte layout. If you change the program interface, update it too and re-run `npm run verify:owner-ix`, which byte-compares its output against Anchor and fails loudly on any drift.

## Working Rules

- Prefer small, reviewable commits with one theme each.
- Keep Python-side changes covered by `tests/`.
- Keep Anchor logic small and explicit; policy rules should be auditable.
- Fail closed around spend approval. Do not add a "skip chain and continue" path for devnet mode.
- Avoid moving files unless the move clearly improves navigation and does not break imports or scripts.

## Multi-Agent Reality

Assume you are not the only agent working on this repository.

- Other agents may be working in parallel on overlapping files or adjacent features.
- Your job is not just to produce output. Your job is to produce mergeable, defensible output.

That means:

- inspect current files before editing them
- avoid broad rewrites unless they are necessary
- do not revert or overwrite work you did not create unless the user explicitly asks for it
- leave changes easy to review and easy to merge
- if a file looks actively in flux, prefer the smallest safe change

## Execution Standard

Operate like a disciplined execution partner, not a passive autocomplete tool.

- Be critical about assumptions.
- Push back on weak ideas when the code or constraints do not support them.
- Prefer a correct narrow fix over a flashy fragile rewrite.
- Verify claims with tests or direct inspection whenever possible.
- If something is unclear, say exactly what is unclear instead of bluffing.

Low-trust behavior is unacceptable here:

- pretending something works when it was not verified
- writing docs that overclaim implementation status
- making risky edits without checking surrounding code
- choosing speed over correctness when the change touches policy, money flow, or deployment

If there is a tradeoff between shipping fast and shipping something brittle, bias toward the change that survives review.

## Safe Commands

Python checks:

```powershell
python -m unittest discover -s tests -v
```

TypeScript check:

```powershell
cmd /c npm run lint:ts
```

Local scaffold smoke test:

```powershell
python -m agent.main --init-db --once
```

Devnet status (read-only):

```powershell
cmd /c npm run devnet:status
```

API server:

```powershell
uvicorn agent.api.server:app --reload
```

## Solana / Anchor Notes

- The source tree targets `anchor-lang 0.30.1` and the Solana 1.18 SBF toolchain.
- Build the program with `cargo build-sbf --manifest-path programs/leash/Cargo.toml`; do not rely on `anchor build`'s IDL step (see the IDL invariant above).
- The SBF toolchain's cargo only reads lockfile v3. If host cargo rewrites `Cargo.lock` to `version = 4`, downgrade the header: `sed -i 's/^version = 4$/version = 3/' Cargo.lock`.
- The dependency pins in `programs/leash/Cargo.toml` exist to keep the tree buildable on the SBF toolchain's rustc 1.75. Do not update them casually.
- Devnet helpers live under [`scripts/`](scripts/).

## Secrets And Local State

Never commit:

- `.env`
- anything under `keys/`
- anything under `secrets/`
- database files
- temp publish folders
- tool downloads

Those paths are ignored on purpose. Keep them that way.

## Recommended Contribution Order

1. keep the Python suite and TS lint green
2. improve program/policy test coverage
3. make the SDK consumable outside this repo (npm package, anchorpy client)
4. improve dashboard and demo quality
5. add richer policy (SPL vaults, rolling windows) only after the core stays credible
