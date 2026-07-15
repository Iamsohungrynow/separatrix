#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd anchor
need_cmd solana
need_cmd solana-keygen
need_cmd node

expected_anchor_version="${ANCHOR_VERSION:-0.30.1}"
anchor_version_output="$(anchor --version)"
resolved_anchor_version="$(printf '%s' "${anchor_version_output}" | awk '{print $2}')"
if [[ -n "${resolved_anchor_version}" && "${resolved_anchor_version}" != "${expected_anchor_version}" ]]; then
  echo "Anchor CLI version mismatch. Expected ${expected_anchor_version} but resolved ${resolved_anchor_version}. Install Anchor ${expected_anchor_version} or update the repo's pinned version intentionally." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Missing required command: cargo. Anchor builds on Linux/WSL require a Rust toolchain." >&2
  exit 1
fi

keypair_path="${repo_root}/target/deploy/leash-keypair.json"
if [[ ! -f "${keypair_path}" ]]; then
  (
    cd "${repo_root}"
    anchor keys list >/dev/null
  )
fi

if [[ ! -f "${keypair_path}" ]]; then
  echo "Missing ${keypair_path}. Run \`anchor keys list\` or generate the program keypair before build/test." >&2
  exit 1
fi

pubkey="$(solana-keygen pubkey "${keypair_path}")"
declared_program_id="$(sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' "${repo_root}/programs/leash/src/lib.rs" | head -n 1)"

readarray -t anchor_toml_program_ids < <(awk '
  /^\[programs\.(localnet|devnet)\]/ {
    current_network = $0
    sub(/^\[programs\./, "", current_network)
    sub(/\]$/, "", current_network)
    next
  }
  /^\[/ {
    current_network = ""
  }
  current_network != "" && $1 == "leash" {
    gsub(/"/, "", $3)
    print current_network ":" $3
  }
' "${repo_root}/Anchor.toml")

if [[ -n "${declared_program_id}" && "${declared_program_id}" != "${pubkey}" ]]; then
  echo "Program id mismatch in programs/leash/src/lib.rs. declare_id! uses ${declared_program_id} but ${keypair_path} resolves to ${pubkey}. Run \`anchor keys sync\` locally before build/test." >&2
  exit 1
fi

for entry in "${anchor_toml_program_ids[@]}"; do
  network="${entry%%:*}"
  program_id="${entry#*:}"
  if [[ -n "${program_id}" && "${program_id}" != "${pubkey}" ]]; then
    echo "Program id mismatch in Anchor.toml. [programs.${network}].leash is ${program_id} but ${keypair_path} resolves to ${pubkey}. Run \`anchor keys sync\` locally before build/test." >&2
    exit 1
  fi
done

echo "Anchor preflight passed."
