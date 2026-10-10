"""Insider sales on held coins: sell when the insiders sell, not after the liquidity is gone.

10 Oct research: deployer-linked snipers are out within 5 minutes in 85% of launches, and wallets
run by one actor hold about a third of a graduating coin's supply. 12 of the bot's first 15 live
trades ended on the stop loss or the "liquidity fell 50%" rule, mostly 1-10 minutes after the buy,
when the price was already 23-49% down: that drop is the insiders selling.

Who counts as an insider of a coin is fixed when the bot evaluates it (Engine.compute_flow):
the creator, the first 20 launch-minute buyers, the three that spent the most in that minute
(snipers), the wallets that bought in the launch transaction's own slot (bundles) and the ten
largest holders at that moment. `insider_set` builds it and the `insiders` table keeps it.

While the bot holds a coin on its bonding curve (a real position or its shadow), InsiderWatch
streams every transaction touching the curve from Helius (transactionSubscribe). It rebuilds the
trades from balance deltas with trades_from_tx, as the launch-minute backfill does, so pump.fun's
event layout does not matter. Each insider sale after the entry is recorded with the share of the
supply the insiders have sold since then and the curve's price right after the sale.

What counts is the insiders' net selling since the entry, wallet by wallet: each insider's sales minus
its buys, never below zero, so a volume bot that sells and buys back adds nothing. One transaction is
counted once, however often Helius delivers it. After a gap (a reconnect, a refused subscription, a
restart) the curves of real positions are read back, and a previous run's rows are not counted twice.

INSIDER_EXIT=false (the default) only records, and /report shows what selling at the warning would
have returned against what each position did. With INSIDER_EXIT=true, once the insiders' net sales
since entry reach INSIDER_EXIT_SUPPLY_PCT of the supply the position is sold as an emergency
(emergency_insider_sell), also when that happened before a restart. A runner, whose cost is already
covered, ignores insider sales as it ignores the stop loss.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections import defaultdict
from dataclasses import dataclass

import websockets

from .config import Settings
from .db import Database
from .feeds.pumpchain import (INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKENS, LAMPORTS, SUPPLY, _account_keys,
                              trades_from_tx)
from .paper import exit_fill
from .util import backoff_delay, now_s, redact

log = logging.getLogger("bot.insiders")

CURVE_RENT_SOL = 0.00205      # rent-exempt reserve of a 166-byte bonding-curve account: not real SOL
RESUBSCRIBE_S = 2.0           # how often the set of watched curves is compared with the subscription
REFUSED_RETRY_S = 1800.0      # a refusal no retry fixes soon (unknown method, plan) is retried this much later
STABLE_SESSION_S = 60.0       # a connection that lasted this long resets the reconnect backoff
STREAM_BYTES_PER_CREDIT = 50_000   # Helius bills streamed data at 2 credits per 0.1 MB, and 1 per connection
SEEN_MAX = 20_000             # signatures remembered: overlapping subscriptions deliver a transaction twice
BACKFILL_LOOKBACK_S = 600.0   # after a gap, real positions' curves are read back at most this far,
BACKFILL_MAX_TX = 50          # at most this many transactions per curve (1 credit each)
THRESHOLDS = (0.5, 1.0, 2.0, 3.0, 5.0)   # report: % of the supply sold by insiders since entry, net
KEY_RE = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,44}")   # a base58 public key: one bad key fails the subscription


def insider_set(early: list[dict], holders: dict | None, creator: str | None, curve_key: str | None,
                exclude: frozenset[str] | set[str] = frozenset(), early_n: int = 20,
                top_n: int = 10) -> dict[str, dict]:
    """wallet -> {"roles": [...], "tokens": what it held at evaluation (UI units) or None}.

    `early`: the launch minute's trades as chain.early_trades returns them (slot, then block order).
    `holders`: a holder snapshot (feeds.pumpchain.holder_snapshot). `exclude`: wallets never to count,
    the bot's own above all (a coin evaluated twice may list it among the top holders)."""
    by_owner = (holders or {}).get("by_owner") or {}
    skip = set(exclude) | {curve_key or ""}
    out: dict[str, dict] = {}

    def add(wallet: str | None, role: str) -> None:
        if not wallet or wallet in skip:
            return
        e = out.setdefault(wallet, {"roles": [], "tokens": by_owner.get(wallet)})
        if role not in e["roles"]:
            e["roles"].append(role)

    add(creator, "creator")
    early = [t for t in early or [] if t.get("ts") is not None]
    buys = [t for t in early if t.get("side") == "buy" and t.get("trader") and t["trader"] != creator]
    first: dict[str, int] = {}
    spent: dict[str, float] = defaultdict(float)
    for i, t in enumerate(buys):
        first.setdefault(t["trader"], i)
        spent[t["trader"]] += t.get("sol") or 0.0
    create_slot = early[0].get("slot") if early else None
    for t in buys:
        if create_slot is not None and t.get("slot") == create_slot:
            add(t["trader"], "bundle")
    for w, _ in sorted(spent.items(), key=lambda kv: kv[1], reverse=True)[:3]:
        add(w, "sniper")
    for w in sorted(first, key=first.get)[:early_n]:
        add(w, "early")
    for w, _ in sorted(((w, a) for w, a in by_owner.items() if (a or 0) > 0), key=lambda kv: kv[1],
                       reverse=True)[:top_n]:
        add(w, "top")
    return out


def curve_price_after(tx: dict, curve_key: str) -> float | None:
    """The curve's price right after the transaction, from its SOL balance: pump.fun's curve is a
    constant product of virtual reserves that start at 30 SOL and 1.073B tokens, and the account's
    lamports are its real SOL plus the rent reserve. None when the curve is not in the transaction."""
    keys = _account_keys(tx)
    if curve_key not in keys:
        return None
    i = keys.index(curve_key)
    post = (tx.get("meta") or {}).get("postBalances") or []
    if i >= len(post) or not isinstance(post[i], (int, float)):
        return None
    v_sol = INITIAL_VIRTUAL_SOL + max(0.0, post[i] / LAMPORTS - CURVE_RENT_SOL)
    return v_sol * v_sol / (INITIAL_VIRTUAL_SOL * INITIAL_VIRTUAL_TOKENS)


@dataclass(frozen=True)
class Watched:
    position_id: int
    candidate_id: int
    mint: str
    kind: str
    opened_at: float


class SubscriptionRefused(Exception):
    """Helius answered the current subscription with an error. `lasting`: the endpoint lacks the method or
    the plan lacks it, which no quick retry fixes; anything else takes the normal reconnect backoff."""

    def __init__(self, message: str, lasting: bool = False):
        super().__init__(message)
        self.lasting = lasting


LASTING_RE = re.compile(r"method not found|not available|not supported|\bplans?\b|upgrade|unauthori[sz]ed|"
                        r"forbidden|not allowed|permission", re.I)


def _lasting(error) -> bool:
    code = error.get("code") if isinstance(error, dict) else None
    return code == -32601 or bool(LASTING_RE.search(str(error)))


class InsiderWatch:
    def __init__(self, s: Settings, db: Database, positions, curve_key_of, connect=None, helius=None,
                 paused=None, over_pace=None):
        self.s, self.db, self.positions = s, db, positions
        self.curve_key_of = curve_key_of            # mint -> bonding-curve key, None once graduated or unknown
        self._connect = connect or websockets.connect
        self.helius = helius                        # credits counter (the engine paces it), rpc() for read-backs
        self.paused = paused or (lambda: False)     # true while the month's Helius credits are spent: watch nothing
        self.over_pace = over_pace or (lambda: False)   # true while spending runs ahead of the month: real only
        self.credits = 0                            # what the stream cost this run, in Helius credits
        self._bytes = 0
        self._connections = 0
        self._insiders: dict[int, dict[str, dict]] = {}   # candidate id -> insider set
        self._flow: dict[int, dict[str, float]] = {}       # position id -> insider -> net tokens sold since entry
        self._loaded: set[int] = set()                     # positions whose earlier rows are in _flow
        self._handled: set[int] = set()                    # positions whose crossing was logged or acted on
        self._counted: set[int] = set()                    # positions counted in stats["warnings"]
        self._marked: set[int] = set()                     # positions filed in insider_watch
        self._seen: dict[str, None] = {}                   # signatures processed, oldest first
        self._watch: dict[str, list[Watched]] = {}         # curve key -> positions on it
        self._last_msg_at: float | None = None             # the last notification: where a read-back starts
        self._error_saved = False
        self.error: str | None = None
        self.reconnects = 0
        self.stats = {"watching": 0, "transactions": 0, "trades": 0, "insider_sells": 0, "warnings": 0, "exits": 0,
                      "read_back": 0}

    def _url(self) -> str:
        return self.s.HELIUS_WS_URL.format(key=self.s.HELIUS_API_KEY)

    def _meter(self, n_bytes: int = 0, connection: bool = False) -> None:
        """Add what the stream costs to the Helius client's credits, which the engine records and paces
        with the RPC calls: 1 credit per connection and 2 per 0.1 MB received."""
        self._bytes += n_bytes
        self._connections += int(connection)
        due = self._connections + self._bytes // STREAM_BYTES_PER_CREDIT
        if due > self.credits:
            if self.helius is not None and hasattr(self.helius, "credits"):
                self.helius.credits += due - self.credits
            self.credits = due

    async def targets(self) -> dict[str, list[Watched]]:
        """Open positions on a bonding curve whose coin has a recorded insider set, real ones first, then the
        newest shadows, at most INSIDER_WATCH_MAX curves. Only real positions while Helius spending runs
        ahead of the month, none while the month's credits are spent."""
        if self.paused():
            return {}
        real_only = self.over_pace()
        held = [p for p in self.positions.positions.values()
                if p.status == "open" and p.candidate_id and (p.kind == "real" or not real_only)]
        held.sort(key=lambda p: (p.kind != "real", -(p.opened_at or 0)))
        out: dict[str, list[Watched]] = {}
        for p in held:
            key = self.curve_key_of(p.mint)
            if not key or not KEY_RE.fullmatch(key):
                continue
            if key not in out and len(out) >= self.s.INSIDER_WATCH_MAX:
                continue
            if not await self._insiders_of(p.candidate_id):
                continue      # evaluated before insiders were recorded, or without chain data: nothing to match
            out.setdefault(key, []).append(Watched(p.id, p.candidate_id, p.mint, p.kind, p.opened_at or 0.0))
        return out

    def _total(self, position_id: int) -> float:
        return sum(max(0.0, v) for v in self._flow.get(position_id, {}).values())

    async def _load(self, w: Watched) -> None:
        """First sight of a position this run: pick up what a previous run recorded and, if the insiders had
        already sold enough, warn (INSIDER_EXIT=false: silently, it was logged then) or sell now."""
        if w.position_id in self._loaded:
            return
        rows = await self.db.fetchall(
            "SELECT wallet, SUM(CASE WHEN side='buy' THEN -tokens ELSE tokens END) net FROM insider_trades "
            "WHERE position_id=? GROUP BY wallet", [w.position_id])
        self._flow[w.position_id] = {r["wallet"]: float(r["net"] or 0.0) for r in rows}
        self._loaded.add(w.position_id)
        pct = 100 * self._total(w.position_id) / SUPPLY
        if pct >= self.s.INSIDER_EXIT_SUPPLY_PCT and w.position_id not in self._handled:
            await self._crossed(w, f"insiders had sold {pct:.1f}% of the supply since the buy, before a restart",
                                quiet=True)

    async def _insiders_of(self, candidate_id: int) -> dict[str, dict] | None:
        if candidate_id not in self._insiders:
            if len(self._insiders) > 2000:
                self._insiders.clear()
            try:
                rows = await self.db.fetchall("SELECT wallet, roles, tokens FROM insiders WHERE candidate_id=?",
                                              [candidate_id])
            except Exception as e:
                log.warning("insider watch: could not read candidate %d's insiders: %s", candidate_id, e)
                return None                          # not cached: read again at the next refresh
            self._insiders[candidate_id] = {r["wallet"]: {"roles": (r["roles"] or "").split(","),
                                                          "tokens": r["tokens"]} for r in rows}
        return self._insiders[candidate_id]

    async def _mark(self) -> None:
        """File the positions a confirmed subscription now covers: the report counts only those."""
        for watched in self._watch.values():
            for w in watched:
                if w.position_id in self._marked:
                    continue
                try:
                    await self.db.execute("INSERT OR IGNORE INTO insider_watch (position_id, mint, kind, started_at) "
                                          "VALUES (?,?,?,?)", [w.position_id, w.mint, w.kind, now_s()])
                    self._marked.add(w.position_id)
                except Exception as e:
                    log.warning("insider watch: could not file #%d as watched: %s", w.position_id, e)

    def _prune(self) -> None:
        """Forget positions that are no longer open."""
        live = {p.id for p in self.positions.positions.values() if p.status == "open"}
        for pid in [pid for pid in self._flow if pid not in live]:
            del self._flow[pid]
        self._loaded &= live
        self._handled &= live
        self._counted &= live
        self._marked &= live

    async def on_transaction(self, result: dict, ts: float | None = None) -> None:
        """One transactionNotification result: {"transaction": {"transaction", "meta"}, "signature", "slot"}.
        `ts`: the block time of a transaction read back after a gap (None: it just happened)."""
        inner = result.get("transaction") or {}
        tx = {"slot": result.get("slot"), "transaction": inner.get("transaction") or {},
              "meta": inner.get("meta") or {}}
        sig = result.get("signature") or next(iter(tx["transaction"].get("signatures") or []), None)
        if sig:
            if sig in self._seen:
                return                               # delivered again: a second subscription, or in flight
            self._seen[sig] = None
            if len(self._seen) > SEEN_MAX:
                del self._seen[next(iter(self._seen))]
        keys = set(_account_keys(tx))
        self.stats["transactions"] += 1
        now = now_s() if ts is None else ts
        for curve_key, watched in list(self._watch.items()):
            if curve_key not in keys or not watched:
                continue
            trades = trades_from_tx(tx, watched[0].mint, curve_key)
            if not trades:
                continue
            self.stats["trades"] += len(trades)
            price = curve_price_after(tx, curve_key)
            for t in trades:
                for w in watched:
                    held = self.positions.positions.get(w.position_id)
                    if now < w.opened_at or held is None or held.status != "open":
                        continue                     # closed since the last refresh: its outcome is set
                    e = (await self._insiders_of(w.candidate_id) or {}).get(t["trader"])
                    if not e:
                        continue
                    try:
                        await self._record(w, t, e, price or t["price_sol"], now, sig or t.get("signature"),
                                           read_back=ts is not None)
                    except Exception:
                        log.exception("insider watch: could not process %s for #%d", sig, w.position_id)

    async def _record(self, w: Watched, t: dict, e: dict, price: float, ts: float, sig: str | None,
                      read_back: bool = False) -> None:
        await self._load(w)
        if read_back and sig and await self.db.fetchone(
                "SELECT 1 FROM insider_trades WHERE position_id=? AND signature=? AND wallet=?",
                [w.position_id, sig, t["trader"]]):
            return                                   # a previous run recorded it
        sold = t["side"] == "sell"
        flow = self._flow.setdefault(w.position_id, {})
        flow[t["trader"]] = flow.get(t["trader"], 0.0) + (t["tokens"] if sold else -t["tokens"])
        pct = 100 * self._total(w.position_id) / SUPPLY
        roles = ",".join(e["roles"])
        try:
            await self.db.insert("insider_trades", {
                "position_id": w.position_id, "mint": w.mint, "ts": ts, "side": t["side"], "wallet": t["trader"],
                "roles": roles, "tokens": t["tokens"], "sol": t["sol"], "price": price, "cum_supply_pct": pct,
                "signature": sig})
        except Exception as ex:                       # the count stands: a lost row never hides a sale
            log.warning("insider watch: could not save %s for #%d: %s", sig, w.position_id, ex)
        if not sold:
            log.debug("insider buy #%d %s: %s (%s) bought %.2f%% of the supply; net sold since entry %.2f%%",
                      w.position_id, w.mint, t["trader"], roles, 100 * t["tokens"] / SUPPLY, pct)
            return
        self.stats["insider_sells"] += 1
        held = e.get("tokens")
        of_held = f", {100 * t['tokens'] / held:.0f}% of what it held at evaluation" if held else ""
        log.info("INSIDER SELL #%d %s: %s (%s) sold %.2f%% of the supply for %.3f SOL%s; insiders' net sales "
                 "since entry %.2f%%%s", w.position_id, w.mint, t["trader"], roles, 100 * t["tokens"] / SUPPLY,
                 t["sol"], of_held, pct, " (read back after a gap)" if read_back else "")
        if pct >= self.s.INSIDER_EXIT_SUPPLY_PCT and w.position_id not in self._handled:
            await self._crossed(w, f"insiders sold {pct:.1f}% of the supply since the buy (the last: {roles} "
                                   f"wallet {t['trader'][:6]}…, {t['sol']:.2f} SOL)")

    async def _crossed(self, w: Watched, note: str, quiet: bool = False) -> None:
        """The insiders' net sales since entry reached INSIDER_EXIT_SUPPLY_PCT. INSIDER_EXIT=false logs it;
        true sells the position. It counts as handled only once that happened, so a failed write or a sale
        that cannot be queued yet is tried again at the next insider trade or refresh."""
        if not quiet and w.position_id not in self._counted:
            self._counted.add(w.position_id)
            self.stats["warnings"] += 1
        if not self.s.INSIDER_EXIT:
            self._handled.add(w.position_id)
            if not quiet:
                log.info("INSIDER WARNING #%d %s (%s, not acted on: INSIDER_EXIT=false)", w.position_id, w.mint, note)
            return
        try:
            done = await self.positions.insider_exit(w.position_id, note)
        except Exception:
            log.exception("insider exit #%d failed; tried again at the next insider trade", w.position_id)
            return
        if done is None:
            return                                   # its buy is not settled yet: ask again later
        self._handled.add(w.position_id)
        if done:
            self.stats["exits"] += 1

    def _subscribe_msg(self, req_id: int, keys: list[str]) -> str:
        return json.dumps({"jsonrpc": "2.0", "id": req_id, "method": "transactionSubscribe", "params": [
            {"accountInclude": keys, "failed": False, "vote": False},
            {"commitment": "confirmed", "encoding": "json", "transactionDetails": "full",
             "showRewards": False, "maxSupportedTransactionVersion": 0}]})

    async def _session(self, ws, stop: asyncio.Event) -> None:
        """Keep one subscription on the watched curves. A new set is subscribed before the old one is dropped,
        so no trade falls between them (on_transaction counts a transaction delivered twice once)."""
        live: set = set()                           # subscription ids Helius confirmed that we still hold
        current = None                              # the live one that covers want_keys
        want_keys: tuple[str, ...] = ()
        req = 0
        asked: dict[int, tuple[str, ...]] = {}      # subscribe requests awaiting an answer -> their curves
        next_check = 0.0
        gap_from = self._last_msg_at                # None: the first connection of this run
        read_back: asyncio.Task | None = None

        async def unsubscribe(sid) -> None:
            nonlocal req
            live.discard(sid)
            req += 1
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": req, "method": "transactionUnsubscribe",
                                      "params": [sid]}))
        try:
            while not stop.is_set():
                if time.monotonic() >= next_check:
                    next_check = time.monotonic() + RESUBSCRIBE_S
                    want = await self.targets()
                    for watched in want.values():
                        for w in watched:
                            try:
                                await self._load(w)
                                pct = 100 * self._total(w.position_id) / SUPPLY
                                if pct >= self.s.INSIDER_EXIT_SUPPLY_PCT and w.position_id not in self._handled:
                                    await self._crossed(w, f"insiders sold {pct:.1f}% of the supply since the buy",
                                                        quiet=True)   # a sale that could not be queued yet
                            except Exception as e:
                                log.warning("insider watch: could not load #%d: %s", w.position_id, e)
                    self._watch = want
                    self._prune()
                    self.stats["watching"] = len(want)
                    keys = tuple(sorted(want))
                    if keys != want_keys:
                        want_keys, current = keys, None
                        if keys:
                            req += 1
                            asked[req] = keys
                            await ws.send(self._subscribe_msg(req, list(keys)))
                        else:
                            for sid in list(live):
                                await unsubscribe(sid)
                    elif current is not None:
                        await self._mark()           # a position joined a curve that is already streamed
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                self._meter(len(raw) if isinstance(raw, (str, bytes)) else 0)
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("id") in asked:
                    keys = asked.pop(msg["id"])
                    if msg.get("error") is not None:
                        err = redact(str(msg["error"]))[:300]
                        if keys != want_keys:
                            log.warning("insider watch: Helius refused an outdated subscription: %s", err)
                            continue
                        raise SubscriptionRefused(err, _lasting(msg["error"]))
                    sid = msg.get("result")
                    if keys != want_keys:            # the watched set moved on while Helius answered
                        await unsubscribe(sid)
                        continue
                    live.add(sid)
                    current = sid
                    for old in [x for x in live if x != sid]:
                        await unsubscribe(old)       # the new one is live: drop the one it replaces
                    self.error = None
                    await self._mark()
                    await self._clear_saved_error()
                    log.info("insider watch: streaming trades on %d held coin(s)", len(keys))
                    if read_back is None:
                        read_back = asyncio.create_task(self._read_back(dict(self._watch), gap_from))
                elif msg.get("method") == "transactionNotification":
                    self._last_msg_at = now_s()
                    result = (msg.get("params") or {}).get("result")
                    if isinstance(result, dict):
                        await self.on_transaction(result)
        finally:
            if read_back is not None and not read_back.done():
                read_back.cancel()

    async def _read_back(self, watched: dict[str, list[Watched]], gap_from: float | None) -> None:
        """After a gap (a reconnect, a refused subscription, a restart), read back the curves of real positions:
        the latest signatures (1 credit) and each transaction since the gap that the stream did not deliver
        (1 credit each), at most BACKFILL_MAX_TX per curve, through the same path as the stream."""
        rpc = getattr(self.helius, "rpc", None)
        if rpc is None:
            return
        now = now_s()
        since = max(gap_from or 0.0, now - BACKFILL_LOOKBACK_S)
        for curve_key, ws_ in watched.items():
            real = [w for w in ws_ if w.kind == "real"]
            if not real:
                continue
            start = max(since, min(w.opened_at for w in real))
            try:
                sigs = await rpc("getSignaturesForAddress", [curve_key, {"limit": 100, "commitment": "confirmed"}])
                todo = [x for x in reversed(sigs or []) if isinstance(x, dict) and not x.get("err")
                        and (x.get("blockTime") or 0) >= start and x.get("signature") not in self._seen]
                for x in todo[:BACKFILL_MAX_TX]:
                    tx = await rpc("getTransaction", [x["signature"], {
                        "encoding": "json", "maxSupportedTransactionVersion": 0, "commitment": "confirmed"}])
                    if isinstance(tx, dict):
                        self.stats["read_back"] += 1
                        await self.on_transaction({"transaction": {"transaction": tx.get("transaction"),
                                                                   "meta": tx.get("meta")},
                                                   "signature": x["signature"], "slot": tx.get("slot")},
                                                  ts=float(x.get("blockTime") or tx.get("blockTime") or now))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("insider watch: reading back %s failed: %s", curve_key, redact(str(e))[:200])

    async def _save_error(self) -> None:
        try:
            await self.db.kv_set("insider_watch_error", json.dumps({"at": now_s(), "error": self.error}))
            self._error_saved = True
        except Exception:
            pass

    async def _clear_saved_error(self) -> None:
        if self._error_saved:
            try:
                await self.db.kv_set("insider_watch_error", "")
                self._error_saved = False
            except Exception:
                pass

    async def run(self, stop: asyncio.Event) -> None:
        if not self.s.INSIDER_WATCH or not self.s.HELIUS_API_KEY:
            await stop.wait()
            return
        attempt = 0
        while not stop.is_set():
            delay = None
            began = time.monotonic()
            try:
                async with self._connect(self._url(), ping_interval=20, ping_timeout=20, max_size=2 ** 23,
                                         open_timeout=20) as ws:
                    self._meter(connection=True)
                    await self._session(ws, stop)
            except SubscriptionRefused as e:
                self.error = f"Helius refused the trade subscription: {e}"
                if e.lasting:
                    delay = REFUSED_RETRY_S
                    await self._save_error()
                log.warning("insider watch: %s; retrying%s", self.error,
                            f" in {REFUSED_RETRY_S / 60:.0f} min" if e.lasting else "")
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                if status in (401, 403):             # the key or the plan: retrying every minute would not help
                    self.error = f"Helius refused the stream connection (HTTP {status})"
                    delay = REFUSED_RETRY_S
                    await self._save_error()
                else:
                    self.error = f"stream disconnected: {type(e).__name__}"
                log.warning("insider watch disconnected: %s", redact(f"{type(e).__name__}: {e}")[:200])
            except Exception:
                log.exception("insider watch error")
            finally:
                self._watch = {}
            if stop.is_set():
                break
            if time.monotonic() - began >= STABLE_SESSION_S:
                attempt = 0                          # only a connection that held resets the backoff
            if delay is None:
                delay = backoff_delay(attempt, base=1.0, cap=60.0)
                attempt += 1
            self.reconnects += 1
            try:
                await asyncio.wait_for(stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass


# --- report -----------------------------------------------------------------------------------

def _warning_outcome(s: Settings, pos: dict, fills: list[dict], trades: list[dict], threshold: float) -> dict | None:
    """What the position would have returned had INSIDER_EXIT sold everything it still held at the first
    insider sale that took the insiders' net sales since entry to `threshold`% of the supply: an urgent
    sale at the curve's price right after that sale, booked as the paper engine books one."""
    first = next((r for r in trades if r["side"] == "sell" and (r["cum_supply_pct"] or 0) >= threshold), None)
    if first is None or not pos["cost_sol"] or not pos["tokens_initial"] or not first["price"]:
        return None
    before = [f for f in fills if (f["ts"] or 0) < first["ts"]]
    if any((f["reason"] or "").startswith("core_") for f in before):
        return None                                  # a runner by then: INSIDER_EXIT leaves runners alone
    proceeds = sum(f["sol"] or 0 for f in before)
    left = pos["tokens_initial"] - sum(f["tokens"] or 0 for f in before)
    if left > 0:
        try:
            proceeds += exit_fill(left, first["price"], s, urgent=True).sol
        except ValueError:
            return None
    return {"ret": proceeds / pos["cost_sol"] - 1, "actual": (pos["pnl_sol"] or 0) / pos["cost_sol"],
            "delta_sol": proceeds - (pos["proceeds_sol"] or 0)}


async def insider_summary(db: Database, s: Settings) -> dict:
    """Closed watched positions and, per threshold, what selling at the warning would have done."""
    rows = await db.fetchall(
        "SELECT p.id, p.kind, p.cost_sol, p.tokens_initial, p.proceeds_sol, p.pnl_sol, p.closed_at, w.started_at "
        "FROM insider_watch w JOIN positions p ON p.id=w.position_id "
        "WHERE p.status='closed' AND p.cost_sol > 0 AND p.pnl_sol IS NOT NULL")
    since = await db.fetchone("SELECT MIN(started_at) t FROM insider_watch")
    err = await db.kv_get("insider_watch_error")
    out = {"enabled": s.INSIDER_WATCH, "acting": s.INSIDER_EXIT, "threshold": s.INSIDER_EXIT_SUPPLY_PCT,
           "since": since["t"] if since else None, "closed": len(rows), "with_sells": 0, "rows": [],
           "error": json.loads(err) if err else None}
    fills: dict[int, list[dict]] = defaultdict(list)
    trades: dict[int, list[dict]] = defaultdict(list)
    if rows:
        for f in await db.fetchall("SELECT f.position_id, f.ts, f.tokens, f.sol, f.reason FROM fills f "
                                   "JOIN insider_watch w ON w.position_id=f.position_id WHERE f.side='sell' "
                                   "ORDER BY f.ts, f.id"):
            fills[f["position_id"]].append(f)
        for t in await db.fetchall("SELECT t.position_id, t.ts, t.side, t.price, t.cum_supply_pct FROM insider_trades t "
                                   "JOIN insider_watch w ON w.position_id=t.position_id ORDER BY t.ts, t.id"):
            trades[t["position_id"]].append(t)
    by_pos: dict[int, list[dict]] = {}
    for p in rows:
        mine = [t for t in trades.get(p["id"], []) if p["closed_at"] is None or (t["ts"] or 0) <= p["closed_at"]]
        if any(t["side"] == "sell" for t in mine):
            by_pos[p["id"]] = mine
    out["with_sells"] = len(by_pos)
    for t in THRESHOLDS:
        res = [r for p in rows if p["id"] in by_pos
               and (r := _warning_outcome(s, p, fills.get(p["id"], []), by_pos[p["id"]], t)) is not None]
        n = len(res)
        out["rows"].append({"threshold": t, "n": n,
                            "actual": sum(r["actual"] for r in res) / n if n else None,
                            "if_sold": sum(r["ret"] for r in res) / n if n else None,
                            "won_anyway": sum(1 for r in res if r["actual"] > 0),
                            "delta_sol": sum(r["delta_sol"] for r in res)})
    return out


def insider_lines(m: dict | None) -> list[str]:
    if not m or not m.get("enabled"):
        return []
    from datetime import datetime, timezone

    def at(ts):
        return datetime.fromtimestamp(ts, timezone.utc).strftime("%m-%d %H:%M UTC")
    since = at(m["since"]) if m.get("since") else "not yet"
    lines = ["", f"== Insider sells after the buy (exits on them: "
                 f"{'ON at ' + format(m['threshold'], 'g') + '% of supply' if m.get('acting') else 'off, watching only'}) ==",
             f"watching since {since}: {m['closed']} watched positions closed, {m['with_sells']} saw an insider "
             f"sell after the buy"]
    err = m.get("error")
    if err and err.get("error"):
        lines.append(f"stream: {err['error']} (since {at(err['at'])})")
    if not m["with_sells"]:
        return lines
    lines.append("insiders' net sales  warned  actual avg  if sold then  won anyway   SOL vs actual")
    for r in m["rows"]:
        if not r["n"]:
            continue
        lines.append(f">= {r['threshold']:<4g}% of supply    {r['n']:>5d}  {r['actual']:>+9.1%}   {r['if_sold']:>+9.1%}"
                     f"   {r['won_anyway']:>9d}   {r['delta_sol']:>+12.4f}")
    lines.append("(net: each insider's sales minus its buys since the buy. If sold then: an urgent sale at the curve's "
                 "price right after the warning sale, after fees, before any later selling, so optimistic in a fast "
                 "dump; runners by then excluded. SOL vs actual > 0: selling at the warning would have kept more)")
    return lines
