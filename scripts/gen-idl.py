#!/usr/bin/env python3
"""Generate the Anchor 0.30.1 IDL for policy_controller without `anchor idl build`.

`anchor idl build` (the idl-build feature path) does not compile on modern Rust
toolchains: anchor-syn 0.30.1 calls `proc_macro2::Span::source_file()`, a nightly
compiler API removed from current rustc. This script emits an IDL that matches the
0.30.1 spec directly from the program definition in
`programs/policy_controller/src/lib.rs`, with correct 8-byte sighash discriminators.

Keep this in sync by hand if the program's instructions/accounts/errors change.

Usage:
    python scripts/gen-idl.py            # writes target/idl/policy_controller.json
    python scripts/gen-idl.py --check    # verify the on-disk IDL matches (CI-friendly)
"""
import hashlib
import json
import os
import sys

PROGRAM_ID = "Ej6KFBgzyNqcT9D1FpGfWMePhFWgfB4wkzuK1rv3UqSG"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(REPO_ROOT, "target", "idl", "policy_controller.json")

# "policy" PDA seed prefix as raw bytes.
POLICY_SEED = list(b"policy")


def disc(prefix: str, name: str):
    return list(hashlib.sha256(f"{prefix}:{name}".encode()).digest()[:8])


def policy_pda(extra_seed):
    return {"pda": {"seeds": [{"kind": "const", "value": POLICY_SEED}, extra_seed]}}


def build_idl():
    u64 = "u64"
    return {
        "address": PROGRAM_ID,
        "metadata": {
            "name": "policy_controller",
            "version": "0.1.0",
            "spec": "0.1.0",
            "description": "QubitAlpha policy controller",
        },
        "instructions": [
            {
                "name": "initialize_policy",
                "discriminator": disc("global", "initialize_policy"),
                "accounts": [
                    {"name": "owner", "writable": True, "signer": True},
                    {"name": "agent", "signer": True},
                    dict({"name": "policy", "writable": True},
                         **policy_pda({"kind": "account", "path": "agent"})),
                    {"name": "system_program",
                     "address": "11111111111111111111111111111111"},
                ],
                "args": [
                    {"name": "daily_buy_limit_microusdc", "type": u64},
                    {"name": "per_trade_buy_limit_microusdc", "type": u64},
                ],
            },
            {
                "name": "update_policy",
                "discriminator": disc("global", "update_policy"),
                "accounts": [
                    dict({"name": "policy", "writable": True},
                         **policy_pda({"kind": "account", "path": "policy.agent",
                                       "account": "AgentPolicy"})),
                    {"name": "owner", "signer": True},
                ],
                "args": [
                    {"name": "daily_buy_limit_microusdc", "type": u64},
                    {"name": "per_trade_buy_limit_microusdc", "type": u64},
                ],
            },
            {
                "name": "set_halt",
                "discriminator": disc("global", "set_halt"),
                "accounts": [
                    dict({"name": "policy", "writable": True},
                         **policy_pda({"kind": "account", "path": "policy.agent",
                                       "account": "AgentPolicy"})),
                    {"name": "owner", "signer": True},
                ],
                "args": [{"name": "halted", "type": "bool"}],
            },
            {
                "name": "submit_trade",
                "discriminator": disc("global", "submit_trade"),
                "accounts": [
                    dict({"name": "policy", "writable": True},
                         **policy_pda({"kind": "account", "path": "policy.agent",
                                       "account": "AgentPolicy"})),
                    {"name": "agent", "signer": True},
                ],
                "args": [
                    {"name": "trade_seq", "type": u64},
                    {"name": "side", "type": {"defined": {"name": "TradeSide"}}},
                    {"name": "amount_microusdc", "type": u64},
                ],
            },
        ],
        "accounts": [
            {"name": "AgentPolicy", "discriminator": disc("account", "AgentPolicy")},
        ],
        "events": [
            {"name": "TradeSubmitted", "discriminator": disc("event", "TradeSubmitted")},
        ],
        "errors": [
            {"code": 6000, "name": "AgentHalted", "msg": "the agent is halted"},
            {"code": 6001, "name": "TradeTooBig", "msg": "the trade exceeds the per-trade limit"},
            {"code": 6002, "name": "DailyLimitExceeded", "msg": "the trade exceeds the daily limit"},
            {"code": 6003, "name": "InvalidTradeSequence", "msg": "the trade sequence is invalid"},
            {"code": 6004, "name": "Overflow", "msg": "arithmetic overflow"},
            {"code": 6005, "name": "UnauthorizedOwner", "msg": "only the configured owner may modify policy"},
            {"code": 6006, "name": "UnauthorizedAgent", "msg": "only the configured agent may submit trades"},
            {"code": 6007, "name": "InvalidPolicy", "msg": "policy limits are invalid"},
        ],
        "types": [
            {"name": "AgentPolicy", "type": {"kind": "struct", "fields": [
                {"name": "owner", "type": "pubkey"},
                {"name": "agent", "type": "pubkey"},
                {"name": "daily_buy_limit_microusdc", "type": "u64"},
                {"name": "per_trade_buy_limit_microusdc", "type": "u64"},
                {"name": "daily_buy_used_microusdc", "type": "u64"},
                {"name": "current_day_index", "type": "i64"},
                {"name": "next_trade_seq", "type": "u64"},
                {"name": "halted", "type": "bool"},
                {"name": "bump", "type": "u8"},
            ]}},
            {"name": "TradeSide", "type": {"kind": "enum", "variants": [
                {"name": "Buy"}, {"name": "Sell"},
            ]}},
            {"name": "TradeSubmitted", "type": {"kind": "struct", "fields": [
                {"name": "agent", "type": "pubkey"},
                {"name": "trade_seq", "type": "u64"},
                {"name": "side", "type": "u8"},
                {"name": "amount_microusdc", "type": "u64"},
                {"name": "daily_buy_used_microusdc", "type": "u64"},
                {"name": "timestamp", "type": "i64"},
            ]}},
        ],
    }


def main():
    idl = build_idl()
    rendered = json.dumps(idl, indent=2) + "\n"
    if "--check" in sys.argv:
        with open(OUT_PATH, encoding="utf-8") as f:
            on_disk = f.read()
        if on_disk != rendered:
            print("IDL out of date. Run: python scripts/gen-idl.py", file=sys.stderr)
            sys.exit(1)
        print("IDL up to date.")
        return
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(rendered)
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
