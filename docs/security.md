# Security

## Threat Model

The current repo is a paper-trading devnet project. It does not move real funds.

That matters because the security goal is not custody yet. The goal is controlled behavior and clean separation of concerns.

## Wallet Separation

Use three wallets once devnet deployment starts:

- owner wallet for policy changes and emergency halt
- agent wallet for submitting policy-approved trades
- treasury wallet for future paid API routes

Do not reuse the owner wallet for automation.

## Current Safety Guarantees

Implemented today:

- paper portfolio only
- explicit BUY limits in the Anchor program
- monotonic sequence checks in the Anchor program
- local and on-chain halt semantics
- `.gitignore` protection for keys and database files

Not implemented yet:

- encrypted key storage
- hosted secret management
- x402 payment enforcement
- live transaction submission from the Python executor

## Operational Guidance

- keep devnet keys in `keys/`
- do not commit raw keypairs
- use tiny devnet balances
- treat the Python local simulator as a development aid, not as a security boundary
- once `anchorpy` is wired, do not allow a "skip chain if devnet is down" fallback

That last point is important. If the project claims Solana is in the control loop, the off-chain executor should fail closed when policy approval is unavailable.
