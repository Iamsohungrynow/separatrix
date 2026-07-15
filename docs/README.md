# Documentation Index

Use this folder as the stable entrypoint for project context.

## Start Here

- [`../README.md`](../README.md): public overview, live devnet addresses, and quick start
- [`../AGENT.md`](../AGENT.md): contributor and coding-agent operating guide
- [`HACKATHON_DEV_GUIDE.md`](HACKATHON_DEV_GUIDE.md): fastest path to ship changes

## Architecture And Scope

- [`design.md`](design.md): program model, bridge model, demo-agent model
- [`security.md`](security.md): threat model, enforcement properties, known limitations
- [`ROADMAP.md`](ROADMAP.md): delivery phases and non-goals

## When To Read What

- Working on the Anchor program:
  Read `design.md`, `security.md`, and `tests/anchor/leash.ts`; note the IDL rule in `AGENT.md` (update `scripts/gen-idl.js` with any interface change)
- Working on the Python runtime:
  Read `design.md`, then `HACKATHON_DEV_GUIDE.md`
- Working on docs or demos:
  Read `README.md` and `ROADMAP.md`

## Current Validation Surface

Green by default:

- `python -m unittest discover -s tests -v`
- `cmd /c npm run lint:ts`
- `npm run devnet:smoke` (live enforcement against the deployed devnet program)

Not default-green yet:

- `npm run test:anchor` (needs a local validator)
- `anchor build`'s IDL step (host-toolchain sensitive; the committed IDL + `npm run gen:idl` is the supported path)

Treat that distinction seriously when updating docs or PR descriptions.
