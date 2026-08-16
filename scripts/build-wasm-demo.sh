#!/usr/bin/env bash
# Rebuild the browser demo's WebAssembly bundle.
#
# The generated files under site/demo/pkg/ are committed so the site deploys
# from a clean checkout without a wasm toolchain. Re-run this whenever the
# solver crate changes.
#
# `--target no-modules` (not `web`) on purpose: the demo runs the solver in a
# classic Worker, and module workers proved unreliable to load.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --manifest-path separatrix/Cargo.toml -p separatrix-wasm \
  --target wasm32-unknown-unknown --release

wasm-bindgen --target no-modules --no-typescript \
  --out-dir site/demo/pkg \
  separatrix/target/wasm32-unknown-unknown/release/separatrix_wasm.wasm

echo "rebuilt site/demo/pkg (wasm-bindgen $(wasm-bindgen --version))"
