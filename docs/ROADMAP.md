# Roadmap

This roadmap tracks the code that actually exists in the repository, not a vision deck.

## Phase 0: The Guardrail Core — done

- [x] `leash` Anchor program: vault PDA, per-tx cap, daily budget with UTC day roll, recipient allowlist, kill switch, owner withdraw
- [x] Deployed to devnet and exercised end to end (approved spend, cap rejection, allowlist rejection, halt, resume)
- [x] Committed IDL (`idl/leash.json`) + deterministic generator (`npm run gen:idl`) so consumers never need the Rust toolchain
- [x] TypeScript bridge CLI: init / status / deposit / spend / halt / resume / withdraw / smoke, JSON output
- [x] Fail-closed Python client (`AnchorLeashClient`) and local simulator (`LocalLeashClient`)
- [x] Demo agent: research-driven paper trader metered through the leash with real devnet SOL
- [x] Live dashboard: leash state, vault balance, budget meter, spend history with explorer links
- [x] 109 Python unit tests, TypeScript type-check, devnet smoke script

## Phase 1: Make It Adoptable

- [ ] Publish the TypeScript client as a small npm package (`@leash/sdk`): create/spend/halt/status without this repo
- [ ] Native `anchorpy` client to replace the subprocess bridge for Python consumers
- [ ] `close_leash` instruction (reclaim rent, retire an agent)
- [ ] Owner web UI: create a leash, set caps, halt from a wallet-adapter page (no CLI)
- [ ] Anchor test run wired into CI against a local validator

## Phase 2: Richer Policy

- [ ] SPL-token vaults (USDC budgets, not just SOL)
- [ ] Rolling-window budgets instead of UTC-day reset
- [ ] Per-recipient caps
- [ ] Multiple leashes per agent (seed includes owner)
- [ ] Spend memo field for on-chain audit trails

## Phase 3: Agent-Economy Integration

- [ ] x402 payment flow: the agent pays for paid API routes through the leash
- [ ] Event indexer + webhook so owners get notified on every spend/block
- [ ] Session keys: short-lived agent keys authorized against a leash

## Non-Goals For Now

- Mainnet deployment before an audit
- Custodying user funds beyond devnet experiments
- General-purpose smart-wallet features (that is Squads' job); Leash stays a narrow, auditable spending firewall
