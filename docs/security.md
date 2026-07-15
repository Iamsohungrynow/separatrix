# Security

## Threat Model

Leash's job is to bound the blast radius of a misbehaving or compromised agent. The interesting attacker is the agent itself: a prompt-injected LLM, a buggy strategy loop, or a stolen agent key.

What a fully compromised **agent key** can do:

- spend at most `per_tx_cap` per transaction and at most the remaining daily budget per UTC day
- only to allowlisted recipients (when enforcement is on)
- nothing at all once the owner halts

What it cannot do: raise its own limits, change the allowlist, un-halt itself, withdraw the vault, or touch anything but the vault via the program. `has_one` constraints bind every instruction to the configured owner/agent keys.

What a compromised **owner key** can do: everything. The owner is root — keep that key cold and never give it to automation.

## Enforcement Properties

- All spend rules run in program logic; a blocked spend is a failed transaction, not a logged warning.
- The vault is a program-derived account; nothing but the program can sign value out of it.
- Day-roll accounting uses on-chain clock time (UTC day index), not client-supplied timestamps.
- Arithmetic uses checked ops; overflow aborts the instruction.
- The Python/TypeScript bridge fails closed: RPC down, program missing, timeout, or malformed output all surface as rejections. There is deliberately no "skip chain and continue" fallback, and none should ever be added.

## Known Limitations (devnet software, not audited)

- SOL only; SPL-token vaults are roadmap.
- The daily budget resets at the UTC day boundary; an agent can spend `daily_cap` just before midnight and again just after. Treat `daily_cap` as "per ~24h window" with that caveat.
- The allowlist holds at most 8 recipients.
- One leash per agent key (the PDA is seeded by agent pubkey alone).
- Fee lamports: the agent wallet pays transaction fees from its own tiny balance, which the program does not cap.
- No audit has been performed. Do not deploy to mainnet with meaningful funds.

## Operational Guidance

- Three-wallet separation: owner (cold, policy changes and halt), agent (hot, automation, fee dust only), treasury/recipients.
- Keep keypairs in `keys/` (gitignored); never commit them; use tiny devnet balances.
- Keep the FastAPI service on localhost unless auth and narrowed CORS are added; it is observability, not a control plane, but it still leaks state.
- Treat `LocalLeashClient` as a development aid, never as a security boundary.
