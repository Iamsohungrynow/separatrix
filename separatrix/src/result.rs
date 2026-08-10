//! Solver output.

use num_traits::Float;

/// The outcome of one solver run: the best spin configuration found and its
/// Ising energy. A lower energy is better; no solver can report an energy
/// below the exact ground state (asserting exactly that is part of this
/// crate's test suite).
#[derive(Debug, Clone, PartialEq)]
pub struct SolveResult<T> {
    /// Spin configuration, each entry −1 or +1.
    pub spins: Vec<i8>,
    /// Ising energy of `spins` under the solved model.
    pub energy: T,
    /// Steps (SB integration steps, or annealing sweeps) the winning run used.
    pub steps: u64,
    /// Seed that reproduces this run through the same solver + config.
    pub seed: u64,
    /// Which replica / restart produced the winner.
    pub replica: usize,
}

impl<T: Float> SolveResult<T> {
    /// The configuration as QUBO bits: spin −1 ↦ 0, spin +1 ↦ 1.
    pub fn bits(&self) -> Vec<u8> {
        self.spins.iter().map(|&s| u8::from(s > 0)).collect()
    }
}

/// Convert QUBO bits (0/1) to Ising spins (−1/+1).
pub fn spins_from_bits(bits: &[u8]) -> Vec<i8> {
    bits.iter().map(|&b| if b > 0 { 1 } else { -1 }).collect()
}
