<!-- Keep one theme per PR. See CONTRIBUTING.md for the check matrix and the invariants. -->

## What and why

<!-- What changed, why it changed, and what is intentionally left unfinished. -->

## Pillar

- [ ] Solver crate (`separatrix/`) or Separatrix Studio (`site/`)
- [ ] Solana programs / bridges (`programs/`, `scripts/`, `idl/`, `dashboard/leash-ix.js`)
- [ ] Python: demo agent, workbench, quantum primitives, tests
- [ ] Docs, CI, or tooling only

## Checks run

Tick only what you actually ran on this change. If you did not run a check, say so below rather than leaving it ambiguous.

Python:

- [ ] `python -m unittest discover -s tests -v`
- [ ] `ruff check agent quantum scripts tests`

Solver crate (inside `separatrix/`):

- [ ] `cargo test --workspace`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo fmt --all -- --check`
- [ ] `cargo check --no-default-features --target wasm32-unknown-unknown`
- [ ] `scripts/build-wasm-demo.sh` and the regenerated `site/public/pkg` is committed (if the solver changed)

Studio (inside `site/`):

- [ ] `npm test`
- [ ] `npm run build`

Solana / Anchor:

- [ ] `npm run lint:ts`
- [ ] `npm run check:sbf-lockfile`
- [ ] `npm run verify:owner-ix` / `npm run verify:separatrix-idl`
- [ ] `npm run test:anchor` against a local validator
- [ ] devnet smoke (`npm run devnet:smoke` / `npm run separatrix:smoke`), with the transaction signature(s) below

Quantum primitives (inside `.venv-quantinuum`):

- [ ] `python -m unittest discover -s tests -p test_quantum_dicke.py -v`

Not run, and why:

<!-- e.g. "test:anchor: no local validator on this machine" -->

## Claims and evidence

- [ ] This change does not alter any number or claim in `README.md`, `docs/`, or `reports/`.
- [ ] It does, and the evidence is attached or linked here (command, output, artifact path, or transaction signature), with each number labelled measured / estimated / NOT RUN.

<!-- Evidence: -->

## Program interface

- [ ] No program instruction, account, event, or error changed.
- [ ] One did, and the generator (`scripts/gen-idl.js` / `scripts/gen-separatrix-idl.js`) was updated, the IDL regenerated, `dashboard/leash-ix.js` updated if it is the leash program, and the verifier re-run.

## Hygiene

- [ ] No `.env`, keys, secrets, database files, logs, or credentials are included.
- [ ] No generated junk (build output, caches, temp folders) is included; regenerated artifacts that are meant to be committed (`idl/*.json`, `site/public/pkg`) are the only generated files in the diff.
- [ ] Commit messages use a `feat:` / `fix:` / `docs:` / `test:` / `chore:` / `ci:` prefix and describe one theme each.
