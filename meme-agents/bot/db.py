"""SQLite storage (aiosqlite, WAL). One connection, writes serialized by aiosqlite's thread."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

import aiosqlite

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS mints (
    mint TEXT PRIMARY KEY,
    name TEXT, symbol TEXT, uri TEXT,
    creator TEXT,
    bonding_curve_key TEXT,
    created_at REAL,
    first_trade_at REAL,
    last_trade_at REAL,
    trade_count INTEGER DEFAULT 0,
    buy_count INTEGER DEFAULT 0,
    sell_count INTEGER DEFAULT 0,
    unique_buyers INTEGER DEFAULT 0,
    buy_sol REAL DEFAULT 0,
    sell_sol REAL DEFAULT 0,
    net_inflow_sol REAL DEFAULT 0,
    creator_sold_sol REAL DEFAULT 0,
    v_sol REAL, v_tokens REAL,
    progress REAL DEFAULT 0,
    market_cap_sol REAL,
    last_price_sol REAL,
    pool TEXT,
    graduated INTEGER DEFAULT 0,
    status TEXT DEFAULT 'tracking',
    status_reason TEXT,
    updated_at REAL
);
CREATE INDEX IF NOT EXISTS ix_mints_status ON mints(status, first_trade_at);
CREATE INDEX IF NOT EXISTS ix_mints_creator ON mints(creator);

CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY,
    signature TEXT, mint TEXT, trader TEXT, side TEXT,
    sol REAL, tokens REAL, price_sol REAL,
    v_sol REAL, v_tokens REAL, mcap_sol REAL, pool TEXT, ts REAL
);
CREATE INDEX IF NOT EXISTS ix_trades_mint_ts ON trades(mint, ts);
CREATE INDEX IF NOT EXISTS ix_trades_ts ON trades(ts);

CREATE TABLE IF NOT EXISTS prefilter_results (
    id INTEGER PRIMARY KEY, mint TEXT, ts REAL, passed INTEGER, reason TEXT, metrics TEXT
);
CREATE INDEX IF NOT EXISTS ix_pf_mint ON prefilter_results(mint);

CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY, mint TEXT, ts REAL, metrics TEXT,
    status TEXT DEFAULT 'pending', decision TEXT, mean_confidence REAL, gate_reason TEXT,
    llm_cost_usd REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_cand_mint ON candidates(mint);

CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY, candidate_id INTEGER, mint TEXT, agent TEXT,
    vote TEXT, confidence REAL, reasons TEXT, evidence TEXT, size_usd REAL,
    cost_usd REAL, turns INTEGER, error TEXT, ts REAL,
    raw_vote TEXT, grounding REAL, tool_calls_ok INTEGER, guard TEXT
);
CREATE INDEX IF NOT EXISTS ix_votes_cand ON votes(candidate_id);

CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY,
    mint TEXT, candidate_id INTEGER, kind TEXT, mode TEXT, creator TEXT,
    status TEXT, decided_at REAL, opened_at REAL, closed_at REAL,
    size_usd REAL, sol_in REAL, cost_sol REAL,
    entry_price REAL, tokens_initial REAL, tokens_remaining REAL,
    peak_price REAL, last_price REAL, last_tick_at REAL, tp_done INTEGER DEFAULT 0,
    entry_liq_usd REAL, last_liq_usd REAL,
    proceeds_sol REAL DEFAULT 0, pnl_sol REAL, pnl_usd REAL,
    sol_usd_entry REAL, sol_usd_exit REAL, exit_reason TEXT,
    pending_exit TEXT, pending_exit_fraction REAL, pending_exit_at REAL
);
CREATE INDEX IF NOT EXISTS ix_pos_status ON positions(status, kind);

CREATE TABLE IF NOT EXISTS fills (
    id INTEGER PRIMARY KEY, position_id INTEGER, ts REAL, side TEXT, reason TEXT,
    price REAL, tokens REAL, sol REAL, fee_sol REAL, tx_sig TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY, kind TEXT, ts REAL, day TEXT, month TEXT, usd REAL, detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_ledger ON ledger(kind, day, month);

CREATE TABLE IF NOT EXISTS x_posts (
    post_id TEXT PRIMARY KEY, source TEXT, author TEXT, text TEXT, created_at TEXT,
    metrics TEXT, fetched_at REAL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS live_tx (
    id INTEGER PRIMARY KEY, ts REAL, position_id INTEGER, side TEXT, route TEXT,
    signature TEXT, sent INTEGER, ok INTEGER, detail TEXT
);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts REAL, kind TEXT, detail TEXT);
"""

# Columns added after the first release: (table, column, type). Applied with ALTER TABLE when
# an existing database lacks them, so upgrades keep their data.
MIGRATIONS = [
    ("votes", "raw_vote", "TEXT"),
    ("votes", "grounding", "REAL"),
    ("votes", "tool_calls_ok", "INTEGER"),
    ("votes", "guard", "TEXT"),
    ("positions", "pending_exit_fraction", "REAL"),
]

MINT_COLS = (
    "mint", "name", "symbol", "uri", "creator", "bonding_curve_key", "created_at",
    "first_trade_at", "last_trade_at", "trade_count", "buy_count", "sell_count",
    "unique_buyers", "buy_sol", "sell_sol", "net_inflow_sol", "creator_sold_sol",
    "v_sol", "v_tokens", "progress", "market_cap_sol", "last_price_sol", "pool",
    "graduated", "status", "status_reason", "updated_at",
)


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        self.conn: aiosqlite.Connection | None = None

    async def open(self) -> "Database":
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.executescript(SCHEMA)
        await self._migrate()
        await self.conn.commit()
        return self

    async def _migrate(self) -> None:
        for table, col, typ in MIGRATIONS:
            async with self.conn.execute(f"PRAGMA table_info({table})") as cur:
                have = {r[1] for r in await cur.fetchall()}
            if col not in have:
                await self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")

    async def close(self) -> None:
        if self.conn:
            await self.conn.commit()
            await self.conn.close()
            self.conn = None

    # --- generic -------------------------------------------------------------
    async def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        cur = await self.conn.execute(sql, tuple(params))
        await self.conn.commit()
        return cur.lastrowid

    async def executemany(self, sql: str, rows: list[tuple]) -> None:
        if rows:
            await self.conn.executemany(sql, rows)
            await self.conn.commit()

    async def fetchall(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        async with self.conn.execute(sql, tuple(params)) as cur:
            return [dict(r) for r in await cur.fetchall()]

    async def fetchone(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        async with self.conn.execute(sql, tuple(params)) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None

    async def insert(self, table: str, row: dict) -> int:
        cols = ",".join(row)
        qs = ",".join("?" * len(row))
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in row.values()]
        return await self.execute(f"INSERT INTO {table} ({cols}) VALUES ({qs})", vals)

    async def update(self, table: str, key: str, key_val: Any, row: dict) -> None:
        sets = ",".join(f"{c}=?" for c in row)
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in row.values()]
        await self.execute(f"UPDATE {table} SET {sets} WHERE {key}=?", [*vals, key_val])

    async def event(self, kind: str, detail: Any, ts: float) -> None:
        await self.insert("events", {"ts": ts, "kind": kind, "detail": json.dumps(detail, default=str)})

    async def kv_get(self, k: str) -> str | None:
        r = await self.fetchone("SELECT v FROM kv WHERE k=?", [k])
        return r["v"] if r else None

    async def kv_set(self, k: str, v: str) -> None:
        await self.execute("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [k, v])

    # --- mints/trades --------------------------------------------------------
    async def upsert_mints(self, rows: list[dict]) -> None:
        if not rows:
            return
        cols = ",".join(MINT_COLS)
        qs = ",".join("?" * len(MINT_COLS))
        upd = ",".join(f"{c}=excluded.{c}" for c in MINT_COLS if c != "mint")
        await self.executemany(
            f"INSERT INTO mints ({cols}) VALUES ({qs}) ON CONFLICT(mint) DO UPDATE SET {upd}",
            [tuple(r.get(c) for c in MINT_COLS) for r in rows],
        )

    async def insert_trades(self, rows: list[tuple]) -> None:
        await self.executemany(
            "INSERT INTO trades (signature,mint,trader,side,sol,tokens,price_sol,v_sol,v_tokens,mcap_sol,pool,ts)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )

    async def recent_trades(self, mint: str, limit: int = 50) -> list[dict]:
        return await self.fetchall(
            "SELECT ts,side,trader,sol,tokens,price_sol,pool FROM trades WHERE mint=? ORDER BY ts DESC LIMIT ?",
            [mint, limit],
        )

    async def all_trades(self, mint: str, limit: int = 50_000) -> list[dict]:
        """Oldest first, for feature computation."""
        return await self.fetchall(
            "SELECT ts,side,trader,sol,tokens,price_sol FROM trades WHERE mint=? ORDER BY ts LIMIT ?", [mint, limit])

    async def prune_trades(self, before_ts: float) -> None:
        await self.execute(
            "DELETE FROM trades WHERE ts < ? AND mint NOT IN (SELECT mint FROM candidates)", [before_ts]
        )
