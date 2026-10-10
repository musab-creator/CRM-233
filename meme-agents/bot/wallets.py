"""Wallet memory: what a new coin's launch-minute buyers and its creator did in the coins the bot
evaluated before it.

10 Oct research: choosing wallets by their record of early entries into coins that went on to run
(arXiv 2601.08641, WWW'26) earned about +14% per trade, and followers kept about +3% after frictions;
copying known influencer wallets loses money. The bot already records, for every coin it evaluates,
who bought in its launch minute (insiders.py) and what the coin did next: its highest confirmed price
over 14 days (moonshots.py) and its shadow's result. This module keeps a record per wallet and gives
each new candidate six numbers:

  wm_creator_launches   launches by the same creator the bot saw in the last LAUNCH_MEMORY_DAYS
  wm_creator_best_x     the best peak among the creator's earlier evaluated coins (x the bot's price)
  wm_launch_known       launch buyers seen in the launch minute of 2 or more earlier coins
  wm_launch_serial      launch buyers seen in 10 or more (sniper bots)
  wm_launch_smart       launch buyers with 3 or more earlier coins old enough to judge, at least half
                        of which reached 2x
  wm_launch_2x_rate     the share of the other known buyers' judged earlier coins that reached 2x

A coin can be judged MATURE_S after the bot evaluated it, and a peak counts only from when it
happened, so a candidate's numbers use only what was known when it was evaluated. One book computes
them live (Engine.evaluate) and replays the past for the report (walk_forward), so the report
measures what the bot would have seen.

Measured first: the numbers are stored with each candidate and checked in /report against what the
coins did; the agents do not see them until that check shows they separate winners from losers. The
check scores only days on which nearly every evaluated coin has its launch buyers on record, and a
fixed 24-hour outcome, so neither missing coins nor recent coins' unfinished runs can fake a signal.

Coins evaluated before launch buyers were recorded are read back from the chain, newest first (never
winners first: that would fill the check with them), only while Helius spending is well inside the
month's pace, three transaction reads at a time: one signature page per 1,000 curve transactions and
up to BACKFILL_MAX_TX transactions, 1 credit each. Those rows are marked as read back; the insider
watch keeps using only the sets recorded at evaluation.
"""
from __future__ import annotations

import asyncio
import heapq
import itertools
import logging
import math
from bisect import bisect_left
from collections import defaultdict

from .config import Settings
from .db import SPIKED_SHADOWS_SQL, Database
from .feeds.pumpchain import bonding_curve_key
from .insiders import insider_set
from .util import now_s

log = logging.getLogger("bot.wallets")

LAUNCH_ROLES = frozenset({"early", "sniper", "bundle"})
LAUNCH_SQL = "(instr(i.roles,'early')>0 OR instr(i.roles,'sniper')>0 OR instr(i.roles,'bundle')>0)"
MATURE_S = 6 * 3600.0         # a coin's outcome is judged this long after the bot evaluated it
KNOWN_N = 2                   # earlier launch coins for a buyer to count as known
SERIAL_N = 10                 # ... as a sniper bot
SMART_N, SMART_RATE = 3, 0.5  # judged earlier coins, and the share of them that reached HIT_X
HIT_X = 2.0
RATE_MIN = 5                  # judged coins behind wm_launch_2x_rate, else None
NEW_COINS_S = 60.0            # newly decided coins join the book this often
REFRESH_S = 600.0             # coins' peaks and results are re-read this often
BACKFILL_DAYS = 14.0          # coins evaluated this far back are read back from the chain
BACKFILL_PAGES = 100          # signature pages to reach a busy (often graduated) coin's launch
BACKFILL_CONCURRENCY = 3      # transaction reads in flight for one read-back
BACKFILL_ATTEMPTS = 3
BURN_IN_S = 86400.0           # the walk-forward scores coins this long after its covered data starts
HORIZON_S = 86400.0           # the walk-forward's outcome: the coin reached 2x within this long
COVERAGE_MIN = 0.9            # share of a day's evaluated coins with launch buyers for the day to count
FEATURES = ("wm_creator_launches", "wm_creator_best_x", "wm_launch_known", "wm_launch_serial",
            "wm_launch_smart", "wm_launch_2x_rate")


def launch_wallets(insiders: dict[str, dict] | None) -> list[str]:
    """The launch-minute buyers of an insider set: bundles, snipers and the first buyers."""
    return [w for w, e in (insiders or {}).items() if LAUNCH_ROLES & set(e.get("roles") or [])]


async def _first_cid(db: Database, since: float) -> int:
    """The first candidate id evaluated since `since`: ids grow with time, so insider rows from there on
    can be read along the table's primary key instead of scanning it."""
    row = await db.fetchone("SELECT MIN(id) i FROM candidates WHERE ts >= ?", [since])
    return int(row["i"]) if row and row["i"] is not None else 2 ** 62


async def coin_outcomes(db: Database, since: float) -> dict[str, dict]:
    """Every coin first evaluated since `since`: when, by whom it was created, its highest known price
    as a multiple of the bot's price (the tracker's confirmed peak or its shadows' own, spiked shadows
    left out) and when that peak happened, and its first shadow's result."""
    cands = await db.fetchall(
        "SELECT c.mint, MIN(c.ts) first_ts, MIN(c.id) cid, m.creator, ms.ref_price, ms.peak_price, ms.peak_at "
        "FROM candidates c LEFT JOIN mints m ON m.mint=c.mint LEFT JOIN moonshots ms ON ms.mint=c.mint "
        "WHERE c.decision IS NOT NULL AND c.mint IN (SELECT mint FROM candidates WHERE ts >= ?) "
        "GROUP BY c.mint HAVING MIN(c.ts) >= ?", [since, since])
    if not cands:
        return {}
    spiked = {r["position_id"] for r in await db.fetchall(SPIKED_SHADOWS_SQL)}
    shadows: dict[str, list[dict]] = defaultdict(list)
    for p in await db.fetchall("SELECT id, mint, entry_price, peak_price, status, pnl_sol, pnl_usd, cost_sol, "
                               "opened_at, closed_at, last_tick_at FROM positions WHERE kind='shadow' "
                               "AND decided_at >= ? ORDER BY decided_at, id", [since - 3600]):
        shadows[p["mint"]].append(p)
    out = {}
    for c in cands:
        own = shadows.get(c["mint"], [])
        first = own[0] if own else None
        ref = c["ref_price"] if (c["ref_price"] or 0) > 0 else \
            (first["entry_price"] if first and (first["entry_price"] or 0) > 0 else None)
        x = x_at = None
        if ref:
            peaks = [((p["peak_price"] or 0) / ref, p["closed_at"] or p["last_tick_at"] or p["opened_at"])
                     for p in own if p["id"] not in spiked and (p["peak_price"] or 0) > 0]
            if (c["peak_price"] or 0) > 0:
                peaks.append((c["peak_price"] / ref, c["peak_at"]))
            if peaks:
                x, x_at = max(peaks, key=lambda pk: pk[0])
        ret = pnl_usd = None
        if (first and first["status"] == "closed" and first["id"] not in spiked
                and isinstance(first["pnl_sol"], (int, float)) and math.isfinite(first["pnl_sol"])
                and (first["cost_sol"] or 0) > 0):
            ret, pnl_usd = first["pnl_sol"] / first["cost_sol"], first["pnl_usd"] or 0.0
        out[c["mint"]] = {"mint": c["mint"], "cid": c["cid"], "t": c["first_ts"], "creator": c["creator"],
                          "x": x, "x_at": x_at or c["first_ts"], "ret": ret, "pnl_usd": pnl_usd}
    return out


async def launch_rows(db: Database, since: float, page: int = 20_000) -> dict[str, list[str]]:
    """mint -> its launch-minute buyers (recorded at evaluation or read back), for coins evaluated since
    `since`. Read a page at a time along the primary key, each address kept once: two weeks hold some
    300,000 rows, the busiest bots in thousands of them."""
    out: dict[str, set[str]] = defaultdict(set)
    pool: dict[str, str] = {}
    cid, wallet = await _first_cid(db, since) - 1, ""
    while True:
        rows = await db.fetchall(
            "SELECT i.candidate_id, i.mint, i.wallet, i.roles FROM insiders i JOIN candidates c ON c.id=i.candidate_id "
            "WHERE (i.candidate_id, i.wallet) > (?, ?) AND c.ts >= ? ORDER BY i.candidate_id, i.wallet LIMIT ?",
            [cid, wallet, since, page])
        for r in rows:
            if LAUNCH_ROLES & set((r["roles"] or "").split(",")):
                out[r["mint"]].add(pool.setdefault(r["wallet"], r["wallet"]))
        if len(rows) < page:
            break
        cid, wallet = rows[-1]["candidate_id"], rows[-1]["wallet"]
    return {m: sorted(ws) for m, ws in out.items()}


def covered_since(outcomes: dict[str, dict], launches: dict[str, list[str]], now: float) -> float | None:
    """The start of the run of UTC days, back from today, on which at least COVERAGE_MIN of the evaluated
    coins have launch buyers on record (days without coins are skipped); None if today falls short."""
    days: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    for o in outcomes.values():
        d = days[int(o["t"] // 86400)]
        d[0] += 1
        d[1] += o["mint"] in launches
    start = None
    for day in sorted(days, reverse=True):
        if day > int(now // 86400):
            continue
        n, covered = days[day]
        if covered < COVERAGE_MIN * n:
            break
        start = day * 86400.0
    return start


class WalletBook:
    """Launch buyers' and creators' records, replayed in time order: a coin counts as seen from its
    evaluation, as judged MATURE_S later, as a 2x hit from when its peak happened (if later), and drops
    out after the window."""

    def __init__(self, days: float):
        self.window = days * 86400.0
        self.coins: dict[str, dict] = {}
        self.stats: dict[str, list[int]] = {}               # wallet -> [seen, judged, reached 2x]
        self.by_creator: dict[str, set[str]] = defaultdict(set)
        self._pool: dict[str, str] = {}                     # one copy of each address
        self._events: list[tuple] = []
        self._seq = itertools.count()
        self._gen = itertools.count()                       # a coin added again never takes an old event
        self.now = 0.0

    def _push(self, when: float, kind: str, mint: str, gen: int) -> None:
        heapq.heappush(self._events, (when, next(self._seq), kind, mint, gen))

    def add(self, mint: str, t: float, wallets, creator: str | None, x: float | None = None,
            x_at: float | None = None) -> None:
        if mint in self.coins or (self.window and t < self.now - self.window):
            return
        c = {"t": t, "wallets": tuple(sorted({self._pool.setdefault(w, w) for w in wallets})), "creator": creator,
             "x": None, "x_at": None, "judged": False, "hit": False, "gen": next(self._gen)}
        self.coins[mint] = c
        for w in c["wallets"]:
            self.stats.setdefault(w, [0, 0, 0])[0] += 1
        if creator:
            self.by_creator[creator].add(mint)
        self._push(t + MATURE_S, "judge", mint, c["gen"])
        if self.window:
            self._push(t + self.window, "expire", mint, c["gen"])
        self.outcome(mint, x, x_at)

    def outcome(self, mint: str, x: float | None, x_at: float | None) -> None:
        """A coin's highest known price so far (x the bot's price) and when it happened."""
        c = self.coins.get(mint)
        if c is None or x is None or (c["x"] is not None and x <= c["x"]):
            return
        c["x"], c["x_at"] = x, x_at if x_at is not None else c["t"]
        if not c["hit"] and x >= HIT_X:
            self._push(max(c["t"] + MATURE_S, c["x_at"]), "hit", mint, c["gen"])

    def advance(self, now: float) -> None:
        while self._events and self._events[0][0] <= now:
            when, _, kind, mint, gen = heapq.heappop(self._events)
            c = self.coins.get(mint)
            if c is None or c["gen"] != gen:
                continue
            if kind == "judge" and not c["judged"]:
                c["judged"] = True
                for w in c["wallets"]:
                    self.stats[w][1] += 1
                self._maybe_hit(c, when)
            elif kind == "hit":
                self._maybe_hit(c, when)
            elif kind == "expire":
                self._drop(mint, c)
        self.now = max(self.now, now)

    def _maybe_hit(self, c: dict, when: float) -> None:
        if c["judged"] and not c["hit"] and c["x"] is not None and c["x"] >= HIT_X and c["x_at"] <= when:
            c["hit"] = True
            for w in c["wallets"]:
                self.stats[w][2] += 1

    def _drop(self, mint: str, c: dict) -> None:
        for w in c["wallets"]:
            st = self.stats[w]
            st[0] -= 1
            st[1] -= c["judged"]
            st[2] -= c["hit"]
            if st[0] <= 0:
                del self.stats[w]
                self._pool.pop(w, None)
        if c["creator"]:
            self.by_creator[c["creator"]].discard(mint)
            if not self.by_creator[c["creator"]]:
                del self.by_creator[c["creator"]]
        del self.coins[mint]

    def features(self, wallets, creator: str | None, creator_launches: int | None, now: float,
                 exclude: str | None = None) -> dict:
        """The six numbers for a coin with these launch buyers and creator, from what was known at `now`;
        `exclude`: the coin itself when it is already in the book (a second evaluation)."""
        self.advance(now)
        own = self.coins.get(exclude) if exclude else None
        mine = set(own["wallets"]) if own else set()
        known = serial = smart = judged = hits = 0
        for w in set(wallets):
            st = self.stats.get(w)
            if not st:
                continue
            n, j, h = st
            if w in mine:
                n, j, h = n - 1, j - own["judged"], h - own["hit"]
            known += n >= KNOWN_N
            serial += n >= SERIAL_N
            if j >= SMART_N and h >= SMART_RATE * j:
                smart += 1
            if KNOWN_N <= n < SERIAL_N:              # the bots' thousands of coins would drown the rest
                judged += j
                hits += h
        best = max((c["x"] for m in self.by_creator.get(creator or "", ()) if m != exclude
                    and (c := self.coins[m])["t"] < now and c["x"] is not None and c["x_at"] <= now), default=None)
        return {"wm_creator_launches": creator_launches,
                "wm_creator_best_x": round(best, 2) if best is not None else None,
                "wm_launch_known": known, "wm_launch_serial": serial, "wm_launch_smart": smart,
                "wm_launch_2x_rate": round(hits / judged, 3) if judged >= RATE_MIN else None}

    def summary(self) -> dict:
        return {"coins": len(self.coins), "wallets": len(self.stats),
                "known": sum(1 for st in self.stats.values() if st[0] >= KNOWN_N),
                "serial": sum(1 for st in self.stats.values() if st[0] >= SERIAL_N),
                "smart": sum(1 for st in self.stats.values() if st[1] >= SMART_N and st[2] >= SMART_RATE * st[1])}


async def _creator_launches(db: Database, creator: str | None, mint: str, now: float, window: float) -> int | None:
    if not creator:
        return None
    row = await db.fetchone("SELECT COUNT(*) n FROM mints WHERE creator=? AND mint<>? "
                            "AND COALESCE(created_at, first_trade_at) >= ? AND COALESCE(created_at, first_trade_at) < ?",
                            [creator, mint, now - window, now])
    return int(row["n"]) if row else 0


class WalletMemory:
    """The live book: loaded from the database at start, fed newly decided coins every minute and their
    peaks every 10 minutes, and asked for each candidate's numbers at evaluation. It also reads back
    the launch buyers of coins evaluated before they were recorded."""

    def __init__(self, s: Settings, db: Database, chain=None, exclude=frozenset(), budget_ok=None):
        self.s, self.db, self.chain = s, db, chain
        self.exclude = frozenset(w for w in exclude if w)   # the bot's own wallet
        self.budget_ok = budget_ok or (lambda: True)        # Helius spending well inside the month's pace
        self.book = WalletBook(s.LAUNCH_MEMORY_DAYS)
        self.loaded = False
        self.stats = {"read_back": 0, "no_launch_data": 0, "errors": 0}
        self._queue: list[dict] = []                         # past coins to read back, the newest last
        self._checked: dict[int, float] = {}                 # decided candidates add_new has looked at

    @property
    def window(self) -> float:
        return self.s.LAUNCH_MEMORY_DAYS * 86400.0

    async def load(self) -> None:
        now = now_s()
        since = now - self.window
        outcomes = await coin_outcomes(self.db, since)
        launches = await launch_rows(self.db, since)
        for i, o in enumerate(sorted(outcomes.values(), key=lambda o: o["t"])):
            if o["mint"] in launches:
                self.book.add(o["mint"], o["t"], launches[o["mint"]], o["creator"], o["x"], o["x_at"])
            if i % 500 == 499:
                await asyncio.sleep(0)                       # a long replay never holds up the trading loops
        self.book.advance(now)
        self.loaded = True
        log.info("wallet memory: %d coins, %d wallets (%d in 2+ launches, %d sniper bots, %d smart)",
                 *self.book.summary().values())

    async def add_new(self) -> int:
        """Coins decided since the last pass, each candidate looked at once."""
        now = now_s()
        rows = await self.db.fetchall(
            "SELECT c.id, c.mint, c.ts, m.creator FROM candidates c LEFT JOIN mints m ON m.mint=c.mint "
            "WHERE c.decision IS NOT NULL AND c.ts >= ? ORDER BY c.ts", [now - 6 * 3600])
        fresh = [r for r in rows if r["id"] not in self._checked]
        for cid in [cid for cid, t in self._checked.items() if t < now - 7 * 3600]:
            del self._checked[cid]
        if not fresh:
            return 0
        wallets: dict[int, set[str]] = defaultdict(set)
        for i in await self.db.fetchall(
                f"SELECT i.candidate_id, i.wallet FROM insiders i WHERE i.candidate_id IN "
                f"({','.join('?' * len(fresh))}) AND {LAUNCH_SQL}", [r["id"] for r in fresh]):
            wallets[i["candidate_id"]].add(i["wallet"])
        n = 0
        for r in fresh:
            self._checked[r["id"]] = r["ts"]
            if wallets.get(r["id"]) and r["mint"] not in self.book.coins:
                self.book.add(r["mint"], r["ts"], wallets[r["id"]], r["creator"])
                n += 1
        self.book.advance(now)
        return n

    async def refresh(self) -> None:
        """Peaks move for days: hand the book each coin's latest, and line up the past coins that still
        have no launch buyers on record, newest first."""
        now = now_s()
        since = now - max(self.window, BACKFILL_DAYS * 86400)
        outcomes = await coin_outcomes(self.db, since)
        for o in outcomes.values():
            self.book.outcome(o["mint"], o["x"], o["x_at"])
        self.book.advance(now)
        have = {r["mint"] for r in await self.db.fetchall(
            f"SELECT DISTINCT i.mint FROM insiders i WHERE i.candidate_id >= ? AND {LAUNCH_SQL}",
            [await _first_cid(self.db, since)])}
        done = {r["mint"] for r in await self.db.fetchall(
            "SELECT mint FROM wallet_backfill WHERE status IN ('ok','empty') OR attempts >= ?", [BACKFILL_ATTEMPTS])}
        todo = [o for m, o in outcomes.items() if m not in have and m not in done
                and o["t"] >= now - BACKFILL_DAYS * 86400]
        # In time order only: winners first would fill the report's check with winners' buyers.
        self._queue = sorted(todo, key=lambda o: o["t"])

    async def features(self, mint: str, insiders: dict[str, dict] | None, creator: str | None) -> dict | None:
        """A candidate's six numbers, or None while the book is loading or the coin has no launch buyers
        on record (its launch minute could not be read), so a gap never reads as zeros."""
        wallets = launch_wallets(insiders)
        if not self.loaded or not wallets:
            return None
        now = now_s()
        launches = await _creator_launches(self.db, creator, mint, now, self.window)
        return self.book.features(wallets, creator, launches, now, exclude=mint)

    async def read_back_once(self) -> str | None:
        """One past coin's launch buyers from the chain, filed as read back and added to the book."""
        if not self._queue:
            return None
        o = self._queue.pop()
        mint = o["mint"]
        m = await self.db.fetchone("SELECT creator, bonding_curve_key FROM mints WHERE mint=?", [mint]) or {}
        curve = m.get("bonding_curve_key") or bonding_curve_key(mint)
        status, detail = "error", None
        try:
            if not curve:
                raise ValueError("no bonding-curve key")
            early = await self.chain.early_trades(mint, curve, self.s.BACKFILL_WINDOW_S, self.s.BACKFILL_MAX_TX,
                                                  max_pages=BACKFILL_PAGES, concurrency=BACKFILL_CONCURRENCY)
            ins = insider_set(early.get("trades") or [], None, m.get("creator") or o["creator"], curve,
                              exclude=self.exclude)
            wallets = launch_wallets(ins)
            if not early.get("reached_launch") or not wallets:
                status, detail = "empty", "launch not reached" if not early.get("reached_launch") else "no buyers"
                self.stats["no_launch_data"] += 1
            else:
                await self.db.save_insiders(o["cid"], mint, ins, source="read_back")
                self.book.add(mint, o["t"], wallets, m.get("creator") or o["creator"], o["x"], o["x_at"])
                status = "ok"
                self.stats["read_back"] += 1
        except asyncio.CancelledError:
            raise
        except Exception as e:
            detail = f"{type(e).__name__}: {e}"[:200]
            self.stats["errors"] += 1
            log.warning("wallet memory: reading back %s failed: %s", mint, detail)
        await self.db.execute(
            "INSERT INTO wallet_backfill (mint, status, attempts, at, detail) VALUES (?,?,1,?,?) "
            "ON CONFLICT(mint) DO UPDATE SET status=excluded.status, attempts=wallet_backfill.attempts+1, "
            "at=excluded.at, detail=excluded.detail", [mint, status, now_s(), detail])
        return status

    async def run(self, stop: asyncio.Event) -> None:
        if self.s.LAUNCH_MEMORY_DAYS <= 0:
            await stop.wait()
            return
        next_new = next_refresh = next_back = next_load = 0.0
        while not stop.is_set():
            now = now_s()
            reading = False
            if not self.loaded:
                if now >= next_load:
                    next_load = now + 60.0
                    try:
                        await self.load()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        log.exception("wallet memory could not load; retrying in a minute")
                if not self.loaded:
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        pass
                    continue
            try:
                if now >= next_new:
                    next_new = now + NEW_COINS_S
                    await self.add_new()
                if now >= next_refresh:
                    next_refresh = now + REFRESH_S
                    await self.refresh()
                per_min = self.s.LAUNCH_BACKFILL_PER_MIN
                reading = bool(per_min > 0 and self._queue and self.chain is not None
                               and getattr(self.chain, "enabled", False) and self.budget_ok())
                if reading and now >= next_back:
                    next_back = now + 60.0 / per_min
                    await self.read_back_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                reading = False
                log.exception("wallet memory error")
            wait = min(next_new, next_refresh, next_back if reading else math.inf) - now_s()
            try:
                await asyncio.wait_for(stop.wait(), timeout=min(5.0, max(0.2, wait)))
            except asyncio.TimeoutError:
                pass

    def note(self) -> str:
        """For the heartbeat."""
        if not self.loaded:
            return " | wallet memory: loading"
        b = self.book.summary()
        return (f" | wallet memory: {b['coins']} coins, {b['known']} known wallets, {b['smart']} smart, "
                f"{self.stats['read_back']} read back, {len(self._queue)} to read back")


# --- report -----------------------------------------------------------------------------------

async def walk_forward(db: Database, s: Settings, now: float | None = None) -> dict:
    """Replays the covered days (covered_since) through a book as the live one would have run, and scores
    each coin evaluated at least a day after they start and a day before now with the six numbers it
    would have had and what it did: its shadow's result and whether it reached 2x within HORIZON_S."""
    now = now or now_s()
    since = now - BACKFILL_DAYS * 86400
    outcomes = await coin_outcomes(db, since)
    launches = await launch_rows(db, since)
    start = covered_since(outcomes, launches, now)
    out = {"covered_from": start, "rows": [], "coins": len(outcomes),
           "with_launch": sum(1 for m in outcomes if m in launches)}
    if start is None:
        return out
    coins = sorted((o for o in outcomes.values() if o["t"] >= start and o["mint"] in launches), key=lambda o: o["t"])
    window = s.LAUNCH_MEMORY_DAYS * 86400.0
    creator_times: dict[str, list[float]] = defaultdict(list)
    created: dict[str, float] = {}
    for r in await db.fetchall(
            "SELECT mint, creator, COALESCE(created_at, first_trade_at) t FROM mints WHERE creator IN "
            "(SELECT m2.creator FROM mints m2 JOIN candidates c ON c.mint=m2.mint WHERE c.ts >= ?) "
            "AND COALESCE(created_at, first_trade_at) >= ?", [start, start - window]):
        if r["creator"] and r["t"] is not None:
            creator_times[r["creator"]].append(r["t"])
            created[r["mint"]] = r["t"]
    for ts in creator_times.values():
        ts.sort()
    book = WalletBook(s.LAUNCH_MEMORY_DAYS)
    for i, o in enumerate(coins):
        if start + BURN_IN_S <= o["t"] <= now - HORIZON_S and o["ret"] is not None:
            launches_n = None
            if o["creator"]:                          # as _creator_launches counts them: the coin itself left out
                ts = creator_times.get(o["creator"], [])
                own = created.get(o["mint"])
                launches_n = (bisect_left(ts, o["t"]) - bisect_left(ts, o["t"] - window)
                              - (own is not None and o["t"] - window <= own < o["t"]))
            out["rows"].append({"flow": book.features(launches[o["mint"]], o["creator"], launches_n, o["t"]),
                                "ret": o["ret"], "win": o["ret"] > 0, "pnl_usd": o["pnl_usd"] or 0.0,
                                "x2": (o["x"] or 0) >= HIT_X and o["x_at"] - o["t"] <= HORIZON_S})
        book.add(o["mint"], o["t"], launches[o["mint"]], o["creator"], o["x"], o["x_at"])
        if i % 500 == 499:
            await asyncio.sleep(0)
    return out


def _bucket(rows: list[dict]) -> dict:
    n = len(rows)
    return {"n": n, "win_rate": sum(r["win"] for r in rows) / n if n else None,
            "avg_return": sum(r["ret"] for r in rows) / n if n else None,
            "x2_rate": sum(r["x2"] for r in rows) / n if n else None}


def feature_check(rows: list[dict]) -> list[dict]:
    """Each feature: coins above vs at or below its median (at vs below when the median is the top)."""
    out = []
    for name in FEATURES:
        vals = [(r["flow"].get(name), r) for r in rows if isinstance(r["flow"].get(name), (int, float))
                and math.isfinite(r["flow"][name])]
        if len(vals) < 20:
            continue
        xs = sorted(v for v, _ in vals)
        med = xs[len(xs) // 2]
        hi, lo, split = [r for v, r in vals if v > med], [r for v, r in vals if v <= med], "above"
        if not hi:
            hi, lo, split = [r for v, r in vals if v >= med], [r for v, r in vals if v < med], "at"
        if not lo:
            continue
        out.append({"feature": name, "median": med, "split": split, "hi": _bucket(hi), "lo": _bucket(lo)})
    return out


async def wallet_summary(db: Database, s: Settings) -> dict | None:
    if s.LAUNCH_MEMORY_DAYS <= 0:
        return None
    now = now_s()
    wf = await walk_forward(db, s, now)
    since = now - BACKFILL_DAYS * 86400
    back = {r["status"]: r["n"] for r in await db.fetchall(
        "SELECT b.status, COUNT(*) n FROM wallet_backfill b WHERE b.mint IN "
        "(SELECT mint FROM candidates WHERE ts >= ?) AND b.mint NOT IN "
        f"(SELECT i.mint FROM insiders i WHERE i.candidate_id >= ? AND {LAUNCH_SQL} AND i.source IS NULL) "
        "GROUP BY b.status", [since, await _first_cid(db, since)])}
    return {"evaluated": wf["coins"], "with_launch": wf["with_launch"], "covered_from": wf["covered_from"],
            "read_back": back.get("ok", 0), "no_launch_data": back.get("empty", 0), "failed": back.get("error", 0),
            "scored": len(wf["rows"]), "checks": feature_check(wf["rows"]), "days": s.LAUNCH_MEMORY_DAYS}


def wallet_lines(m: dict | None) -> list[str]:
    if not m:
        return []
    from datetime import datetime, timezone
    lines = ["", "== Wallet memory (launch buyers' and creators' records; the agents do not see these yet) ==",
             f"coins with launch buyers: {m['with_launch']} of {m['evaluated']} evaluated in "
             f"{BACKFILL_DAYS:g} days (read back from the chain: {m['read_back']}, no launch data "
             f"{m['no_launch_data']}, failed {m['failed']})"]
    if m["covered_from"] is None:
        lines.append(f"walk-forward: waits for days on which {COVERAGE_MIN:.0%} of the evaluated coins have "
                     f"launch buyers on record")
        return lines
    since = datetime.fromtimestamp(m["covered_from"], timezone.utc).strftime("%m-%d")
    if not m["checks"]:
        lines.append(f"walk-forward from {since}: {m['scored']} coins scored so far; it needs 20 per feature")
        return lines
    lines.append(f"walk-forward over {m['scored']} coins from {since} (fully recorded days), each scored on what "
                 f"the bot knew when it evaluated it ({m['days']:g}-day memory):")
    lines.append("feature                median   above/at: n  win  avg ret  2x  | below: n  win  avg ret  2x")
    for c in m["checks"]:
        def cell(b):
            return (f"{b['n']:>5d} {b['win_rate']:>4.0%} {b['avg_return']:>+8.1%} {b['x2_rate']:>4.0%}"
                    if b["n"] else f"{0:>5d}")
        lines.append(f"{c['feature']:22s} {c['median']:<8.3g} {'at' if c['split'] == 'at' else 'ab'} {cell(c['hi'])}"
                     f"  | {cell(c['lo'])}")
    lines.append(f"(win, avg ret: the coin's shadow under the bot's exits; 2x: the coin reached twice the bot's "
                 f"price within {HORIZON_S / 3600:g} hours)")
    return lines
