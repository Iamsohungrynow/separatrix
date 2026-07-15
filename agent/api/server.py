from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agent.config import Settings
from agent.db.database import Database
from agent.trading.leash_client import AnchorLeashClient


def _explorer_address(address: str) -> str:
    return f"https://explorer.solana.com/address/{address}?cluster=devnet"


def _explorer_tx(signature: str | None) -> str | None:
    if not signature or signature.startswith("LOCAL-"):
        return None
    return f"https://explorer.solana.com/tx/{signature}?cluster=devnet"


def create_app(
    app_settings: Settings | None = None,
    app_database: Database | None = None,
) -> FastAPI:
    current_settings = app_settings or Settings.from_env()
    current_database = app_database or Database(current_settings.database_path)
    current_database.initialize()
    current_database.ensure_cash(current_settings.starting_paper_cash_usdc)

    app = FastAPI(title="Leash API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict[str, object]:
        leash_mode = "devnet-anchor" if current_settings.enable_devnet_leash else "local-simulator"
        payload = current_database.health_snapshot(network=current_settings.solana_network, policy_mode=leash_mode)
        payload["leash_program_id"] = current_settings.leash_program_id
        payload["leash_program_explorer_url"] = _explorer_address(current_settings.leash_program_id)
        return payload

    @app.get("/leash")
    def leash() -> dict[str, object]:
        leash_mode = "devnet-anchor" if current_settings.enable_devnet_leash else "local-simulator"
        payload: dict[str, object] = {
            "network": current_settings.solana_network,
            "leash_mode": leash_mode,
            "devnet_leash_enabled": current_settings.enable_devnet_leash,
            "program_id": current_settings.leash_program_id,
            "program_explorer_url": _explorer_address(current_settings.leash_program_id),
        }

        if not current_settings.enable_devnet_leash:
            payload["on_chain"] = None
            return payload

        client = AnchorLeashClient(
            rpc_url=current_settings.solana_rpc_url,
            program_id=current_settings.leash_program_id,
            wallet_path=current_settings.agent_wallet_path,
        )
        payload["on_chain"] = client.leash_status()
        return payload

    @app.get("/pnl")
    def pnl() -> dict[str, object]:
        payload = current_database.latest_pnl(current_settings.starting_paper_cash_usdc)
        payload["positions"] = current_database.list_positions()
        return payload

    @app.get("/signal/latest")
    def latest_signal() -> dict[str, object]:
        return {"signal": current_database.latest_signal(), "x402_enabled": current_settings.enable_x402}

    @app.get("/signal/history")
    def signal_history(limit: int = 20) -> dict[str, object]:
        limit = max(1, min(limit, 100))
        return {"signals": current_database.signal_history(limit=limit), "x402_enabled": current_settings.enable_x402}

    @app.get("/trades")
    def trades(limit: int = 20) -> dict[str, object]:
        limit = max(1, min(limit, 100))
        rows = current_database.trade_history(limit=limit)
        for row in rows:
            row["explorer_url"] = _explorer_tx(row.get("tx_signature"))
        return {"trades": rows, "x402_enabled": current_settings.enable_x402}

    return app


settings = Settings.from_env()
database = Database(settings.database_path)
app = create_app(settings, database)
