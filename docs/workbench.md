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
`gap_int = objective_int(solver) − objective_int(exact)` (a non-negative
integer) and `gap_rel = gap_int / max(1, |objective_int(exact)|)`.

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
Per solver: mean/median `gap_rel`, % of rebalances at the exact optimum,
pre-repair feasibility %, mean runtime (ms).

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
  "exact": {"bits": [0,1,...], "objective_int": "-123456789", "runtime_ms": 41},
  "results": [
    {
      "solver": "bsb",
      "bits": [0,1,...],
      "weights": [0.0, 0.125, ...],
      "objective_int": "-123456780",
      "feasible_raw": true,
      "repaired": false,
      "gap_int": "9",
      "gap_rel": 7.3e-8,
      "runtime_ms": 18
    }
  ]
}
```

- `objective_int` / `gap_int` are **decimal strings** (i128 exceeds JSON-safe
  integer range).
- If exact was requested but the instance exceeds the cap:
  `"exact": {"error": "TOO_LARGE", "subsets": 137846528820}` and `gap_*` are
  `null`.
- Binary discovery order in Python: `SEPARATRIX_CLI` env var, then
  `separatrix/target/release/separatrix-cli(.exe)`.

## Repo layout

- Rust: `separatrix/src/portfolio.rs` (QUBO builder, repair, K-exact
  enumerator — all wasm-safe library code), `separatrix/cli/` (workspace
  member `separatrix-cli`, serde lives here, not in the lib).
- Python: `agent/workbench/` package + `tests/test_workbench_*.py`;
  `numpy` joins `requirements.txt`.
- Output: `reports/<run-id>/report.md` and `report.json` (run-id =
  `YYYYMMDD-HHMMSS` UTC). `reports/` is gitignored except committed examples.
