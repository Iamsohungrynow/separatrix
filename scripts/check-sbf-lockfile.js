#!/usr/bin/env node
// Guards the repo's single most expensive build hazard.
//
// The Solana 1.18 SBF toolchain bundles cargo 1.75, which reads lockfile v3
// only. Any modern host cargo that touches the workspace silently rewrites
// Cargo.lock to v4, and the next `cargo build-sbf` dies with
// "lock file version 4 requires -Znext-lockfile-bump" — far from the change
// that caused it. This check fails fast and says what to do instead.
//
// It also verifies the separatrix solver crate never entered the SBF
// workspace: its modern dependency tree would drag the lockfile forward again.
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const lockPath = path.join(repoRoot, "Cargo.lock");
const manifestPath = path.join(repoRoot, "Cargo.toml");

let failures = 0;
const fail = (message, hint) => {
  console.error(`FAIL  ${message}`);
  if (hint) console.error(`      ${hint}`);
  failures += 1;
};

const lock = fs.readFileSync(lockPath, "utf8");
const versionLine = lock.split(/\r?\n/).find((line) => /^version = \d+$/.test(line));
if (!versionLine) {
  fail("Cargo.lock has no top-level `version = N` header");
} else {
  const version = Number(versionLine.split("=")[1].trim());
  if (version !== 3) {
    fail(
      `Cargo.lock is lockfile v${version}; the SBF toolchain's cargo 1.75 only reads v3`,
      "Fix: cargo metadata --format-version 1 >/dev/null && sed -i '3s/^version = 4$/version = 3/' Cargo.lock"
    );
  } else {
    console.log("ok    Cargo.lock is lockfile v3 (SBF toolchain can read it)");
  }
}

const manifest = fs.readFileSync(manifestPath, "utf8");
if (!/exclude\s*=\s*\[[^\]]*"separatrix"/s.test(manifest)) {
  fail(
    "the root workspace no longer excludes `separatrix`",
    "The solver crate must stay out of the SBF workspace or its dependency tree re-enters this lockfile."
  );
} else {
  console.log("ok    root workspace still excludes the separatrix solver crate");
}

// Unambiguous markers only. Several crates that look host-side (rand_xoshiro,
// rayon, indexmap) legitimately arrive via solana-frozen-abi -> im, so they
// prove nothing; the solver crates and their dev-only deps prove everything.
for (const crate of ["separatrix", "separatrix-cli", "criterion", "proptest", "ndarray"]) {
  if (new RegExp(`^name = "${crate}"$`, "m").test(lock)) {
    fail(
      `${crate} appears in the SBF Cargo.lock`,
      "A host-side dependency leaked into the program workspace; check workspace members and path deps."
    );
  }
}
if (failures === 0) {
  console.log("ok    no host-side solver dependencies leaked into the SBF lockfile");
  console.log("\nSBF lockfile guard passed.");
  process.exit(0);
}
console.error(`\n${failures} check(s) failed.`);
process.exit(1);
