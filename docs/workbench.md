# Separatrix Workbench — formulation, protocol, and evaluation rules

This document is the contract between the Python walk-forward harness
(`agent/workbench/`) and the Rust solver CLI (`separatrix/cli/`). Every claim
the workbench publishes is defined here first.

## Portfolio formulation (v1)

Cardinality-constrained selection: from a universe of `N` assets choose
**exactly K**, equal-weighted (`w_i = x_i / K`, `x ∈ {0,1}^N`).

Inputs at rebalance date `t` (strictly point-in-time):

- Daily log-returns from `price_history` closes, `source = "binance"` only.
- `μ_i` = mean daily log-return over the trailing **90** days.
- `Σ` = sample covariance over the trailing **180** days, with diagonal
  shrinkage `Σ' = (1−δ)·Σ + δ·diag(Σ)`, `δ = 0.3`.

Float objective (minimized):

```
f(x) = (1/K²)·xᵀΣ'x  −  (λ/K)·μᵀx  +  P·(Σx − K)²
```

- `λ` (risk_aversion trade-off) default **0.5**.
- `P` (cardinality penalty) is chosen by the Rust side automatically so that
  violating the cardinality constraint can never pay: `P` exceeds the largest
  possible marginal gain of any single add/drop (formula documented in
  `portfolio.rs`; overridable).

**Canonical objective**: Rust quantizes the QUBO once to bounded integers
(`QuantizedQubo`); every solver optimizes and is scored on the **integer**
objective. Floats build models; integers keep score.

**Feasibility & repair**: SB/SA/PT solve the penalized unconstrained QUBO and
may return `Σx ≠ K`. Such solutions are greedily repaired (add/drop the asset
with the best marginal integer-objective change until exactly K). Reports show
the **pre-repair feasibility rate** and score the repaired solution.

**Ground truth**: exact enumeration over all `C(N,K)` subsets of the same
integer objective (the penalty term is zero on the feasible set). The
enumerator refuses instances with `C(N,K)` above a configurable cap (default
2×10⁷) rather than running for hours. Per-solver gap:

```
gap_int  = objective_int(solver) − objective_int(exact)          (>= 0)
gap_norm = gap_int / (worst − best)                              (in [0, 1])
gap_rel  = gap_int / max(1, |portfolio_objective_int(exact)|)
```

**`gap_norm` is the headline measure.** The enumerator sees every feasible
`k`-subset, so it reports the worst one as well as the best; dividing the gap
by that spread answers "how far along the achievable range did the solver
land", where 0 is optimal and 1 is the worst portfolio available. It is
scale-free, penalty-free, and — unlike any ratio to the optimum itself —
stable on dates where the optimal objective passes through zero. On real data
that instability is not hypothetical: it drags the *mean* `gap_rel` an order
of magnitude above its median. Reports print both, and say which to read.

`gap_rel` is normalized by the **portfolio** objective — `objective_int`
plus `objective_offset_int`, i.e. the risk/return objective with the
cardinality-penalty constant removed. Normalizing by the raw penalized
`objective_int` would be wrong: on the feasible set every solution carries the
same constant `P·K²` term, and `P` is chosen large enough to dominate any
single add/drop, so that constant is far larger than the portfolio objective
itself. Dividing by it deflates every gap by roughly the ratio of penalty to
signal — a solver could be 10% worse in portfolio terms and still show a
"0.1%" gap. The absolute `gap_int` is unaffected by the choice; only the
relative figure is, and it now means "fraction of the objective anyone
actually cares about".

**When exact is unavailable** (`C(N,K)` over the cap), the study does *not*
lose the rebalance: every solver keeps its selection and its objective, and
`gap_int` / `gap_rel` are `null` for that date. Reports count those dates
separately (`exact.too_large`) and the per-solver gap statistics are computed
over the dates that do have ground truth (`gaps_available`).

## Walk-forward protocol

- Rebalance every **7 calendar days**, from `start + warmup` to `end`;
  warmup = **252** days.
- Universe at `t`: configured tickers with ≥252 daily binance closes at or
  before `t` **and** a close within 3 days of `t` (still trading). If fewer
  than `K + 5` qualify, the rebalance is skipped and logged.
- The selected equal-weight portfolio is held until the next rebalance; daily
  portfolio returns come from realized closes.
- **No data after `t` enters any decision made at `t`.** Tests must pin this
  (e.g. perturbing future prices must not change the selection at `t`).
- Transaction costs: one-way turnover `Σ_i |w_new,i − w_prev,i|` charged at
  **0 / 10 / 30 bps** of portfolio value per rebalance; all three reported.

## Baselines (same dates, universe, and cost model)

1. `1/N` — equal weight over the whole eligible universe, weekly.
2. Buy-and-hold BTC; buy-and-hold SOL.
3. `Momentum-K` — top K by trailing 90-day return, equal weight.
4. `MinVar-greedy-K` — greedy add minimizing `(1/k²)xᵀΣ'x`.
5. HRP over the universe (numpy-only implementation) — include only if the
   implementation is clean and tested; otherwise omit and say so in the report.

## Metrics

Per strategy: annualized (365d) return, volatility, Sharpe, Sortino, max
drawdown, average one-way turnover per rebalance, cost drag at each bps level.
Cost drag is measured against zero cost when the study priced it, else against
the cheapest level it did price; the reference level is recorded
(`config.cost_drag_reference_bps`) so a `--bps` list that omits 0 cannot
silently redefine the metric. The value path starts at 1.0 **before** the
first rebalance's entry charge, so entry costs show up in every return-based
metric rather than cancelling out of the daily-return series.
Per solver: mean/median `gap_norm` (the headline) and median `gap_rel`, % of
rebalances at the exact optimum, pre-repair feasibility %, mean runtime (ms).

Every report includes: date range, number of rebalances, the **number of
configurations tried in the study** (deflated-Sharpe honesty), and a
Limitations section covering at minimum: no volume/liquidity filter yet
(closes only are stored), curated-universe survivorship risk, cost estimates,
and the `C(N,K)` exactness bound.

## CLI protocol (Python ⇄ `separatrix-cli`)

One JSON object on stdin, one JSON line on stdout, exit 0 on success.
Any non-zero exit or unparseable output is a **failure**; the Python bridge is
fail-closed (the rebalance is skipped with the error logged — results are
never fabricated).

Request:

```json
{
  "mu": [0.001, ...],
  "sigma": [[0.0004, ...], ...],
  "risk_aversion": 0.5,
  "k": 8,
  "penalty": null,
  "solvers": ["bsb", "dsb", "sa", "pt", "exact"],
  "budget": {
    "sb_steps": 2000, "sb_replicas": 8,
    "sa_sweeps": 2000, "sa_restarts": 8,
    "pt_sweeps": 2000, "pt_replicas": 16
  },
  "seed": 42,
  "max_exact_subsets": 20000000
}
```

`penalty`, `budget`, and `max_exact_subsets` are optional (defaults above /
auto). `sigma` must be symmetric, length-N rows.

Response:

```json
{
  "n": 30, "k": 8, "scale": 12345.6,
  "objective_offset_int": "3644735687",
  "exact": {
    "bits": [0,1,...],
    "objective_int": "-123456789",
    "portfolio_objective_int": "-78901",
    "worst_objective_int": "-123400000",
    "objective_range_int": "56789",
    "runtime_ms": 0.041
  },
  "results": [
    {
      "solver": "bsb",
      "bits": [0,1,...],
      "weights": [0.0, 0.125, ...],
      "objective_int": "-123456780",
      "portfolio_objective_int": "-78892",
      "feasible_raw": true,
      "repaired": false,
      "gap_int": "9",
      "gap_rel": 1.1e-4,
      "gap_norm": 1.6e-4,
      "runtime_ms": 18.375
    }
  ]
}
```

- `objective_int`, `gap_int`, `objective_offset_int` and
  `portfolio_objective_int` are **decimal strings** (i128 exceeds JSON-safe
  integer range).
- `worst_objective_int` and `objective_range_int` come free with enumeration
  (the DFS already visits every feasible subset) and define `gap_norm`.
- `objective_offset_int` (top level) is the quantized `P·K²` constant the
  penalized QUBO drops on the feasible set.
  `portfolio_objective_int = objective_int + objective_offset_int` is the true
  portfolio objective, reported in the `exact` block and in every solver
  result. `gap_rel` is normalized by `|portfolio_objective_int(exact)|`, not by
  the penalty-polluted `objective_int` (see *Ground truth* above for why).
- `runtime_ms` (in `exact` and per solver) is a **float**: sub-millisecond
  solves are routine at this size and rounding them to integers would report
  most of them as `0`.
- If exact was requested but the instance exceeds the cap:
  `"exact": {"error": "TOO_LARGE", "subsets": 137846528820}` — `subsets` is a
  JSON **number**, not a string — and every `gap_int` / `gap_rel` is `null`
  while the solver results themselves are unchanged.
- Binary discovery order in Python: `SEPARATRIX_CLI` env var, then
  `separatrix/target/release/separatrix-cli(.exe)`.

## Reproducing the published study

`dashboard/workbench-report.json` (rendered by `dashboard/workbench.html`) was
produced by, from the repo root, with `data/leash.db` backfilled and
`separatrix/target/release/separatrix-cli` built:

```
python -m agent.workbench --start 2021-06-01 --end 2026-07-31 --k 8 --solvers bsb,dsb,sa,pt,exact --bps 0,10,30 --seed 42 --max-exact-subsets 100000000 --publish-dashboard
```

(one line, so it pastes unchanged into PowerShell or a POSIX shell)

Notes on reproducing it exactly:

- `--max-exact-subsets 100000000 --publish-dashboard` raises the cap above the CLI's built-in
  2×10⁷; the published run needed it to enumerate every rebalance. Every
  report records the cap it ran under (`config.max_exact_subsets`,
  `config.max_exact_subsets_effective` and `..._source`), so a study can
  always be re-run from its own config.
- The run writes `reports/<run-id>/report.{json,md}`. It does **not** touch
  `dashboard/workbench-report.json`: republishing the dashboard artifact is
  opt-in via `--publish-dashboard` (destination `--dashboard-path`).
- The universe defaults to every ticker in `BINANCE_SYMBOLS`, including
  aliases. Tickers with no rows in the database are dropped before the study
  runs and logged by name; the report records the configured universe, the
  effective one, and each dropped ticker with its reason
  (`config.universe_configured`, `config.universe`, `config.universe_dropped`).

## Repo layout

- Rust: `separatrix/src/portfolio.rs` (QUBO builder, repair, K-exact
  enumerator — all wasm-safe library code), `separatrix/cli/` (workspace
  member `separatrix-cli`, serde lives here, not in the lib).
- Python: `agent/workbench/` package + `tests/test_workbench_*.py`;
  `numpy` joins `requirements.txt`.
- Output: `reports/<run-id>/report.md` and `report.json` (run-id =
  `YYYYMMDD-HHMMSS` UTC). `reports/` is gitignored except committed examples.
