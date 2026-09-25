// Numbers on the Benchmarks page, copied from committed artifacts. Each block
// names the file and run it came from; if the artifact changes, change this.

/** dashboard/workbench-report.json, run 20260811-114110 (39 assets, K=8, 234 weekly rebalances). */
export const WORKBENCH = {
  source: "dashboard/workbench-report.json",
  runId: "20260811-114110",
  rebalances: 234,
  assets: 39,
  k: 8,
  maxSubsets: "61.5M",
  period: "2022-02 → 2026-07",
  solvers: [
    { id: "exact", name: "Exact enumeration", medianGap: 0, meanGap: 0, pctOptimal: 100, meanMs: 273.74 },
    { id: "bSB", name: "Ballistic SB", medianGap: 0.0309, meanGap: 0.0525, pctOptimal: 14.96, meanMs: 2.159 },
    { id: "SA", name: "Simulated annealing", medianGap: 0.0789, meanGap: 0.082, pctOptimal: 0, meanMs: 1.432 },
    { id: "PT", name: "Parallel tempering", medianGap: 0.1097, meanGap: 0.1073, pctOptimal: 0, meanMs: 4.968 },
    { id: "dSB", name: "Discrete SB", medianGap: 0.3246, meanGap: 0.319, pctOptimal: 0, meanMs: 1.768 },
  ],
};

/**
 * reports/examples/dicke-characterisation/result.json, run 20260817-090743.
 * Compiled two-qubit gate counts of the Dicke + XY-ring ansatz (p = 1) per
 * coupling graph: [n, k, all-to-all, heavy-hex, linear]. Emulated, not run on hardware.
 */
export const ROUTING = {
  source: "reports/examples/dicke-characterisation/report.md",
  runId: "20260817-090743",
  heavyHexMedian: 1.956,
  heavyHexRange: [1.0, 2.278],
  linearMedian: 2.2,
  linearRange: [1.6, 2.65],
  sectorLossPer2q: 6.78e-4,
  points: [
    [4, 1, 12, 18, 21], [4, 2, 30, 51, 48], [6, 1, 20, 38, 38], [6, 2, 56, 92, 98], [6, 3, 83, 164, 176],
    [8, 1, 28, 40, 61], [8, 2, 82, 160, 145], [8, 3, 127, 256, 289], [8, 4, 163, 334, 349],
    [10, 1, 36, 48, 72], [10, 2, 108, 180, 180], [10, 3, 171, 363, 423], [10, 4, 225, 468, 495], [10, 5, 270, 615, 609],
    [12, 1, 44, 44, 107], [12, 2, 134, 233, 224], [12, 3, 215, 461, 461], [12, 4, 287, 608, 662], [12, 5, 350, 788, 773], [12, 6, 404, 758, 908],
    [14, 1, 52, 73, 106], [14, 2, 160, 277, 352], [14, 3, 259, 562, 547], [14, 4, 349, 721, 829], [14, 5, 430, 934, 943], [14, 6, 502, 949, 1135], [14, 7, 565, 1099, 1333],
    [16, 1, 60, 78, 159], [16, 2, 186, 327, 432], [16, 3, 303, 660, 672], [16, 4, 411, 864, 1020], [16, 5, 510, 1125, 1116], [16, 6, 600, 1179, 1374], [16, 7, 681, 1332, 1614], [16, 8, 753, 1479, 1764],
  ] as [number, number, number, number, number][],
};

/** reports/examples/heron-simulation/report.md: n=10, k=3, noiseless simulation. Hardware NOT RUN. */
export const QAOA = {
  source: "reports/examples/heron-simulation/report.md",
  rows: [
    { name: "Uniform random feasible portfolio", gap: 0.463, pOpt: 0.008, feasible: 100 },
    { name: "QAOA p = 2, XY mixer on a Dicke state", gap: 0.203, pOpt: 0.066, feasible: 100, highlight: true },
    { name: "QAOA p = 2, X mixer + penalty", gap: 0.453, pOpt: 0.004, feasible: 61 },
  ],
};

/** docs/onchain.md: measured compute units on Solana devnet. */
export const ONCHAIN = {
  source: "docs/onchain.md",
  program: "CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp",
  revealTx: "DoNokzvPXDyMkq8V42wERNr5PCZRizAbKwJrDCJ2GZjoADSi8hWR2bGfnC3gsTvh2LdNoqG4SZMDPnUVPPav7MB",
  leash: "EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV",
  revealCu: [ { k: 4, cu: "≈ 8.5k" }, { k: 24, cu: "≈ 61k" } ],
  maxCardinality: 40,
};
