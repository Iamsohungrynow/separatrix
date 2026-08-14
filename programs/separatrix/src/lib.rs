use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

declare_id!("CsnV36BSJsfCRSrJQSCddi5ZM7XAA8KVpL8ziCh7xSzp");

/// Largest universe a single study account can hold. The coefficient buffer is
/// `MAX_ASSETS*(MAX_ASSETS+1)/2` i64 terms, and the whole account must stay
/// under the 10,240-byte limit on CPI-created accounts.
pub const MAX_ASSETS: usize = 48;
pub const MAX_TERMS: usize = MAX_ASSETS * (MAX_ASSETS + 1) / 2;
/// Coefficients per `write_coefficients` call. A Solana transaction is ~1232
/// bytes, so 96 i64 (768 bytes) plus accounts and overhead fits comfortably.
pub const MAX_CHUNK: usize = 96;
/// Domain separator: a commitment is only ever valid for one program, one
/// study, one sequence, and one agent.
pub const COMMITMENT_DOMAIN: &[u8] = b"separatrix:allocation:v1";
/// Domain separator for the sealed-problem hash.
pub const QUBO_DOMAIN: &[u8] = b"separatrix:qubo:v1";
/// Coefficients are quantized to i32 bounds off-chain. Enforcing that here
/// makes the scoring loop's accumulator overflow-proof by construction:
/// `k*(k+1)/2` terms of magnitude < 2^31 cannot leave i128's range for any
/// `k <= MAX_ASSETS`.
pub const MAX_ABS_COEFFICIENT: i64 = i32::MAX as i64;

/// Separatrix publishes portfolio allocations to Solana and verifies them.
///
/// The thesis is an asymmetry: choosing the best K-of-N portfolio under a
/// quadratic objective is NP-hard, but *checking* what a given portfolio
/// scores is O(K^2) integer additions that any validator can replay. So the
/// chain does not solve anything and claims no advantage. It does two things
/// that off-chain infrastructure cannot:
///
/// 1. **Commit before the market moves.** The agent publishes
///    `hash(domain || study || sequence || agent || bits || salt)` *before*
///    executing. A pick cannot be backdated, and the salt keeps the tiny
///    allocation space (C(39,8) is only ~61M) from being brute-forced out of
///    the commitment.
/// 2. **Score against a sealed problem.** The quantized objective matrix is
///    written on-chain and frozen against a hash before any allocation is
///    accepted, so the problem cannot be edited to flatter an answer. On
///    reveal the program re-derives the objective itself; the number in the
///    event is the chain's, not the submitter's.
///
/// What this deliberately does *not* prove: that an agent revealed everything
/// it committed. Nothing on a public chain can force a reveal, so an agent can
/// always publish several candidate allocations and reveal only the one that
/// aged well. The program therefore makes that behaviour *countable* rather
/// than pretending to prevent it: sequences are strictly monotonic (no gaps to
/// hide in), one agent is bound to a study at creation (nobody else can
/// squat sequences), and both `published_count` and `revealed_count` live on
/// the study. Any honest reading of a track record quotes both numbers; a
/// large gap between them is the tell, and it is on-chain.
#[program]
pub mod separatrix {
    use super::*;

    /// Open a study: fix the universe, the cardinality, and a hash of the
    /// quantized objective matrix that `seal_study` will check the uploaded
    /// coefficients against.
    pub fn create_study(
        ctx: Context<CreateStudy>,
        study_id: u64,
        n: u8,
        k: u8,
        scale_bits: u64,
        offset_int_le: [u8; 16],
        q_hash: [u8; 32],
        label: [u8; 32],
    ) -> Result<()> {
        require!(n as usize <= MAX_ASSETS, ErrorCode::UniverseTooLarge);
        require!(n >= 1, ErrorCode::InvalidCardinality);
        require!(k >= 1 && k <= n, ErrorCode::InvalidCardinality);

        let mut study = ctx.accounts.study.load_init()?;
        study.authority = ctx.accounts.authority.key();
        study.agent = ctx.accounts.agent.key();
        study.q_hash = q_hash;
        study.label = label;
        study.offset_int_le = offset_int_le;
        study.study_id = study_id;
        study.scale_bits = scale_bits;
        study.created_at = Clock::get()?.unix_timestamp;
        study.published_count = 0;
        study.revealed_count = 0;
        study.term_count = term_count(n as usize) as u32;
        study.n = n;
        study.k = k;
        study.sealed = 0;
        study.bump = ctx.bumps.study;
        Ok(())
    }

    /// Stream the upper-triangular objective matrix in chunks. Only the
    /// authority, only before sealing.
    pub fn write_coefficients(
        ctx: Context<WriteCoefficients>,
        start_index: u32,
        values: Vec<i64>,
    ) -> Result<()> {
        require!(!values.is_empty(), ErrorCode::EmptyChunk);
        require!(values.len() <= MAX_CHUNK, ErrorCode::ChunkTooLarge);

        let mut study = ctx.accounts.study.load_mut()?;
        require!(study.sealed == 0, ErrorCode::StudySealed);

        // Bounding magnitudes here is what makes the scoring loop's
        // accumulator provably overflow-free later.
        for value in values.iter() {
            require!(
                value.abs() <= MAX_ABS_COEFFICIENT,
                ErrorCode::CoefficientOutOfRange
            );
        }

        let end = (start_index as usize)
            .checked_add(values.len())
            .ok_or(ErrorCode::Overflow)?;
        require!(end <= study.term_count as usize, ErrorCode::IndexOutOfRange);

        study.coefficients[start_index as usize..end].copy_from_slice(&values);
        Ok(())
    }

    /// Freeze the problem. The uploaded coefficients must hash to the value
    /// committed at `create_study`, so a partially written or tampered matrix
    /// can never be sealed.
    ///
    /// The digest covers the *whole instance*, not just the coefficient bytes:
    /// binding `n`, `k`, the quantization scale and the penalty offset means an
    /// authority cannot reuse one matrix under a different cardinality or a
    /// different offset and present it as the same sealed problem.
    pub fn seal_study(ctx: Context<SealStudy>) -> Result<()> {
        let mut study = ctx.accounts.study.load_mut()?;
        require!(study.sealed == 0, ErrorCode::StudySealed);

        let terms = study.term_count as usize;
        // Hash the coefficients in place. `to_le_bytes` per term would mean
        // ~1200 iterations and a 9.4 KB heap allocation against BPF's 32 KB
        // heap; the buffer is already little-endian i64 in memory.
        let coefficient_bytes: &[u8] = bytemuck::cast_slice(&study.coefficients[..terms]);
        let digest = hashv(&[
            QUBO_DOMAIN,
            &[study.n, study.k],
            &study.scale_bits.to_le_bytes(),
            &study.offset_int_le,
            coefficient_bytes,
        ])
        .to_bytes();
        require!(digest == study.q_hash, ErrorCode::CoefficientHashMismatch);

        study.sealed = 1;
        emit!(StudySealed {
            study: ctx.accounts.study.key(),
            authority: study.authority,
            n: study.n,
            k: study.k,
            term_count: study.term_count,
            q_hash: study.q_hash,
        });
        Ok(())
    }

    /// Commit to an allocation before acting on it.
    ///
    /// Sequences are strictly monotonic — `sequence` must equal the study's
    /// current `published_count`. That leaves no gaps for an agent to hide an
    /// unrevealed commitment in, and no way for anyone to squat a future
    /// sequence, because only the study's bound agent may publish at all.
    pub fn publish_allocation(
        ctx: Context<PublishAllocation>,
        sequence: u64,
        commitment: [u8; 32],
        method: [u8; 16],
    ) -> Result<()> {
        let mut study = ctx.accounts.study.load_mut()?;
        require!(study.sealed == 1, ErrorCode::StudyNotSealed);
        require!(
            study.agent == ctx.accounts.agent.key(),
            ErrorCode::UnauthorizedAgent
        );
        require!(sequence == study.published_count, ErrorCode::SequenceOutOfOrder);
        require!(commitment != [0u8; 32], ErrorCode::EmptyCommitment);

        let clock = Clock::get()?;
        let study_key = ctx.accounts.study.key();
        let allocation_key = ctx.accounts.allocation.key();
        let agent_key = ctx.accounts.agent.key();
        let allocation = &mut ctx.accounts.allocation;
        allocation.study = study_key;
        allocation.agent = agent_key;
        allocation.commitment = commitment;
        allocation.method = method;
        allocation.sequence = sequence;
        allocation.published_slot = clock.slot;
        allocation.published_at = clock.unix_timestamp;
        allocation.revealed_at = 0;
        allocation.objective_int_le = [0u8; 16];
        allocation.revealed = 0;
        allocation.bump = ctx.bumps.allocation;

        study.published_count = study.published_count.saturating_add(1);

        emit!(AllocationPublished {
            study: study_key,
            allocation: allocation_key,
            agent: agent_key,
            sequence,
            commitment,
            method,
            slot: allocation.published_slot,
            timestamp: allocation.published_at,
        });
        Ok(())
    }

    /// Reveal the allocation and let the chain score it.
    ///
    /// `bits` is a bitmap of the selected assets: exactly `ceil(n/8)` bytes,
    /// **LSB-first within each byte** (asset `i` is bit `i % 8` of byte
    /// `i / 8`), with every bit at index `>= n` zero. The program checks the
    /// commitment, checks the cardinality, then re-derives the objective from
    /// the sealed matrix. The emitted objective is computed here — a submitted
    /// value is never trusted or stored.
    pub fn reveal_allocation(
        ctx: Context<RevealAllocation>,
        bits: Vec<u8>,
        salt: [u8; 32],
    ) -> Result<()> {
        let mut study = ctx.accounts.study.load_mut()?;
        let study_key = ctx.accounts.study.key();
        let allocation_key = ctx.accounts.allocation.key();
        let allocation = &mut ctx.accounts.allocation;
        require!(allocation.revealed == 0, ErrorCode::AlreadyRevealed);
        require!(salt != [0u8; 32], ErrorCode::EmptySalt);

        let n = study.n as usize;
        require!(bits.len() == bitmap_len(n), ErrorCode::BadBitmapLength);

        // Every field the commitment binds is read from account state, never
        // from instruction arguments, so a commitment copied out of somebody
        // else's transaction can never be revealed here: a different program,
        // study, sequence, agent, or problem shape yields a different digest.
        // The explicit length prefix keeps `bits || salt` unambiguous.
        let expected = hashv(&[
            COMMITMENT_DOMAIN,
            crate::ID.as_ref(),
            study_key.as_ref(),
            &allocation.sequence.to_le_bytes(),
            allocation.agent.as_ref(),
            &[study.n, study.k],
            &(bits.len() as u32).to_le_bytes(),
            &bits,
            &salt,
        ])
        .to_bytes();
        require!(expected == allocation.commitment, ErrorCode::CommitmentMismatch);

        // Collect selected indices; reject any bit set beyond the universe so
        // padding cannot smuggle in a different bitmap with the same meaning.
        let mut selected: Vec<usize> = Vec::with_capacity(study.k as usize);
        for (byte_index, byte) in bits.iter().enumerate() {
            for bit in 0..8usize {
                if byte & (1u8 << bit) != 0 {
                    let index = byte_index * 8 + bit;
                    require!(index < n, ErrorCode::BitOutsideUniverse);
                    require!(
                        selected.len() < study.k as usize,
                        ErrorCode::WrongCardinality
                    );
                    selected.push(index);
                }
            }
        }
        require!(selected.len() == study.k as usize, ErrorCode::WrongCardinality);

        // The whole point: O(k^2) integer additions any validator can replay.
        let mut objective: i128 = 0;
        for (position, &i) in selected.iter().enumerate() {
            objective = objective
                .checked_add(study.coefficients[triangular_index(n, i, i)] as i128)
                .ok_or(ErrorCode::Overflow)?;
            for &j in selected[position + 1..].iter() {
                objective = objective
                    .checked_add(study.coefficients[triangular_index(n, i, j)] as i128)
                    .ok_or(ErrorCode::Overflow)?;
            }
        }
        let portfolio_objective = objective
            .checked_add(i128::from_le_bytes(study.offset_int_le))
            .ok_or(ErrorCode::Overflow)?;

        allocation.objective_int_le = objective.to_le_bytes();
        allocation.portfolio_objective_int_le = portfolio_objective.to_le_bytes();
        allocation.revealed_at = Clock::get()?.unix_timestamp;
        allocation.revealed = 1;
        // The gap between these two counters is the honest reading of the
        // record, so the reveal side must actually move.
        study.revealed_count = study.revealed_count.saturating_add(1);

        emit!(AllocationScored {
            study: study_key,
            allocation: allocation_key,
            agent: allocation.agent,
            sequence: allocation.sequence,
            objective_int_le: allocation.objective_int_le,
            portfolio_objective_int_le: allocation.portfolio_objective_int_le,
            selected_count: selected.len() as u8,
            timestamp: allocation.revealed_at,
        });
        Ok(())
    }
}

/// Number of stored terms for an `n`-asset upper triangle (diagonal included).
pub fn term_count(n: usize) -> usize {
    n * (n + 1) / 2
}

/// Bytes needed for an `n`-bit selection bitmap.
pub fn bitmap_len(n: usize) -> usize {
    n.div_ceil(8)
}

/// Row-major upper-triangular index for `i <= j` in an `n`-asset matrix.
/// Row `i` starts after the `n + (n-1) + ... + (n-i+1)` terms above it.
pub fn triangular_index(n: usize, i: usize, j: usize) -> usize {
    let (i, j) = if i <= j { (i, j) } else { (j, i) };
    i * n - i * (i.saturating_sub(1)) / 2 + (j - i)
}

#[derive(Accounts)]
#[instruction(study_id: u64)]
pub struct CreateStudy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: recorded as the only key allowed to publish allocations to this
    /// study. It does not sign here — an authority may open a study for an
    /// agent that does not exist yet, exactly as leash does.
    pub agent: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + core::mem::size_of::<Study>(),
        seeds = [b"study", authority.key().as_ref(), &study_id.to_le_bytes()],
        bump
    )]
    pub study: AccountLoader<'info, Study>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteCoefficients<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"study", authority.key().as_ref(), &study.load()?.study_id.to_le_bytes()],
        bump = study.load()?.bump,
        constraint = study.load()?.authority == authority.key() @ ErrorCode::UnauthorizedAuthority
    )]
    pub study: AccountLoader<'info, Study>,
}

#[derive(Accounts)]
pub struct SealStudy<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"study", authority.key().as_ref(), &study.load()?.study_id.to_le_bytes()],
        bump = study.load()?.bump,
        constraint = study.load()?.authority == authority.key() @ ErrorCode::UnauthorizedAuthority
    )]
    pub study: AccountLoader<'info, Study>,
}

#[derive(Accounts)]
#[instruction(sequence: u64)]
pub struct PublishAllocation<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(mut)]
    pub study: AccountLoader<'info, Study>,
    #[account(
        init,
        payer = agent,
        space = 8 + Allocation::INIT_SPACE,
        seeds = [b"alloc", study.key().as_ref(), &sequence.to_le_bytes()],
        bump
    )]
    pub allocation: Account<'info, Allocation>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealAllocation<'info> {
    /// Mutable because the reveal advances `revealed_count`. The allocation's
    /// stored `study` pins which sealed problem may score it, so a caller
    /// cannot swap in a flattering matrix.
    #[account(mut)]
    pub study: AccountLoader<'info, Study>,
    #[account(
        mut,
        seeds = [b"alloc", study.key().as_ref(), &allocation.sequence.to_le_bytes()],
        bump = allocation.bump,
        constraint = allocation.study == study.key() @ ErrorCode::StudyMismatch
    )]
    pub allocation: Account<'info, Allocation>,
}

/// Zero-copy so the coefficient buffer never round-trips through Borsh.
/// Field order is chosen so `repr(C)` introduces no padding: the align-1
/// byte arrays come first, then the 8-byte scalars, then the small integers,
/// then the align-8 coefficient array.
#[account(zero_copy)]
#[repr(C)]
pub struct Study {
    pub authority: Pubkey,
    /// The only key permitted to publish allocations against this study.
    pub agent: Pubkey,
    pub q_hash: [u8; 32],
    pub label: [u8; 32],
    /// `P*k^2`, the penalty constant the QUBO drops, as little-endian i128.
    pub offset_int_le: [u8; 16],
    pub study_id: u64,
    /// `f64::to_bits` of the quantization scale — informational, so a reader
    /// can convert integer objectives back to float units.
    pub scale_bits: u64,
    pub created_at: i64,
    pub published_count: u64,
    pub revealed_count: u64,
    pub term_count: u32,
    pub n: u8,
    pub k: u8,
    pub sealed: u8,
    pub bump: u8,
    pub coefficients: [i64; MAX_TERMS],
}

#[account]
#[derive(InitSpace)]
pub struct Allocation {
    pub study: Pubkey,
    pub agent: Pubkey,
    pub commitment: [u8; 32],
    pub method: [u8; 16],
    pub sequence: u64,
    pub published_slot: u64,
    pub published_at: i64,
    pub revealed_at: i64,
    /// Objective the *program* computed, little-endian i128. Zero until reveal.
    pub objective_int_le: [u8; 16],
    pub portfolio_objective_int_le: [u8; 16],
    pub revealed: u8,
    pub bump: u8,
}

#[event]
pub struct StudySealed {
    pub study: Pubkey,
    pub authority: Pubkey,
    pub n: u8,
    pub k: u8,
    pub term_count: u32,
    pub q_hash: [u8; 32],
}

#[event]
pub struct AllocationPublished {
    pub study: Pubkey,
    pub allocation: Pubkey,
    pub agent: Pubkey,
    pub sequence: u64,
    pub commitment: [u8; 32],
    pub method: [u8; 16],
    pub slot: u64,
    pub timestamp: i64,
}

#[event]
pub struct AllocationScored {
    pub study: Pubkey,
    pub allocation: Pubkey,
    pub agent: Pubkey,
    pub sequence: u64,
    pub objective_int_le: [u8; 16],
    pub portfolio_objective_int_le: [u8; 16],
    pub selected_count: u8,
    pub timestamp: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("universe exceeds MAX_ASSETS")]
    UniverseTooLarge,
    #[msg("cardinality must satisfy 1 <= k <= n")]
    InvalidCardinality,
    #[msg("coefficient chunk is empty")]
    EmptyChunk,
    #[msg("coefficient chunk exceeds MAX_CHUNK")]
    ChunkTooLarge,
    #[msg("coefficient index out of range for this study")]
    IndexOutOfRange,
    #[msg("study is sealed and its coefficients are immutable")]
    StudySealed,
    #[msg("study must be sealed before allocations are accepted")]
    StudyNotSealed,
    #[msg("uploaded coefficients do not match the committed hash")]
    CoefficientHashMismatch,
    #[msg("allocation has already been revealed")]
    AlreadyRevealed,
    #[msg("bitmap length does not match the universe size")]
    BadBitmapLength,
    #[msg("bitmap sets a bit outside the universe")]
    BitOutsideUniverse,
    #[msg("selection does not contain exactly k assets")]
    WrongCardinality,
    #[msg("revealed allocation does not match the commitment")]
    CommitmentMismatch,
    #[msg("allocation belongs to a different study")]
    StudyMismatch,
    #[msg("signer is not the study authority")]
    UnauthorizedAuthority,
    #[msg("signer is not the study's bound agent")]
    UnauthorizedAgent,
    #[msg("sequence must equal the study's published_count")]
    SequenceOutOfOrder,
    #[msg("commitment must not be all zeroes")]
    EmptyCommitment,
    #[msg("salt must not be all zeroes")]
    EmptySalt,
    #[msg("coefficient magnitude exceeds the quantization bound")]
    CoefficientOutOfRange,
    #[msg("arithmetic overflow")]
    Overflow,
}
