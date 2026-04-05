# QubitAlpha Agent Guide

This file is the operating guide for humans and coding agents working in this repository.

## Mission

QubitAlpha is a narrow Solana devnet MVP:

1. ingest research and market context
2. turn that into paper-trade signals
3. enforce policy checks before portfolio state changes

The repo is intentionally not a full trading system yet. Keep changes honest, incremental, and demoable.

## Read This First

Start in this order:

1. [`README.md`](README.md) for project scope and quick start
2. [`docs/README.md`](docs/README.md) for documentation map
3. [`docs/HACKATHON_DEV_GUIDE.md`](docs/HACKATHON_DEV_GUIDE.md) for contributor workflow
4. [`docs/design.md`](docs/design.md) and [`docs/security.md`](docs/security.md) before touching policy logic

## Repo Map

- [`agent/`](agent/) contains the Python application scaffold
- [`agent/api/`](agent/api/) exposes local FastAPI status endpoints
- [`agent/db/`](agent/db/) owns SQLite schema and persistence
- [`agent/ingestion/`](agent/ingestion/) holds feed and price fetcher stubs
- [`agent/scoring/`](agent/scoring/) holds scoring and signal pipeline stubs
- [`agent/trading/`](agent/trading/) owns policy clients and paper-trade execution
- [`programs/policy_controller/`](programs/policy_controller/) contains the Anchor program
- [`tests/`](tests/) contains Python tests and Anchor TypeScript tests
- [`scripts/`](scripts/) contains environment setup and deployment helpers
- [`dashboard/`](dashboard/) is the static frontend shell
- [`docs/`](docs/) holds architecture, roadmap, security, and workflow docs

## Current Truth

Implemented and testable today:

- local Python scaffold
- SQLite-backed paper portfolio state
- local policy simulator
- FastAPI observability endpoints
- Anchor policy controller source and TypeScript test scaffold

Not wired yet:

- live ingestion
- live LLM scoring
- `anchorpy` trade submission
- x402 payment flow
- production dashboard

Do not write docs or commit messages that imply those pieces already work.

## Working Rules

- Prefer small, reviewable commits with one theme each.
- Keep Python-side changes covered by `tests/`.
- Keep Anchor logic small and explicit; policy rules should be auditable.
- Fail closed around policy approval. Do not add a "skip chain and continue" path for devnet mode.
- Avoid moving files unless the move clearly improves navigation and does not break imports or scripts.

## Multi-Agent Reality

Assume you are not the only agent working on this repository.

- Other agents may be working in parallel on overlapping files or adjacent features.
- Another agent may be faster, sloppier, or operating with weaker context.
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

API server:

```powershell
uvicorn agent.api.server:app --reload
```

## Solana / Anchor Notes

- The source tree targets `anchor-lang 0.30.1`.
- Devnet helpers live under [`scripts/`](scripts/).
- Anchor runtime validation is not part of the default CI yet.
- If Anchor commands fail locally, check `Anchor.toml`, CLI version alignment, and wallet paths before changing code.

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

1. stabilize local Python behavior
2. improve test coverage
3. wire Solana client integration
4. improve dashboard and demo quality
5. add paid-route / x402 work only after the control loop is credible
