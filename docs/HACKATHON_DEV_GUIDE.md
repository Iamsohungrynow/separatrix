# Hackathon Dev Guide

This guide is for shipping useful work in this repo quickly without creating a mess.

Hackathon speed is not an excuse for amateur engineering. Work here should look like it came from someone who understands production tradeoffs, data modeling, testing discipline, and Solana/Anchor constraints.

## Goal

Optimize for a credible demo, not a sprawling platform. Every change should make one of these stronger:

- local scaffold reliability
- policy-controller clarity
- devnet readiness
- demo quality

The standard is simple:

- build like a senior engineer
- test like you expect failure
- document like someone else has to extend it tomorrow
- keep claims narrower than the evidence

## Professional Standard

Every contributor should behave as if they are responsible for the long-term health of the codebase.

- Understand the surrounding module before editing it.
- Respect interfaces, invariants, and data flow.
- Prefer explicit logic over clever shortcuts.
- Treat schema changes, policy logic, and trade execution as high-risk surfaces.
- Leave code in a state that another strong engineer can review quickly.

This repo is small, but the expected engineering bar is not small.

## Required Engineering Mindset

Work as if you are already fluent in:

- Python application structure
- SQLite schema design and persistence behavior
- API contract stability
- TypeScript test scaffolding
- Rust and Anchor account constraints
- failure modes in deployment and policy enforcement

If you are not sure about one of those surfaces, slow down, read the code, and verify assumptions before editing.

## Best Workstreams

### 1. Python Runtime

Good targets:

- improve `agent/main.py`
- flesh out `agent/ingestion/`
- add real scoring logic in `agent/scoring/`
- improve API responses in `agent/api/server.py`
- harden persistence in `agent/db/database.py`

Ship when:

- Python tests stay green
- the local scaffold still runs with `--once`
- the code is understandable without verbal explanation
- state transitions and edge cases were actually checked, not assumed

### 2. Policy Controller

Good targets:

- tighten rule enforcement in `programs/policy_controller/src/lib.rs`
- expand TypeScript coverage in `tests/anchor/policy_controller.ts`
- improve deployment scripts under `scripts/`

Ship when:

- `cmd /c npm run lint:ts` stays green
- docs clearly state whether Anchor runtime validation was actually run
- account constraints, signer rules, and sequence logic were reviewed carefully
- the change would survive scrutiny from an Anchor maintainer

### 3. Demo / Developer Experience

Good targets:

- improve README clarity
- improve dashboard shell in `dashboard/`
- clean scripts and docs
- reduce setup ambiguity on Windows

Ship when:

- a new contributor can tell what works in under five minutes
- the docs do not hide sharp edges or unresolved gaps

## Fast Setup

### Python

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python -m agent.main --init-db --once
```

### API

```powershell
uvicorn agent.api.server:app --reload
```

### TypeScript Check

```powershell
cmd /c npm install
cmd /c npm run lint:ts
```

### Solana / Anchor

Use the repo scripts first:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-devnet.ps1
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
```

If Anchor work is blocked, do not fake success in docs. Note the exact blocker.

## What Counts As Done

A change is ready when all of these are true:

1. the code path is understandable from filenames and docs
2. the relevant local checks pass
3. the README and docs do not overclaim
4. no local secrets or temp artifacts were introduced into tracked files
5. edge cases were examined deliberately
6. the implementation would not embarrass you in front of a senior reviewer

## Testing Discipline

Test carefully and assume the first version is incomplete.

- Run the narrowest relevant check while developing.
- Run the broader suite before calling the work done.
- Inspect failure paths, not just happy paths.
- If a change touches state, policy, or sequence handling, verify rejection behavior too.
- If you did not run a check, say so plainly.

Minimum verified paths for most changes:

- Python changes: `python -m unittest discover -s tests -v`
- TypeScript / Anchor test changes: `cmd /c npm run lint:ts`
- local runtime changes: `python -m agent.main --init-db --once`

For policy-sensitive work, think in invariants:

- what must never happen
- what must happen exactly once
- what must fail closed
- what sequence assumptions must hold

That is the level of care expected here.

## Recommended Commit Strategy

Prefer commit themes like:

- `feat: improve local signal generation`
- `fix: harden env loading on Windows`
- `test: cover policy rejection paths`
- `docs: clarify devnet setup`

Avoid mixing product logic, docs, and deployment changes in one commit unless they are tightly coupled.

Each commit should tell a coherent engineering story. A reviewer should be able to answer:

- what changed
- why it changed
- how it was checked
- what remains intentionally unfinished

## Known Constraints

- Python and x402/Anchor Python work are split across different requirements files for dependency reasons
- Anchor runtime validation is not the default CI path yet
- The Python executor still uses the local simulator instead of submitting live Anchor approvals

Build around those constraints instead of pretending they do not exist.

## Do Not Burn Time On

- mainnet ambitions
- speculative platform features
- abstract architecture churn
- rewriting folder names just for aesthetics

The repo gets cleaner when workflows are clearer, not when files are shuffled without payoff.

## Final Rule

Move fast, but do not work loosely.

This repo should feel like it is being built by someone who is careful with money-adjacent systems, serious about code review, and familiar with professional engineering standards. That is the bar for every change.
