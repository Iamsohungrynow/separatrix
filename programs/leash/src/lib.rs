use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV");

const SECONDS_PER_DAY: i64 = 86_400;
const MAX_ALLOWED_RECIPIENTS: usize = 8;

/// Leash is an on-chain spending firewall for AI agents.
///
/// The owner funds a program-derived vault and configures limits. The agent
/// can only move lamports out of the vault through `spend`, which the program
/// rejects unless every policy check passes. The owner can halt the agent,
/// change limits, or withdraw the remaining balance at any time.
#[program]
pub mod leash {
    use super::*;

    pub fn create_leash(
        ctx: Context<CreateLeash>,
        per_tx_cap_lamports: u64,
        daily_cap_lamports: u64,
        allowlist_enforced: bool,
    ) -> Result<()> {
        require_valid_limits(per_tx_cap_lamports, daily_cap_lamports)?;

        let leash = &mut ctx.accounts.leash;
        leash.owner = ctx.accounts.owner.key();
        leash.agent = ctx.accounts.agent.key();
        leash.per_tx_cap_lamports = per_tx_cap_lamports;
        leash.daily_cap_lamports = daily_cap_lamports;
        leash.spent_today_lamports = 0;
        leash.current_day_index = current_day_index(Clock::get()?.unix_timestamp);
        leash.total_spent_lamports = 0;
        leash.spend_count = 0;
        leash.halted = false;
        leash.allowlist_enforced = allowlist_enforced;
        leash.allowed_recipients = Vec::new();
        leash.bump = ctx.bumps.leash;
        leash.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount_lamports: u64) -> Result<()> {
        require!(amount_lamports > 0, ErrorCode::InvalidAmount);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        emit!(VaultDeposited {
            leash: ctx.accounts.leash.key(),
            depositor: ctx.accounts.depositor.key(),
            amount_lamports,
            vault_balance_lamports: ctx.accounts.vault.lamports(),
        });
        Ok(())
    }

    /// The only path by which the agent can move value. Fails closed.
    pub fn spend(ctx: Context<Spend>, amount_lamports: u64) -> Result<()> {
        require!(amount_lamports > 0, ErrorCode::InvalidAmount);

        let leash = &mut ctx.accounts.leash;

        if leash.halted {
            return err!(ErrorCode::LeashHalted);
        }

        roll_day_if_needed(leash, Clock::get()?.unix_timestamp);

        require!(
            amount_lamports <= leash.per_tx_cap_lamports,
            ErrorCode::PerTxCapExceeded
        );

        let projected_today = leash
            .spent_today_lamports
            .checked_add(amount_lamports)
            .ok_or(ErrorCode::Overflow)?;
        require!(
            projected_today <= leash.daily_cap_lamports,
            ErrorCode::DailyCapExceeded
        );

        let recipient_key = ctx.accounts.recipient.key();
        if leash.allowlist_enforced {
            require!(
                leash.allowed_recipients.contains(&recipient_key),
                ErrorCode::RecipientNotAllowed
            );
        }

        require!(
            ctx.accounts.vault.lamports() >= amount_lamports,
            ErrorCode::VaultInsufficient
        );

        let leash_key = leash.key();
        let vault_seeds: &[&[u8]] = &[b"vault", leash_key.as_ref(), &[leash.vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount_lamports,
        )?;

        leash.spent_today_lamports = projected_today;
        leash.total_spent_lamports = leash
            .total_spent_lamports
            .checked_add(amount_lamports)
            .ok_or(ErrorCode::Overflow)?;
        leash.spend_count = leash.spend_count.checked_add(1).ok_or(ErrorCode::Overflow)?;

        emit!(SpendExecuted {
            leash: leash_key,
            agent: leash.agent,
            recipient: recipient_key,
            amount_lamports,
            spent_today_lamports: leash.spent_today_lamports,
            total_spent_lamports: leash.total_spent_lamports,
            spend_count: leash.spend_count,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn update_limits(
        ctx: Context<OwnerAction>,
        per_tx_cap_lamports: u64,
        daily_cap_lamports: u64,
    ) -> Result<()> {
        require_valid_limits(per_tx_cap_lamports, daily_cap_lamports)?;
        let leash = &mut ctx.accounts.leash;
        leash.per_tx_cap_lamports = per_tx_cap_lamports;
        leash.daily_cap_lamports = daily_cap_lamports;
        Ok(())
    }

    pub fn set_halt(ctx: Context<OwnerAction>, halted: bool) -> Result<()> {
        ctx.accounts.leash.halted = halted;
        emit!(HaltChanged {
            leash: ctx.accounts.leash.key(),
            halted,
        });
        Ok(())
    }

    pub fn set_allowlist(
        ctx: Context<OwnerAction>,
        enforced: bool,
        recipients: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            recipients.len() <= MAX_ALLOWED_RECIPIENTS,
            ErrorCode::AllowlistTooLarge
        );
        let leash = &mut ctx.accounts.leash;
        leash.allowlist_enforced = enforced;
        leash.allowed_recipients = recipients;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount_lamports: u64) -> Result<()> {
        require!(amount_lamports > 0, ErrorCode::InvalidAmount);
        require!(
            ctx.accounts.vault.lamports() >= amount_lamports,
            ErrorCode::VaultInsufficient
        );

        let leash_key = ctx.accounts.leash.key();
        let vault_seeds: &[&[u8]] =
            &[b"vault", leash_key.as_ref(), &[ctx.accounts.leash.vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount_lamports,
        )?;

        emit!(VaultWithdrawn {
            leash: leash_key,
            owner: ctx.accounts.owner.key(),
            amount_lamports,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateLeash<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: any pubkey may be leashed; the agent does not need to consent.
    pub agent: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + LeashState::INIT_SPACE,
        seeds = [b"leash", agent.key().as_ref()],
        bump
    )]
    pub leash: Account<'info, LeashState>,
    /// CHECK: system-owned PDA that holds the vault lamports.
    #[account(
        seeds = [b"vault", leash.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        seeds = [b"leash", leash.agent.as_ref()],
        bump = leash.bump
    )]
    pub leash: Account<'info, LeashState>,
    /// CHECK: vault PDA validated by seeds.
    #[account(
        mut,
        seeds = [b"vault", leash.key().as_ref()],
        bump = leash.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Spend<'info> {
    #[account(
        mut,
        seeds = [b"leash", leash.agent.as_ref()],
        bump = leash.bump,
        has_one = agent @ ErrorCode::UnauthorizedAgent
    )]
    pub leash: Account<'info, LeashState>,
    pub agent: Signer<'info>,
    /// CHECK: vault PDA validated by seeds.
    #[account(
        mut,
        seeds = [b"vault", leash.key().as_ref()],
        bump = leash.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: destination is policy-checked against the allowlist when enforced.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerAction<'info> {
    #[account(
        mut,
        seeds = [b"leash", leash.agent.as_ref()],
        bump = leash.bump,
        has_one = owner @ ErrorCode::UnauthorizedOwner
    )]
    pub leash: Account<'info, LeashState>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [b"leash", leash.agent.as_ref()],
        bump = leash.bump,
        has_one = owner @ ErrorCode::UnauthorizedOwner
    )]
    pub leash: Account<'info, LeashState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: vault PDA validated by seeds.
    #[account(
        mut,
        seeds = [b"vault", leash.key().as_ref()],
        bump = leash.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct LeashState {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub per_tx_cap_lamports: u64,
    pub daily_cap_lamports: u64,
    pub spent_today_lamports: u64,
    pub current_day_index: i64,
    pub total_spent_lamports: u64,
    pub spend_count: u64,
    pub halted: bool,
    pub allowlist_enforced: bool,
    #[max_len(8)]
    pub allowed_recipients: Vec<Pubkey>,
    pub bump: u8,
    pub vault_bump: u8,
}

#[event]
pub struct SpendExecuted {
    pub leash: Pubkey,
    pub agent: Pubkey,
    pub recipient: Pubkey,
    pub amount_lamports: u64,
    pub spent_today_lamports: u64,
    pub total_spent_lamports: u64,
    pub spend_count: u64,
    pub timestamp: i64,
}

#[event]
pub struct VaultDeposited {
    pub leash: Pubkey,
    pub depositor: Pubkey,
    pub amount_lamports: u64,
    pub vault_balance_lamports: u64,
}

#[event]
pub struct VaultWithdrawn {
    pub leash: Pubkey,
    pub owner: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct HaltChanged {
    pub leash: Pubkey,
    pub halted: bool,
}

#[error_code]
pub enum ErrorCode {
    #[msg("the leash is halted; the agent may not spend")]
    LeashHalted,
    #[msg("the spend exceeds the per-transaction cap")]
    PerTxCapExceeded,
    #[msg("the spend exceeds the daily cap")]
    DailyCapExceeded,
    #[msg("the recipient is not on the allowlist")]
    RecipientNotAllowed,
    #[msg("the vault balance is insufficient")]
    VaultInsufficient,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("limits are invalid")]
    InvalidLimits,
    #[msg("the allowlist holds at most 8 recipients")]
    AllowlistTooLarge,
    #[msg("only the configured owner may perform this action")]
    UnauthorizedOwner,
    #[msg("only the configured agent may spend")]
    UnauthorizedAgent,
    #[msg("amount must be greater than zero")]
    InvalidAmount,
}

fn require_valid_limits(per_tx_cap_lamports: u64, daily_cap_lamports: u64) -> Result<()> {
    require!(per_tx_cap_lamports > 0, ErrorCode::InvalidLimits);
    require!(
        per_tx_cap_lamports <= daily_cap_lamports,
        ErrorCode::InvalidLimits
    );
    Ok(())
}

fn current_day_index(unix_timestamp: i64) -> i64 {
    unix_timestamp.div_euclid(SECONDS_PER_DAY)
}

fn roll_day_if_needed(leash: &mut Account<LeashState>, unix_timestamp: i64) {
    let day_index = current_day_index(unix_timestamp);
    if day_index != leash.current_day_index {
        leash.current_day_index = day_index;
        leash.spent_today_lamports = 0;
    }
}
