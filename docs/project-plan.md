# Product Positioning

QubitAlpha should be presented as a focused Solana devnet MVP, not a sprawling agent platform.

## Core Pitch

QubitAlpha is a paper-trading research agent that uses a Solana Anchor program as a policy guardrail before local portfolio state changes.

That pitch is strong because it is:

- easy to explain
- verifiable on devnet
- compatible with an open-source build-in-public workflow
- narrow enough to implement without hand-waving

## Current Narrative

The current public story should stay centered on four claims:

1. The agent can ingest niche research and news.
2. The agent can convert that into paper-trade signals.
3. The local paper portfolio only updates after policy approval.
4. The policy rules live in an Anchor program on Solana devnet.

Everything else is optional until those four claims are demonstrably true.

## What To De-Emphasize For Now

These ideas are interesting, but they dilute the repo if they dominate the README before the MVP is live:

- ZK proof verification as a second product
- copy-trade vaults
- mainnet execution
- multi-vertical expansion
- "agent economy" monetization language before x402 is wired

Keep them in roadmap or future-notes sections, not in the main promise.

## What Earns Stars

For a personal GitHub project, stars come from clarity and trust:

- the README says exactly what works
- the repo boots locally without drama
- the install story is explicit when dependencies cannot share one environment yet
- the Solana parts are pinned and inspectable
- screenshots and devnet explorer links exist
- the code looks like a real starting point instead of a pitch deck

This scaffold is meant to support that path.
