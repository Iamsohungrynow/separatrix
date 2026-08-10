//! Deterministic randomness for solvers.
//!
//! Everything is seeded explicitly (no OS entropy), which keeps every solve
//! reproducible from its reported seed and keeps the crate free of `getrandom`
//! so the same code builds for `wasm32-unknown-unknown` unmodified.

use num_traits::Float;
use rand_core::{RngCore, SeedableRng};
use rand_xoshiro::Xoshiro256PlusPlus;

pub(crate) struct Rng(Xoshiro256PlusPlus);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(Xoshiro256PlusPlus::seed_from_u64(seed))
    }

    /// Derive an independent stream for replica `index` of a run.
    ///
    /// Mixes the index through SplitMix64-style constants rather than adding,
    /// so nearby (seed, index) pairs do not produce correlated streams.
    pub fn for_replica(seed: u64, index: u64) -> Self {
        let mixed = seed
            .wrapping_add(index.wrapping_mul(0x9E37_79B9_7F4A_7C15))
            .rotate_left(31)
            .wrapping_mul(0xBF58_476D_1CE4_E5B9);
        Self::new(mixed)
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.0.next_u64()
    }

    /// Uniform in [0, 1) with 53 bits of precision.
    #[inline]
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Uniform in (-half_width, half_width).
    #[inline]
    pub fn uniform_symmetric<T: Float>(&mut self, half_width: T) -> T {
        let u = T::from(self.uniform() * 2.0 - 1.0).unwrap();
        u * half_width
    }

    /// Uniform index in [0, n) via widening multiply (bias is negligible for
    /// any n this crate handles; n is far below 2^32).
    #[inline]
    pub fn below(&mut self, n: usize) -> usize {
        ((self.next_u64() as u128 * n as u128) >> 64) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_for_same_seed() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn replica_streams_differ() {
        let mut a = Rng::for_replica(42, 0);
        let mut b = Rng::for_replica(42, 1);
        assert_ne!(a.next_u64(), b.next_u64());
    }

    #[test]
    fn uniform_in_range() {
        let mut rng = Rng::new(7);
        for _ in 0..1000 {
            let u = rng.uniform();
            assert!((0.0..1.0).contains(&u));
        }
        for _ in 0..1000 {
            let i = rng.below(13);
            assert!(i < 13);
        }
    }
}
