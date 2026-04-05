<div align="center">

# QubitAlpha

An autonomous research-to-signal trading scaffold for Solana devnet.

[Architecture](docs/design.md) &middot; [Security](docs/security.md) &middot; [Roadmap](docs/ROADMAP.md)

[![Python](https://img.shields.io/badge/python-3.11%2B-blue?logo=python&logoColor=white)](https://python.org)
[![Solana](https://img.shields.io/badge/solana-devnet-9945FF?logo=solana&logoColor=white)](https://solana.com)
[![Anchor](https://img.shields.io/badge/anchor-0.30.1-blue)](https://www.anchor-lang.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

> Status: scaffolded MVP. The repo now contains a real Python agent skeleton, a real Anchor policy controller, local tests, and pinned devnet setup files. It does not yet contain live market ingestion, Groq scoring, x402 payments, or a production dashboard.

## What This Repo Is

QubitAlpha is a build-in-public project around one narrow claim:

1. Read niche research and news.
2. Turn that into paper-trade signals.
3. Put Solana in the control loop with an on-chain devnet policy program.

The current repository is intentionally honest about scope. You can run the local paper-trade scaffold today. You can also deploy the Anchor policy controller on Solana devnet after installing the Solana toolchain. The full end-to-end agent is still under construction.

## What Exists Today

- Python agent scaffold with config loading, SQLite schema, local dry-run loop, and a paper-trade executor.
- FastAPI status API with `GET /health`, `GET /pnl`, `GET /signal/latest`, and `GET /signal/history`.
- Anchor program for `policy_controller` with daily BUY caps, per-trade BUY caps, monotonic trade sequence, and halt/resume.
- TypeScript Anchor test scaffold.
- Pinned devnet scripts for Solana `1.18.17` and Anchor `0.30.1`.
- Static dashboard shell in [`dashboard/`](dashboard/).

## What Does Not Exist Yet

- Live arXiv and RSS ingestion.
- Groq-backed scoring and signal generation.
- Live `anchorpy` integration from the Python executor into the deployed program.
- x402-paid API routes.
- A hosted dashboard with real trade history.

That separation is deliberate. It keeps the public repo credible while still showing a concrete Solana path.

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

For Windows, the official Solana and Anchor docs still point to WSL2 first. PowerShell wrappers are included in `scripts/setup-devnet.ps1` and `scripts/deploy.ps1` for native Windows setups that already have the Solana and Anchor binaries on `PATH`.

As of April 4, 2026, `anchorpy==0.21.0` and `x402[svm]==2.3.0` resolve against different `solders` and `construct-typing` ranges, so this repo keeps those install paths separate instead of publishing a broken one-command setup.

### 3. Devnet policy deployment

```bash
bash scripts/setup-devnet.sh
bash scripts/deploy.sh
anchor test
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-devnet.ps1
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
anchor test
```

The Python executor is not yet wired to submit Anchor transactions. The on-chain program is ready first; the client integration is the next implementation step.

## Tests

Run the current local checks with:

```bash
python -m unittest discover -s tests -v
cmd /c npm run lint:ts
```

Once the Solana and Anchor toolchain is installed, add:

```bash
anchor test
```

## Repo Layout

```text
QubitAlpha/
|-- agent/                      # Python scaffold
|-- programs/policy_controller/ # Anchor program
|-- tests/                      # Python + Anchor tests
|-- scripts/                    # devnet setup and deploy helpers
|-- dashboard/                  # static dashboard shell
`-- docs/                       # architecture, roadmap, security
```

## Public Roadmap

### Phase 1

- Replace demo trades with live ingestion and scoring.
- Add real signal generation and validation rules.
- Persist richer P&L snapshots.

### Phase 2

- Wire the Python executor to the deployed Anchor program with `anchorpy`.
- Run Anchor tests on local validator and devnet.
- Add explorer links and on-chain state reads to the API.

### Phase 3

- Enable x402 paid routes on devnet.
- Replace the static dashboard with a live frontend.
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
- `anchorpy` policy submission in `agent/trading/policy_client.py`
- x402 integration in `agent/api/server.py`
- Dashboard polish in `dashboard/`

A GitHub Actions workflow is included for Python tests and TypeScript type-checking so the repo can show basic health without requiring Solana tooling on every CI run.

## License

[MIT](LICENSE)
