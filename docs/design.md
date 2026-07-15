# Design

## Current MVP Boundary

The repository now implements a narrow vertical slice:

- a Python runtime that can initialize state, emit a demo signal, and execute a paper trade locally
- live arXiv/RSS ingestion, price fetchers, Groq scoring, signal generation, and validation
- a SQLite database for raw items, scores, signals, trades, positions, snapshots, and app state
- an Anchor program that models the on-chain policy rules for devnet
- a small FastAPI surface for local observability, policy status, trade history, and explorer links
- a TypeScript command bridge for fail-closed devnet policy approval from the Python runtime

The missing pieces are verified live devnet deployment, native `anchorpy` integration, x402 enforcement, and a production dashboard.

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
3. use the devnet Anchor policy client from Python through the TypeScript command bridge
4. submit BUY and SELL approvals before portfolio mutation

The current Python client uses the repo's Anchor TypeScript command bridge. Native `anchorpy` is still the preferred long-term cleanup once the dependency split is resolved.

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

Live cycles currently populate raw items, scores, validated signals, executed trades, positions, P&L snapshots, and app metadata. Paid request receipts are reserved for x402 work.
