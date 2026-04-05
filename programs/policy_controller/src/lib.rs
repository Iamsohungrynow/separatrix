use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWxTWqk6W2BeZ7FEfcYkgMQHgZP");

const SECONDS_PER_DAY: i64 = 86_400;

#[program]
pub mod policy_controller {
    use super::*;

    pub fn initialize_policy(
        ctx: Context<InitializePolicy>,
        agent: Pubkey,
        daily_buy_limit_microusdc: u64,
        per_trade_buy_limit_microusdc: u64,
    ) -> Result<()> {
        require!(
            per_trade_buy_limit_microusdc <= daily_buy_limit_microusdc,
            ErrorCode::InvalidPolicy
        );

        let policy = &mut ctx.accounts.policy;
        policy.owner = ctx.accounts.owner.key();
        policy.agent = agent;
        policy.daily_buy_limit_microusdc = daily_buy_limit_microusdc;
        policy.per_trade_buy_limit_microusdc = per_trade_buy_limit_microusdc;
        policy.daily_buy_used_microusdc = 0;
        policy.current_day_index = current_day_index(Clock::get()?.unix_timestamp);
        policy.next_trade_seq = 1;
        policy.halted = false;
        policy.bump = ctx.bumps.policy;
        Ok(())
    }

    pub fn update_policy(
        ctx: Context<ModifyPolicy>,
        daily_buy_limit_microusdc: u64,
        per_trade_buy_limit_microusdc: u64,
    ) -> Result<()> {
        require!(
            per_trade_buy_limit_microusdc <= daily_buy_limit_microusdc,
            ErrorCode::InvalidPolicy
        );

        let policy = &mut ctx.accounts.policy;
        policy.daily_buy_limit_microusdc = daily_buy_limit_microusdc;
        policy.per_trade_buy_limit_microusdc = per_trade_buy_limit_microusdc;
        Ok(())
    }

    pub fn set_halt(ctx: Context<ModifyPolicy>, halted: bool) -> Result<()> {
        ctx.accounts.policy.halted = halted;
        Ok(())
    }

    pub fn submit_trade(
        ctx: Context<SubmitTrade>,
        trade_seq: u64,
        side: TradeSide,
        amount_microusdc: u64,
    ) -> Result<()> {
        let policy = &mut ctx.accounts.policy;

        if policy.halted {
            return err!(ErrorCode::AgentHalted);
        }

        roll_day_if_needed(policy, Clock::get()?.unix_timestamp);

        require!(trade_seq == policy.next_trade_seq, ErrorCode::InvalidTradeSequence);

        if side == TradeSide::Buy {
            require!(
                amount_microusdc <= policy.per_trade_buy_limit_microusdc,
                ErrorCode::TradeTooBig
            );

            let next_daily_buy_used = policy
                .daily_buy_used_microusdc
                .checked_add(amount_microusdc)
                .ok_or(ErrorCode::Overflow)?;

            require!(
                next_daily_buy_used <= policy.daily_buy_limit_microusdc,
                ErrorCode::DailyLimitExceeded
            );

            policy.daily_buy_used_microusdc = next_daily_buy_used;
        }

        policy.next_trade_seq = policy
            .next_trade_seq
            .checked_add(1)
            .ok_or(ErrorCode::Overflow)?;

        emit!(TradeSubmitted {
            agent: policy.agent,
            trade_seq,
            side: side as u8,
            amount_microusdc,
            daily_buy_used_microusdc: policy.daily_buy_used_microusdc,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct InitializePolicy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + AgentPolicy::INIT_SPACE,
        seeds = [b"policy", agent.as_ref()],
        bump
    )]
    pub policy: Account<'info, AgentPolicy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ModifyPolicy<'info> {
    #[account(
        mut,
        seeds = [b"policy", policy.agent.as_ref()],
        bump = policy.bump,
        has_one = owner @ ErrorCode::UnauthorizedOwner
    )]
    pub policy: Account<'info, AgentPolicy>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitTrade<'info> {
    #[account(
        mut,
        seeds = [b"policy", policy.agent.as_ref()],
        bump = policy.bump,
        has_one = agent @ ErrorCode::UnauthorizedAgent
    )]
    pub policy: Account<'info, AgentPolicy>,
    pub agent: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct AgentPolicy {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub daily_buy_limit_microusdc: u64,
    pub per_trade_buy_limit_microusdc: u64,
    pub daily_buy_used_microusdc: u64,
    pub current_day_index: i64,
    pub next_trade_seq: u64,
    pub halted: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum TradeSide {
    Buy = 0,
    Sell = 1,
}

#[event]
pub struct TradeSubmitted {
    pub agent: Pubkey,
    pub trade_seq: u64,
    pub side: u8,
    pub amount_microusdc: u64,
    pub daily_buy_used_microusdc: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("the agent is halted")]
    AgentHalted,
    #[msg("the trade exceeds the per-trade limit")]
    TradeTooBig,
    #[msg("the trade exceeds the daily limit")]
    DailyLimitExceeded,
    #[msg("the trade sequence is invalid")]
    InvalidTradeSequence,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("only the configured owner may modify policy")]
    UnauthorizedOwner,
    #[msg("only the configured agent may submit trades")]
    UnauthorizedAgent,
    #[msg("policy limits are invalid")]
    InvalidPolicy,
}

fn current_day_index(unix_timestamp: i64) -> i64 {
    unix_timestamp.div_euclid(SECONDS_PER_DAY)
}

fn roll_day_if_needed(policy: &mut Account<AgentPolicy>, unix_timestamp: i64) {
    let day_index = current_day_index(unix_timestamp);
    if day_index != policy.current_day_index {
        policy.current_day_index = day_index;
        policy.daily_buy_used_microusdc = 0;
    }
}
