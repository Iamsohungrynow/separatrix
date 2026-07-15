# Roadmap

This roadmap tracks the code that actually exists in the repository, not the broader vision deck.

## Phase 0: Repo Credibility

- [x] Honest README with exact status and scope
- [x] Pinned Solana / Anchor versions
- [x] Python project skeleton
- [x] SQLite schema and local execution path
- [x] Anchor workspace scaffold
- [x] Policy controller program scaffold
- [x] Local Python tests
- [x] Separate Python dependency tracks for `anchorpy` and x402 SVM work
- [x] API-backed static dashboard shell

## Phase 1: Real Agent Inputs

- [x] arXiv fetcher with deduplication
- [x] Google News RSS fetcher
- [x] Jupiter price fetcher
- [x] CoinGecko fallback
- [x] Groq-backed scorer
- [x] Signal generator and validator using live inputs
- [x] Persist raw items and model scores from live cycles

## Phase 2: Solana Devnet Integration

- [ ] Run `anchor test` against local validator
- [ ] Deploy `policy_controller` to devnet
- [x] Add explicit devnet policy initialization and smoke scripts
- [x] Add fail-closed Python devnet policy submission through the Anchor command bridge
- [ ] Replace the command bridge with a native `anchorpy` client
- [x] Expose on-chain state through the API
- [x] Add explorer links to trades and status responses

## Phase 3: Public API + Monetization

- [ ] x402 middleware on paid routes
- [ ] Buyer-demo flow on devnet
- [ ] Settlement logging
- [ ] Rate limiting and request hardening
- [ ] Authorization for protected API operations once exposed beyond localhost
- [ ] Collapse the split Python environments once upstream package ranges converge

## Phase 4: Public Demo

- [ ] Host and polish the API-backed dashboard
- [ ] Run the agent for 48h+
- [ ] Capture screenshots and a short demo
- [x] Add CI for Python and TypeScript checks
- [ ] Add CI for Anchor once the build backend is available

## Non-Goals For The Current MVP

- Live mainnet trading
- ZK proof verification service
- Copy-trade vaults
- Multi-vertical platform features

Those may come later, but they are intentionally outside the first credible open-source slice.
