//! Parallel tempering (replica exchange): the strongest simple classical
//! baseline for Ising heuristics — and therefore mandatory in this crate.
//! Replicas anneal at a geometric ladder of fixed temperatures; every few
//! sweeps, neighboring temperatures attempt to exchange configurations with
//! the Metropolis criterion `min(1, exp((β_a − β_b)(E_a − E_b)))`, letting
//! low-energy states migrate to cold replicas and stuck cold replicas escape
//! through hot ones.

use crate::model::IsingModel;
use crate::result::SolveResult;
use crate::rng::Rng;
use crate::sa::{metropolis_sweep, random_spins, temp_scale};
use num_traits::Float;

#[derive(Debug, Clone)]
pub struct PtConfig {
    /// Number of temperature rungs (minimum 2).
    pub replicas: usize,
    /// Total Metropolis sweeps per replica.
    pub sweeps: usize,
    /// Sweeps between exchange attempts.
    pub exchange_every: usize,
    /// Coldest temperature. `None` uses `t_max / 1000`.
    pub t_min: Option<f64>,
    /// Hottest temperature. `None` auto-scales to `2·(σ_J·√n + max|h|)`.
    pub t_max: Option<f64>,
    pub seed: u64,
}

impl Default for PtConfig {
    fn default() -> Self {
        Self {
            replicas: 16,
            sweeps: 1000,
            exchange_every: 10,
            t_min: None,
            t_max: None,
            seed: 0,
        }
    }
}

struct Replica<T> {
    spins: Vec<i8>,
    fields: Vec<T>,
    energy: T,
    rng: Rng,
}

pub fn solve<T: Float + Send + Sync>(model: &IsingModel<T>, cfg: &PtConfig) -> SolveResult<T> {
    assert!(cfg.replicas >= 2, "PtConfig.replicas must be at least 2");
    assert!(cfg.sweeps > 0, "PtConfig.sweeps must be positive");
    assert!(
        cfg.exchange_every > 0,
        "PtConfig.exchange_every must be positive"
    );
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

    let t_max = cfg.t_max.unwrap_or_else(|| 2.0 * temp_scale(model));
    let t_min = cfg.t_min.unwrap_or(t_max / 1000.0).min(t_max);
    assert!(t_min > 0.0 && t_max > 0.0, "temperatures must be positive");

    // Geometric ladder, index 0 = coldest.
    let r_count = cfg.replicas;
    let temps: Vec<f64> = (0..r_count)
        .map(|r| {
            let frac = if r_count > 1 {
                r as f64 / (r_count - 1) as f64
            } else {
                0.0
            };
            t_min * (t_max / t_min).powf(frac)
        })
        .collect();

    let mut replicas: Vec<Replica<T>> = (0..r_count)
        .map(|r| {
            let mut rng = Rng::for_replica(cfg.seed, r as u64);
            let spins = random_spins(n, &mut rng);
            let fields = model.local_fields(&spins);
            let energy = model.energy(&spins);
            Replica {
                spins,
                fields,
                energy,
                rng,
            }
        })
        .collect();

    // Separate stream for exchange decisions.
    let mut exchange_rng = Rng::for_replica(cfg.seed, u64::MAX);

    let mut best_energy = replicas[0].energy;
    let mut best_spins = replicas[0].spins.clone();
    let mut best_slot = 0usize;
    for (slot, rep) in replicas.iter().enumerate() {
        if rep.energy < best_energy {
            best_energy = rep.energy;
            best_spins = rep.spins.clone();
            best_slot = slot;
        }
    }

    let mut done = 0usize;
    let mut round = 0usize;
    while done < cfg.sweeps {
        let batch = cfg.exchange_every.min(cfg.sweeps - done);

        let sweep_replica = |(rep, temp): (&mut Replica<T>, &f64)| {
            for _ in 0..batch {
                metropolis_sweep(
                    model,
                    &mut rep.spins,
                    &mut rep.fields,
                    &mut rep.energy,
                    *temp,
                    &mut rep.rng,
                );
            }
        };

        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            replicas
                .par_iter_mut()
                .zip(temps.par_iter())
                .for_each(sweep_replica);
        }
        #[cfg(not(feature = "parallel"))]
        replicas
            .iter_mut()
            .zip(temps.iter())
            .for_each(sweep_replica);

        for (slot, rep) in replicas.iter().enumerate() {
            if rep.energy < best_energy {
                best_energy = rep.energy;
                best_spins.copy_from_slice(&rep.spins);
                best_slot = slot;
            }
        }

        // Exchange pass with alternating parity so every rung participates.
        let start = round % 2;
        let mut a = start;
        while a + 1 < r_count {
            let b = a + 1;
            let beta_a = 1.0 / temps[a];
            let beta_b = 1.0 / temps[b];
            let e_a = replicas[a].energy.to_f64().unwrap();
            let e_b = replicas[b].energy.to_f64().unwrap();
            let exponent = (beta_a - beta_b) * (e_a - e_b);
            if exponent >= 0.0 || exchange_rng.uniform() < exponent.exp() {
                replicas.swap(a, b);
            }
            a += 2;
        }

        done += batch;
        round += 1;
    }

    // Rescore the winner from its spins: the incremental accumulators are for
    // selection only, and at f32 their drift must not leak into the result.
    let energy = model.energy(&best_spins);
    SolveResult {
        spins: best_spins,
        energy,
        steps: cfg.sweeps as u64,
        seed: cfg.seed,
        replica: best_slot,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_small_frustrated_triangle() {
        // Antiferromagnetic triangle: ground energy is -1 (one unsatisfied edge).
        let mut m = IsingModel::<f64>::new(3);
        m.set_coupling(0, 1, -1.0);
        m.set_coupling(1, 2, -1.0);
        m.set_coupling(0, 2, -1.0);
        let r = solve(
            &m,
            &PtConfig {
                seed: 2,
                ..PtConfig::default()
            },
        );
        assert_eq!(r.energy, -1.0);
    }

    #[test]
    fn deterministic_for_same_seed() {
        let mut m = IsingModel::<f64>::new(10);
        for i in 0..10 {
            for j in (i + 1)..10 {
                m.set_coupling(i, j, (((i * 5 + j * 11) % 7) as f64) - 3.0);
            }
        }
        let cfg = PtConfig {
            seed: 42,
            ..PtConfig::default()
        };
        assert_eq!(solve(&m, &cfg), solve(&m, &cfg));
    }
}
