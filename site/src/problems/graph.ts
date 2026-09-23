import { Rng } from "./rng";

/**
 * Undirected simple graph. `edges` are [i, j, w] with i < j, no duplicates,
 * no self-loops; w is the weight (1 for unweighted graphs). `pos` holds one
 * drawing position per node inside [0.05, 0.95]².
 */
export interface Graph {
  n: number;
  edges: [number, number, number][];
  pos: [number, number][];
}

export type GraphKind = "geometric" | "erdos" | "regular3" | "grid" | "torus" | "ring" | "petersen";

export const GRAPH_KIND_OPTIONS: { value: GraphKind; label: string }[] = [
  { value: "geometric", label: "Random geometric (points + radius)" },
  { value: "erdos", label: "Erdős–Rényi random" },
  { value: "regular3", label: "Random 3-regular" },
  { value: "grid", label: "Grid" },
  { value: "torus", label: "Torus (wrapped grid)" },
  { value: "ring", label: "Ring (cycle)" },
  { value: "petersen", label: "Petersen graph (10 nodes)" },
];

export type Weighting = "unit" | "random";

const LO = 0.05;
const HI = 0.95;

// ---------------------------------------------------------------- helpers

class EdgeSet {
  private readonly seen = new Set<number>();
  readonly edges: [number, number, number][] = [];
  constructor(private readonly n: number) {}
  has(i: number, j: number): boolean {
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    return this.seen.has(a * this.n + b);
  }
  add(i: number, j: number, w = 1): boolean {
    if (i === j) return false;
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const key = a * this.n + b;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.edges.push([a, b, w]);
    return true;
  }
}

function sortEdges(edges: [number, number, number][]): [number, number, number][] {
  return edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/** Uniformly rescale positions (keeping aspect ratio) and centre them in [0.05, 0.95]². */
export function normalizePositions(pos: [number, number][]): [number, number][] {
  if (pos.length === 0) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pos) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  if (!(span > 0)) return pos.map(() => [0.5, 0.5]);
  const scale = (HI - LO) / span;
  const offX = LO + ((HI - LO) - (maxX - minX) * scale) / 2;
  const offY = LO + ((HI - LO) - (maxY - minY) * scale) / 2;
  return pos.map(([x, y]) => [clamp01(offX + (x - minX) * scale), clamp01(offY + (y - minY) * scale)]);
}

function clamp01(v: number): number {
  return Math.min(HI, Math.max(LO, v));
}

function components(n: number, edges: [number, number, number][]): number[] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (const [i, j] of edges) {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  return Array.from({ length: n }, (_, i) => find(i));
}

/** True if the graph is connected (an empty or 1-node graph counts as connected). */
export function isConnected(g: Graph): boolean {
  if (g.n <= 1) return true;
  const comp = components(g.n, g.edges);
  return comp.every((c) => c === comp[0]);
}

export function degrees(g: Graph): number[] {
  const d = new Array<number>(g.n).fill(0);
  for (const [i, j] of g.edges) {
    d[i]++;
    d[j]++;
  }
  return d;
}

// ---------------------------------------------------------------- layout

const GRAVITY = 3;

/**
 * Deterministic Fruchterman–Reingold layout: seeded initial positions, a
 * fixed number of iterations with linear cooling. O(n² + m) per iteration.
 * Returns positions normalised into [0.05, 0.95]².
 */
export function forceLayout(n: number, edges: [number, number, number][], seed: number, iterations?: number): [number, number][] {
  if (n === 0) return [];
  if (n === 1) return [[0.5, 0.5]];
  const rng = new Rng(seed ^ 0x51f15e);
  const iters = iterations ?? (n <= 60 ? 400 : n <= 150 ? 250 : 150);
  const k = Math.sqrt(1 / n); // ideal edge length in a unit square
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = rng.float();
    y[i] = rng.float();
  }
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const t0 = 0.1;
  for (let it = 0; it < iters; it++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = x[i] - x[j];
        let ey = y[i] - y[j];
        let d2 = ex * ex + ey * ey;
        if (d2 < 1e-12) {
          // Coincident points: deterministic nudge.
          ex = ((i * 7 + j * 13) % 11) / 11 - 0.5 + 1e-3;
          ey = ((i * 5 + j * 3) % 7) / 7 - 0.5 + 1e-3;
          d2 = ex * ex + ey * ey;
        }
        const f = (k * k) / d2; // repulsion k²/d, applied along the unit vector
        dx[i] += ex * f;
        dy[i] += ey * f;
        dx[j] -= ex * f;
        dy[j] -= ey * f;
      }
    }
    for (const [i, j] of edges) {
      const ex = x[i] - x[j];
      const ey = y[i] - y[j];
      const d = Math.sqrt(ex * ex + ey * ey) + 1e-9;
      const f = d / k; // attraction d²/k, along the unit vector
      dx[i] -= ex * f;
      dy[i] -= ey * f;
      dx[j] += ex * f;
      dy[j] += ey * f;
    }
    const temp = t0 * (1 - it / iters) + 1e-4;
    for (let i = 0; i < n; i++) {
      // Linear gravity towards the centre. Total repulsion felt at radius r
      // is about n·k²/r = 1/r, so gravity G·r settles stray pieces (isolated
      // nodes, small components) near r ≈ 1/√G instead of flinging them to
      // the far corners and squashing the main component.
      dx[i] -= (x[i] - 0.5) * GRAVITY;
      dy[i] -= (y[i] - 0.5) * GRAVITY;
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (len > 0) {
        const step = Math.min(len, temp);
        x[i] += (dx[i] / len) * step;
        y[i] += (dy[i] / len) * step;
      }
    }
  }
  const pos: [number, number][] = [];
  for (let i = 0; i < n; i++) pos.push([x[i], y[i]]);
  return normalizePositions(pos);
}

// ---------------------------------------------------------------- generators

export interface GeometricOptions {
  /** Connection radius in the unit square. Takes precedence over avgDegree. */
  radius?: number;
  /** Target average degree (default 4); the radius is derived from it. */
  avgDegree?: number;
}

/**
 * Random geometric graph: n uniform points in the unit square, an edge
 * between every pair closer than the radius. Components are then joined by
 * their closest pair of points, so the result is always connected.
 */
export function geometric(n: number, opts: GeometricOptions, seed: number): Graph {
  assertN(n, 1);
  const rng = new Rng(seed);
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < n; i++) {
    px.push(rng.float());
    py.push(rng.float());
  }
  // Expected degree ≈ (n−1)·π r² ignoring the boundary; the 1.2 factor makes
  // up for points near the edges having fewer neighbours.
  const avg = opts.avgDegree ?? 4;
  const r = opts.radius ?? Math.sqrt((1.2 * avg) / (Math.max(1, n - 1) * Math.PI));
  const set = new EdgeSet(n);
  const d2 = (i: number, j: number) => (px[i] - px[j]) ** 2 + (py[i] - py[j]) ** 2;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (d2(i, j) <= r * r) set.add(i, j);
  // Join components greedily by the globally closest inter-component pair.
  for (;;) {
    const comp = components(n, set.edges);
    if (comp.every((c) => c === comp[0])) break;
    let best = Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (comp[i] === comp[j]) continue;
        const d = d2(i, j);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    set.add(bi, bj);
  }
  const pos = normalizePositions(px.map((xv, i) => [xv, py[i]] as [number, number]));
  return { n, edges: sortEdges(set.edges), pos };
}

/** Erdős–Rényi G(n, p), laid out with the force-directed layout. */
export function erdosRenyi(n: number, p: number, seed: number): Graph {
  assertN(n, 1);
  if (!(p >= 0 && p <= 1)) throw new Error(`Edge probability must be in [0, 1] (got ${p})`);
  const rng = new Rng(seed);
  const set = new EdgeSet(n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rng.chance(p)) set.add(i, j);
  const edges = sortEdges(set.edges);
  return { n, edges, pos: forceLayout(n, edges, seed) };
}

/**
 * Uniform-ish random 3-regular simple graph (pairing model with local
 * rejection and restarts). Requires n even and n ≥ 4.
 */
export function regular3(n: number, seed: number): Graph {
  if (!Number.isInteger(n) || n < 4 || n % 2 !== 0) {
    throw new Error(`A 3-regular graph needs an even number of nodes, at least 4 (got ${n})`);
  }
  const rng = new Rng(seed);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const points: number[] = [];
    for (let i = 0; i < n; i++) points.push(i, i, i);
    const set = new EdgeSet(n);
    let ok = true;
    while (points.length > 0) {
      let paired = false;
      for (let tries = 0; tries < 50; tries++) {
        const a = rng.int(0, points.length - 1);
        let b = rng.int(0, points.length - 2);
        if (b >= a) b++;
        const u = points[a];
        const v = points[b];
        if (u === v || set.has(u, v)) continue;
        set.add(u, v);
        // Remove the higher index first so the lower stays valid.
        const hi = Math.max(a, b);
        const lo = Math.min(a, b);
        points[hi] = points[points.length - 1];
        points.pop();
        points[lo] = points[points.length - 1];
        points.pop();
        paired = true;
        break;
      }
      if (!paired) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const edges = sortEdges(set.edges);
      return { n, edges, pos: forceLayout(n, edges, seed) };
    }
  }
  throw new Error("Could not build a random 3-regular graph; try another seed");
}

/** rows × cols grid (or torus, with wrap-around edges). Intrinsic positions. */
export function grid(rows: number, cols: number, torus = false): Graph {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
    throw new Error(`Grid dimensions must be positive integers (got ${rows} × ${cols})`);
  }
  const n = rows * cols;
  const set = new EdgeSet(n);
  const id = (r: number, c: number) => r * cols + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) set.add(id(r, c), id(r, c + 1));
      else if (torus && cols > 2) set.add(id(r, c), id(r, 0));
      if (r + 1 < rows) set.add(id(r, c), id(r + 1, c));
      else if (torus && rows > 2) set.add(id(r, c), id(0, c));
    }
  }
  const pos: [number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pos.push([c, r]);
  return { n, edges: sortEdges(set.edges), pos: normalizePositions(pos) };
}

export function torus(rows: number, cols: number): Graph {
  return grid(rows, cols, true);
}

/** Cycle on n nodes, drawn as a circle. */
export function ring(n: number): Graph {
  assertN(n, 3);
  const set = new EdgeSet(n);
  for (let i = 0; i < n; i++) set.add(i, (i + 1) % n);
  return { n, edges: sortEdges(set.edges), pos: circlePositions(n, 0) };
}

/** The Petersen graph: outer 5-cycle 0..4, inner pentagram 5..9, spokes i–(i+5). */
export function petersen(): Graph {
  const set = new EdgeSet(10);
  for (let i = 0; i < 5; i++) {
    set.add(i, (i + 1) % 5);
    set.add(5 + i, 5 + ((i + 2) % 5));
    set.add(i, i + 5);
  }
  const outer = circlePositions(5, 0);
  const inner = circlePositions(5, 0).map(([x, y]) => [0.5 + (x - 0.5) * 0.5, 0.5 + (y - 0.5) * 0.5] as [number, number]);
  return { n: 10, edges: sortEdges(set.edges), pos: normalizePositions([...outer, ...inner]) };
}

function circlePositions(n: number, phase: number): [number, number][] {
  const pos: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = phase - Math.PI / 2 + (2 * Math.PI * i) / n;
    pos.push([0.5 + 0.45 * Math.cos(a), 0.5 + 0.45 * Math.sin(a)]);
  }
  return normalizePositions(pos);
}

/** Returns a copy with unit weights, or random integer weights 1..9 (seeded). */
export function withWeights(g: Graph, weighting: Weighting, seed: number): Graph {
  const rng = new Rng(seed ^ 0x77e1647);
  const edges = g.edges.map(([i, j]) => [i, j, weighting === "random" ? rng.int(1, 9) : 1] as [number, number, number]);
  return { n: g.n, edges, pos: g.pos.map(([x, y]) => [x, y] as [number, number]) };
}

function assertN(n: number, min: number): void {
  if (!Number.isInteger(n) || n < min) throw new Error(`Number of nodes must be an integer ≥ ${min} (got ${n})`);
}

// ---------------------------------------------------------------- one-stop builder

export interface GraphSpec {
  kind: GraphKind;
  /** Requested node count (grid/torus round to rows × cols, regular3 rounds up to even, petersen is always 10). */
  n: number;
  /** Target average degree for geometric and Erdős–Rényi graphs. */
  avgDegree: number;
  weighting: Weighting;
}

export interface BuiltGraph {
  graph: Graph;
  /** Set when the requested size had to be adjusted, e.g. "Grid rounded to 5 × 6 = 30 nodes". */
  notice?: string;
}

/** Build any supported graph family from UI-level parameters. */
export function buildGraph(spec: GraphSpec, seed: number): BuiltGraph {
  const n = Math.round(spec.n);
  let g: Graph;
  let notice: string | undefined;
  switch (spec.kind) {
    case "geometric":
      g = geometric(n, { avgDegree: spec.avgDegree }, seed);
      break;
    case "erdos":
      g = erdosRenyi(n, Math.min(1, Math.max(0, spec.avgDegree / Math.max(1, n - 1))), seed);
      break;
    case "regular3": {
      const m = Math.max(4, n % 2 === 0 ? n : n + 1);
      if (m !== n) notice = `A 3-regular graph needs an even node count: using ${m} nodes`;
      g = regular3(m, seed);
      break;
    }
    case "grid":
    case "torus": {
      const rows = Math.max(spec.kind === "torus" ? 3 : 1, Math.round(Math.sqrt(n)));
      const cols = Math.max(spec.kind === "torus" ? 3 : 1, Math.round(n / rows));
      if (rows * cols !== n) notice = `${spec.kind === "grid" ? "Grid" : "Torus"} rounded to ${rows} × ${cols} = ${rows * cols} nodes`;
      g = grid(rows, cols, spec.kind === "torus");
      break;
    }
    case "ring":
      g = ring(Math.max(3, n));
      break;
    case "petersen":
      if (n !== 10) notice = "The Petersen graph always has 10 nodes";
      g = petersen();
      break;
    default: {
      const bad: never = spec.kind;
      throw new Error(`Unknown graph type "${String(bad)}"`);
    }
  }
  if (spec.weighting === "random") g = withWeights(g, "random", seed);
  return notice === undefined ? { graph: g } : { graph: g, notice };
}

export function isGraphKind(v: unknown): v is GraphKind {
  return typeof v === "string" && GRAPH_KIND_OPTIONS.some((o) => o.value === v);
}
