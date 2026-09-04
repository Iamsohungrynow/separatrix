# Contributing to Separatrix

Thanks for looking. This repository holds three pillars that share one history:

1. `separatrix/` is a pure-Rust simulated-bifurcation Ising/QUBO solver with its classical
   baselines (simulated annealing, parallel tempering, exact enumeration), published on
   crates.io as `separatrix`, plus a browser WASM demo in `site/demo`.
2. `programs/` holds two Solana/Anchor programs on devnet: `leash` (spending guardrails for
   agents) and `separatrix` (commit-before-execution and on-chain re-scoring of allocations),
   with their TypeScript bridges under `scripts/`.
3. Python 3.12 code: the demo agent (`agent/`), the walk-forward workbench (`agent/workbench/`,
   contract in `docs/workbench.md`), and the quantum primitives track (`quantum/`, reference in
   `docs/primitives.md`; the QAOA pipeline in `scripts/heron_qaoa.py`, reference in
   `docs/quantum.md`).

The project's brand is honesty. Every number in the docs is labelled measured, estimated, or
NOT RUN; the solvers are quantum-inspired, never a quantum advantage; the docs stay narrower
than the evidence. Contributions are judged by that standard as much as by whether the code
works.

## What we are looking for

- Solver algorithms and baselines in `separatrix/`: new heuristics, stronger classical
  references, benchmark instances, WASM-friendly changes. A baseline that beats SB is a
  welcome result, not a problem.
- Workbench methodology in `agent/workbench/`: formulation, walk-forward rules, metrics. Read
  `docs/workbench.md` first; it is the binding contract, so a change to it is a change to the
  study.
- Program hardening in `programs/leash` and `programs/separatrix`: tighter constraints,
  rejection-path tests, compute-unit measurements.
- Quantum constructions and characterisation in `quantum/`: state-preparation circuits,
  mixers, compiled-cost measurements on emulators, correctness checks against analytic states.
- Docs: corrections, sharper wording, and especially claims you can show are overstated (use
  the `claim:` issue template).

Small, reviewable changes with one theme each are preferred over broad rewrites. If a file
looks actively in flux, make the smallest safe change.

Before you start, read [`AGENT.md`](AGENT.md) (the operating guide for humans and coding
agents) and the [docs index](docs/README.md). Coding agents: `AGENT.md` is written for you.
Follow it.

## Development setup

The commands below work in both PowerShell and bash unless a shell is named. On Windows, if
PowerShell refuses to run `npm`, prefix it with `cmd /c`.

### Python 3.12 (agent, workbench, tests)

```
python -m venv .venv
# PowerShell:  .\.venv\Scripts\Activate.ps1
# bash:        source .venv/bin/activate      (Git Bash on Windows: source .venv/Scripts/activate)
python -m pip install -r requirements.txt
```

Copy `.env.example` to `.env` to run the demo agent (`python -m agent.main --init-db --once`).

The quantum extras are deliberately not in the main install:

- `requirements-quantum.txt` (qiskit) is for `scripts/heron_qaoa.py`, which runs in simulation
  with no credentials and defaults to `--dry-run`.
- `requirements-quantinuum.txt` (pytket, guppy, selene) is for `quantum/characterise.py`.
  Install it into a dedicated venv named `.venv-quantinuum` (gitignored). It needs Python >=
  3.12 and is large.

```
python -m venv .venv-quantinuum
# PowerShell:  .venv-quantinuum\Scripts\python.exe -m pip install -r requirements-quantinuum.txt
# bash:        .venv-quantinuum/bin/python -m pip install -r requirements-quantinuum.txt
```

`tests/test_quantum_dicke.py` skips its pytket- and qiskit-dependent groups when those packages
are absent, so the main suite stays green without either extra.

### Rust solver crate (`separatrix/`)

The crate is its own cargo workspace (`separatrix/Cargo.toml`), separate from the repo root.
Use a current stable toolchain with `clippy`, `rustfmt`, and the wasm target:

```
rustup target add wasm32-unknown-unknown
```

Run cargo from inside `separatrix/` (or pass `--manifest-path separatrix/Cargo.toml`), never
from the repo root; see the lockfile invariant below. Rebuilding the browser demo after a
solver change also needs `wasm-bindgen-cli`: `scripts/build-wasm-demo.sh` (bash) regenerates
`site/demo/pkg`, and the generated files are committed so the site deploys without a wasm
toolchain.

### Solana / Anchor (repo root workspace)

Targets `anchor-lang 0.30.1` and the Solana 1.18 SBF toolchain; Node 20 for the bridge and the
Anchor tests.

```
npm ci
npm run lint:ts
cargo build-sbf --manifest-path programs/leash/Cargo.toml
cargo build-sbf --manifest-path programs/separatrix/Cargo.toml
```

`scripts/preflight-anchor.ps1` / `.sh` fails early on the usual environment problems (Anchor
CLI version, missing Docker or Rust build backend, keypair not matching `declare_id!`). Do not
rely on `anchor build`'s IDL step; the committed IDLs plus the generator scripts are the
supported path. Devnet keypairs live under `keys/` (gitignored); `scripts/setup-devnet.ps1` /
`.sh` can generate and fund them. The Anchor suites (`npm run test:anchor`) need a local
validator with the program deployed at its declared address; `docs/onchain.md` section 8 has
the exact commands, including the two Windows accommodations.

## Check matrix

Run the narrowest relevant check while developing and the broader set before opening a PR.
CI runs the Python lint and suite, the quantum-primitive tests with pytket installed, the
TypeScript check, the lockfile guard, the IDL diff, and the solver crate's fmt, test, clippy,
wasm, and rustdoc checks on every push to `main` and every pull request. Everything else is on
you, and the PR template asks which rows you ran.

| Area | Commands |
| --- | --- |
| Python (agent, workbench, quantum, tests) | `python -m unittest discover -s tests -v` and `ruff check agent quantum scripts tests` |
| Solver crate (run inside `separatrix/`) | `cargo fmt --all -- --check`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo check --no-default-features --target wasm32-unknown-unknown`, `cargo doc --no-deps -p separatrix` with `RUSTDOCFLAGS=-D warnings` |
| Browser demo | `scripts/build-wasm-demo.sh`, then commit the regenerated `site/demo/pkg` |
| TypeScript bridge and Anchor tests | `npm ci`, `npm run lint:ts`; `npm run test:anchor` against a local validator |
| SBF lockfile guard | `npm run check:sbf-lockfile` |
| IDLs and encoders | `npm run gen:idl`, `npm run gen:idl:separatrix`, `npm run verify:owner-ix`, `npm run verify:separatrix-idl` |
| Programs (build) | `cargo build-sbf --manifest-path programs/<program>/Cargo.toml` |
| Devnet smoke (needs funded devnet keys) | `npm run devnet:smoke`, `npm run separatrix:smoke` |
| Quantum primitives (inside `.venv-quantinuum`) | `python -m unittest discover -s tests -p test_quantum_dicke.py -v`; `python -m quantum.characterise --no-selene --n 6 8` for a short sweep |
| Local runtime | `python -m agent.main --init-db --once` |

## Repository invariants

These break silently and surface far from the change that caused them. Each has a guard; do
not remove a guard to make a build pass.

- **The SBF lockfile is v3.** The SBF toolchain's cargo 1.75 reads lockfile v3 only, and any
  modern host cargo that touches the root workspace silently rewrites `Cargo.lock` to v4.
  Never run host `cargo` in the repo root. `npm run check:sbf-lockfile` catches a rewrite (and
  any host-side crate leaking into the program workspace); it runs in CI and its error message
  contains the fix. The dependency pins in `programs/*/Cargo.toml` keep the tree buildable on
  rustc 1.75; do not bump them casually. Dependabot is configured to watch `separatrix/` only,
  never the root.
- **Two cargo workspaces, on purpose.** `separatrix/` is excluded from the root workspace so
  its dependency tree never enters the SBF lockfile. Do not add it as a member, and do not
  path-depend on it from a program.
- **IDLs come from hand-mirrored generators.** `anchor build`'s IDL generation is unreliable
  on the development host, so `idl/leash.json` and `idl/separatrix.json` are produced by
  `scripts/gen-idl.js` and `scripts/gen-separatrix-idl.js`. If you change any instruction,
  account, event, or error in a program, update its generator, regenerate (`npm run gen:idl` /
  `npm run gen:idl:separatrix`), and re-run `npm run verify:owner-ix` /
  `npm run verify:separatrix-idl`. The owner console's `dashboard/leash-ix.js` hardcodes
  discriminators and the `LeashState` layout and must be updated in step. CI diffs both
  committed IDLs against their generators.
- **The commitment preimages exist in four places and must agree.** The seal digest and the
  allocation commitment are implemented in the `separatrix` program, the Rust exporter
  (`separatrix/cli --emit-qubo`), the Python client (`agent/workbench/onchain.py`), and the
  golden vectors in `tests/test_onchain_vectors.py`; the TypeScript bridge in
  `scripts/devnet-separatrix.ts` builds transactions from the same bytes. If any two drift,
  `seal_study` or `reveal_allocation` rejects on devnet. The vectors are literals on purpose;
  never regenerate them from the code they check. `docs/onchain.md` section 2 is the
  byte-level reference.
- **Fail closed.** The leash bridge has no "skip chain and continue" path for devnet mode, and
  none should be added (`docs/security.md`).

## Honesty rules for docs and reports

- Label every number as **measured** (with the command and the artifact that produced it),
  **estimated** (with the basis), or **NOT RUN**. A published device specification is not a
  measurement taken by this project, and an emulator run is not a hardware run.
- The solvers are quantum-inspired classical algorithms. Do not write "quantum advantage",
  "quantum speedup", or anything a reader could mistake for one. Keep the hardware status in
  `docs/quantum.md` and `docs/primitives.md` current, with the evidence attached.
- The headline metric for solver quality is the optimality gap against exact ground truth
  (`gap_norm` in the workbench). If a baseline wins, the report says so.
- Commit the artifact you got, not the one you wanted. A run that came out worse replaces the
  previous one; do not rerun until it looks nice and commit that.
- Docs stay narrower than the evidence. "Verified on devnet" means a transaction signature you
  can link. "Tests pass" means you ran them on this change.
- On-chain reveal counts travel with publish counts (`docs/onchain.md` section 7). Never quote
  one without the other.

## Commit messages

Prefixes: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`. One theme per commit; do not
mix product logic, docs, and deployment changes unless they are tightly coupled. A reviewer
should be able to tell from the message what changed, why, how it was checked, and what is
intentionally unfinished.

```
feat: alternating-parity replica exchange in parallel tempering
fix: reject seal_study when the coefficient count is not n(n+1)/2
docs: label the reveal compute-unit table as measured on devnet
test: cover the LSB-first bitmap edge at n=48
```

## Pull requests

Use the pull request template. Say which pillar the change touches and which checks you ran;
if you did not run a check, say so plainly rather than leaving the box unticked and hoping. If
the change alters any claim in `README.md`, `docs/`, or `reports/`, attach the evidence in the
PR: command, output, artifact path, or transaction signature.

A change is done when all of these are true:

1. the code path is understandable from filenames and docs
2. the relevant local checks pass
3. the README and docs do not overclaim
4. no local secrets or temp artifacts were introduced into tracked files
5. edge cases and rejection paths were examined deliberately, not assumed
6. IDLs, generators, and encoders were regenerated and verified if a program interface changed
7. the implementation would not embarrass you in front of a senior reviewer

For policy-sensitive work (programs, spend paths, commitment logic), think in invariants: what
must never happen, what must happen exactly once, what must fail closed, what sequence
assumptions must hold.

## Reporting problems

- A defect: the `bug:` issue template, with a minimal reproduction.
- A number or sentence in the README, `docs/`, or `reports/` that says more than the evidence
  supports: the `claim:` issue template. The project would rather correct a claim than defend
  it.
- A vulnerability: [`SECURITY.md`](SECURITY.md), privately. Not an issue.

## Secrets and local state

Never commit `.env`, anything under `keys/` or `secrets/`, `*.db` files, temp publish folders,
or tool downloads. Those paths are gitignored on purpose; keep them that way and do not
force-add around them.

IBM Quantum and Quantinuum credentials never go in the repository, in `.env`, or under
`secrets/`. They are live credentials against metered accounts. `scripts/heron_qaoa.py` reads
`IBM_QUANTUM_TOKEN` from the environment and submits nothing without `--no-dry-run`; the
Selene emulator and the offline Quantinuum compiler need no account at all.

Devnet keypairs are devnet keypairs. Keep balances tiny, and never reuse an owner key from
anything that holds real value.

## Coding agents

If you are a coding agent, read [`AGENT.md`](AGENT.md) before changing anything. It covers the
repo map, the current truth of what is and is not implemented, the multi-agent working rules,
and the execution standard. Everything in this file applies to you as well.
