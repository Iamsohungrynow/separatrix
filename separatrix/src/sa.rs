//! Simulated annealing: the baseline any Ising heuristic must be measured
//! against. Single-spin-flip Metropolis over a geometric temperature schedule,
//! with cached local fields so each proposed flip is O(1) to evaluate and each
//! accepted flip O(n) to book-keep.

use crate::model::IsingModel;
use crate::parallel::{best_of, run_replicas};
use crate::result::SolveResult;
use crate::rng::Rng;
use num_traits::Float;

#[derive(Debug, Clone)]
pub struct SaConfig {
    /// Metropolis sweeps (each sweep proposes one flip per spin).
    pub sweeps: usize,
    /// Independent restarts; best final configuration wins.
    pub restarts: usize,
    /// Starting temperature. `None` auto-scales to `2·(σ_J·√n + max|h|)`.
    pub t_initial: Option<f64>,
    /// Final temperature. `None` uses `t_initial / 1000`.
    pub t_final: Option<f64>,
    pub seed: u64,
}

impl Default for SaConfig {
    fn default() -> Self {
        Self {
            sweeps: 1000,
            restarts: 8,
            t_initial: None,
            t_final: None,
            seed: 0,
        }
    }
}

/// A characteristic energy scale of the model, used to auto-range temperature
/// schedules: `σ_J·√n + max|h|`, floored at 1 for degenerate models.
pub(crate) fn temp_scale<T: Float>(model: &IsingModel<T>) -> f64 {
    let n = model.n();
    let sigma = model.coupling_rms().to_f64().unwrap_or(0.0);
    let h_max = model.field_max_abs().to_f64().unwrap_or(0.0);
    let scale = sigma * (n as f64).sqrt() + h_max;
    if scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// One Metropolis sweep at temperature `temp`: proposes flipping each spin in
/// order, accepting with probability `min(1, exp(−ΔE/temp))` where
/// `ΔE = 2 s_i ℓ_i`. Maintains `fields` (`ℓ_j = Σ_k J_jk s_k + h_j`) and
/// `energy` incrementally.
pub(crate) fn metropolis_sweep<T: Float>(
    model: &IsingModel<T>,
    spins: &mut [i8],
    fields: &mut [T],
    energy: &mut T,
    temp: f64,
    rng: &mut Rng,
) {
    let n = model.n();
    let two = T::from(2.0).unwrap();
    for i in 0..n {
        let s = T::from(spins[i]).unwrap();
        let delta = two * s * fields[i];
        let accept = delta <= T::zero() || {
            let d = delta.to_f64().unwrap();
            rng.uniform() < (-d / temp).exp()
        };
        if accept {
            spins[i] = -spins[i];
            *energy = *energy + delta;
            let s_new = T::from(spins[i]).unwrap();
            let row = model.j_row(i);
            for (f, &jv) in fields.iter_mut().zip(row.iter()) {
                *f = *f + two * jv * s_new;
            }
        }
    }
}

pub(crate) fn random_spins(n: usize, rng: &mut Rng) -> Vec<i8> {
    (0..n)
        .map(|_| if rng.below(2) == 0 { -1 } else { 1 })
        .collect()
}

pub fn solve<T: Float + Send + Sync>(model: &IsingModel<T>, cfg: &SaConfig) -> SolveResult<T> {
    assert!(cfg.sweeps > 0, "SaConfig.sweeps must be positive");
    assert!(cfg.restarts > 0, "SaConfig.restarts must be positive");
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

    let t0 = cfg.t_initial.unwrap_or_else(|| 2.0 * temp_scale(model));
    let t1 = cfg.t_final.unwrap_or(t0 / 1000.0).min(t0);
    assert!(t0 > 0.0 && t1 > 0.0, "temperatures must be positive");
    let ratio = t1 / t0;

    let results = run_replicas(cfg.restarts, |r| {
        let mut rng = Rng::for_replica(cfg.seed, r as u64);
        let mut spins = random_spins(n, &mut rng);
        let mut fields = model.local_fields(&spins);
        let mut energy = model.energy(&spins);
        let mut best_energy = energy;
        let mut best_spins = spins.clone();

        for k in 0..cfg.sweeps {
            let frac = if cfg.sweeps > 1 {
                k as f64 / (cfg.sweeps - 1) as f64
            } else {
                1.0
            };
            let temp = t0 * ratio.powf(frac);
            metropolis_sweep(model, &mut spins, &mut fields, &mut energy, temp, &mut rng);
            if energy < best_energy {
                best_energy = energy;
                best_spins.copy_from_slice(&spins);
            }
        }

        // The incremental accumulator only *selects* the best configuration;
        // the reported energy is recomputed from the spins so the contract
        // "energy is the Ising energy of spins" holds exactly. (At f32, the
        // accumulator drifts over thousands of updates and can otherwise
        // report energies below the true ground state.)
        let energy = model.energy(&best_spins);
        SolveResult {
            spins: best_spins,
            energy,
            steps: cfg.sweeps as u64,
            seed: cfg.seed,
            replica: r,
        }
    });

    best_of(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_two_spin_ferromagnet() {
        let mut m = IsingModel::<f64>::new(2);
        m.set_coupling(0, 1, 1.0);
        let r = solve(
            &m,
            &SaConfig {
                seed: 5,
                ..SaConfig::default()
            },
        );
        assert_eq!(r.energy, -1.0);
    }

    #[test]
    fn incremental_energy_stays_consistent() {
        let mut m = IsingModel::<f64>::new(6);
        for i in 0..6 {
            m.set_field(i, (i as f64) - 2.5);
            for j in (i + 1)..6 {
                m.set_coupling(i, j, ((i + 2 * j) % 3) as f64 - 1.0);
            }
        }
        let mut rng = Rng::new(11);
        let mut spins = random_spins(6, &mut rng);
        let mut fields = m.local_fields(&spins);
        let mut energy = m.energy(&spins);
        for _ in 0..50 {
            metropolis_sweep(&m, &mut spins, &mut fields, &mut energy, 1.5, &mut rng);
        }
        assert!((energy - m.energy(&spins)).abs() < 1e-9);
        let expect_fields = m.local_fields(&spins);
        for (a, b) in fields.iter().zip(expect_fields.iter()) {
            assert!((*a - *b).abs() < 1e-9);
        }
    }
}
