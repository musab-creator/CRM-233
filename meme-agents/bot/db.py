"""SQLite storage (aiosqlite, WAL). One connection, writes serialized by aiosqlite's thread."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
from typing import Any, Iterable

import aiosqlite

# Shadow positions with a sell booked at more than SPIKE_FACTOR times their final mark were priced
# by a bad tick, not a run: a real runner's take-profit sits within a trailing stop of its last
# mark. Every shadow statistic (report, regime snapshot) leaves them out.
SPIKE_FACTOR = 20.0
SPIKED_SHADOWS_SQL = ("SELECT f.position_id FROM fills f JOIN positions q ON q.id=f.position_id "
                      "WHERE q.kind='shadow' AND f.side='sell' AND q.last_price>0 AND f.price>q.last_price*%g"
                      % SPIKE_FACTOR)

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
    updated_at REAL,
    real_sol REAL, curve_at REAL, wallets_ex_dev INTEGER, holders_now INTEGER, holders_at REAL,
    mayhem INTEGER DEFAULT 0
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
CREATE INDEX IF NOT EXISTS ix_trades_identity ON trades(signature,mint,trader,side);

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
    pending_exit TEXT, pending_exit_fraction REAL, pending_exit_at REAL,
    exit_attempts INTEGER DEFAULT 0, next_exit_at REAL,
    runner_fraction REAL DEFAULT 0, runner_target_multiple REAL, runner_max_hold_hours REAL,
    runner_active INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_pos_status ON positions(status, kind);
CREATE INDEX IF NOT EXISTS ix_pos_candidate ON positions(candidate_id,kind,status);

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
CREATE TABLE IF NOT EXISTS x_post_sources (
    source TEXT, post_id TEXT, PRIMARY KEY (source, post_id)
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
    ("positions", "exit_attempts", "INTEGER DEFAULT 0"),
    ("positions", "next_exit_at", "REAL"),
    ("positions", "runner_fraction", "REAL DEFAULT 0"),
    ("positions", "runner_target_multiple", "REAL"),
    ("positions", "runner_max_hold_hours", "REAL"),
    ("positions", "runner_active", "INTEGER DEFAULT 0"),
    ("mints", "real_sol", "REAL"),
    ("mints", "curve_at", "REAL"),
    ("mints", "wallets_ex_dev", "INTEGER"),
    ("mints", "holders_now", "INTEGER"),
    ("mints", "holders_at", "REAL"),
    ("mints", "mayhem", "INTEGER DEFAULT 0"),
]

MINT_COLS = (
    "mint", "name", "symbol", "uri", "creator", "bonding_curve_key", "created_at",
    "first_trade_at", "last_trade_at", "trade_count", "buy_count", "sell_count",
    "unique_buyers", "buy_sol", "sell_sol", "net_inflow_sol", "creator_sold_sol",
    "v_sol", "v_tokens", "progress", "market_cap_sol", "last_price_sol", "pool",
    "graduated", "status", "status_reason", "updated_at",
    "real_sol", "curve_at", "wallets_ex_dev", "holders_now", "holders_at", "mayhem",
)


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        self.conn: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()
        self._transaction_owner: asyncio.Task | None = None
        self._savepoint_counter = 0

    @asynccontextmanager
    async def _access(self):
        if self._transaction_owner is asyncio.current_task():
            yield
        else:
            async with self._lock:
                yield

    async def _finish_boundary(self, operation, cancelled: list[int]):
        """Finish queued SQLite work before releasing its lock, even during cancellation.

        aiosqlite cancellation only cancels the awaiting Future; its worker may still
        execute BEGIN/COMMIT/ROLLBACK. Shield the work and remember cancellation so the
        transaction can report the actual outcome instead of guessing from the Future.
        """
        boundary = asyncio.ensure_future(operation)
        parent = asyncio.current_task()
        while True:
            try:
                return await asyncio.shield(boundary)
            except asyncio.CancelledError:
                if boundary.cancelled():
                    raise
                cancelled[0] += 1
                parent.uncancel()

    def _defer_cancellation(self, cancelled: list[int]) -> None:
        if cancelled[0]:
            # The commit is already durable. Let this await chain return so callers can
            # update their memory synchronously, then deliver cancellation at the next
            # event-loop turn/await. Raising here would falsely make callers roll back
            # memory after a committed position or fill.
            asyncio.get_running_loop().call_soon(asyncio.current_task().cancel)

    @asynccontextmanager
    async def transaction(self):
        """Commit a group atomically; unrelated tasks cannot commit its partial writes."""
        if self.conn is None:
            raise RuntimeError("Database is not open")
        task = asyncio.current_task()
        if self._transaction_owner is task:
            self._savepoint_counter += 1
            name = f"bot_savepoint_{self._savepoint_counter}"
            cancelled = [0]
            await self._finish_boundary(self.conn.execute(f"SAVEPOINT {name}"), cancelled)
            try:
                if cancelled[0]:
                    raise asyncio.CancelledError
                yield self
            except BaseException:
                await self._finish_boundary(self.conn.execute(f"ROLLBACK TO SAVEPOINT {name}"), cancelled)
                await self._finish_boundary(self.conn.execute(f"RELEASE SAVEPOINT {name}"), cancelled)
                if cancelled[0]:
                    raise asyncio.CancelledError
                raise
            else:
                await self._finish_boundary(self.conn.execute(f"RELEASE SAVEPOINT {name}"), cancelled)
                self._defer_cancellation(cancelled)
            return
        async with self._lock:
            self._transaction_owner = task
            cancelled = [0]
            try:
                await self._finish_boundary(self.conn.execute("BEGIN IMMEDIATE"), cancelled)
                try:
                    if cancelled[0]:
                        raise asyncio.CancelledError
                    yield self
                except BaseException:
                    await self._finish_boundary(self.conn.rollback(), cancelled)
                    if cancelled[0]:
                        raise asyncio.CancelledError
                    raise
                else:
                    try:
                        await self._finish_boundary(self.conn.commit(), cancelled)
                    except BaseException:
                        await self._finish_boundary(self.conn.rollback(), cancelled)
                        if cancelled[0]:
                            raise asyncio.CancelledError
                        raise
                    self._defer_cancellation(cancelled)
            finally:
                self._transaction_owner = None

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
        if self._transaction_owner is asyncio.current_task():
            raise RuntimeError("Cannot close database inside a transaction")
        async with self._access():
            if self.conn:
                await self.conn.close()
                self.conn = None

    # --- generic -------------------------------------------------------------
    async def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        if self._transaction_owner is not asyncio.current_task():
            async with self.transaction():
                rowid = await self.execute(sql, params)
            return rowid
        async with self.conn.execute(sql, tuple(params)) as cur:
            return cur.lastrowid

    async def executemany(self, sql: str, rows: list[tuple]) -> None:
        if rows:
            if self._transaction_owner is not asyncio.current_task():
                async with self.transaction():
                    await self.executemany(sql, rows)
                return
            async with self.conn.executemany(sql, rows):
                pass

    async def fetchall(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        async with self._access():
            async with self.conn.execute(sql, tuple(params)) as cur:
                return [dict(r) for r in await cur.fetchall()]

    async def fetchone(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        async with self._access():
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
            " SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ? IS NULL OR ?='' OR NOT EXISTS "
            "(SELECT 1 FROM trades WHERE signature=? AND mint=? AND trader=? AND side=?)",
            [(*r, r[0], r[0], r[0], r[1], r[2], r[3]) for r in rows],
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
            "DELETE FROM trades WHERE ts < ? "
            "AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.mint=trades.mint AND c.status='pending') "
            "AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.mint=trades.mint AND p.status IN ('pending','open'))",
            [before_ts]
        )
