from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agent.config import Settings
from agent.db.database import Database


def create_app(
    app_settings: Settings | None = None,
    app_database: Database | None = None,
) -> FastAPI:
    current_settings = app_settings or Settings.from_env()
    current_database = app_database or Database(current_settings.database_path)
    current_database.initialize()
    current_database.ensure_cash(current_settings.starting_paper_cash_usdc)

    app = FastAPI(title="QubitAlpha API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict[str, object]:
        policy_mode = "devnet-anchor" if current_settings.enable_devnet_policy else "local-simulator"
        return current_database.health_snapshot(network=current_settings.solana_network, policy_mode=policy_mode)

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

    return app


settings = Settings.from_env()
database = Database(settings.database_path)
app = create_app(settings, database)
