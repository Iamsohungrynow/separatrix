<div align="center">

# QubitAlpha

An autonomous research-to-signal trading scaffold for Solana devnet.

[Docs Index](docs/README.md) &middot; [Agent Guide](AGENT.md) &middot; [Hackathon Dev Guide](docs/HACKATHON_DEV_GUIDE.md) &middot; [Architecture](docs/design.md) &middot; [Roadmap](docs/ROADMAP.md)

[![Python](https://img.shields.io/badge/python-3.11%2B-blue?logo=python&logoColor=white)](https://python.org)
[![Solana](https://img.shields.io/badge/solana-devnet-9945FF?logo=solana&logoColor=white)](https://solana.com)
[![Anchor](https://img.shields.io/badge/anchor-0.30.1-blue)](https://www.anchor-lang.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

> Status: scaffolded MVP. The repo now contains a real Python agent skeleton, a real Anchor policy controller, local tests, live local-policy ingestion/scoring, and pinned devnet setup files. It does not yet contain x402 payments or a production dashboard.

## What This Repo Is

QubitAlpha is a build-in-public project around one narrow claim:

1. Read niche research and news.
2. Turn that into paper-trade signals.
3. Put Solana in the control loop with an on-chain devnet policy program.

The current repository is intentionally honest about scope. You can run the local paper-trade scaffold today. You can also deploy the Anchor policy controller on Solana devnet once the Solana toolchain and a supported Anchor build backend are installed. The full end-to-end agent is still under construction.

## Engineering Standard

This repository is meant to be credible, inspectable, and reviewable.

- Claims in the README should map to code that exists.
- Checks that are described as green should actually have been run.
- Policy, state, and deployment logic should be treated as high-risk surfaces.
- Fast iteration is fine; sloppy engineering is not.

The standard for contributions is closer to "small professional system" than "hackathon prototype held together by optimism."

## Documentation

Use these files as the stable navigation layer:

- [`AGENT.md`](AGENT.md): repository operating guide for contributors and coding agents
- [`docs/README.md`](docs/README.md): documentation map
- [`docs/HACKATHON_DEV_GUIDE.md`](docs/HACKATHON_DEV_GUIDE.md): fast contributor workflow for shipping during a hackathon
- [`docs/design.md`](docs/design.md): architecture boundary and execution model
- [`docs/security.md`](docs/security.md): threat model and safety rules
- [`docs/ROADMAP.md`](docs/ROADMAP.md): implementation phases

## What Exists Today

- Python agent scaffold with config loading, SQLite schema, local dry-run loop, and a paper-trade executor.
- Live arXiv/RSS ingestion, Jupiter/CoinGecko price fetchers, Groq-backed scoring, signal generation, and validation.
- Raw item, score, signal, trade, position, and P&L persistence in SQLite.
- FastAPI status API with `GET /health`, `GET /policy`, `GET /pnl`, `GET /signal/latest`, `GET /signal/history`, and `GET /trades`.
- Anchor program for `policy_controller` with daily BUY caps, per-trade BUY caps, monotonic trade sequence, and halt/resume.
- Fail-closed Python-to-devnet policy approval through the repo's Anchor TypeScript command bridge.
- TypeScript Anchor test scaffold.
- Pinned devnet scripts for Solana `1.18.17` and Anchor `0.30.1`.
- Static API-backed dashboard in [`dashboard/`](dashboard/).

## What Does Not Exist Yet

- Native `anchorpy` integration from the Python executor into the deployed program. The current devnet path uses the repo's Anchor TypeScript command bridge.
- x402-paid API routes.
- A hosted production dashboard.

That separation is deliberate. It keeps the public repo credible while still showing a concrete Solana path.

## Validation Surface

Verified in the default local workflow:

- Python unit tests
- TypeScript type-check / test scaffold validation
- local paper-trade scaffold run path
- Solana Rust source check with `cargo +solana check --manifest-path programs/policy_controller/Cargo.toml`

Not part of the default verified path yet:

- `anchor test` (the TypeScript test suite has not been run against the live program)

Devnet deployment, verified on June 21, 2026:

The `policy_controller` program is live on Solana devnet. `anchor build` now
produces `target/deploy/policy_controller.so` on this host (see the dependency
pins in `programs/policy_controller/Cargo.toml` and `scripts/gen-idl.py` for the
IDL), and the program was deployed and exercised end to end.

- Program id: [`Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG`](https://explorer.solana.com/address/Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG?cluster=devnet)
- Policy PDA: [`DrRXobtrawrvFspoMrjVPxG5r76mD1kS49HRDTgoiFUx`](https://explorer.solana.com/address/DrRXobtrawrvFspoMrjVPxG5r76mD1kS49HRDTgoiFUx?cluster=devnet)
- `initialize_policy`: [tx](https://explorer.solana.com/tx/3hSG6X6PwD99GuYtG353nYjj1eN194ahbJtWvuqA53oANJQiKdMMGLXRgyHfWenn8Hzi4oEosUbB6x2vxfg2PMdp?cluster=devnet) (daily cap 10 USDC, per-trade cap 5 USDC)
- `submit_trade` BUY approved: [tx](https://explorer.solana.com/tx/3Yphd5ckjVhZwjDKbBEFLwzGGmJedK39e1Q3mxbwGBN3HsRk9U4XYBHhM3KZdGB3pWEpycp9eD71Jn7yDNA4bbHy?cluster=devnet)
- `set_halt(true)`: [tx](https://explorer.solana.com/tx/5DV32K31hxha4CGf4LPhX9xjG3vk9RngNyNvMCdzfQLUbF7APFjNo8YagRTL6La4xjqqygDKne3a9az58uATW3RC?cluster=devnet)
- `set_halt(false)` (resume): [tx](https://explorer.solana.com/tx/Yvjw7vN1SCW8oszVEngKgZC2Xor5BHCzr5nZbwHF6si56XBxFY1y8XrTxbNviLnCbz1MVv8J4dzhdJ4AeUvmxse?cluster=devnet)

- `submit_trade` BUY **rejected** on-chain (`TRADE_TOO_BIG`): [failed tx](https://explorer.solana.com/tx/3keQpYZfmuC9M9roVtz9xRKA562ZqNBZt536oFMeY7qF3PE5F8z7duazt9Cu4ixJdU3KiAYfcmX7ThRNS4NUb7Hu?cluster=devnet) — a 99 USDC BUY against the 5 USDC per-trade cap, finalized on devnet with program log `Error Code: TradeTooBig. Error Number: 6001`.

Policy enforcement is fail-closed. By default the Python/TypeScript bridge rejects
an over-cap or halted trade at transaction preflight, so it never leaves the
client. `scripts/land-rejection.ts` instead submits with `skipPreflight` so the
rejection lands on-chain as the verifiable failed transaction linked above.

This repo should never imply that unverified paths are already production-ready.
Paper trades only; no funds are custodied.

## Architecture

```
Research/news -> scoring -> signal validation -> paper-trade executor
                                              |
                                              v
                              policy_controller (Anchor on devnet)
                                              |
                                              v
                                   SQLite + FastAPI + dashboard
```

The security boundary for the MVP is the Anchor policy controller. It does not custody funds. It approves or rejects paper trades before the local portfolio mutates.

## Quick Start

### 1. Local scaffold

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m agent.main --init-db --once
uvicorn agent.api.server:app --reload
```

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
Copy-Item .env.example .env
```

Local mode uses a policy simulator with the same limit model as the Anchor program. It is there so contributors can work on the agent without needing Solana installed first.

### 2. Devnet prerequisites

Use these exact toolchain targets for the current scaffold:

- Solana CLI `1.18.17`
- Anchor CLI `0.30.1`
- Rust stable toolchain
- Node.js `20.x` LTS recommended for Anchor tooling
- `pip install -r requirements-devnet.txt` for Python-side Anchor / Solana client work
- `pip install -r requirements-x402.txt` in a separate virtualenv for x402 SVM route experiments

For Windows, the official Solana and Anchor docs still point to WSL2 first. PowerShell wrappers are included in `scripts/setup-devnet.ps1` and `scripts/deploy.ps1` for native Windows setups that already have the Solana and Anchor binaries on `PATH`, but `anchor build` still needs a supported backend such as Docker Desktop. On this host, the native Windows preflight remains blocked until Docker Desktop or WSL2 is installed.

As of April 4, 2026, `anchorpy==0.21.0` and `x402[svm]==2.3.0` resolve against different `solders` and `construct-typing` ranges, so this repo keeps those install paths separate instead of publishing a broken one-command setup.

### 3. Devnet policy deployment

```bash
bash scripts/setup-devnet.sh
bash scripts/preflight-anchor.sh
bash scripts/deploy.sh
bash scripts/init-policy.sh
bash scripts/smoke-devnet.sh
anchor test
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-devnet.ps1
powershell -ExecutionPolicy Bypass -File scripts/preflight-anchor.ps1
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
powershell -ExecutionPolicy Bypass -File scripts/init-policy.ps1
powershell -ExecutionPolicy Bypass -File scripts/smoke-devnet.ps1
anchor test
```

The Python executor can submit devnet policy approvals through the repo's Anchor TypeScript command bridge when `ENABLE_DEVNET_POLICY=true`. Native `anchorpy` integration is still a later cleanup target.

After deployment, `init-policy` initializes the policy PDA for the configured owner and agent wallets. `smoke-devnet` submits a small devnet BUY approval, verifies halt rejection, resumes the policy, and prints explorer links.

`preflight-anchor` is the required gate before Anchor build and test. It checks:

- Anchor CLI version alignment
- build backend availability
- local program-keypair / program-id consistency

If `anchor build` fails on native Windows with the vague message `program not found`, treat that as a build-backend failure first. In practice that usually means Docker Desktop is not installed or not reachable from Anchor.

## Tests

Run the current local checks with:

```bash
python -m unittest discover -s tests -v
cmd /c npm run lint:ts
```

Once the Solana and Anchor toolchain is installed, add:

```bash
bash scripts/preflight-anchor.sh
anchor test
```

At the moment, the repo should be described as:

- Python-test green
- TypeScript-check green
- Anchor source and tests scaffolded, but not part of the default green path yet

If you change behavior, the expectation is to verify the relevant path directly, not just assume the existing scaffold still holds.

## Repo Layout

```text
QubitAlpha/
|-- AGENT.md                    # contributor / coding-agent guide
|-- agent/                      # Python scaffold
|-- dashboard/                  # API-backed static dashboard
|-- docs/                       # docs index, roadmap, security, hackathon guide
|-- programs/policy_controller/ # Anchor program
|-- scripts/                    # devnet setup and deploy helpers
`-- tests/                      # Python + Anchor tests
```

## Public Roadmap

### Phase 1

- Harden live ingestion, scoring, signal generation, and validation.
- Expand persistence and audit views for raw items, scores, signals, trades, and P&L.
- Add more realistic risk controls around drawdown and concentration.

### Phase 2

- Wire the Python executor to the deployed Anchor program with `anchorpy`.
- Run Anchor tests on local validator and devnet.
- Keep the command bridge as a fallback while native `anchorpy` matures.

### Phase 3

- Enable x402 paid routes on devnet.
- Host and polish the API-backed dashboard.
- Publish demo material and CI.

Full details are in [docs/ROADMAP.md](docs/ROADMAP.md).

## Why The Scope Is Tight

If the goal is a credible open-source repo that can earn stars, the MVP has to be small enough to be true. Right now the repo is centered on one strong demo:

"A paper-trading research agent whose paper trades are guarded by a Solana devnet policy program."

That is easier to understand, easier to verify, and easier to extend than a repo that claims a full agent economy before the first vertical slice is working.

## Contributing

Useful contribution areas:

- Real fetchers in `agent/ingestion/`
- Groq scoring in `agent/scoring/`
- native `anchorpy` policy submission in `agent/trading/policy_client.py`
- x402 integration in `agent/api/server.py`
- Dashboard polish in `dashboard/`

Contribution standard:

- keep changes narrow and reviewable
- test the code path you touched
- do not overstate what is implemented
- document sharp edges and blockers plainly
- treat data flow, policy enforcement, and deployment behavior with senior-level caution

A GitHub Actions workflow is included for Python tests and TypeScript type-checking so the repo can show basic health without requiring Solana tooling on every CI run.

## License

[MIT](LICENSE)
