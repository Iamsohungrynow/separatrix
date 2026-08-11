from __future__ import annotations

import argparse
import logging
import sys
from datetime import date
from pathlib import Path

from agent.config import Settings
from agent.db.database import Database
from agent.ingestion.binance_klines import BINANCE_SYMBOLS
from agent.workbench.baselines import default_baselines
from agent.workbench.bridge import DEFAULT_SOLVERS, SeparatrixCli
from agent.workbench.data import load_price_data
from agent.workbench.report import build_report, write_report
from agent.workbench.walkforward import WalkForwardConfig, run_walkforward

logger = logging.getLogger("leash.workbench")


def default_universe() -> list[str]:
    """All BINANCE_SYMBOLS tickers, deduplicated by Binance symbol.

    RENDER and RNDR alias the same RENDERUSDT series; keeping both would put
    one asset in the portfolio twice, so only the first ticker per symbol
    survives (dict order keeps RENDER).
    """
    seen: set[str] = set()
    tickers: list[str] = []
    for ticker, symbol in BINANCE_SYMBOLS.items():
        if symbol in seen:
            continue
        seen.add(symbol)
        tickers.append(ticker)
    return tickers


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m agent.workbench",
        description="Walk-forward evaluation of the Separatrix portfolio QUBO "
                    "against baselines (contract: docs/workbench.md)",
    )
    parser.add_argument("--start", required=True, help="Study start, YYYY-MM-DD "
                        "(first rebalance is start + 252d warmup)")
    parser.add_argument("--end", required=True, help="Study end, YYYY-MM-DD")
    parser.add_argument("--k", type=int, default=8, help="Portfolio cardinality (default 8)")
    parser.add_argument("--universe", default=None,
                        help="Comma-separated tickers (default: all Binance-mapped tickers)")
    parser.add_argument("--solvers", default=",".join(DEFAULT_SOLVERS),
                        help="Comma-separated solver names (default bsb,dsb,sa,pt,exact)")
    parser.add_argument("--bps", default="0,10,30",
                        help="Comma-separated one-way-turnover cost levels in bps")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-exact-subsets", type=int, default=None,
                        help="Cap on C(N,K) for exact ground truth "
                        "(default: the solver CLI's built-in 20M)")
    parser.add_argument("--db", default=None, help="SQLite path (default: SQLITE_PATH from .env)")
    parser.add_argument("--env-file", default=".env", help="Path to .env file")
    parser.add_argument("--reports-dir", default="reports",
                        help="Directory that receives reports/<run-id>/ output")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )

    try:
        start = date.fromisoformat(args.start)
        end = date.fromisoformat(args.end)
    except ValueError as exc:
        print(f"error: bad date: {exc}", file=sys.stderr)
        return 2
    if end <= start:
        print("error: --end must be after --start", file=sys.stderr)
        return 2

    if args.universe:
        universe = [part.strip().upper() for part in args.universe.split(",") if part.strip()]
    else:
        universe = default_universe()
    solvers = tuple(part.strip() for part in args.solvers.split(",") if part.strip())
    try:
        bps_levels = tuple(float(part) for part in args.bps.split(",") if part.strip())
    except ValueError as exc:
        print(f"error: bad --bps: {exc}", file=sys.stderr)
        return 2
    if not universe or not solvers or not bps_levels:
        print("error: --universe, --solvers and --bps must be non-empty", file=sys.stderr)
        return 2

    settings = Settings.from_env(args.env_file)
    db_path = Path(args.db) if args.db else settings.database_path

    db = Database(db_path)
    try:
        db.initialize()
        try:
            data = load_price_data(db, universe)
        except ValueError as exc:
            print(f"error: {exc} (db: {db_path})", file=sys.stderr)
            return 2
    finally:
        db.close()

    bridge = SeparatrixCli()
    if bridge.binary is None:
        logger.warning(
            "separatrix-cli binary not found (SEPARATRIX_CLI unset, no release "
            "build) — every separatrix rebalance will fail closed and be "
            "skipped; baselines still run"
        )

    config = WalkForwardConfig(
        start=start,
        end=end,
        k=args.k,
        solvers=solvers,
        bps_levels=bps_levels,
        seed=args.seed,
        max_exact_subsets=args.max_exact_subsets,
    )
    result = run_walkforward(
        data, config, bridge, default_baselines(args.k, universe)
    )

    report = build_report(result, data, meta={"db_path": str(db_path)})
    out_dir = write_report(report, reports_dir=args.reports_dir)

    # Publish the latest report next to the dashboard so
    # dashboard/workbench.html can fetch it without configuration.
    dashboard_copy = Path("dashboard") / "workbench-report.json"
    if dashboard_copy.parent.is_dir():
        dashboard_copy.write_text(
            (out_dir / "report.json").read_text(encoding="utf-8"), encoding="utf-8"
        )

    executed = report["rebalances"]["executed"]
    attempted = report["rebalances"]["attempted"]
    print(f"report written to {out_dir}")
    print(f"rebalances: {executed}/{attempted} executed "
          f"({report['rebalances']['skipped']} skipped, "
          f"{report['rebalances']['bridge_failures']} bridge failures)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
