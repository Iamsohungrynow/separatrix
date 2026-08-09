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

pub fn solve<T: Float + Send + Sync>(model: &IsingModel<T>, cfg: &SbConfig) -> SolveResult<T> {
    assert!(cfg.steps > 0, "SbConfig.steps must be positive");
    assert!(cfg.replicas > 0, "SbConfig.replicas must be positive");
    assert!(cfg.dt > 0.0, "SbConfig.dt must be positive");
    let n = model.n();
    if n == 0 {
        return SolveResult {
            spins: Vec::new(),
            energy: T::zero(),
            steps: 0,
            seed: cfg.seed,
            replica: 0,
        };
    }

    let c0 = cfg.c0.unwrap_or_else(|| auto_c0(model, cfg.a0));
    let measure_every = if cfg.measure_every == 0 {
        cfg.steps
    } else {
        cfg.measure_every
    };

    let dt = T::from(cfg.dt).unwrap();
    let a0 = T::from(cfg.a0).unwrap();
    let c0_t = T::from(c0).unwrap();
    let one = T::one();
    let init_width = T::from(0.1).unwrap();

    let results = run_replicas(cfg.replicas, |r| {
        let mut rng = Rng::for_replica(cfg.seed, r as u64);
        let mut x: Vec<T> = (0..n).map(|_| rng.uniform_symmetric(init_width)).collect();
        let mut y: Vec<T> = (0..n).map(|_| rng.uniform_symmetric(init_width)).collect();
        let mut z: Vec<T> = vec![T::zero(); n];

        let mut best_spins: Vec<i8> = x.iter().map(|&v| sign_spin(v)).collect();
        let mut best_energy = model.energy(&best_spins);

        for k in 1..=cfg.steps {
            let a = a0 * T::from(k).unwrap() / T::from(cfg.steps).unwrap();
            let detune = a0 - a;

            match cfg.variant {
                SbVariant::Ballistic => z.copy_from_slice(&x),
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
                y[i] = y[i] + dt * (-detune * x[i] + c0_t * force);
            }
            for i in 0..n {
                x[i] = x[i] + dt * a0 * y[i];
                // Perfectly inelastic walls at |x| = 1.
                if x[i] > one {
                    x[i] = one;
                    y[i] = T::zero();
                } else if x[i] < -one {
                    x[i] = -one;
                    y[i] = T::zero();
                }
            }

            if k % measure_every == 0 || k == cfg.steps {
                let spins: Vec<i8> = x.iter().map(|&v| sign_spin(v)).collect();
                let energy = model.energy(&spins);
                if energy < best_energy {
                    best_energy = energy;
                    best_spins = spins;
                }
            }
        }

        SolveResult {
            spins: best_spins,
            energy: best_energy,
            steps: cfg.steps as u64,
            seed: cfg.seed,
            replica: r,
        }
    });

    best_of(results)
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
}
