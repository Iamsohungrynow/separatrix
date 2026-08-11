from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from agent.workbench import metrics
from agent.workbench.bridge import DEFAULT_MAX_EXACT_SUBSETS
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
    "Ratio conventions: Sharpe and Sortino assume a zero risk-free rate and "
    "annualize the arithmetic mean of daily simple returns by sqrt(365), "
    "while annualized return is geometric — so Sharpe is not exactly "
    "annualized return over annualized volatility.",
)


def run_id(now: datetime | None = None) -> str:
    """YYYYMMDD-HHMMSS in UTC."""
    stamp = now if now is not None else datetime.now(timezone.utc)
    return stamp.astimezone(timezone.utc).strftime("%Y%m%d-%H%M%S")


def cost_drag_reference(bps_levels: Sequence[float]) -> float:
    """The cost level every cost drag is measured against.

    Zero cost when the study priced it (the metric's intended meaning), else
    the cheapest level available — recorded either way so a ``--bps`` list
    that omits 0 cannot silently redefine "cost drag".
    """
    if not bps_levels:
        return math.nan
    if any(level == 0.0 for level in bps_levels):
        return 0.0
    return min(bps_levels)


def build_report(
    result: WalkForwardResult,
    data: PriceData,
    meta: dict[str, Any] | None = None,
    configured_universe: Sequence[str] | None = None,
    universe_dropped: Sequence[dict[str, str]] | None = None,
) -> dict[str, Any]:
    config = result.config
    executed = [r for r in result.records if r.bridge_error is None]
    bridge_failures = [r for r in result.records if r.bridge_error is not None]

    reference_bps = cost_drag_reference(config.bps_levels)
    reference_key = _bps_key(reference_bps)

    strategies: dict[str, Any] = {}
    for name, strat in sorted(result.strategies.items()):
        if not strat.sims:
            strategies[name] = {"rebalances": 0, "per_bps": {}, "cost_drag": {}}
            continue
        per_bps: dict[str, Any] = {}
        for bps in config.bps_levels:
            sim = strat.sims[bps]
            per_bps[_bps_key(bps)] = metrics.summarize(sim.daily_returns, sim.values)
        base_return = per_bps[reference_key]["annualized_return"]
        drag = {
            _bps_key(bps): metrics.cost_drag(
                base_return, per_bps[_bps_key(bps)]["annualized_return"]
            )
            for bps in config.bps_levels
            if bps != reference_bps
        }
        strategies[name] = {
            "rebalances": len(strat.schedule),
            "avg_one_way_turnover": metrics.average_turnover(strat.turnovers),
            "per_bps": per_bps,
            "cost_drag": drag,
            "cost_drag_reference_bps": reference_bps,
        }

    solver_stats = _solver_stats(executed)
    exact_ok = sum(1 for r in executed if r.exact_available)
    exact_too_large = sum(1 for r in executed if r.exact_error is not None)
    too_large_subsets = [
        r.exact_subsets for r in executed if r.exact_subsets is not None
    ]

    configured = list(
        configured_universe if configured_universe is not None else result.tickers
    )
    with_data = {
        asset
        for j, asset in enumerate(data.assets)
        if bool(data.observed[:, j].any())
    }

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
            "cost_drag_reference_bps": reference_bps,
            "seed": config.seed,
            "warmup_days": config.warmup_days,
            "rebalance_interval_days": config.rebalance_interval_days,
            "mu_window_days": config.mu_window_days,
            "sigma_window_days": config.sigma_window_days,
            "shrinkage_delta": config.shrinkage_delta,
            # The two knobs that decide every solver number below. A null
            # value means the study never sent it and the solver CLI's own
            # default applied; the effective value is spelled out either way.
            "max_exact_subsets": config.max_exact_subsets,
            "max_exact_subsets_effective": (
                config.max_exact_subsets
                if config.max_exact_subsets is not None
                else DEFAULT_MAX_EXACT_SUBSETS
            ),
            "max_exact_subsets_source": (
                "study" if config.max_exact_subsets is not None else "solver-cli-default"
            ),
            "budget": dict(config.budget) if config.budget else None,
            "budget_source": "study" if config.budget else "solver-cli-default",
            "universe": list(result.tickers),
            "universe_configured": configured,
            "universe_dropped": [dict(item) for item in (universe_dropped or [])],
        },
        "data": {
            # Tickers that carry at least one real close — what the report
            # says when it says "with data".
            "assets": len(with_data),
            "assets_configured": len(configured),
            "assets_without_data": [a for a in data.assets if a not in with_data],
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
            "max_subsets_seen": max(too_large_subsets) if too_large_subsets else None,
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
                {"gap_rel": [], "gap_norm": [], "gap_int": [], "feasible": [], "runtime": []},
            )
            gap_rel = record.gap_rel.get(solver)
            gap_norm = record.gap_norm.get(solver)
            gap_int = record.gap_int.get(solver)
            if gap_rel is not None:
                bucket["gap_rel"].append(float(gap_rel))
            if gap_norm is not None:
                bucket["gap_norm"].append(float(gap_norm))
            if gap_int is not None:
                bucket["gap_int"].append(int(gap_int))
            bucket["feasible"].append(bool(record.feasible_raw.get(solver, False)))
            bucket["runtime"].append(float(record.runtime_ms.get(solver, 0.0)))

    stats: dict[str, Any] = {}
    for solver, bucket in sorted(per_solver.items()):
        gaps = bucket["gap_rel"]
        norms = bucket["gap_norm"]
        gap_ints = bucket["gap_int"]
        stats[solver] = {
            "rebalances": len(bucket["runtime"]),
            # gap_rel divides by the optimum's own objective, so it blows up on
            # dates where that objective is near zero; the mean is therefore
            # outlier-dominated and the median is the one to read. gap_norm
            # divides by the achievable spread instead and stays in [0, 1].
            "gap_norm_mean": float(np.mean(norms)) if norms else math.nan,
            "gap_norm_median": float(np.median(norms)) if norms else math.nan,
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
    lines.append(f"- Cost levels: {', '.join(_bps_key(b) for b in config['bps_levels'])} bps "
                 f"(cost drag measured against {_bps_key(config['cost_drag_reference_bps'])} bps)")
    lines.append(f"- Exact cap: max_exact_subsets = "
                 f"{config['max_exact_subsets_effective']} "
                 f"({'set by this study' if config['max_exact_subsets_source'] == 'study' else 'solver CLI default, not sent'})")
    lines.append(f"- Solver budget: "
                 f"{config['budget'] if config['budget'] else 'solver CLI defaults (not sent)'}")
    lines.append(f"- Universe: {report['data']['assets_configured']} configured tickers, "
                 f"{report['data']['assets']} with data "
                 f"({report['data']['calendar_start']} → {report['data']['calendar_end']})")
    for dropped in config.get("universe_dropped", []):
        lines.append(f"  - dropped **{dropped.get('ticker')}**: {dropped.get('reason')}")
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
        reference_key = _bps_key(config["cost_drag_reference_bps"])
        lines.append("| Strategy | Rebalances | Ann. return | Ann. vol | Sharpe | "
                     f"Sortino | Max DD | Avg turnover | Cost drag vs {reference_key} bps |")
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
                 f"{exact['too_large']} exceeded the C(N,K) cap of "
                 f"{config['max_exact_subsets_effective']}"
                 + (f" (largest instance seen: {exact['max_subsets_seen']} subsets)"
                    if exact.get("max_subsets_seen") else "")
                 + ". Rebalances without ground truth keep their solver "
                   "selections and report null gaps.")
    lines.append("")
    lines.append("`gap_norm` is the gap as a fraction of the full achievable "
                 "spread on the feasible set (worst minus best k-subset): 0 is "
                 "optimal, 1 is the worst possible portfolio. It is the figure "
                 "to read. `gap_rel` divides the same gap by the optimum's own "
                 "objective, which is unstable on dates where that objective "
                 "passes through zero — its median is meaningful, its mean is "
                 "outlier-dominated and reported only for completeness.")
    lines.append("")
    lines.append("| Solver | Rebalances | Median gap_norm | Mean gap_norm | "
                 "Median gap_rel | % at exact optimum | Pre-repair feasibility % | "
                 "Mean runtime (ms) |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for solver, entry in report["solvers"].items():
        lines.append(
            f"| {solver} | {entry['rebalances']} "
            f"| {_fmt(entry.get('gap_norm_median'), 4)} "
            f"| {_fmt(entry.get('gap_norm_mean'), 4)} "
            f"| {_fmt(entry['gap_rel_median'], 4)} "
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
