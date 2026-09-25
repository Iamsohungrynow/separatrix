# Security policy

## Supported versions

There are no tagged releases. Only the `main` branch is supported, and only at its current head.

The Solana programs (`programs/leash`, `programs/separatrix`) are deployed on **devnet only**. They are unaudited. Do not deploy either of them to mainnet with real funds, and do not treat a devnet deployment as evidence that it would be safe to.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. That creates a private advisory that only the maintainer can see.

If the button is missing, private reporting has not been enabled yet. Open a plain issue that says only "please enable private vulnerability reporting" (mention @Iamsohungrynow) and put nothing else in it; the maintainer will enable it and you can file the report there.

There is no security email address. Please do not put vulnerability details in public issues, pull requests, or discussions.

## Scope

In scope:

- the Anchor programs `programs/leash` and `programs/separatrix`, including account constraints, signer rules, arithmetic bounds, and the commitment preimages
- the bridge scripts under `scripts/` (`devnet-leash.ts`, `devnet-separatrix.ts`, the IDL generators and verifiers, the setup and deploy scripts)
- the FastAPI service in `agent/api`
- the owner console `dashboard/owner.html` and its instruction encoder `dashboard/leash-ix.js`
- Separatrix Studio, the browser app in `site/`

Out of scope:

- loss of devnet test funds
- outages, rate limits, or behaviour of third-party RPC providers
- the demo agent's paper-trading logic (`agent/ingestion`, `agent/scoring`, `agent/trading`); it exists to exercise the guardrails and is deliberately untrusted
- issues in upstream dependencies without a demonstrated impact on this repository

Findings about the *strength of a claim* (a number that is overstated, a doc that says more than the evidence supports) are welcome too, but they are not security issues; use the `claim:` issue template instead.

## What to expect

- Acknowledgement within 7 days, on a best-effort basis; this is a small project with one maintainer.
- A fix or a documented limitation on `main`, with credit in the commit or advisory if you want it.
- No bug bounty. There is no budget for one.

## Further reading

- [`docs/security.md`](docs/security.md): the Leash threat model, its enforcement properties, and the known limitations of the program.
- [`docs/onchain.md`](docs/onchain.md), section 7: what the separatrix program does **not** prove. Read it before relying on any on-chain record it produces.
