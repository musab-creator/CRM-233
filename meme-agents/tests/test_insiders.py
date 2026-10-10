"""Insider sales on held coins (bot/insiders.py): who the insiders are, the trade stream, what is
recorded, what INSIDER_EXIT does, and the report's what-if."""
import asyncio
import dataclasses
import json
import time
from types import SimpleNamespace

import pytest

import bot.insiders as insiders_mod
from bot.config import ConfigError, validate_settings
from bot.db import Database
from bot.feeds.pumpchain import INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKENS
from bot.insiders import (CURVE_RENT_SOL, InsiderWatch, SubscriptionRefused, curve_price_after, insider_lines,
                          insider_set, insider_summary)
from bot.ops import OpsError, validate_set
from bot.paper import PaperExecutor
from bot.positions import PositionManager
from bot.risk import RiskManager
from tests.test_paper import FixedPrice

MINT, CURVE = "MINT", "CURVE"


def test_the_insiders_are_the_creator_launch_buyers_snipers_bundles_and_top_holders():
    early = [  # the launch minute as chain.early_trades returns it: slot, then block order
        {"ts": 1, "slot": 10, "side": "buy", "trader": "DEV", "sol": 1.0},
        {"ts": 1, "slot": 10, "side": "buy", "trader": "BUNDLE1", "sol": 0.5},
        {"ts": 1, "slot": 10, "side": "buy", "trader": "BUNDLE2", "sol": 0.5},
        {"ts": 2, "slot": 11, "side": "buy", "trader": "WHALE", "sol": 3.0},
        {"ts": 3, "slot": 12, "side": "sell", "trader": "BUNDLE1", "sol": 0.4},
        {"ts": 4, "slot": 13, "side": "buy", "trader": "BOT_WALLET", "sol": 0.1},
        {"ts": None, "slot": 14, "side": "buy", "trader": "UNPLACED", "sol": 9.0},
    ]
    holders = {"by_owner": {"DEV": 0.0, "WHALE": 40e6, "HOLDER": 25e6, "BUNDLE2": 10e6, "BOT_WALLET": 99e6}}
    ins = insider_set(early, holders, "DEV", CURVE, exclude={"BOT_WALLET"})
    assert ins["DEV"] == {"roles": ["creator"], "tokens": 0.0}
    assert ins["BUNDLE1"]["roles"] == ["bundle", "sniper", "early"] and ins["BUNDLE1"]["tokens"] is None
    assert ins["BUNDLE2"]["roles"] == ["bundle", "sniper", "early", "top"] and ins["BUNDLE2"]["tokens"] == 10e6
    assert ins["WHALE"]["roles"] == ["sniper", "early", "top"]
    assert ins["HOLDER"]["roles"] == ["top"]
    assert "BOT_WALLET" not in ins and "UNPLACED" not in ins and CURVE not in ins   # the bot never counts itself
    assert insider_set([], None, None, CURVE) == {}


def _tx(trader: str, sol: float, tokens: float, curve_lamports_before: int = 40_000_000_000, sig: str = "SIG") -> dict:
    """A transactionNotification result for one curve trade: +sol/+tokens buys, -sol/-tokens sells."""
    keys = [trader, CURVE, "PUMP"]
    pre = [5_000_000_000, curve_lamports_before, 1]
    post = [5_000_000_000 - round(sol * 1e9), curve_lamports_before + round(sol * 1e9), 1]
    before = 50_000_000 * 10 ** 6
    return {"signature": sig, "slot": 7, "transaction": {
        "transaction": {"signatures": [sig], "message": {"accountKeys": keys}},
        "meta": {"err": None, "preBalances": pre, "postBalances": post,
                 "preTokenBalances": [{"mint": MINT, "owner": trader, "uiTokenAmount": {"amount": str(before)}}],
                 "postTokenBalances": [{"mint": MINT, "owner": trader,
                                        "uiTokenAmount": {"amount": str(before + round(tokens * 10 ** 6))}}]}}}


def test_the_price_after_a_trade_comes_from_the_curve_balance():
    res = _tx("X", -1.5, -25e6)
    tx = {"transaction": res["transaction"]["transaction"], "meta": res["transaction"]["meta"]}
    v_sol = INITIAL_VIRTUAL_SOL + 38.5 - CURVE_RENT_SOL
    assert curve_price_after(tx, CURVE) == pytest.approx(v_sol ** 2 / (INITIAL_VIRTUAL_SOL * INITIAL_VIRTUAL_TOKENS))
    assert curve_price_after(tx, "NOT_IN_IT") is None


async def _book(s, db, notifier=None):
    await db.kv_set("bankroll_sol", "5")
    pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(), notifier=notifier)
    real = await pm.create(MINT, 1, "real", "C", 10.0, None)
    shadow = await pm.create(MINT, 2, "shadow", "C", 10.0, None)
    for p in (real, shadow):
        await pm.on_tick(MINT, 1e-7, p.decided_at + 0.001, {})
    assert real.status == shadow.status == "open"
    for cid in (1, 2):
        await db.save_insiders(cid, MINT, {"SNIPER": {"roles": ["sniper", "early"], "tokens": 30e6},
                                           "DEV": {"roles": ["creator"], "tokens": 0.0}})
    return pm, real, shadow


def test_insider_sales_after_the_buy_are_recorded_and_by_default_only_warned(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, shadow = await _book(s, db)
            w = InsiderWatch(s, db, pm, lambda m: CURVE if m == MINT else None)
            w._watch = w.targets()
            assert list(w._watch) == [CURVE] and [x.kind for x in w._watch[CURVE]] == ["real", "shadow"]
            await w.on_transaction(_tx("SNIPER", 0.2, 3e6, sig="BUY"))          # a buy: not a sale
            await w.on_transaction(_tx("RANDO", -2.0, -40e6, sig="RANDO"))     # a sale, not by an insider
            await w.on_transaction(_tx("SNIPER", -0.6, -12e6, sig="S1"))       # 1.2% of the supply
            assert w.stats["warnings"] == 0
            await w.on_transaction(_tx("SNIPER", -0.5, -10e6, sig="S2"))       # 2.2% since the buy: warned
            shadow.status = "closed"                                            # closed before the next resubscribe
            await w.on_transaction(_tx("SNIPER", -0.1, -1e6, sig="S3"))
            shadow.status = "open"
            rows = await db.fetchall("SELECT position_id, wallet, roles, tokens, cum_supply_pct, signature "
                                     "FROM insider_sells ORDER BY id")
            watched = await db.fetchall("SELECT position_id, kind FROM insider_watch ORDER BY position_id")
            return real, shadow, w, rows, watched
        finally:
            await db.close()
    real, shadow, w, rows, watched = asyncio.run(go())
    assert [(r["position_id"], r["signature"]) for r in rows] == [(real.id, "S1"), (shadow.id, "S1"),
                                                                   (real.id, "S2"), (shadow.id, "S2"), (real.id, "S3")]
    assert rows[0]["roles"] == "sniper,early" and rows[0]["tokens"] == pytest.approx(12e6)
    assert [round(r["cum_supply_pct"], 2) for r in rows] == [1.2, 1.2, 2.2, 2.2, 2.3]
    assert w.stats["warnings"] == 2 and w.stats["exits"] == 0 and w.stats["insider_sells"] == 5
    assert real.status == shadow.status == "open" and not real.pending_exit    # INSIDER_EXIT=false: watch only
    assert [r["kind"] for r in watched] == ["real", "shadow"]


def test_with_insider_exit_on_the_position_sells_as_an_emergency_and_a_runner_keeps_riding(s):
    s.INSIDER_EXIT = True
    sent = []

    async def telegram(text):
        sent.append(text)

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, shadow = await _book(s, db, notifier=telegram)
            shadow.runner_active = 1                       # its cost is covered: rides through, as with a stop
            w = InsiderWatch(s, db, pm, lambda m: CURVE)
            w._watch = w.targets()
            await w.on_transaction(_tx("SNIPER", -1.2, -25e6, sig="DUMP"))
            exit_reason = real.pending_exit or real.exit_reason
            await pm.on_tick(MINT, 0.9e-7, time.time() + 1, {})         # the queued emergency fills
            again = await pm.insider_exit(real.id, "again")              # a closed position is left alone
            await pm.settle()
            events = await db.fetchall("SELECT kind FROM events WHERE kind='insider_exit'")
            return real, shadow, w, exit_reason, again, events
        finally:
            await db.close()
    real, shadow, w, exit_reason, again, events = asyncio.run(go())
    assert exit_reason == "emergency_insider_sell"
    assert real.status == "closed" and real.exit_reason == "emergency_insider_sell"
    assert shadow.status == "open" and not shadow.pending_exit
    assert w.stats["warnings"] == 2 and w.stats["exits"] == 1 and again is False and len(events) == 1
    notice = next(t for t in sent if t.startswith("🚨 INSIDER SELL"))
    assert "insiders sold 2.5% of the supply since the buy" in notice and "sniper,early wallet SNIPER…" in notice
    assert any(t.startswith("❌ LOSS") and "emergency insider sell" in t for t in sent)


def test_a_restart_picks_up_what_the_insiders_already_sold(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, _ = await _book(s, db)
            first = InsiderWatch(s, db, pm, lambda m: CURVE)
            first._watch = first.targets()
            await first.on_transaction(_tx("SNIPER", -0.6, -15e6, sig="S1"))      # 1.5% before the restart
            second = InsiderWatch(s, db, pm, lambda m: CURVE)
            second._watch = second.targets()
            await second.on_transaction(_tx("SNIPER", -0.3, -6e6, sig="S2"))      # 2.1% in all
            rows = await db.fetchall("SELECT cum_supply_pct FROM insider_sells WHERE position_id=? ORDER BY id",
                                     [real.id])
            return second, rows
        finally:
            await db.close()
    second, rows = asyncio.run(go())
    assert [round(r["cum_supply_pct"], 2) for r in rows] == [1.5, 2.1]
    assert second.stats["warnings"] == 2


class FakeWS:
    def __init__(self):
        self.sent, self.inbox = [], asyncio.Queue()

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def recv(self):
        return await self.inbox.get()

    def answer(self, req_id, result=None, error=None):
        msg = {"jsonrpc": "2.0", "id": req_id}
        msg.update({"error": error} if error else {"result": result})
        self.inbox.put_nowait(json.dumps(msg))

    def nudge(self):
        self.inbox.put_nowait(json.dumps({"jsonrpc": "2.0", "method": "noop"}))


def test_the_stream_follows_the_held_curves_and_drops_stale_subscriptions(s, monkeypatch):
    monkeypatch.setattr(insiders_mod, "RESUBSCRIBE_S", 0.0)

    def pos(pid, mint, kind="shadow"):
        return SimpleNamespace(id=pid, mint=mint, kind=kind, status="open", candidate_id=pid, opened_at=time.time())

    async def go():
        db = await Database(s.DB_PATH).open()
        book = SimpleNamespace(positions={1: pos(1, "M1", "real")})
        w = InsiderWatch(s, db, book, {"M1": "C1", "M2": "C2", "M3": None}.get)
        ws, stop = FakeWS(), asyncio.Event()
        task = asyncio.create_task(w._session(ws, stop))

        async def step():
            ws.nudge()
            await asyncio.sleep(0.05)
        try:
            await step()
            assert ws.sent[0]["method"] == "transactionSubscribe" and ws.sent[0]["id"] == 1
            assert ws.sent[0]["params"][0] == {"accountInclude": ["C1"], "failed": False, "vote": False}
            assert ws.sent[0]["params"][1]["encoding"] == "json" and ws.sent[0]["params"][1]["commitment"] == "confirmed"
            ws.answer(1, 77)
            book.positions[2] = pos(2, "M2")
            book.positions[3] = pos(3, "M3")                                # graduated: no curve to stream
            await step()
            assert ws.sent[1] == {"jsonrpc": "2.0", "id": 2, "method": "transactionUnsubscribe", "params": [77]}
            assert ws.sent[2]["id"] == 3 and ws.sent[2]["params"][0]["accountInclude"] == ["C1", "C2"]
            del book.positions[2]                                           # moved on before Helius answered
            await step()
            assert ws.sent[3]["id"] == 4 and ws.sent[3]["params"][0]["accountInclude"] == ["C1"]
            ws.answer(3, 78)                                                # the stale answer is dropped at once
            await step()
            assert ws.sent[4] == {"jsonrpc": "2.0", "id": 5, "method": "transactionUnsubscribe", "params": [78]}
            ws.answer(4, 79)
            await step()
            assert len(ws.sent) == 5 and w.stats["watching"] == 1
            book.positions.clear()                                          # nothing held: unsubscribe, no new one
            await step()
            assert ws.sent[5]["params"] == [79] and len(ws.sent) == 6
            book.positions[4] = pos(4, "M1")
            await step()
            ws.answer(7, error={"code": -32601, "message": "Method not found"})
            with pytest.raises(SubscriptionRefused, match="Method not found"):
                await asyncio.wait_for(task, 2)
        finally:
            stop.set()
            if not task.done():
                await asyncio.wait_for(task, 3)
            await db.close()
    asyncio.run(go())


def test_the_watch_does_not_start_without_a_key_or_when_switched_off(s):
    async def go():
        stop = asyncio.Event()
        stop.set()
        for key, on in (("", True), ("abc", False)):
            s2 = dataclasses.replace(s, HELIUS_API_KEY=key, INSIDER_WATCH=on)
            w = InsiderWatch(s2, None, SimpleNamespace(positions={}), lambda m: None,
                             connect=lambda *a, **k: (_ for _ in ()).throw(AssertionError("connected")))
            await asyncio.wait_for(w.run(stop), 1)
    asyncio.run(go())


def test_the_report_shows_what_selling_at_the_warning_would_have_done(s):
    t0 = 1_700_000_000.0

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            # a loser: insiders sold 0.6% then 2.4%; the stop sold everything later at 4e-8
            a = await db.insert("positions", {"kind": "shadow", "mint": "A", "status": "closed", "cost_sol": 0.05,
                                              "tokens_initial": 500_000, "proceeds_sol": 0.019, "pnl_sol": -0.031,
                                              "entry_price": 1e-7, "opened_at": t0, "closed_at": t0 + 300})
            await db.insert("fills", {"position_id": a, "ts": t0 + 300, "side": "sell", "reason": "stop_loss",
                                      "price": 4e-8, "tokens": 500_000, "sol": 0.019, "fee_sol": 0.001})
            # a winner: half sold at +60% first, the insiders sold 2.5% after it, the rest sold at 1.3e-7
            b = await db.insert("positions", {"kind": "shadow", "mint": "B", "status": "closed", "cost_sol": 0.05,
                                              "tokens_initial": 500_000, "proceeds_sol": 0.07, "pnl_sol": 0.02,
                                              "entry_price": 1e-7, "opened_at": t0, "closed_at": t0 + 600})
            await db.insert("fills", {"position_id": b, "ts": t0 + 10, "side": "sell", "reason": "take_profit",
                                      "price": 1.6e-7, "tokens": 250_000, "sol": 0.038, "fee_sol": 0.001})
            await db.insert("fills", {"position_id": b, "ts": t0 + 600, "side": "sell", "reason": "trailing_stop",
                                      "price": 1.3e-7, "tokens": 250_000, "sol": 0.032, "fee_sol": 0.001})
            # watched, no insider sold
            c = await db.insert("positions", {"kind": "real", "mint": "C", "status": "closed", "cost_sol": 0.1,
                                              "tokens_initial": 1e6, "proceeds_sol": 0.05, "pnl_sol": -0.05})
            for pid in (a, b, c):
                await db.insert("insider_watch", {"position_id": pid, "mint": "x", "kind": "shadow",
                                                  "started_at": t0 - 5})
            for pid, ts, price, cum in ((a, t0 + 60, 9e-8, 0.6), (a, t0 + 120, 8e-8, 2.4), (b, t0 + 30, 1.2e-7, 2.5),
                                        (a, t0 + 900, 1e-9, 9.0)):          # after A closed: never counts
                await db.insert("insider_sells", {"position_id": pid, "mint": "x", "ts": ts, "wallet": "W",
                                                  "roles": "sniper", "tokens": 1, "sol": 0.1, "price": price,
                                                  "cum_supply_pct": cum})
            return await insider_summary(db, s)
        finally:
            await db.close()
    m = asyncio.run(go())
    assert m["closed"] == 3 and m["with_sells"] == 2 and m["acting"] is False
    rows = {r["threshold"]: r for r in m["rows"]}
    a_2 = 500_000 * 8e-8 * 0.95 - 0.001                 # A at its 2.4% sale, at its own booked fee rate
    rate_b = 0.07 / (250_000 * 1.6e-7 + 250_000 * 1.3e-7)
    b_2 = 0.038 + 250_000 * 1.2e-7 * rate_b - 0.001    # B keeps its take-profit, sells the rest at the warning
    r2 = rows[2.0]
    assert r2["n"] == 2 and r2["won_anyway"] == 1
    assert r2["actual"] == pytest.approx((-0.031 / 0.05 + 0.02 / 0.05) / 2)
    assert r2["if_sold"] == pytest.approx((a_2 / 0.05 - 1 + b_2 / 0.05 - 1) / 2)
    assert r2["delta_sol"] == pytest.approx(a_2 - 0.019 + b_2 - 0.07)
    assert rows[0.5]["n"] == 2 and rows[3.0]["n"] == 0
    text = "\n".join(insider_lines(m))
    assert "== Insider sells after the buy (exits on them: off, watching only) ==" in text
    assert "3 watched positions closed, 2 saw an insider sell after the buy" in text
    assert ">= 2   % of supply      2" in text and ">= 3" not in text
    assert insider_lines({"enabled": False}) == []


def test_the_insider_settings_and_their_phone_bounds(s):
    validate_settings(s)
    assert (s.INSIDER_WATCH, s.INSIDER_EXIT, s.INSIDER_EXIT_SUPPLY_PCT, s.INSIDER_WATCH_MAX) == (True, False, 2.0, 60)
    for bad in ({"INSIDER_EXIT_SUPPLY_PCT": 0.05}, {"INSIDER_EXIT_SUPPLY_PCT": 51}, {"INSIDER_WATCH_MAX": 0},
                {"HELIUS_WS_URL": "ws://plain"}):
        with pytest.raises(ConfigError):
            validate_settings(dataclasses.replace(s, **bad))
    assert validate_set("INSIDER_EXIT", "true", s) == "true"
    assert validate_set("INSIDER_EXIT_SUPPLY_PCT", "3", s) == "3"
    for key, raw in (("INSIDER_EXIT_SUPPLY_PCT", "0.4"), ("INSIDER_EXIT_SUPPLY_PCT", "21"),
                     ("INSIDER_WATCH_MAX", "201"), ("HELIUS_WS_URL", "wss://evil")):
        with pytest.raises(OpsError):
            validate_set(key, raw, s)
