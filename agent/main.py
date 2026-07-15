from __future__ import annotations

import argparse
import asyncio
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
    parser.add_argument("--live", action="store_true", help="Run one live cycle (ingest -> score -> validate -> execute)")
    parser.add_argument(
        "--loop",
        action="store_true",
        help="Run live cycles continuously, sleeping poll_interval_seconds between cycles",
    )
    parser.add_argument(
        "--max-cycles",
        type=int,
        default=0,
        help="Stop the loop after N cycles (0 = infinite). Useful for bounded runs and tests.",
    )
    parser.add_argument("--demo-price", type=float, default=11.25, help="Price used for the demo signal")
    return parser


async def _run_live_cycle(
    settings: Settings,
    db: Database,
    executor: PaperTradeExecutor,
    logger: object,
) -> None:
    """Ingest -> score -> validate -> execute pipeline."""
    from agent.ingestion.jupiter_price import fetch_prices
    from agent.ingestion.coingecko import fetch_fallback_prices
    from agent.ingestion.arxiv import fetch_arxiv
    from agent.ingestion.news_rss import fetch_news_rss
    from agent.scoring.llm_scorer import score_items
    from agent.scoring.signal_generator import generate_signals
    from agent.scoring.signal_validator import validate_signal

    db.record_state(status="ingesting")

    # --- 1. Fetch prices (Jupiter primary, CoinGecko fallback) ---
    try:
        prices = await fetch_prices(assets=settings.tracked_assets)
    except Exception as exc:
        logger.warning("jupiter price fetch failed, trying coingecko: %s", exc)
        prices = {}

    if not prices:
        try:
            prices = await fetch_fallback_prices(assets=settings.tracked_assets)
        except Exception as exc:
            logger.error("coingecko fallback also failed: %s", exc)
            prices = {}

    if not prices:
        logger.error("no prices available - aborting cycle")
        db.record_state(status="idle")
        return

    logger.info("prices: %s", json.dumps(prices, sort_keys=True))

    # --- 2. Fetch research items ---
    items: list[dict[str, str]] = []
    try:
        arxiv_items = await fetch_arxiv()
        items.extend(arxiv_items)
    except Exception as exc:
        logger.warning("arxiv fetch failed: %s", exc)

    try:
        news_items = await fetch_news_rss()
        items.extend(news_items)
    except Exception as exc:
        logger.warning("news rss fetch failed: %s", exc)

    if not items:
        logger.warning("no research items ingested - aborting cycle")
        db.record_state(status="idle")
        return

    raw_item_ids = db.upsert_raw_items(items)

    logger.info("ingested %d items (%d arxiv, %d news)",
                len(items),
                len([i for i in items if i.get("source") == "arxiv"]),
                len([i for i in items if i.get("source") == "google_news_rss"]))

    # --- 3. Score items ---
    db.record_state(status="scoring")

    scores = await score_items(
        items=items,
        tracked_assets=settings.tracked_assets,
        groq_api_key=settings.groq_api_key,
    )

    if not scores:
        logger.warning("no scores produced - aborting cycle")
        db.record_state(status="idle")
        return

    db.insert_scores(raw_item_ids, scores)

    logger.info("got %d scores", len(scores))

    # --- 4. Generate signals ---
    signals = generate_signals(
        scores=scores,
        tracked_assets=settings.tracked_assets,
        sentiment_threshold=settings.sentiment_threshold,
        confidence_threshold=settings.confidence_threshold,
        base_trade_amount_usdc=settings.base_trade_amount_usdc,
        per_trade_buy_limit_usdc=settings.per_trade_buy_limit_usdc,
    )

    if not signals:
        logger.info("no actionable signals this cycle")
        db.record_state(status="idle")
        return

    logger.info("generated %d signals", len(signals))

    # --- 5. Validate and execute ---
    db.record_state(status="executing")
    cash = db.get_cash(settings.starting_paper_cash_usdc)
    pnl = db.latest_pnl(settings.starting_paper_cash_usdc)
    portfolio_value = pnl["total_value_usdc"]

    executed = 0
    for signal in signals:
        asset_price = prices.get(signal.asset)
        if asset_price is None:
            logger.warning("no price for %s - skipping signal", signal.asset)
            continue

        validation = validate_signal(
            signal=signal,
            current_cash_usdc=cash,
            max_position_pct=settings.max_position_pct,
            portfolio_value_usdc=portfolio_value,
        )

        if not validation.get("valid", False):
            logger.warning("signal rejected: %s %s - %s", signal.action, signal.asset, validation.get("reason"))
            continue

        # Mark as validated before execution.
        signal.validated = True
        signal.validation_details = validation.get("checks", {})

        result = executor.execute(signal=signal, price_usdc=asset_price)
        logger.info(
            "%s %s: %s (qty=%.6f)",
            signal.action, signal.asset, result.reason,
            result.quantity,
        )

        if result.approved:
            executed += 1
            cash = db.get_cash(settings.starting_paper_cash_usdc)

    db.record_state(status="idle")
    logger.info(
        "cycle complete: %d/%d signals executed | pnl: %s",
        executed,
        len(signals),
        json.dumps(db.latest_pnl(settings.starting_paper_cash_usdc), sort_keys=True),
    )


async def _run_loop(
    settings: Settings,
    db: Database,
    executor: PaperTradeExecutor,
    logger: object,
    max_cycles: int = 0,
) -> int:
    """Run live cycles forever (or up to max_cycles), surviving per-cycle errors."""
    cycle = 0
    while True:
        cycle += 1
        logger.info("loop cycle %d starting", cycle)
        try:
            await _run_live_cycle(settings, db, executor, logger)
        except Exception as exc:
            logger.exception("loop cycle %d failed: %s", cycle, exc)
            db.record_state(status="idle")

        if max_cycles and cycle >= max_cycles:
            logger.info("loop reached max_cycles=%d, stopping", max_cycles)
            return cycle

        logger.info("loop sleeping %ds until next cycle", settings.poll_interval_seconds)
        await asyncio.sleep(settings.poll_interval_seconds)


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

        if args.init_db and not args.once and not args.live and not args.loop:
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

        if args.live:
            if not settings.groq_api_key:
                raise SystemExit(
                    "GROQ_API_KEY is not set. The live pipeline requires a Groq API key for scoring. "
                    "Get a free key at https://console.groq.com and add it to .env."
                )

            asyncio.run(_run_live_cycle(settings, db, executor, logger))
            return

        if args.loop:
            if not settings.groq_api_key:
                raise SystemExit(
                    "GROQ_API_KEY is not set. The live pipeline requires a Groq API key for scoring. "
                    "Get a free key at https://console.groq.com and add it to .env."
                )

            try:
                asyncio.run(_run_loop(settings, db, executor, logger, max_cycles=args.max_cycles))
            except KeyboardInterrupt:
                logger.info("loop interrupted by user, shutting down cleanly")
                db.record_state(status="idle")
            return

        if not args.once:
            logger.info(
                "scaffold ready; rerun with --once for a demo trade, --live for one real cycle, "
                "or --loop for continuous live cycles"
            )
            return

        if settings.enable_devnet_policy:
            logger.info("ENABLE_DEVNET_POLICY=true; demo signal will require devnet Anchor approval")

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
