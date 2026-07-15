#!/usr/bin/env bash
set -euo pipefail

SOLANA_VERSION="${SOLANA_VERSION:-1.18.17}"
ANCHOR_VERSION="${ANCHOR_VERSION:-0.30.1}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

echo "Checking toolchain..."
need_cmd solana
need_cmd anchor
need_cmd node

mkdir -p keys

solana config set --url https://api.devnet.solana.com

if [[ ! -f keys/owner-devnet.json ]]; then
  solana-keygen new --outfile keys/owner-devnet.json --no-bip39-passphrase
fi

if [[ ! -f keys/agent-devnet.json ]]; then
  solana-keygen new --outfile keys/agent-devnet.json --no-bip39-passphrase
fi

if [[ ! -f keys/treasury-devnet.json ]]; then
  solana-keygen new --outfile keys/treasury-devnet.json --no-bip39-passphrase
fi

echo "Airdropping devnet SOL..."
solana airdrop 2 "$(solana-keygen pubkey keys/owner-devnet.json)" || true
solana airdrop 2 "$(solana-keygen pubkey keys/agent-devnet.json)" || true
solana airdrop 2 "$(solana-keygen pubkey keys/treasury-devnet.json)" || true

cat <<EOF
Devnet setup finished.

Pinned targets:
  Solana CLI: ${SOLANA_VERSION}
  Anchor CLI: ${ANCHOR_VERSION}

Next steps:
  1. bash scripts/deploy.sh
  2. verify POLICY_CONTROLLER_PROGRAM_ID in .env matches Anchor.toml and declare_id!
  3. run anchor test
EOF
