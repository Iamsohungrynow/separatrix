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
- [x] Static dashboard shell

## Phase 1: Real Agent Inputs

- [ ] arXiv fetcher with deduplication
- [ ] Google News RSS fetcher
- [ ] Jupiter price fetcher
- [ ] CoinGecko fallback
- [ ] Groq-backed scorer
- [ ] Signal generator and validator using live inputs

## Phase 2: Solana Devnet Integration

- [ ] Run `anchor test` against local validator
- [ ] Deploy `policy_controller` to devnet
- [ ] Replace local policy simulator with `anchorpy` client
- [ ] Expose on-chain state through the API
- [ ] Add explorer links to trades and status responses

## Phase 3: Public API + Monetization

- [ ] x402 middleware on paid routes
- [ ] Buyer-demo flow on devnet
- [ ] Settlement logging
- [ ] Rate limiting and request hardening
- [ ] Collapse the split Python environments once upstream package ranges converge

## Phase 4: Public Demo

- [ ] Replace the static dashboard shell with a live UI
- [ ] Run the agent for 48h+
- [ ] Capture screenshots and a short demo
- [ ] Add CI for Python and Anchor

## Non-Goals For The Current MVP

- Live mainnet trading
- ZK proof verification service
- Copy-trade vaults
- Multi-vertical platform features

Those may come later, but they are intentionally outside the first credible open-source slice.
