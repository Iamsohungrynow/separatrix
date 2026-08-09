//! Replica fan-out: rayon when the `parallel` feature is on (the default),
//! sequential otherwise (e.g. wasm32 builds).

use crate::result::SolveResult;
use num_traits::Float;

#[cfg(feature = "parallel")]
pub(crate) fn run_replicas<T, F>(count: usize, run: F) -> Vec<SolveResult<T>>
where
    T: Send,
    F: Fn(usize) -> SolveResult<T> + Send + Sync,
{
    use rayon::prelude::*;
    (0..count).into_par_iter().map(run).collect()
}

#[cfg(not(feature = "parallel"))]
pub(crate) fn run_replicas<T, F>(count: usize, run: F) -> Vec<SolveResult<T>>
where
    F: Fn(usize) -> SolveResult<T>,
{
    (0..count).map(run).collect()
}

/// Lowest-energy result wins. Panics on an empty slice (callers assert
/// `replicas >= 1`).
pub(crate) fn best_of<T: Float>(results: Vec<SolveResult<T>>) -> SolveResult<T> {
    results
        .into_iter()
        .min_by(|a, b| {
            a.energy
                .partial_cmp(&b.energy)
                .unwrap_or(core::cmp::Ordering::Equal)
        })
        .expect("at least one replica result")
}
