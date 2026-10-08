"""Per-mint state from three inputs, and the tick stream that drives fills and exits.

* PumpPortal `create` and `migrate` events (free): every launch, and every graduation.
* Bonding-curve reads from the chain (`apply_curve`): net inflow, price, progress. A curve
  that moved since the last read means trades happened, so it emits a tick.
* Holder snapshots (`apply_holders`): wallets that bought, from the mint's token accounts.
* Optionally, PumpPortal's paid per-token trade stream (`_on_trade`). Mints streamed since
  launch (`streamed`) get exact buyer sets and full trade history.

Trades are written to `trades`. Aggregates live in memory (the hot path) and are flushed to
`mints` once a second. Buyer counts exclude the creator wallet.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from .config import Settings
from .db import Database
from .feeds.pumpchain import plausible_curve
from .util import now_s

log = logging.getLogger("bot.ingest")

# pump.fun bonding curve constants (UI units, 6 decimals already applied by PumpPortal)
INITIAL_VIRTUAL_TOKENS = 1_073_000_000.0
INITIAL_VIRTUAL_SOL = 30.0
SELLABLE_TOKENS = 793_100_000.0
SUPPLY = 1_000_000_000.0


def bonding_progress(v_tokens: float | None) -> float:
    if v_tokens is None:
        return 0.0
    return max(0.0, min(1.0, (INITIAL_VIRTUAL_TOKENS - float(v_tokens)) / SELLABLE_TOKENS))


def trade_price(msg: dict) -> float | None:
    """SOL per token, from the trade itself; falls back to curve reserves."""
    sol, tok = msg.get("solAmount"), msg.get("tokenAmount") or msg.get("initialBuy")
    try:
        if sol and tok and float(tok) > 0:
            return float(sol) / float(tok)
        vs, vt = msg.get("vSolInBondingCurve"), msg.get("vTokensInBondingCurve")
        if vs and vt and float(vt) > 0:
            return float(vs) / float(vt)
    except (TypeError, ValueError):
        pass
    return None


@dataclass
class MintState:
    mint: str
    name: str = ""
    symbol: str = ""
    uri: str = ""
    creator: str = ""
    bonding_curve_key: str = ""
    created_at: float = 0.0
    first_trade_at: float = 0.0
    last_trade_at: float = 0.0
    trade_count: int = 0
    buy_count: int = 0
    sell_count: int = 0
    buyers: set[str] = field(default_factory=set)
    buy_sol: float = 0.0
    sell_sol: float = 0.0
    creator_sold_sol: float = 0.0
    v_sol: float | None = None
    v_tokens: float | None = None
    progress: float = 0.0
    market_cap_sol: float | None = None
    last_price_sol: float | None = None
    pool: str = "pump"
    graduated: bool = False
    status: str = "tracking"
    status_reason: str = ""
    # on-chain reads
    real_sol: float | None = None       # curve real SOL reserves: the exact net inflow
    curve_at: float = 0.0               # last curve read
    next_poll_at: float = 0.0
    wallets_ex_dev: int | None = None   # wallets with a token account (bought), excluding the dev
    holders_now: int | None = None      # of those, still holding
    holders_at: float = 0.0
    streamed: bool = False              # every trade since launch came from the paid stream
    mayhem: bool = False                # pump.fun Mayhem Mode: an AI agent trades it for 24 h
    supply: float | None = None         # token_total_supply from the curve (Mayhem mints extra)
    snapshots: deque = field(default_factory=lambda: deque(maxlen=240), repr=False)  # (ts, price, real_sol)

    @property
    def net_inflow_sol(self) -> float:
        """The curve's real SOL reserve when it has been read; else the sum of streamed trades."""
        if self.real_sol is not None:
            return self.real_sol
        return self.buy_sol - self.sell_sol

    @property
    def unique_buyers(self) -> int:
        """Streamed buyers, or wallets seen on chain if more (a lower bound: closed accounts vanish)."""
        return max(len(self.buyers), self.wallets_ex_dev or 0)

    def age_min(self, now: float) -> float:
        return (now - self.first_trade_at) / 60 if self.first_trade_at else 0.0

    def row(self) -> dict:
        return {
            "mint": self.mint, "name": self.name, "symbol": self.symbol, "uri": self.uri,
            "creator": self.creator, "bonding_curve_key": self.bonding_curve_key,
            "created_at": self.created_at, "first_trade_at": self.first_trade_at,
            "last_trade_at": self.last_trade_at, "trade_count": self.trade_count,
            "buy_count": self.buy_count, "sell_count": self.sell_count,
            "unique_buyers": self.unique_buyers, "buy_sol": self.buy_sol, "sell_sol": self.sell_sol,
            "net_inflow_sol": self.net_inflow_sol, "creator_sold_sol": self.creator_sold_sol,
            "v_sol": self.v_sol, "v_tokens": self.v_tokens, "progress": self.progress,
            "market_cap_sol": self.market_cap_sol, "last_price_sol": self.last_price_sol,
            "pool": self.pool, "graduated": int(self.graduated), "status": self.status,
            "status_reason": self.status_reason, "updated_at": now_s(),
            "real_sol": self.real_sol, "curve_at": self.curve_at or None, "wallets_ex_dev": self.wallets_ex_dev,
            "holders_now": self.holders_now, "holders_at": self.holders_at or None, "mayhem": int(self.mayhem),
        }


TickHandler = Callable[[str, float, float, dict], Awaitable[None]]


class Ingestor:
    def __init__(self, settings: Settings, db: Database):
        self.s = settings
        self.db = db
        self.mints: dict[str, MintState] = {}
        self.pinned: set[str] = set()  # mints that must stay subscribed (candidates, positions)
        self._trade_buf: list[tuple] = []
        self._pending_trade_keys: set[tuple[str, str, str, str]] = set()
        self._dirty: set[str] = set()
        self._dirty_versions: dict[str, int] = {}
        self._event_lock = asyncio.Lock()
        self._flush_lock = asyncio.Lock()
        self.tick_handlers: list[TickHandler] = []
        self.subscribe: Callable[[list[str]], Awaitable[None]] | None = None
        self.unsubscribe: Callable[[list[str]], Awaitable[None]] | None = None
        self.stream_new_tokens = False  # subscribe every launch to the paid trade stream
        self.stats = {"creates": 0, "trades": 0, "stream_trades": 0, "curve_reads": 0, "curve_rejected": 0,
                      "migrations": 0, "other_launchpads": 0}

    # --- message handling -----------------------------------------------------
    async def handle(self, msg: dict, ts: float | None = None) -> None:
        tx = msg.get("txType")
        mint = msg.get("mint")
        if not tx or not mint:
            return
        ts = now_s() if ts is None else ts
        tick = None
        async with self._event_lock:
            try:
                if tx == "create":
                    await self._on_create(msg, ts)
                elif tx in ("buy", "sell"):
                    # Meter delivered messages, including duplicates: the provider may charge both.
                    self.stats["stream_trades"] += 1
                    tick = await self._on_trade(msg, ts)
                elif tx == "migrate":
                    self._on_migrate(msg)
            except BaseException:
                # Do not poison replay protection if normalization or state mutation failed
                # before the event reached the durable-write buffer.
                side = "buy" if tx == "create" else tx
                key = self._trade_key(msg.get("signature"), mint, msg.get("traderPublicKey") or "", side)
                if key is not None and not any(
                        self._trade_key(row[0], row[1], row[2], row[3]) == key for row in self._trade_buf):
                    self._pending_trade_keys.discard(key)
                raise
        # A handler may call ingest again. Dispatch after the event lock is released, rather
        # than deadlocking the callback on this same lock.
        if tick is not None:
            await self._tick(*tick)

    @staticmethod
    def _trade_key(signature, mint: str, trader: str, side: str) -> tuple[str, str, str, str] | None:
        # Missing signatures cannot establish event identity: two identical unsigned trades
        # may both be legitimate. A signature alone also identifies all traders in a bundle.
        if not isinstance(signature, str) or not signature.strip():
            return None
        return signature, mint, trader, side

    async def _claim_trade(self, signature, mint: str, trader: str, side: str) -> bool:
        """Reserve a signed event before aggregates/ticks; False means already processed."""
        key = self._trade_key(signature, mint, trader, side)
        if key is None:
            return True
        if key in self._pending_trade_keys:
            return False
        if await self.db.fetchone(
                "SELECT 1 FROM trades WHERE signature=? AND mint=? AND trader=? AND side=? LIMIT 1", key):
            return False
        self._pending_trade_keys.add(key)
        return True

    def _mark_dirty(self, mint: str) -> None:
        self._dirty.add(mint)
        self._dirty_versions[mint] = self._dirty_versions.get(mint, 0) + 1

    async def _on_create(self, msg: dict, ts: float) -> None:
        if (msg.get("pool") or "pump") != "pump" or not msg.get("bondingCurveKey"):
            # PumpPortal also announces other launchpads' tokens ("bonk"), and the live probe saw
            # creates without a curve key: neither is a pump.fun bonding-curve launch
            self.stats["other_launchpads"] += 1
            return
        mint = msg["mint"]
        trader = msg.get("traderPublicKey") or ""
        sol = float(msg.get("solAmount") or 0)
        tokens = float(msg.get("initialBuy") or 0)
        if not await self._claim_trade(msg.get("signature"), mint, trader, "buy"):
            return
        st = self.mints.get(mint) or MintState(mint=mint)
        st.name = (msg.get("name") or "")[:64]
        st.symbol = (msg.get("symbol") or "")[:32]
        st.uri = msg.get("uri") or ""
        st.creator = trader
        st.bonding_curve_key = msg.get("bondingCurveKey") or ""
        st.mayhem = bool(msg.get("is_mayhem_mode"))
        st.created_at = ts
        st.next_poll_at = ts + self.s.CURVE_FIRST_POLL_S
        self.mints[mint] = st
        self.stats["creates"] += 1
        # The create carries the dev's initial buy: it is the first bonding-curve trade.
        self._apply(st, "buy", st.creator, sol, tokens, msg, ts)
        await self._evict_if_full()
        if self.stream_new_tokens and self.subscribe:
            st.streamed = True
            await self.subscribe([mint])

    def _on_migrate(self, msg: dict) -> None:
        st = self.mints.get(msg["mint"])
        self.stats["migrations"] += 1
        if st:
            st.graduated, st.progress = True, 1.0
            st.pool = msg.get("pool") or "pump-amm"
            self._mark_dirty(st.mint)

    async def _on_trade(self, msg: dict, ts: float) -> tuple[str, float, float, dict] | None:
        mint = msg["mint"]
        trader = msg.get("traderPublicKey") or ""
        sol = float(msg.get("solAmount") or 0)
        tokens = float(msg.get("tokenAmount") or 0)
        side = msg["txType"]
        if not await self._claim_trade(msg.get("signature"), mint, trader, side):
            return
        st = self.mints.get(mint)
        if st is None:
            # Not a tracked mint: an account-trade event for a watched creator's other token,
            # or a late message after unsubscribe. Keep the raw trade; don't start tracking it.
            self._trade_buf.append((
                msg.get("signature"), mint, trader, side, sol, tokens, trade_price(msg),
                _f(msg.get("vSolInBondingCurve"), None), _f(msg.get("vTokensInBondingCurve"), None),
                _f(msg.get("marketCapSol"), None), msg.get("pool"), ts))
            return
        self._apply(st, side, trader, sol, tokens, msg, ts)
        if st.last_price_sol:
            return mint, st.last_price_sol, ts, msg

    async def _tick(self, mint: str, price: float, ts: float, msg: dict) -> None:
        for h in self.tick_handlers:
            try:
                await h(mint, price, ts, msg)
            except Exception:  # a broken handler must not stop ingestion
                log.exception("tick handler failed for %s", mint)

    # --- on-chain reads ---------------------------------------------------------
    async def apply_curve(self, mint: str, c, ts: float) -> bool:
        """Apply a bonding-curve read (`feeds.pumpchain.Curve`).

        Returns True if the curve moved since the previous read. A move means trades happened,
        so it emits a tick at the new price, which is what paper fills and exits act on.
        """
        st = self.mints.get(mint)
        if st is None:
            return False
        self.stats["curve_reads"] += 1
        first = not st.curve_at
        st.curve_at = ts
        if c.complete:
            # graduated: the curve is emptied into the AMM pool, so keep the inflow it reached
            st.graduated, st.progress = True, 1.0
            st.real_sol = max(st.real_sol or 0.0, c.real_sol, c.v_sol - INITIAL_VIRTUAL_SOL)
            self._mark_dirty(mint)
            return False
        if not plausible_curve(c):
            # a corrupt read must not become a tick, a snapshot or the token's market cap
            self.stats["curve_rejected"] += 1
            log.warning("%s: rejecting implausible curve read v_sol=%.4g v_tokens=%.4g real_sol=%.4g (last price %s)",
                        mint, c.v_sol, c.v_tokens, c.real_sol, f"{st.last_price_sol:.3e}" if st.last_price_sol else "none")
            return False
        moved = not first and (abs((st.v_sol or 0) - c.v_sol) > 1e-9 or abs((st.v_tokens or 0) - c.v_tokens) > 1e-6)
        st.real_sol = c.real_sol
        st.v_sol, st.v_tokens = c.v_sol, c.v_tokens
        st.supply = c.supply or st.supply
        st.progress = bonding_progress(c.v_tokens)
        price = c.price_sol
        if price:
            st.last_price_sol = price
            st.market_cap_sol = price * (st.supply or SUPPLY)
            st.snapshots.append((ts, price, c.real_sol))
        if moved:
            st.last_trade_at = ts
        self._mark_dirty(mint)
        if moved and price:
            await self._tick(mint, price, ts, {"txType": "curve", "pool": "pump", "vSolInBondingCurve": c.v_sol,
                                               "vTokensInBondingCurve": c.v_tokens})
        return moved

    def apply_holders(self, mint: str, snap: dict, ts: float) -> None:
        """Apply a holder snapshot (`feeds.pumpchain.holder_snapshot`)."""
        st = self.mints.get(mint)
        if st is None:
            return
        st.wallets_ex_dev = snap.get("wallets_ex_dev")
        st.holders_now = snap.get("holders_ex_dev")
        st.holders_at = ts
        self._mark_dirty(mint)

    def _apply(self, st: MintState, side: str, trader: str, sol: float, tokens: float, msg: dict, ts: float):
        if not st.first_trade_at:
            st.first_trade_at = ts
        st.last_trade_at = ts
        st.trade_count += 1
        self.stats["trades"] += 1
        if side == "buy":
            st.buy_count += 1
            st.buy_sol += sol
            if trader and trader != st.creator:
                st.buyers.add(trader)
        else:
            st.sell_count += 1
            st.sell_sol += sol
            if trader and trader == st.creator:
                st.creator_sold_sol += sol
        st.v_sol = _f(msg.get("vSolInBondingCurve"), st.v_sol)
        st.v_tokens = _f(msg.get("vTokensInBondingCurve"), st.v_tokens)
        st.market_cap_sol = _f(msg.get("marketCapSol"), st.market_cap_sol)
        pool = msg.get("pool") or st.pool
        st.pool = pool
        if pool and pool != "pump":
            st.graduated = True
            st.progress = 1.0
        else:
            st.progress = bonding_progress(st.v_tokens)
        price = trade_price(msg)
        if price:
            st.last_price_sol = price
        self._trade_buf.append((
            msg.get("signature"), st.mint, trader, side, sol, tokens, price,
            st.v_sol, st.v_tokens, st.market_cap_sol, pool, ts,
        ))
        self._mark_dirty(st.mint)

    # --- subscriptions ---------------------------------------------------------
    async def _evict_if_full(self) -> None:
        if len(self.mints) <= self.s.MAX_TRACKED_MINTS:
            return
        victims = sorted(
            (m for m in self.mints.values() if m.mint not in self.pinned),
            key=lambda m: m.last_trade_at,
        )[: len(self.mints) - self.s.MAX_TRACKED_MINTS]
        await self._drop([v.mint for v in victims], "evicted")

    async def _drop(self, mints: list[str], reason: str) -> None:
        if not mints:
            return
        for m in mints:
            st = self.mints.pop(m, None)
            if st and st.status == "tracking":
                st.status, st.status_reason = "dropped", reason
            if st:
                await self.db.upsert_mints([st.row()])
            self._dirty.discard(m)
            self._dirty_versions.pop(m, None)
        if self.unsubscribe:
            await self.unsubscribe(mints)

    async def housekeeping(self) -> None:
        now = now_s()
        old = [m.mint for m in self.mints.values()
               if m.mint not in self.pinned and m.age_min(now) > self.s.PF_MAX_AGE_MIN]
        await self._drop(old, "aged_out")
        # launches that never got going: stop reading their curves
        dead = [m.mint for m in self.mints.values()
                if m.mint not in self.pinned and m.status == "tracking" and m.real_sol is not None
                and m.age_min(now) >= self.s.CURVE_DROP_AFTER_MIN and m.real_sol < self.s.CURVE_DROP_BELOW_SOL]
        await self._drop(dead, "no traction")
        await self.db.prune_trades(now - self.s.TRADE_RETENTION_HOURS * 3600)

    async def flush(self) -> None:
        # The periodic flusher and candidate evaluator can call this concurrently. Keep
        # snapshots in memory until both table writes commit together; failed writes retry
        # the same batch, while events arriving during I/O stay queued for the next flush.
        async with self._flush_lock:
            async with self.db.transaction():
                buf = self._trade_buf[:]
                versions = {m: self._dirty_versions.get(m, 0) for m in self._dirty}
                rows = [self.mints[m].row() for m in versions if m in self.mints]
                await self.db.insert_trades(buf)
                await self.db.upsert_mints(rows)
            del self._trade_buf[:len(buf)]
            for row in buf:
                key = self._trade_key(row[0], row[1], row[2], row[3])
                if key is not None:
                    self._pending_trade_keys.discard(key)
            for mint, version in versions.items():
                if self._dirty_versions.get(mint, 0) == version:
                    self._dirty.discard(mint)

    async def run_flusher(self, stop: asyncio.Event) -> None:
        last_hk = now_s()
        while not stop.is_set():
            await asyncio.sleep(1.0)
            try:
                await self.flush()
                if now_s() - last_hk > 60:
                    await self.housekeeping()
                    last_hk = now_s()
            except Exception:
                log.exception("flush failed")
        await self.flush()

    async def restore(self) -> None:
        """Rebuild in-memory state for mints still inside the window after a restart."""
        cutoff = now_s() - self.s.PF_MAX_AGE_MIN * 60
        rows = await self.db.fetchall(
            "SELECT * FROM mints WHERE first_trade_at > ? OR mint IN "
            "(SELECT mint FROM positions WHERE status IN ('pending','open'))", [cutoff])
        for r in rows:
            st = MintState(mint=r["mint"])
            for k in ("name", "symbol", "uri", "creator", "bonding_curve_key", "created_at", "first_trade_at",
                      "last_trade_at", "trade_count", "buy_count", "sell_count", "buy_sol", "sell_sol",
                      "creator_sold_sol", "v_sol", "v_tokens", "progress", "market_cap_sol",
                      "last_price_sol", "pool", "status", "status_reason", "real_sol", "curve_at",
                      "wallets_ex_dev", "holders_now", "holders_at"):
                if r.get(k) is not None:
                    setattr(st, k, r[k])
            st.graduated = bool(r.get("graduated"))
            st.mayhem = bool(r.get("mayhem"))
            buyers = await self.db.fetchall(
                "SELECT DISTINCT trader FROM trades WHERE mint=? AND side='buy' AND trader!=?",
                [st.mint, st.creator or ""])
            st.buyers = {b["trader"] for b in buyers}
            self.mints[st.mint] = st
        if rows:
            log.info("restored %d mints from db", len(rows))


def _f(v, default):
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default
