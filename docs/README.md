# Documentation Index

Use this folder as the stable entrypoint for project context.

## Start Here

- [`../README.md`](../README.md): public overview and quick start
- [`../AGENT.md`](../AGENT.md): contributor and coding-agent operating guide
- [`HACKATHON_DEV_GUIDE.md`](HACKATHON_DEV_GUIDE.md): fastest path to ship changes during a hackathon

## Architecture And Scope

- [`design.md`](design.md): MVP boundary, execution model, and policy split
- [`security.md`](security.md): threat model and operational safety rules
- [`ROADMAP.md`](ROADMAP.md): delivery phases and non-goals
- [`project-plan.md`](project-plan.md): positioning and narrative constraints for the public repo

## When To Read What

- Working on Python runtime:
  Read `design.md`, then `HACKATHON_DEV_GUIDE.md`
- Working on Solana policy logic:
  Read `design.md`, `security.md`, and `tests/anchor/policy_controller.ts`
- Working on docs or demos:
  Read `README.md`, `ROADMAP.md`, and `project-plan.md`

## Current Validation Surface

Green by default:

- `python -m unittest discover -s tests -v`
- `cmd /c npm run lint:ts`

Not default-green yet:

- `anchor build`
- `anchor test`

Treat that distinction seriously when updating docs or PR descriptions.
