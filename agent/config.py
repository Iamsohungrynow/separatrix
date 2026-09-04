from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: str | Path = ".env") -> None:
    env_path = Path(path)
    if not env_path.exists():
        return

    # Support UTF-8 BOM files, which PowerShell commonly writes on Windows.
    for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def _get_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _get_float(name: str, default: float) -> float:
    value = os.getenv(name)
    return float(value) if value is not None and value != "" else default


def _get_int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value is not None and value != "" else default


def _get_list(name: str, default: list[str]) -> list[str]:
    value = os.getenv(name)
    if not value:
        return default
    return [part.strip() for part in value.split(",") if part.strip()]


@dataclass(slots=True)
class Settings:
    app_env: str
    log_level: str
    sqlite_path: str
    solana_rpc_url: str
    solana_network: str
    owner_wallet_path: str
    agent_wallet_path: str
    treasury_wallet_path: str
    leash_program_id: str
    enable_devnet_leash: bool
    per_tx_cap_sol: float
    daily_cap_sol: float
    sol_per_usdc_budget: float
    spend_recipient: str
    groq_api_key: str
    tracked_assets: list[str]
    poll_interval_seconds: int
    sentiment_threshold: float
    confidence_threshold: float
    starting_paper_cash_usdc: float
    base_trade_amount_usdc: float
    per_trade_buy_limit_usdc: float
    max_position_pct: float
    max_drawdown_pct: float
    stop_loss_pct: float
    api_host: str
    api_port: int
    api_rate_limit: int

    @classmethod
    def from_env(cls, env_path: str | Path = ".env") -> "Settings":
        load_dotenv(env_path)
        return cls(
            app_env=os.getenv("APP_ENV", "development"),
            log_level=os.getenv("LOG_LEVEL", "INFO"),
            sqlite_path=os.getenv("SQLITE_PATH", "data/leash.db"),
            solana_rpc_url=os.getenv("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
            solana_network=os.getenv("SOLANA_NETWORK", "devnet"),
            owner_wallet_path=os.getenv("OWNER_WALLET_PATH", "keys/owner-devnet.json"),
            agent_wallet_path=os.getenv("AGENT_WALLET_PATH", "keys/agent-devnet.json"),
            treasury_wallet_path=os.getenv("TREASURY_WALLET_PATH", "keys/treasury-devnet.json"),
            leash_program_id=os.getenv(
                "LEASH_PROGRAM_ID", "EZQjF3NwVTMUrRdDiCwzuabFEoe2viVfFhEaWPkj6gkV"
            ),
            enable_devnet_leash=_get_bool("ENABLE_DEVNET_LEASH", False),
            per_tx_cap_sol=_get_float("PER_TX_CAP_SOL", 0.05),
            daily_cap_sol=_get_float("DAILY_CAP_SOL", 0.2),
            sol_per_usdc_budget=_get_float("SOL_PER_USDC_BUDGET", 0.001),
            spend_recipient=os.getenv("SPEND_RECIPIENT", ""),
            groq_api_key=os.getenv("GROQ_API_KEY", ""),
            tracked_assets=_get_list("TRACKED_ASSETS", ["SOL", "RNDR", "IO", "PYTH"]),
            poll_interval_seconds=_get_int("POLL_INTERVAL_SECONDS", 900),
            sentiment_threshold=_get_float("SENTIMENT_THRESHOLD", 0.6),
            confidence_threshold=_get_float("CONFIDENCE_THRESHOLD", 0.7),
            starting_paper_cash_usdc=_get_float("STARTING_PAPER_CASH_USDC", 1000.0),
            base_trade_amount_usdc=_get_float("BASE_TRADE_AMOUNT_USDC", 5.0),
            per_trade_buy_limit_usdc=_get_float("PER_TRADE_BUY_LIMIT_USDC", 5.0),
            max_position_pct=_get_float("MAX_POSITION_PCT", 0.20),
            max_drawdown_pct=_get_float("MAX_DRAWDOWN_PCT", 0.30),
            stop_loss_pct=_get_float("STOP_LOSS_PCT", 0.15),
            api_host=os.getenv("API_HOST", "0.0.0.0"),
            api_port=_get_int("API_PORT", 8000),
            api_rate_limit=_get_int("API_RATE_LIMIT", 100),
        )

    @property
    def database_path(self) -> Path:
        path = Path(self.sqlite_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        return path
