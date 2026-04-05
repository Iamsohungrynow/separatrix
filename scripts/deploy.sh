#!/usr/bin/env bash
set -euo pipefail

if ! command -v anchor >/dev/null 2>&1; then
  echo "Missing required command: anchor" >&2
  exit 1
fi

if ! command -v solana >/dev/null 2>&1; then
  echo "Missing required command: solana" >&2
  exit 1
fi

anchor build
anchor deploy --provider.cluster devnet

cat <<EOF
Anchor deploy completed.

Replace POLICY_CONTROLLER_PROGRAM_ID in .env with the deployed program id.
Then initialize the policy PDA before wiring the Python client.
EOF
