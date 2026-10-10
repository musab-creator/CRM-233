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

INSIDER_EXIT=false (the default) only records, and /report shows what selling at the warning would
have returned against what each position did. With INSIDER_EXIT=true, the first time the insiders'
sales since entry reach INSIDER_EXIT_SUPPLY_PCT of the supply the position is sold as an emergency
(emergency_insider_sell). A runner, whose cost is already covered, ignores insider sales as it
ignores the stop loss.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from dataclasses import dataclass

import websockets

from .config import Settings
from .db import Database
from .feeds.pumpchain import (INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKENS, LAMPORTS, SUPPLY, _account_keys,
                              trades_from_tx)
from .util import backoff_delay, now_s, redact

log = logging.getLogger("bot.insiders")

CURVE_RENT_SOL = 0.00205      # rent-exempt reserve of a 166-byte bonding-curve account: not real SOL
RESUBSCRIBE_S = 2.0           # how often the set of watched curves is compared with the subscription
REFUSED_RETRY_S = 1800.0      # a subscription Helius refuses (plan, method) is retried this much later
THRESHOLDS = (0.5, 1.0, 2.0, 3.0, 5.0)   # report: % of the supply sold by insiders since entry


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
    """Helius answered the subscription with an error (plan without the method, bad filter)."""


class InsiderWatch:
    def __init__(self, s: Settings, db: Database, positions, curve_key_of, connect=None):
        self.s, self.db, self.positions = s, db, positions
        self.curve_key_of = curve_key_of            # mint -> bonding-curve key, None once graduated or unknown
        self._connect = connect or websockets.connect
        self._insiders: dict[int, dict[str, dict]] = {}   # candidate id -> insider set
        self._sold: dict[int, float] = {}                  # position id -> insider tokens sold since entry
        self._warned: set[int] = set()
        self._known: set[int] = set()                      # positions whose watch row and history are loaded
        self._watch: dict[str, list[Watched]] = {}         # curve key -> positions on it
        self.error: str | None = None
        self.reconnects = 0
        self.stats = {"watching": 0, "transactions": 0, "trades": 0, "insider_sells": 0, "warnings": 0, "exits": 0}

    def _url(self) -> str:
        return self.s.HELIUS_WS_URL.format(key=self.s.HELIUS_API_KEY)

    def targets(self) -> dict[str, list[Watched]]:
        """Open positions on a bonding curve, real ones first, then the newest shadows, at most
        INSIDER_WATCH_MAX curves."""
        held = [p for p in self.positions.positions.values() if p.status == "open" and p.candidate_id]
        held.sort(key=lambda p: (p.kind != "real", -(p.opened_at or 0)))
        out: dict[str, list[Watched]] = {}
        for p in held:
            key = self.curve_key_of(p.mint)
            if not key:
                continue
            if key not in out and len(out) >= self.s.INSIDER_WATCH_MAX:
                continue
            out.setdefault(key, []).append(Watched(p.id, p.candidate_id, p.mint, p.kind, p.opened_at or 0.0))
        return out

    async def _load(self, w: Watched) -> None:
        """First sight of a position: mark it watched and pick up what a previous run recorded."""
        if w.position_id in self._known:
            return
        self._known.add(w.position_id)
        await self.db.execute("INSERT OR IGNORE INTO insider_watch (position_id, mint, kind, started_at) "
                              "VALUES (?,?,?,?)", [w.position_id, w.mint, w.kind, now_s()])
        row = await self.db.fetchone("SELECT COALESCE(SUM(tokens),0) t, COALESCE(MAX(cum_supply_pct),0) m "
                                     "FROM insider_sells WHERE position_id=?", [w.position_id])
        self._sold[w.position_id] = float(row["t"] or 0.0)
        if float(row["m"] or 0.0) >= self.s.INSIDER_EXIT_SUPPLY_PCT:
            self._warned.add(w.position_id)          # crossed before a restart: act only on a new crossing

    async def _insiders_of(self, candidate_id: int) -> dict[str, dict]:
        if candidate_id not in self._insiders:
            if len(self._insiders) > 2000:
                self._insiders.clear()
            rows = await self.db.fetchall("SELECT wallet, roles, tokens FROM insiders WHERE candidate_id=?",
                                          [candidate_id])
            self._insiders[candidate_id] = {r["wallet"]: {"roles": (r["roles"] or "").split(","),
                                                          "tokens": r["tokens"]} for r in rows}
        return self._insiders[candidate_id]

    async def on_transaction(self, result: dict) -> None:
        """One transactionNotification result: {"transaction": {"transaction", "meta"}, "signature", "slot"}."""
        inner = result.get("transaction") or {}
        tx = {"slot": result.get("slot"), "transaction": inner.get("transaction") or {},
              "meta": inner.get("meta") or {}}
        keys = set(_account_keys(tx))
        self.stats["transactions"] += 1
        now = now_s()
        for curve_key, watched in list(self._watch.items()):
            if curve_key not in keys or not watched:
                continue
            trades = trades_from_tx(tx, watched[0].mint, curve_key)
            if not trades:
                continue
            self.stats["trades"] += len(trades)
            price = curve_price_after(tx, curve_key)
            for t in trades:
                if t["side"] != "sell":
                    continue
                for w in watched:
                    held = self.positions.positions.get(w.position_id)
                    if now < w.opened_at or held is None or held.status != "open":
                        continue                     # closed since the last resubscribe: its outcome is set
                    e = (await self._insiders_of(w.candidate_id)).get(t["trader"])
                    if e:
                        await self._record(w, t, e, price or t["price_sol"], now,
                                           result.get("signature") or t.get("signature"))

    async def _record(self, w: Watched, t: dict, e: dict, price: float, now: float, sig: str | None) -> None:
        await self._load(w)
        sold = self._sold.get(w.position_id, 0.0) + t["tokens"]
        self._sold[w.position_id] = sold
        pct = 100 * sold / SUPPLY
        roles = ",".join(e["roles"])
        await self.db.insert("insider_sells", {
            "position_id": w.position_id, "mint": w.mint, "ts": now, "wallet": t["trader"], "roles": roles,
            "tokens": t["tokens"], "sol": t["sol"], "price": price, "cum_supply_pct": pct, "signature": sig})
        self.stats["insider_sells"] += 1
        held = e.get("tokens")
        of_held = f", {100 * t['tokens'] / held:.0f}% of what it held at evaluation" if held else ""
        log.info("INSIDER SELL #%d %s: %s (%s) sold %.2f%% of the supply for %.3f SOL%s; insiders have sold "
                 "%.2f%% since entry", w.position_id, w.mint, t["trader"], roles, 100 * t["tokens"] / SUPPLY,
                 t["sol"], of_held, pct)
        if pct < self.s.INSIDER_EXIT_SUPPLY_PCT or w.position_id in self._warned:
            return
        self._warned.add(w.position_id)
        self.stats["warnings"] += 1
        note = (f"insiders sold {pct:.1f}% of the supply since the buy (the last: {roles} wallet "
                f"{t['trader'][:6]}…, {t['sol']:.2f} SOL)")
        if not self.s.INSIDER_EXIT:
            log.info("INSIDER WARNING #%d %s (%s, not acted on: INSIDER_EXIT=false)", w.position_id, w.mint, note)
            return
        if await self.positions.insider_exit(w.position_id, note):
            self.stats["exits"] += 1

    def _subscribe_msg(self, req_id: int, keys: list[str]) -> str:
        return json.dumps({"jsonrpc": "2.0", "id": req_id, "method": "transactionSubscribe", "params": [
            {"accountInclude": keys, "failed": False, "vote": False},
            {"commitment": "confirmed", "encoding": "json", "transactionDetails": "full",
             "showRewards": False, "maxSupportedTransactionVersion": 0}]})

    async def _session(self, ws, stop: asyncio.Event) -> None:
        sub_id = None
        sub_keys: tuple[str, ...] = ()
        req = 0
        asked: dict[int, tuple[str, ...]] = {}      # subscribe requests awaiting an answer -> their curves
        next_check = 0.0

        async def unsubscribe(sid) -> None:
            nonlocal req
            req += 1
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": req, "method": "transactionUnsubscribe",
                                      "params": [sid]}))

        while not stop.is_set():
            if time.monotonic() >= next_check:
                next_check = time.monotonic() + RESUBSCRIBE_S
                want = self.targets()
                for watched in want.values():
                    for w in watched:
                        await self._load(w)
                self._watch = want
                self.stats["watching"] = len(want)
                keys = tuple(sorted(want))
                if keys != sub_keys:
                    if sub_id is not None:
                        await unsubscribe(sub_id)
                        sub_id = None
                    sub_keys = keys
                    if keys:
                        req += 1
                        asked[req] = keys
                        await ws.send(self._subscribe_msg(req, list(keys)))
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("id") in asked:
                keys = asked.pop(msg["id"])
                if msg.get("error") is not None:
                    raise SubscriptionRefused(redact(str(msg["error"]))[:300])
                if keys != sub_keys:                 # the watched set moved on while Helius answered
                    await unsubscribe(msg.get("result"))
                    continue
                sub_id = msg.get("result")
                self.error = None
                log.info("insider watch: streaming trades on %d held coin(s)", len(sub_keys))
            elif msg.get("method") == "transactionNotification":
                result = (msg.get("params") or {}).get("result")
                if isinstance(result, dict):
                    await self.on_transaction(result)

    async def run(self, stop: asyncio.Event) -> None:
        if not self.s.INSIDER_WATCH or not self.s.HELIUS_API_KEY:
            await stop.wait()
            return
        attempt = 0
        while not stop.is_set():
            delay = None
            try:
                async with self._connect(self._url(), ping_interval=20, ping_timeout=20, max_size=2 ** 23,
                                         open_timeout=20) as ws:
                    attempt = 0
                    await self._session(ws, stop)
            except SubscriptionRefused as e:
                self.error = f"Helius refused the trade subscription: {e}"
                log.warning("insider watch: %s; retrying in %.0f min", self.error, REFUSED_RETRY_S / 60)
                delay = REFUSED_RETRY_S
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as e:
                self.error = f"stream disconnected: {type(e).__name__}"
                log.warning("insider watch disconnected: %s", redact(f"{type(e).__name__}: {e}")[:200])
            except Exception:
                log.exception("insider watch error")
            finally:
                self._watch = {}
            if stop.is_set():
                break
            if delay is None:
                delay = backoff_delay(attempt, base=1.0, cap=60.0)
                attempt += 1
            self.reconnects += 1
            try:
                await asyncio.wait_for(stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass


# --- report -----------------------------------------------------------------------------------

async def _warning_outcome(db: Database, pos: dict, sells: list[dict], threshold: float) -> dict | None:
    """What the position would have returned had it sold everything it still held at the first
    insider sale that took the insiders' total since entry to `threshold`% of the supply."""
    first = next((r for r in sells if (r["cum_supply_pct"] or 0) >= threshold), None)
    if first is None or not pos["cost_sol"] or not pos["tokens_initial"] or not first["price"]:
        return None
    fills = await db.fetchall("SELECT ts, tokens, sol, price, fee_sol FROM fills WHERE position_id=? "
                              "AND side='sell' ORDER BY ts", [pos["id"]])
    if not fills:
        return None
    gross = sum((f["tokens"] or 0) * (f["price"] or 0) for f in fills)
    net_rate = sum(f["sol"] or 0 for f in fills) / gross if gross > 0 else 1.0   # fees and slippage as booked
    fee = sum(f["fee_sol"] or 0 for f in fills) / len(fills)
    before = [f for f in fills if (f["ts"] or 0) < first["ts"]]
    proceeds = sum(f["sol"] or 0 for f in before)
    left = max(0.0, pos["tokens_initial"] - sum(f["tokens"] or 0 for f in before))
    if left > 0:
        proceeds += max(0.0, left * first["price"] * net_rate - fee)
    return {"ret": proceeds / pos["cost_sol"] - 1, "actual": (pos["pnl_sol"] or 0) / pos["cost_sol"],
            "delta_sol": proceeds - (pos["proceeds_sol"] or 0)}


async def insider_summary(db: Database, s: Settings) -> dict:
    """Closed watched positions and, per threshold, what selling at the warning would have done."""
    rows = await db.fetchall(
        "SELECT p.id, p.kind, p.cost_sol, p.tokens_initial, p.proceeds_sol, p.pnl_sol, p.closed_at, w.started_at "
        "FROM insider_watch w JOIN positions p ON p.id=w.position_id "
        "WHERE p.status='closed' AND p.cost_sol > 0 AND p.pnl_sol IS NOT NULL")
    since = await db.fetchone("SELECT MIN(started_at) t FROM insider_watch")
    out = {"enabled": s.INSIDER_WATCH, "acting": s.INSIDER_EXIT, "threshold": s.INSIDER_EXIT_SUPPLY_PCT,
           "since": since["t"] if since else None, "closed": len(rows), "with_sells": 0, "rows": []}
    by_pos: dict[int, list[dict]] = {}
    for p in rows:
        sells = await db.fetchall("SELECT ts, price, cum_supply_pct FROM insider_sells WHERE position_id=? "
                                  "AND (? IS NULL OR ts <= ?) ORDER BY ts, id",
                                  [p["id"], p["closed_at"], p["closed_at"]])
        if sells:
            by_pos[p["id"]] = sells
    out["with_sells"] = len(by_pos)
    for t in THRESHOLDS:
        res = [r for p in rows if p["id"] in by_pos
               and (r := await _warning_outcome(db, p, by_pos[p["id"]], t)) is not None]
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
    since = (datetime.fromtimestamp(m["since"], timezone.utc).strftime("%m-%d %H:%M UTC")
             if m.get("since") else "not yet")
    lines = ["", f"== Insider sells after the buy (exits on them: "
                 f"{'ON at ' + format(m['threshold'], 'g') + '% of supply' if m.get('acting') else 'off, watching only'}) ==",
             f"watching since {since}: {m['closed']} watched positions closed, {m['with_sells']} saw an insider "
             f"sell after the buy"]
    if not m["with_sells"]:
        return lines
    lines.append("insiders sold      warned  actual avg  if sold then  won anyway   SOL vs actual")
    for r in m["rows"]:
        if not r["n"]:
            continue
        lines.append(f">= {r['threshold']:<4g}% of supply  {r['n']:>5d}  {r['actual']:>+9.1%}   {r['if_sold']:>+9.1%}"
                     f"   {r['won_anyway']:>9d}   {r['delta_sol']:>+12.4f}")
    lines.append("(actual and if-sold-then both after fees; SOL vs actual > 0 means selling at the warning "
                 "would have kept more)")
    return lines
