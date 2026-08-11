from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from agent.workbench import metrics
from agent.workbench.data import PriceData
from agent.workbench.walkforward import WalkForwardResult

# The Limitations section must always cover these items (docs/workbench.md).
LIMITATIONS: tuple[str, ...] = (
    "No volume/liquidity filter yet: only daily closes are stored, so thinly "
    "traded or illiquid assets are not screened out of the universe.",
    "Curated-universe survivorship risk: the ticker list is hand-curated from "
    "currently listed Binance symbols, so delisted or failed assets are "
    "under-represented and results may be optimistic.",
    "Transaction costs are estimates: flat one-way-turnover charges at the "
    "configured bps levels ignore spread, slippage, market impact and fees "
    "that vary by venue and size.",
    "C(N,K) exactness bound: ground-truth enumeration only runs when the "
    "subset count is at or below the configured cap; larger instances report "
    "solver objectives without an exact optimality gap.",
)


def run_id(now: datetime | None = None) -> str:
    """YYYYMMDD-HHMMSS in UTC."""
    stamp = now if now is not None else datetime.now(timezone.utc)
    return stamp.astimezone(timezone.utc).strftime("%Y%m%d-%H%M%S")


def build_report(
    result: WalkForwardResult,
    data: PriceData,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    config = result.config
    executed = [r for r in result.records if r.bridge_error is None]
    bridge_failures = [r for r in result.records if r.bridge_error is not None]

    strategies: dict[str, Any] = {}
    for name, strat in sorted(result.strategies.items()):
        if not strat.sims:
            strategies[name] = {"rebalances": 0, "per_bps": {}, "cost_drag": {}}
            continue
        per_bps: dict[str, Any] = {}
        for bps in config.bps_levels:
            sim = strat.sims[bps]
            per_bps[_bps_key(bps)] = metrics.summarize(sim.daily_returns, sim.values)
        zero_key = _bps_key(config.bps_levels[0])
        base_return = per_bps[zero_key]["annualized_return"]
        drag = {
            _bps_key(bps): metrics.cost_drag(
                base_return, per_bps[_bps_key(bps)]["annualized_return"]
            )
            for bps in config.bps_levels[1:]
        }
        strategies[name] = {
            "rebalances": len(strat.schedule),
            "avg_one_way_turnover": metrics.average_turnover(strat.turnovers),
            "per_bps": per_bps,
            "cost_drag": drag,
        }

    solver_stats = _solver_stats(executed)
    exact_ok = sum(1 for r in executed if r.exact_available)
    exact_too_large = sum(1 for r in executed if r.exact_error is not None)

    # Deflated-Sharpe honesty: how many strategy/cost configurations this run
    # evaluated. Every one of them was "tried"; the best row of the table must
    # be read against this count.
    configurations_tried = sum(
        max(1, len(entry.get("per_bps", {}))) for entry in strategies.values()
    )

    report: dict[str, Any] = {
        "run_id": run_id(),
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "config": {
            "start": config.start.isoformat(),
            "end": config.end.isoformat(),
            "first_rebalance": (
                result.rebalance_days[0].isoformat() if result.rebalance_days else None
            ),
            "k": config.k,
            "risk_aversion": config.risk_aversion,
            "solvers": list(config.solvers),
            "bps_levels": list(config.bps_levels),
            "seed": config.seed,
            "warmup_days": config.warmup_days,
            "rebalance_interval_days": config.rebalance_interval_days,
            "mu_window_days": config.mu_window_days,
            "sigma_window_days": config.sigma_window_days,
            "shrinkage_delta": config.shrinkage_delta,
            "universe": list(result.tickers),
        },
        "data": {
            "assets": len(data.assets),
            "calendar_start": data.dates[0].isoformat(),
            "calendar_end": data.dates[-1].isoformat(),
            "calendar_days": len(data.dates),
        },
        "rebalances": {
            "attempted": len(result.rebalance_days),
            "executed": len(executed),
            "bridge_failures": len(bridge_failures),
            "skipped": len([s for s in result.skips if s.scope == "all"]),
            "skip_log": [
                {"date": s.day.isoformat(), "reason": s.reason, "scope": s.scope}
                for s in result.skips
            ],
        },
        "configurations_tried": configurations_tried,
        "strategies": strategies,
        "series": _equity_series(result),
        "solvers": solver_stats,
        "exact": {
            "available": exact_ok,
            "too_large": exact_too_large,
            "available_pct": _pct(exact_ok, len(executed)),
        },
        "limitations": list(LIMITATIONS),
    }
    if meta:
        report["meta"] = dict(meta)
    return report


def _equity_series(result: WalkForwardResult, every: int = 7) -> dict[str, Any]:
    """Equity paths per strategy per cost level, downsampled to every 7th day
    (plus the final day) — enough resolution for charts without bloating the
    JSON. Values are the same paths the metrics summarize."""
    out: dict[str, Any] = {}
    for name, strat in sorted(result.strategies.items()):
        if not strat.sims:
            continue
        per: dict[str, Any] = {}
        for bps, sim in strat.sims.items():
            if len(sim.values) == 0:
                continue
            idx = list(range(0, len(sim.values), every))
            if idx[-1] != len(sim.values) - 1:
                idx.append(len(sim.values) - 1)
            per[_bps_key(bps)] = {
                "dates": [sim.dates[i].isoformat() for i in idx],
                "equity": [round(float(sim.values[i]), 6) for i in idx],
            }
        out[name] = per
    return out


def _solver_stats(records) -> dict[str, Any]:
    per_solver: dict[str, dict[str, list]] = {}
    for record in records:
        for solver in record.selection:
            bucket = per_solver.setdefault(
                solver,
                {"gap_rel": [], "gap_int": [], "feasible": [], "runtime": []},
            )
            gap_rel = record.gap_rel.get(solver)
            gap_int = record.gap_int.get(solver)
            if gap_rel is not None:
                bucket["gap_rel"].append(float(gap_rel))
            if gap_int is not None:
                bucket["gap_int"].append(int(gap_int))
            bucket["feasible"].append(bool(record.feasible_raw.get(solver, False)))
            bucket["runtime"].append(float(record.runtime_ms.get(solver, 0.0)))

    stats: dict[str, Any] = {}
    for solver, bucket in sorted(per_solver.items()):
        gaps = bucket["gap_rel"]
        gap_ints = bucket["gap_int"]
        stats[solver] = {
            "rebalances": len(bucket["runtime"]),
            "gap_rel_mean": float(np.mean(gaps)) if gaps else math.nan,
            "gap_rel_median": float(np.median(gaps)) if gaps else math.nan,
            "gaps_available": len(gaps),
            "pct_exact_optimum": _pct(
                sum(1 for g in gap_ints if g == 0), len(gap_ints)
            ),
            "pre_repair_feasibility_pct": _pct(
                sum(bucket["feasible"]), len(bucket["feasible"])
            ),
            "mean_runtime_ms": (
                float(np.mean(bucket["runtime"])) if bucket["runtime"] else math.nan
            ),
        }
    return stats


def _pct(numerator: int, denominator: int) -> float:
    if denominator == 0:
        return math.nan
    return 100.0 * numerator / denominator


def _bps_key(bps: float) -> str:
    return f"{bps:g}"


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------

def render_markdown(report: dict[str, Any]) -> str:
    config = report["config"]
    lines: list[str] = []
    lines.append(f"# Separatrix workbench report — {report['run_id']}")
    lines.append("")
    lines.append(f"Generated {report['generated_at']}.")
    lines.append("")
    lines.append("## Study")
    lines.append("")
    lines.append(f"- Date range: **{config['start']} → {config['end']}** "
                 f"(first rebalance {config['first_rebalance']}, "
                 f"warmup {config['warmup_days']}d, every {config['rebalance_interval_days']}d)")
    lines.append(f"- K = **{config['k']}**, risk aversion λ = {config['risk_aversion']}, "
                 f"shrinkage δ = {config['shrinkage_delta']}, seed = {config['seed']}")
    lines.append(f"- Solvers: {', '.join(config['solvers'])}")
    lines.append(f"- Cost levels: {', '.join(_bps_key(b) for b in config['bps_levels'])} bps")
    lines.append(f"- Universe: {len(config['universe'])} configured tickers, "
                 f"{report['data']['assets']} with data "
                 f"({report['data']['calendar_start']} → {report['data']['calendar_end']})")
    reb = report["rebalances"]
    lines.append(f"- Rebalances: {reb['attempted']} attempted, {reb['executed']} executed, "
                 f"{reb['skipped']} skipped, {reb['bridge_failures']} bridge failures")
    lines.append(f"- **Configurations tried in this study: {report['configurations_tried']}** "
                 "(strategy × cost-level rows; judge the best Sharpe against this "
                 "count — deflated-Sharpe honesty)")
    lines.append("")

    lines.append("## Strategy performance")
    lines.append("")
    for bps in config["bps_levels"]:
        key = _bps_key(bps)
        lines.append(f"### {key} bps per one-way turnover")
        lines.append("")
        lines.append("| Strategy | Rebalances | Ann. return | Ann. vol | Sharpe | "
                     "Sortino | Max DD | Avg turnover | Cost drag |")
        lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
        for name, entry in report["strategies"].items():
            per = entry.get("per_bps", {}).get(key)
            if per is None:
                lines.append(f"| {name} | 0 | — | — | — | — | — | — | — |")
                continue
            drag = entry.get("cost_drag", {}).get(key)
            lines.append(
                f"| {name} | {entry['rebalances']} "
                f"| {_fmt_pct(per['annualized_return'])} "
                f"| {_fmt_pct(per['annualized_volatility'])} "
                f"| {_fmt(per['sharpe'])} "
                f"| {_fmt(per['sortino'])} "
                f"| {_fmt_pct(per['max_drawdown'])} "
                f"| {_fmt(entry.get('avg_one_way_turnover'))} "
                f"| {_fmt_pct(drag) if drag is not None else '—'} |"
            )
        lines.append("")

    lines.append("## Solver quality")
    lines.append("")
    exact = report["exact"]
    lines.append(f"Exact ground truth available on {exact['available']} rebalances "
                 f"({_fmt(exact['available_pct'])}%); "
                 f"{exact['too_large']} exceeded the C(N,K) cap.")
    lines.append("")
    lines.append("| Solver | Rebalances | Mean gap_rel | Median gap_rel | "
                 "% at exact optimum | Pre-repair feasibility % | Mean runtime (ms) |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for solver, entry in report["solvers"].items():
        lines.append(
            f"| {solver} | {entry['rebalances']} "
            f"| {_fmt(entry['gap_rel_mean'], 6)} "
            f"| {_fmt(entry['gap_rel_median'], 6)} "
            f"| {_fmt(entry['pct_exact_optimum'])} "
            f"| {_fmt(entry['pre_repair_feasibility_pct'])} "
            f"| {_fmt(entry['mean_runtime_ms'])} |"
        )
    lines.append("")

    skip_log = reb.get("skip_log", [])
    if skip_log:
        lines.append("## Skipped rebalances")
        lines.append("")
        lines.append("| Date | Scope | Reason |")
        lines.append("|---|---|---|")
        for skip in skip_log:
            lines.append(f"| {skip['date']} | {skip['scope']} | {skip['reason']} |")
        lines.append("")

    lines.append("## Limitations")
    lines.append("")
    for item in report["limitations"]:
        lines.append(f"- {item}")
    lines.append("")
    return "\n".join(lines)


def _fmt(value: Any, digits: int = 2) -> str:
    if value is None:
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    if math.isnan(number):
        return "—"
    return f"{number:.{digits}f}"


def _fmt_pct(value: Any) -> str:
    if value is None:
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    if math.isnan(number):
        return "—"
    return f"{100.0 * number:.2f}%"


def _jsonable(value: Any) -> Any:
    """NaN/inf become null so report.json stays strict JSON."""
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def write_report(
    report: dict[str, Any],
    reports_dir: str | Path = "reports",
) -> Path:
    """Write reports/<run-id>/report.json and report.md; returns the directory."""
    out_dir = Path(reports_dir) / report["run_id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(
        json.dumps(_jsonable(report), indent=2, allow_nan=False), encoding="utf-8"
    )
    (out_dir / "report.md").write_text(render_markdown(report), encoding="utf-8")
    return out_dir
