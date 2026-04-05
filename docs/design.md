# Design

## Current MVP Boundary

The repository now implements a narrow vertical slice:

- a Python runtime that can initialize state, emit a demo signal, and execute a paper trade locally
- a SQLite database for signals, trades, positions, snapshots, and app state
- an Anchor program that models the on-chain policy rules for devnet
- a small FastAPI surface for local observability

The missing pieces are live ingestion, live scoring, and live Solana submission from Python.

## Policy Model

The policy controller is the canonical control surface for BUY activity.

Rules enforced on-chain:

- per-trade BUY cap
- daily BUY cap
- monotonic trade sequence
- halt / resume

Rules enforced off-chain for now:

- max position concentration
- drawdown stop
- stop loss

This split is deliberate. The on-chain program should stay small and auditable.

## Local vs Devnet Execution

### Local mode

`agent.main` uses a local policy simulator with the same rule shape as the Anchor program. This keeps development fast and lets the Python side evolve before the Solana toolchain is installed everywhere.

### Devnet mode

The intended devnet path is:

1. deploy `policy_controller`
2. initialize the PDA for the agent wallet
3. replace the local simulator with `anchorpy`
4. submit BUY and SELL approvals before portfolio mutation

That client wiring is the next implementation step, but the contract surface is already defined.

## Data Model

The SQLite schema stores:

- raw items
- model scores
- validated signals
- executed trades
- positions
- P&L snapshots
- app metadata
- paid request receipts

Only a subset is populated in the current scaffold. The rest is there so the schema does not need to be reinvented later.
