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

./scripts/preflight-anchor.sh
anchor build
anchor deploy --provider.cluster devnet

cat <<EOF
Anchor deploy completed.

Verify LEASH_PROGRAM_ID in .env matches the deployed program id.
Then run:
  bash scripts/init-leash.sh
  bash scripts/smoke-devnet.sh
EOF
