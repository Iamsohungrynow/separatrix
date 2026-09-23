//! Simulated Bifurcation (SB): ballistic (bSB) and discrete (dSB) variants.
//!
//! Follows Goto, Tatsumura et al., *Science Advances* 5:eaav2372 (2019) and
//! 7:eabe7953 (2021): each Ising spin becomes a classical nonlinear oscillator
//! with position `x_i` and momentum `y_i`, integrated with a symplectic Euler
//! scheme while the pump amplitude `a(t)` ramps from 0 to `a0`. As each
//! oscillator crosses the bifurcation it commits to one of two branches; the
//! branch signs are read out as spins. bSB couples through positions `x_j`
//! (fast, smooth); dSB couples through `sign(x_j)` (better solution quality on
//! hard instances). Both use perfectly inelastic walls at `|x| = 1`.
//!
//! External fields `h` are supported the way reference implementations do it:
//! added to the coupling force term. The pump ramp and the `ξ₀`-style
//! auto-scaling of the coupling strength follow the papers.
//!
//! [`trace`] records one replica's trajectory for visualization. It runs the
//! same integration code as [`solve`], so what it shows is what the solver
//! does.
//!
//! This is a **classical, quantum-inspired** algorithm (its lineage is the
//! Kerr-parametric-oscillator network it simulates); no quantum speedup is
//! claimed, here or anywhere in this crate.

use crate::model::IsingModel;
use crate::parallel::{best_of, run_replicas};
use crate::result::SolveResult;
use crate::rng::Rng;
use num_traits::Float;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SbVariant {
    /// Couple through oscillator positions `x_j`.
    Ballistic,
    /// Couple through `sign(x_j)`.
    Discrete,
}

#[derive(Debug, Clone)]
pub struct SbConfig {
    pub variant: SbVariant,
    /// Symplectic Euler steps per replica.
    pub steps: usize,
    /// Integration time step.
    pub dt: f64,
    /// Final pump amplitude (and the `a0` stiffness constant).
    pub a0: f64,
    /// Coupling strength. `None` uses the papers' heuristic
    /// `ξ₀ = 0.7 · a0 / (σ_J · √n)` with `σ_J` the RMS off-diagonal coupling.
    pub c0: Option<f64>,
    /// Independent restarts; the best final configuration wins.
    pub replicas: usize,
    /// Read out `sign(x)` and score it every this many steps (0 = only at the
    /// end). dSB trajectories bounce, so periodic measurement keeps the best
    /// configuration seen, not just the last.
    pub measure_every: usize,
    pub seed: u64,
}

impl Default for SbConfig {
    fn default() -> Self {
        Self {
            variant: SbVariant::Ballistic,
            steps: 2000,
            dt: 0.1,
            a0: 1.0,
            c0: None,
            replicas: 8,
            measure_every: 100,
            seed: 0,
        }
    }
}

/// The coupling strength `c0` that [`SbConfig::c0`] = `None` resolves to for
/// `model`: the papers' `ξ₀ = 0.7 · a0 / (σ_J · √n)`. Exposed so callers can
/// scale it (for example, to slow a trajectory down for visualisation) without
/// re-deriving the heuristic.
pub fn default_coupling<T: Float>(model: &IsingModel<T>, a0: f64) -> f64 {
    auto_c0(model, a0)
}

fn auto_c0<T: Float>(model: &IsingModel<T>, a0: f64) -> f64 {
    let n = model.n();
    let sigma = model.coupling_rms().to_f64().unwrap_or(0.0);
    let denom = sigma * (n as f64).sqrt();
    if denom > 0.0 {
        0.7 * a0 / denom
    } else {
        // Pure-field (or empty) problem: any positive coupling scale works.
        a0
    }
}

#[inline]
fn sign_spin<T: Float>(x: T) -> i8 {
    if x >= T::zero() {
        1
    } else {
        -1
    }
}

/// Config checks shared by [`solve`] and [`trace`].
fn validate(cfg: &SbConfig) {
    assert!(cfg.steps > 0, "SbConfig.steps must be positive");
    assert!(cfg.dt > 0.0, "SbConfig.dt must be positive");
}

/// What a zero-spin problem reports.
fn empty_result<T: Float>(seed: u64) -> SolveResult<T> {
    SolveResult {
        spins: Vec::new(),
        energy: T::zero(),
        steps: 0,
        seed,
        replica: 0,
    }
}

/// The per-run constants of one SB integration, converted to `T` once.
///
/// [`solve`] and [`trace`] both integrate through [`Dynamics::run_replica`],
/// so a traced trajectory is, by construction, the trajectory `solve` runs:
/// same initial condition, same RNG stream, same update, same measurement
/// schedule.
struct Dynamics<T> {
    variant: SbVariant,
    steps: usize,
    measure_every: usize,
    seed: u64,
    dt: T,
    a0: T,
    c0: T,
}

impl<T: Float> Dynamics<T> {
    fn new(model: &IsingModel<T>, cfg: &SbConfig) -> Self {
        let c0 = cfg.c0.unwrap_or_else(|| auto_c0(model, cfg.a0));
        let measure_every = if cfg.measure_every == 0 {
            cfg.steps
        } else {
            cfg.measure_every
        };
        Self {
            variant: cfg.variant,
            steps: cfg.steps,
            measure_every,
            seed: cfg.seed,
            dt: T::from(cfg.dt).unwrap(),
            a0: T::from(cfg.a0).unwrap(),
            c0: T::from(c0).unwrap(),
        }
    }

    /// Initial condition of replica `replica`: all positions, then all
    /// momenta, each uniform in (−0.1, 0.1) from that replica's own stream.
    fn init(&self, n: usize, replica: usize) -> (Vec<T>, Vec<T>) {
        let init_width = T::from(0.1).unwrap();
        let mut rng = Rng::for_replica(self.seed, replica as u64);
        let x: Vec<T> = (0..n).map(|_| rng.uniform_symmetric(init_width)).collect();
        let y: Vec<T> = (0..n).map(|_| rng.uniform_symmetric(init_width)).collect();
        (x, y)
    }

    /// Integration step `k` (1-based): one symplectic Euler update of every
    /// oscillator. `z` is scratch space of length `n`.
    fn step(&self, model: &IsingModel<T>, k: usize, x: &mut [T], y: &mut [T], z: &mut [T]) {
        let n = model.n();
        let one = T::one();
        let a = self.a0 * T::from(k).unwrap() / T::from(self.steps).unwrap();
        let detune = self.a0 - a;

        match self.variant {
            SbVariant::Ballistic => z.copy_from_slice(x),
            SbVariant::Discrete => {
                for (zi, &xi) in z.iter_mut().zip(x.iter()) {
                    *zi = if xi >= T::zero() { one } else { -one };
                }
            }
        }

        // Symplectic Euler: all momenta from current positions, then all
        // positions from the new momenta.
        for i in 0..n {
            let row = model.j_row(i);
            let mut force = model.field(i);
            for (jv, zv) in row.iter().zip(z.iter()) {
                force = force + *jv * *zv;
            }
            y[i] = y[i] + self.dt * (-detune * x[i] + self.c0 * force);
        }
        for i in 0..n {
            x[i] = x[i] + self.dt * self.a0 * y[i];
            // Perfectly inelastic walls at |x| = 1.
            if x[i] > one {
                x[i] = one;
                y[i] = T::zero();
            } else if x[i] < -one {
                x[i] = -one;
                y[i] = T::zero();
            }
        }
    }

    /// Integrate replica `replica` to the end and return its best measured
    /// configuration. `observe(k, x)` sees the positions after step `k`
    /// (`k = 0` is the initial condition); it cannot influence the dynamics.
    fn run_replica<F: FnMut(usize, &[T])>(
        &self,
        model: &IsingModel<T>,
        replica: usize,
        mut observe: F,
    ) -> SolveResult<T> {
        let n = model.n();
        let (mut x, mut y) = self.init(n, replica);
        let mut z: Vec<T> = vec![T::zero(); n];

        let mut best_spins: Vec<i8> = x.iter().map(|&v| sign_spin(v)).collect();
        let mut best_energy = model.energy(&best_spins);
        observe(0, &x);

        for k in 1..=self.steps {
            self.step(model, k, &mut x, &mut y, &mut z);

            if k % self.measure_every == 0 || k == self.steps {
                let spins: Vec<i8> = x.iter().map(|&v| sign_spin(v)).collect();
                let energy = model.energy(&spins);
                if energy < best_energy {
                    best_energy = energy;
                    best_spins = spins;
                }
            }
            observe(k, &x);
        }

        SolveResult {
            spins: best_spins,
            energy: best_energy,
            steps: self.steps as u64,
            seed: self.seed,
            replica,
        }
    }
}

pub fn solve<T: Float + Send + Sync>(model: &IsingModel<T>, cfg: &SbConfig) -> SolveResult<T> {
    validate(cfg);
    assert!(cfg.replicas > 0, "SbConfig.replicas must be positive");
    let n = model.n();
    if n == 0 {
        return empty_result(cfg.seed);
    }

    let dynamics = Dynamics::new(model, cfg);
    let results = run_replicas(cfg.replicas, |r| dynamics.run_replica(model, r, |_, _| {}));

    best_of(results)
}

/// A recorded single-replica SB trajectory; see [`trace`].
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct SbTrace<T> {
    /// Number of oscillators (spins).
    pub n: usize,
    /// Integration steps the run took (`SbConfig::steps`).
    pub steps: usize,
    /// The integration step after which each frame was recorded:
    /// `frame_steps[f] = ⌊f · steps / (frames − 1)⌋`, so frame 0 is the
    /// initial condition and the last frame is step `steps`. When
    /// `frames > steps + 1` some steps appear more than once.
    pub frame_steps: Vec<usize>,
    /// Oscillator positions `x`, frame-major: `frames × n` values, frame `f`
    /// at `positions[f·n .. (f+1)·n]`. Stored as `f32` for display; the
    /// dynamics ran in `T`.
    pub positions: Vec<f32>,
    /// Ising energy of `sign(x)` at each frame (`sign(0) = +1`, as in the
    /// solver's read-out).
    pub energies: Vec<T>,
    /// The best configuration *measured* on the solver's schedule
    /// (`SbConfig::measure_every`): identical, field for field, to what
    /// [`solve`] returns for the same config with `replicas == 1`. A frame
    /// energy can sit below it only at a step the solver does not measure.
    pub best: SolveResult<T>,
}

impl<T> SbTrace<T> {
    /// Number of recorded frames.
    pub fn frames(&self) -> usize {
        self.frame_steps.len()
    }

    /// Positions at frame `f` (length `n`). Panics if `f >= frames()`.
    pub fn frame(&self, f: usize) -> &[f32] {
        &self.positions[f * self.n..(f + 1) * self.n]
    }
}

/// Run one SB replica and record its trajectory at `frames` evenly spaced
/// points, the initial condition and the final step included.
///
/// The integration is the exact code path [`solve`] uses. The trace follows
/// replica 0, which is what `solve` runs when `cfg.replicas == 1`, so
/// `trace(m, &cfg, f).best == solve(m, &SbConfig { replicas: 1, ..cfg })`;
/// `cfg.replicas` itself is ignored. Recording adds `O(n²)` per frame (the
/// frame energy) to the run.
///
/// Panics if `frames < 2`, or on the invalid configs [`solve`] rejects.
///
/// ```
/// use separatrix::{sb, IsingModel, SbConfig};
///
/// let mut m = IsingModel::<f64>::new(2);
/// m.set_coupling(0, 1, 1.0);
/// let cfg = SbConfig { steps: 500, ..SbConfig::default() };
/// let t = sb::trace(&m, &cfg, 11);
/// assert_eq!(t.frames(), 11);
/// assert_eq!(t.frame_steps[10], 500);
/// assert_eq!(t.best.energy, -1.0);
/// ```
pub fn trace<T: Float>(model: &IsingModel<T>, cfg: &SbConfig, frames: usize) -> SbTrace<T> {
    validate(cfg);
    assert!(frames >= 2, "a trace needs at least 2 frames");
    let n = model.n();
    let steps = cfg.steps;
    let frame_steps: Vec<usize> = (0..frames)
        .map(|f| (f as u128 * steps as u128 / (frames as u128 - 1)) as usize)
        .collect();

    if n == 0 {
        return SbTrace {
            n,
            steps,
            frame_steps,
            positions: Vec::new(),
            energies: vec![T::zero(); frames],
            best: empty_result(cfg.seed),
        };
    }

    let dynamics = Dynamics::new(model, cfg);
    let mut positions: Vec<f32> = Vec::with_capacity(frames * n);
    let mut energies: Vec<T> = Vec::with_capacity(frames);
    let mut spins: Vec<i8> = vec![0; n];
    let mut next = 0;
    let best = dynamics.run_replica(model, 0, |k, x| {
        while next < frames && frame_steps[next] == k {
            positions.extend(x.iter().map(|&v| v.to_f32().unwrap_or(f32::NAN)));
            for (s, &v) in spins.iter_mut().zip(x.iter()) {
                *s = sign_spin(v);
            }
            energies.push(model.energy(&spins));
            next += 1;
        }
    });
    debug_assert_eq!(next, frames, "every frame step lies in 0..=steps");

    SbTrace {
        n,
        steps,
        frame_steps,
        positions,
        energies,
        best,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two ferromagnetically coupled spins: both SB variants must find an
    /// aligned ground state (E = -1).
    #[test]
    fn solves_two_spin_ferromagnet() {
        let mut m = IsingModel::<f64>::new(2);
        m.set_coupling(0, 1, 1.0);
        for variant in [SbVariant::Ballistic, SbVariant::Discrete] {
            let cfg = SbConfig {
                variant,
                seed: 3,
                ..SbConfig::default()
            };
            let r = solve(&m, &cfg);
            assert_eq!(r.spins[0], r.spins[1], "{variant:?} failed to align");
            assert_eq!(r.energy, -1.0);
        }
    }

    /// A field must break the tie toward the field direction.
    #[test]
    fn field_breaks_symmetry() {
        let mut m = IsingModel::<f64>::new(1);
        m.set_field(0, 2.0);
        let r = solve(&m, &SbConfig::default());
        assert_eq!(r.spins[0], 1);
        assert_eq!(r.energy, -2.0);
    }

    /// An explicit `c0` equal to `default_coupling` must reproduce the
    /// `c0: None` run exactly, so scaling it is a pure parameter change.
    #[test]
    fn default_coupling_is_what_none_resolves_to() {
        let mut m = IsingModel::<f64>::new(10);
        for i in 0..10 {
            for j in (i + 1)..10 {
                m.set_coupling(i, j, ((i * 5 + j * 3) % 7) as f64 - 3.0);
            }
        }
        let base = SbConfig {
            seed: 5,
            replicas: 1,
            steps: 300,
            ..SbConfig::default()
        };
        let explicit = SbConfig {
            c0: Some(default_coupling(&m, base.a0)),
            ..base.clone()
        };
        assert_eq!(trace(&m, &base, 12), trace(&m, &explicit, 12));
    }

    #[test]
    fn deterministic_for_same_seed() {
        let mut m = IsingModel::<f64>::new(8);
        for i in 0..8 {
            for j in (i + 1)..8 {
                m.set_coupling(i, j, ((i * 3 + j * 7) % 5) as f64 - 2.0);
            }
        }
        let cfg = SbConfig {
            seed: 99,
            ..SbConfig::default()
        };
        let a = solve(&m, &cfg);
        let b = solve(&m, &cfg);
        assert_eq!(a, b);
    }

    /// Dense frustrated model with fields, deterministic from `seed`.
    fn frustrated<T: Float>(n: usize, seed: u64) -> IsingModel<T> {
        let mut state = seed;
        let mut next = move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            T::from((state >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0).unwrap()
        };
        let mut m = IsingModel::<T>::new(n);
        for i in 0..n {
            m.set_field(i, next() * T::from(0.3).unwrap());
            for j in (i + 1)..n {
                m.set_coupling(i, j, next());
            }
        }
        m
    }

    /// The trace's best is exactly the single-replica solve: same spins, same
    /// energy bits, same metadata. Covers both variants, a measurement period
    /// that does not divide `steps`, end-only measurement, both float types,
    /// and a `replicas` setting the trace must ignore.
    #[test]
    fn trace_best_equals_single_replica_solve() {
        let m64 = frustrated::<f64>(30, 5);
        let m32 = frustrated::<f32>(30, 5);
        for variant in [SbVariant::Ballistic, SbVariant::Discrete] {
            for (seed, steps, measure_every) in
                [(0u64, 800usize, 100usize), (7, 333, 7), (42, 250, 0)]
            {
                let cfg = SbConfig {
                    variant,
                    steps,
                    measure_every,
                    seed,
                    replicas: 1,
                    ..SbConfig::default()
                };
                let ignored_replicas = SbConfig {
                    replicas: 8,
                    ..cfg.clone()
                };
                let t = trace(&m64, &ignored_replicas, 17);
                assert_eq!(t.best, solve(&m64, &cfg), "{variant:?} seed {seed}");
                let t32 = trace(&m32, &cfg, 5);
                assert_eq!(t32.best, solve(&m32, &cfg), "{variant:?} seed {seed} f32");
            }
        }
    }

    /// Frame energies are consistent with the solver's measurement: the best
    /// is no worse than any measured frame (the initial condition, every
    /// `measure_every`-th step, and the final step), and the recorded
    /// energies score the recorded positions.
    #[test]
    fn frame_energies_are_consistent_with_best() {
        let m = frustrated::<f64>(24, 9);
        let cfg = SbConfig {
            variant: SbVariant::Discrete,
            steps: 600,
            measure_every: 50,
            seed: 11,
            ..SbConfig::default()
        };
        let t = trace(&m, &cfg, 13); // frames every 50 steps: all measured
        for f in 0..t.frames() {
            assert!(t.best.energy <= t.energies[f], "frame {f}");
            let spins: Vec<i8> = t.frame(f).iter().map(|&v| sign_spin(v)).collect();
            assert!((m.energy(&spins) - t.energies[f]).abs() < 1e-9, "frame {f}");
        }
    }

    #[test]
    fn trace_frame_count_and_shape() {
        let m = frustrated::<f64>(10, 3);
        let cfg = SbConfig {
            steps: 60,
            ..SbConfig::default()
        };

        let t = trace(&m, &cfg, 7);
        assert_eq!(t.n, 10);
        assert_eq!(t.steps, 60);
        assert_eq!(t.frames(), 7);
        assert_eq!(t.frame_steps, vec![0, 10, 20, 30, 40, 50, 60]);
        assert_eq!(t.positions.len(), 7 * 10);
        assert_eq!(t.energies.len(), 7);
        assert!(t.positions.iter().all(|v| (-1.0..=1.0).contains(v)));
        // Frame 0 is the initial condition: uniform in (-0.1, 0.1).
        assert!(t.frame(0).iter().all(|v| v.abs() < 0.1));

        let two = trace(&m, &cfg, 2);
        assert_eq!(two.frame_steps, vec![0, 60]);
        assert_eq!(two.frame(0), t.frame(0));
        assert_eq!(two.frame(1), t.frame(6));

        // More frames than steps: the count is honored, steps repeat.
        let dense = trace(
            &m,
            &SbConfig {
                steps: 3,
                ..SbConfig::default()
            },
            10,
        );
        assert_eq!(dense.frames(), 10);
        assert_eq!(dense.positions.len(), 100);
        assert_eq!(dense.frame_steps.first(), Some(&0));
        assert_eq!(dense.frame_steps.last(), Some(&3));
        assert!(dense.frame_steps.windows(2).all(|w| w[0] <= w[1]));

        let empty = trace(&IsingModel::<f64>::new(0), &cfg, 4);
        assert_eq!(empty.frames(), 4);
        assert!(empty.positions.is_empty());
        assert_eq!(empty.best, solve(&IsingModel::<f64>::new(0), &cfg));
    }

    #[test]
    #[should_panic(expected = "at least 2 frames")]
    fn trace_rejects_a_single_frame() {
        let m = frustrated::<f64>(4, 1);
        trace(&m, &SbConfig::default(), 1);
    }
}
