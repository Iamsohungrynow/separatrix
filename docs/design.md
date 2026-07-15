# Design

## What Leash Is

Leash is an on-chain spending firewall for AI agents on Solana. The unit of trust is inverted from the usual agent-wallet setup: instead of trusting the agent's process to respect limits, the owner funds a program-owned vault and the program enforces the limits on every spend, fail-closed.

The repository has three layers:

1. **The program** (`programs/leash/`) — a single-file Anchor program holding the policy state and the vault, and enforcing every rule at `spend` time.
2. **The bridge** (`scripts/devnet-leash.ts` + `idl/leash.json`) — a TypeScript CLI that owners and agents (including the Python client) drive; every result is a JSON line so machines can consume it.
3. **The demo agent** (`agent/`) — a deliberately untrusted consumer: a research-driven paper trader whose BUYs must clear the leash with real devnet SOL before the paper trade executes.

## Program Model

Accounts:

- `LeashState` PDA at `["leash", agent_pubkey]` — owner, agent, caps, spent-today accumulator, day index, totals, halt flag, allowlist (max 8), bumps. One leash per agent key.
- Vault PDA at `["vault", leash_pubkey]` — a system-owned account holding lamports; only the program can sign transfers out of it (`invoke_signed`).

Rules enforced on-chain, in order, at `spend`:

1. amount > 0
2. not halted
3. UTC day roll (resets `spent_today`)
4. amount <= per-tx cap
5. spent_today + amount <= daily cap
6. recipient in allowlist (when enforced)
7. vault balance sufficient

Only then does the CPI transfer run and the accumulators update. A `SpendExecuted` event is emitted for indexers.

Rules deliberately kept off-chain (demo-agent concerns, not custody concerns): position concentration, drawdown stops, stop losses. The program stays small enough to audit in one sitting.

## Bridge Model

The Python client shells out to `npm run devnet:spend` / `devnet:status-json` and parses a single JSON line. Design rules:

- Fail closed: nonzero exit, timeout, missing binary, or malformed output are all rejections, never approvals.
- Typed rejections: on-chain errors map to stable reason strings (`LEASH_HALTED`, `PER_TX_CAP_EXCEEDED`, `DAILY_CAP_EXCEEDED`, `RECIPIENT_NOT_ALLOWED`, `VAULT_INSUFFICIENT`, ...).
- No toolchain at runtime: the bridge loads the committed `idl/leash.json` and constructs the program client directly; `anchor build` is only needed to modify the program itself.

A native `anchorpy` client remains a cleanup candidate, but the subprocess bridge is the honest, tested path today.

## Demo Agent Model

`agent.main` runs ingest -> score -> validate -> execute. The executor converts a BUY of N paper-USDC into a leash spend of `N * SOL_PER_USDC_BUDGET` SOL (default 0.001). The on-chain spend is budget metering — real value leaves the vault to the configured recipient — while the trade itself stays paper. SELLs release no vault funds and need no on-chain approval.

Local mode (`ENABLE_DEVNET_LEASH=false`) swaps in `LocalLeashClient`, an in-process simulator with the same rule shape, so the Python side can be developed and tested without a cluster.

## Data Model

The SQLite schema stores raw items, model scores, validated signals, executed trades (with devnet tx signatures), positions, P&L snapshots, and app metadata. The FastAPI surface (`/health`, `/leash`, `/pnl`, `/signal/*`, `/trades`) exposes it to the dashboard, which renders leash state and spend history with explorer links.
