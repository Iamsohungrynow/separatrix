CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    url_hash TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT,
    published_at TEXT,
    fetched_at TEXT NOT NULL,
    metadata TEXT
);

CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_item_id INTEGER NOT NULL REFERENCES raw_items(id),
    asset TEXT NOT NULL,
    sentiment REAL NOT NULL,
    confidence REAL NOT NULL,
    reasoning TEXT,
    model TEXT NOT NULL,
    scored_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset TEXT NOT NULL,
    action TEXT NOT NULL,
    sentiment REAL NOT NULL,
    confidence REAL NOT NULL,
    position_size_usdc REAL NOT NULL,
    reasoning TEXT NOT NULL,
    sources TEXT NOT NULL,
    validated INTEGER NOT NULL,
    validation_details TEXT NOT NULL,
    devnet_tx TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER REFERENCES signals(id),
    asset TEXT NOT NULL,
    action TEXT NOT NULL,
    amount_usdc REAL NOT NULL,
    price_usdc REAL NOT NULL,
    quantity REAL NOT NULL,
    realized_pnl REAL NOT NULL DEFAULT 0,
    tx_signature TEXT,
    executed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
    asset TEXT PRIMARY KEY,
    quantity REAL NOT NULL,
    avg_cost REAL NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pnl_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_value_usdc REAL NOT NULL,
    unrealized_pnl REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset TEXT NOT NULL,
    price_usdc REAL NOT NULL,
    source TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE(asset, recorded_at, source)
);

CREATE TABLE IF NOT EXISTS paid_requests (
    payment_ref TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    amount_usd TEXT NOT NULL,
    network TEXT NOT NULL,
    settled_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_executed_at ON trades(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pnl_recorded_at ON pnl_snapshots(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_asset_recorded_at ON price_history(asset, recorded_at);
