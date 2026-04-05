from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from logging import getLogger

from agent.config import Settings
from agent.db.database import Database
from agent.models import Signal
from agent.trading.executor import PaperTradeExecutor
from agent.trading.policy_client import AnchorPolicyClient, LocalPolicyClient
from agent.utils.logging import configure_logging


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="QubitAlpha local scaffold")
    parser.add_argument("--env-file", default=".env", help="Path to .env file")
    parser.add_argument("--init-db", action="store_true", help="Initialize the SQLite schema before running")
    parser.add_argument("--once", action="store_true", help="Run one demo cycle and exit")
    parser.add_argument("--demo-price", type=float, default=11.25, help="Price used for the demo signal")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    settings = Settings.from_env(args.env_file)
    configure_logging(settings.log_level)
    logger = getLogger("qubitalpha.main")

    db = Database(settings.database_path)
    try:
        db.initialize()
        db.ensure_cash(settings.starting_paper_cash_usdc)
        db.record_state(status="idle")

        if args.init_db and not args.once:
            logger.info("database initialized at %s", settings.database_path)
            return

        if settings.enable_devnet_policy:
            policy_client = AnchorPolicyClient(
                rpc_url=settings.solana_rpc_url,
                program_id=settings.policy_controller_program_id,
                wallet_path=settings.agent_wallet_path,
            )
        else:
            policy_client = LocalPolicyClient(
                daily_buy_limit_usdc=settings.daily_buy_limit_usdc,
                per_trade_buy_limit_usdc=settings.per_trade_buy_limit_usdc,
                starting_sequence=db.get_next_trade_sequence(),
            )

        executor = PaperTradeExecutor(
            db=db,
            policy_client=policy_client,
            starting_cash_usdc=settings.starting_paper_cash_usdc,
        )

        if not args.once:
            logger.info("scaffold ready; rerun with --once to emit a demo trade")
            return

        if settings.enable_devnet_policy:
            raise SystemExit(
                "ENABLE_DEVNET_POLICY=true is configured, but live Anchor submission is not wired yet. "
                "Use local policy mode for --once, or deploy the program and implement the anchorpy client first."
            )

        demo_signal = Signal(
            asset="RNDR",
            action="BUY",
            sentiment=0.82,
            confidence=0.75,
            position_size_usdc=min(settings.base_trade_amount_usdc, settings.per_trade_buy_limit_usdc),
            reasoning="Demo signal seeded by the local scaffold. Replace this with live scoring.",
            sources=["local://demo"],
            validation_details={"mode": "local-demo"},
        )

        result = executor.execute(signal=demo_signal, price_usdc=args.demo_price)
        db.record_state(status="idle")
        logger.info("demo execution result: %s", json.dumps(asdict(result), sort_keys=True))
        logger.info("latest pnl: %s", json.dumps(db.latest_pnl(settings.starting_paper_cash_usdc), sort_keys=True))
    finally:
        db.close()


if __name__ == "__main__":
    main()
