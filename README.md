<div align="center">

# Leash

**On-chain spending guardrails for AI agents on Solana.**

Give your agent a wallet it cannot rug you with.

[Docs Index](docs/README.md) &middot; [Agent Guide](AGENT.md) &middot; [Architecture](docs/design.md) &middot; [Security](docs/security.md) &middot; [Roadmap](docs/ROADMAP.md)

[![Python](https://img.shields.io/badge/python-3.11%2B-blue?logo=python&logoColor=white)](https://python.org)
[![Solana](https://img.shields.io/badge/solana-devnet-9945FF?logo=solana&logoColor=white)](https://solana.com)
[![Anchor](https://img.shields.io/badge/anchor-0.30.1-blue)](https://www.anchor-lang.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

> Status: live on Solana devnet. The program, the TypeScript bridge, the Python client, the demo agent, and the dashboard all run end to end today. Mainnet deployment, SPL-token vaults, and a packaged SDK are roadmap items, not claims.

## The Problem

Everyone wants AI agents that can pay for things: API credits, data, trades, other agents. Nobody sane wants to hand an LLM their private key. Prompt-level guardrails ("please don't spend more than $5") are not guardrails; they are suggestions to a stochastic process.

Leash moves the guardrails onto the chain, where the agent cannot negotiate with them:

- The owner funds a **program-owned vault**. The agent's own wallet holds nothing but fee dust.
- The agent can only move value by calling `spend` on the Leash program.
- The program enforces a **per-transaction cap**, a **daily budget** (UTC day roll), and an optional **recipient allowlist**.
- The owner has a **kill switch** (`set_halt`) and can update limits or withdraw the whole vault at any time.
- Every rule is enforced in program logic, fail-closed. A blocked spend is a failed transaction, not a logged warning.

## How It Works

```text
owner keypair                          agent keypair (any AI agent)
     |                                        |
     |  create_leash / deposit /              |  spend(amount, recipient)
     |  set_allowlist / set_halt /            |
     |  update_limits / withdraw              v
     |                                +---------------+
     +------------------------------->|  Leash program |  checks: halted? per-tx cap?
                                      |   (Anchor)     |  daily budget? allowlist? vault?
                                      +-------+-------+
                                              | CPI transfer (only if every check passes)
                                              v
                                    vault PDA ---> recipient
```

State lives in a `LeashState` PDA (`["leash", agent]`); funds live in a system-owned vault PDA (`["vault", leash]`) that only the program can sign for. One leash per agent key.

| Instruction | Signer | Effect |
| --- | --- | --- |
| `create_leash(per_tx_cap, daily_cap, allowlist_enforced)` | owner | Creates the policy for an agent pubkey (no agent consent needed) |
| `deposit(amount)` | anyone | Moves SOL into the vault |
| `spend(amount)` + recipient account | agent | The only value-moving path the agent has; fail-closed policy checks, then CPI transfer |
| `update_limits(per_tx_cap, daily_cap)` | owner | Adjusts caps |
| `set_halt(halted)` | owner | Kill switch / resume |
| `set_allowlist(enforced, recipients[])` | owner | Up to 8 allowed recipients |
| `withdraw(amount)` | owner | Pulls funds back out |

Rejections surface as typed errors: `LeashHalted`, `PerTxCapExceeded`, `DailyCapExceeded`, `RecipientNotAllowed`, `VaultInsufficient`, `UnauthorizedAgent`, `UnauthorizedOwner`.

## Live on Devnet

Deployed and exercised end to end on July 15, 2026:

- Program: [`EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV`](https://explorer.solana.com/address/EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV?cluster=devnet)
- Leash PDA: [`B3zeFVxkcagGrhWUcHzY7Xzdpr5mRGBivS7dwW46f9Zy`](https://explorer.solana.com/address/B3zeFVxkcagGrhWUcHzY7Xzdpr5mRGBivS7dwW46f9Zy?cluster=devnet)
- Vault PDA: [`BTy6fyiZFSVSP8nS4gofsPqkth5zxBkk3hCNkg7Ess8F`](https://explorer.solana.com/address/BTy6fyiZFSVSP8nS4gofsPqkth5zxBkk3hCNkg7Ess8F?cluster=devnet)
- `create_leash` (0.05 SOL per-tx cap, 0.2 SOL daily cap): [tx](https://explorer.solana.com/tx/33s3t4QjE1FbTK4xByqNpARth4RVFzpNv9s1QxmjuMrZjV6dJ9y9amvL89eckL2PtQ5vhgHVoj5A87zd2nPyiaqZ?cluster=devnet)
- `set_allowlist` (treasury only): [tx](https://explorer.solana.com/tx/4W5Nmj81fhQwSkgYqgk9BT91HTpjY3XUtae5qrWcnstAoDdt4AEdiQaWnAGbJyjqR2dYXCdPp2TJZZ5naptdBZer?cluster=devnet)
- `deposit` 0.5 SOL: [tx](https://explorer.solana.com/tx/3MQ8GzRV7dsDZP6nKvEcbjCgrguviQhCunK91rc89PbMzgkWkSKPJ8r58SxaXYBXdDDThTMqJ2iMiwbydN5HHwKR?cluster=devnet)
- Agent `spend` 0.025 SOL, approved and transferred: [tx](https://explorer.solana.com/tx/5Pt2CWCmRagDJFdtXu7C8LkU1a21AjThQpgCJkGvtjZNkhYkefrsUdMnLDWSQZGVSH7Xr5hXcEBNH5CcdWN4A4Mc?cluster=devnet)
- `set_halt(true)`: [tx](https://explorer.solana.com/tx/37MKR64c4KMhKPpWHdmfe5VKhToJQ8suRkstTbnmXGMoftpZePpmzZYc7qoVvvmDestnjap5r6f3aidzhx6fMKPa?cluster=devnet) and resume: [tx](https://explorer.solana.com/tx/57kKyMNMg8jc3rLDjH5zC4duTXtCEHckjX3HvNmWPcQnrAeNyNFKNvxHpuJSUsMkyGkckygvMEhdHH39deYjNSgh?cluster=devnet)
- Demo agent BUY metered through the leash from Python: [tx](https://explorer.solana.com/tx/3c7MQBDXT9CyeuA5rTWb4jq9M9vXo86z66a9Rar69qRsFnaTwVfDfWGfsGe6DtFjmGZ3ZHGM1H5KzvFS2j4bvCrP?cluster=devnet)

In the same smoke run, an over-cap spend, a non-allowlisted recipient, and a spend-while-halted were each rejected (`PER_TX_CAP_EXCEEDED`, `RECIPIENT_NOT_ALLOWED`, `LEASH_HALTED`). Those rejections happen at preflight, so they never land on-chain; `npx ts-node scripts/land-rejection.ts` deliberately lands one as a finalized failed transaction if you want explorer-visible proof of enforcement.

## Quickstart (against the deployed program)

Prereqs: Node 18+, Python 3.11+, and three devnet keypairs under `keys/` (`owner-devnet.json`, `agent-devnet.json`, `treasury-devnet.json`). `scripts/setup-devnet.sh` can generate and fund them.

```bash
npm install
pip install -r requirements.txt
cp .env.example .env

# owner: create the leash, allowlist the treasury, fund the vault
npm run devnet:init

# agent: spend within policy (real SOL moves from the vault)
npm run devnet:spend -- 0.01

# owner: pull the kill switch, watch the agent get blocked, resume
npm run devnet:halt
npm run devnet:spend -- 0.01     # -> {"approved":false,"reason":"LEASH_HALTED"}
npm run devnet:resume

# the full guardrail demonstration in one command
npm run devnet:smoke
```

Other bridge commands: `devnet:status`, `devnet:status-json`, `devnet:deposit -- <sol>`, `devnet:withdraw -- <sol>`.

## The Demo Agent

To make the guardrails visible, the repo ships a deliberately untrusted consumer: an autonomous paper-trading agent (arXiv/news ingestion, Groq scoring, signal validation) whose every BUY must clear the leash with a real devnet spend before the paper trade executes. If the chain says no, the trade does not happen — the bridge is fail-closed end to end.

```bash
# one demo cycle (set ENABLE_DEVNET_LEASH=true in .env for the on-chain path)
python -m agent.main --init-db --once

# live pipeline (needs GROQ_API_KEY), or --loop for continuous cycles
python -m agent.main --live

# observability API + dashboard
uvicorn agent.api.server:app --reload
# then open dashboard/index.html
```

The dashboard shows the leash state (vault balance, caps, budget meter, halt state) and every spend with its explorer link, refreshed live.

## Owner Console (no CLI)

`dashboard/owner.html` is a self-contained wallet-adapter page for owners: connect a Solana wallet (Phantom), then create a leash, deposit to the vault, set caps and the recipient allowlist, halt/resume, or withdraw — all as real devnet transactions signed in your wallet. No CLI, no keys on disk.

It has no build step: it loads a vendored `@solana/web3.js` (offline-safe) and builds instructions from the committed IDL via `dashboard/leash-ix.js`. Open the file or serve the `dashboard/` folder; `owner.html?agent=<pubkey>` deep-links straight to one agent's leash (read-only until a wallet connects).

Because a headless environment can't drive a wallet, the instruction bytes are proven correct another way: `npm run verify:owner-ix` builds every instruction with the page's own encoder and byte-compares it against Anchor, then decodes the live on-chain account to confirm the read path. That check passes against the deployed program.

## Using Leash from Your Own Agent

TypeScript (the bridge in `scripts/devnet-leash.ts` is the reference; the IDL ships in `idl/leash.json`):

```ts
const idl = JSON.parse(fs.readFileSync("idl/leash.json", "utf8"));
const program = new anchor.Program(idl, provider);
await program.methods
  .spend(new anchor.BN(lamports))
  .accounts({ leash, agent: agentPubkey, vault, recipient, systemProgram })
  .signers([agentKeypair])
  .rpc(); // throws PerTxCapExceeded / DailyCapExceeded / ... when blocked
```

Python (subprocess bridge, no Rust/Anchor toolchain needed at runtime):

```python
from agent.trading.leash_client import AnchorLeashClient
from agent.models import SpendRequest

leash = AnchorLeashClient(rpc_url=..., program_id=..., wallet_path="keys/agent-devnet.json")
decision = leash.request_spend(SpendRequest(amount_sol=0.01))
# decision.approved, decision.reason, decision.tx_signature
```

## Repo Map

- [`programs/leash/`](programs/leash/) — the Anchor program (single ~400-line `lib.rs`, auditable in one sitting)
- [`idl/leash.json`](idl/leash.json) — committed IDL; regenerate with `npm run gen:idl`
- [`scripts/devnet-leash.ts`](scripts/devnet-leash.ts) — owner/agent CLI bridge (init, spend, halt, smoke, ...)
- [`agent/`](agent/) — Python demo agent: ingestion, scoring, paper executor, leash client, FastAPI
- [`dashboard/`](dashboard/) — static live monitor (`index.html`) and the owner console (`owner.html` + `owner.js` + `leash-ix.js`)
- [`scripts/verify-owner-ix.js`](scripts/verify-owner-ix.js) — proves the owner console's encoder matches Anchor
- [`tests/`](tests/) — Python unit tests (109) and the Anchor TypeScript test suite
- [`docs/`](docs/) — design, security model, roadmap, contributor guide

## Building the Program from Source

You only need this to modify the program; the deployed program plus committed IDL serve every other workflow.

```bash
cargo build-sbf --manifest-path programs/leash/Cargo.toml   # -> target/deploy/leash.so
solana program deploy target/deploy/leash.so --program-id target/deploy/leash-keypair.json -u devnet -k keys/owner-devnet.json
```

Toolchain notes (hard-won, especially on Windows):

- The Solana 1.18 SBF toolchain bundles cargo 1.75, which only reads lockfile v3. Modern host cargo writes v4. If the build complains about the lock file, regenerate it via host `cargo metadata`, then downgrade the header: `sed -i 's/^version = 4$/version = 3/' Cargo.lock`.
- `anchor build`'s IDL step compiles host-side and is brittle across rustc versions. The repo instead commits the IDL and regenerates it deterministically with `npm run gen:idl` (`scripts/gen-idl.js` mirrors `lib.rs`; discriminators are sha256 prefixes). If you change the program's interface, update both `lib.rs` and `gen-idl.js`.
- Dependency pins in `programs/leash/Cargo.toml` keep the tree compatible with the SBF toolchain's rustc 1.75. Do not "helpfully" update them.

## Validation Surface

Verified in the default local workflow:

- `python -m unittest discover -s tests` — 109 tests
- `npm run lint:ts` — bridge, scripts, and Anchor tests type-check
- `npm run devnet:smoke` — live guardrail enforcement against the deployed program

Not part of the default verified path:

- `npm run test:anchor` (requires a local validator; the devnet smoke covers the same behavior against the real cluster)

## Security Model (short version)

- Compromised agent key: bounded loss — at most `min(per_tx_cap, remaining daily budget)` per day, only to allowlisted recipients, and the owner can halt instantly.
- Compromised owner key: game over, as with any ownership system. Keep it cold.
- The bridge and executor fail closed: any error (RPC down, program missing, malformed output) is a rejection, never an approval.

Details and limitations in [`docs/security.md`](docs/security.md). This is devnet software; it has not been audited.

## Also in This Repo: Separatrix

[`separatrix/`](separatrix/) is a second, independent project sharing this history: a pure-Rust **simulated bifurcation** solver (the quantum-inspired Ising/QUBO algorithm family from Goto et al., *Science Advances* 2019/2021), published on [crates.io](https://crates.io/crates/separatrix) and paired with a walk-forward portfolio workbench.

Its point is measurement discipline rather than any performance claim: every rebalance in the study is solved by bSB, dSB, simulated annealing, and parallel tempering **and** by exact enumeration of all `C(N,K)` subsets, so each solver's optimality gap is measured against a proven optimum. In the first published study — 39 assets, K=8, 234 weekly rebalances, exact ground truth on 100% of them — bSB gave up 0.10% of objective for a ~140× speed-up over exact. No quantum advantage is claimed anywhere; the baselines exist precisely so the claims stay small.

- [`docs/workbench.md`](docs/workbench.md) — formulation, walk-forward rules, evaluation standards, solver protocol
- [`separatrix/README.md`](separatrix/README.md) — the crate
- `dashboard/workbench.html` — the study rendered as notebook cells
- [separatrix.vercel.app](https://separatrix.vercel.app) — project page

Planned next: an Anchor program that commits each allocation on-chain before execution and re-scores it in-program, with spends metered through Leash.

## Origin

Leash grew out of QubitAlpha, an autonomous trading-agent experiment. The trading pipeline survives as the demo agent; the on-chain policy controller grew into the product. Separatrix is QubitAlpha's other half returning — the quantitative engine, rebuilt in Rust, wearing the leash it created. Git history preserves the whole journey.

## License

MIT
