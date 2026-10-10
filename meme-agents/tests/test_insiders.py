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
from bot.insiders import (CURVE_RENT_SOL, REFUSED_RETRY_S, InsiderWatch, SubscriptionRefused, Watched,
                          curve_price_after, insider_lines, insider_set, insider_summary)
from bot.ops import OpsError, validate_set
from bot.paper import PaperExecutor, exit_fill
from bot.positions import PositionManager
from bot.risk import RiskManager
from tests.test_paper import FixedPrice

MINT = "MINT"
CURVE = "CurveAccount" + "1" * 30       # a base58 key: the watch never subscribes a malformed one


def key(name: str) -> str:
    return name + "1" * (43 - len(name))


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


async def _rows(db, pid=None):
    where, args = ("WHERE position_id=?", [pid]) if pid else ("", [])
    return await db.fetchall(f"SELECT position_id, side, wallet, roles, tokens, cum_supply_pct, signature "
                             f"FROM insider_trades {where} ORDER BY id", args)


def test_insider_sales_after_the_buy_are_recorded_and_by_default_only_warned(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, shadow = await _book(s, db)
            w = InsiderWatch(s, db, pm, lambda m: CURVE if m == MINT else None)
            w._watch = await w.targets()
            assert list(w._watch) == [CURVE] and [x.kind for x in w._watch[CURVE]] == ["real", "shadow"]
            await w.on_transaction(_tx("DEV", 0.2, 3e6, sig="BUY"))            # an insider buy: lowers DEV's net only
            await w.on_transaction(_tx("RANDO", -2.0, -40e6, sig="RANDO"))     # a sale, not by an insider
            await w.on_transaction(_tx("SNIPER", -0.6, -12e6, sig="S1"))       # 1.2% of the supply
            assert w.stats["warnings"] == 0
            await w.on_transaction(_tx("SNIPER", -0.5, -10e6, sig="S2"))       # 2.2% since the buy: warned
            shadow.status = "closed"                                            # closed before the next refresh
            await w.on_transaction(_tx("SNIPER", -0.1, -1e6, sig="S3"))
            shadow.status = "open"
            await w._mark()                                                     # what a confirmed subscription does
            watched = await db.fetchall("SELECT position_id, kind FROM insider_watch ORDER BY position_id")
            return real, shadow, w, await _rows(db), watched
        finally:
            await db.close()
    real, shadow, w, rows, watched = asyncio.run(go())
    assert [(r["position_id"], r["signature"], r["side"]) for r in rows] == [
        (real.id, "BUY", "buy"), (shadow.id, "BUY", "buy"), (real.id, "S1", "sell"), (shadow.id, "S1", "sell"),
        (real.id, "S2", "sell"), (shadow.id, "S2", "sell"), (real.id, "S3", "sell")]
    assert rows[2]["roles"] == "sniper,early" and rows[2]["tokens"] == pytest.approx(12e6)
    assert [round(r["cum_supply_pct"], 2) for r in rows] == [0.0, 0.0, 1.2, 1.2, 2.2, 2.2, 2.3]
    assert w.stats["warnings"] == 2 and w.stats["exits"] == 0 and w.stats["insider_sells"] == 5
    assert real.status == shadow.status == "open" and not real.pending_exit    # INSIDER_EXIT=false: watch only
    assert [r["kind"] for r in watched] == ["real", "shadow"]


def test_a_transaction_delivered_twice_counts_once(s):
    """Two live subscriptions (the old one until the new one is confirmed) or a message in flight after an
    unsubscribe deliver one transaction twice: 12 Oct review, a 1.2% sale was booked as 2.4% and sold."""
    s.INSIDER_EXIT = True

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, _ = await _book(s, db)
            w = InsiderWatch(s, db, pm, lambda m: CURVE)
            w._watch = await w.targets()
            note = _tx("SNIPER", -0.6, -12e6, sig="ONE_SALE")
            for _ in range(2):
                await w.on_transaction(note)
            await pm.settle()
            return real, w, await _rows(db)
        finally:
            await db.close()
    real, w, rows = asyncio.run(go())
    assert [round(r["cum_supply_pct"], 2) for r in rows] == [1.2, 1.2]          # once for each position
    assert w.stats["transactions"] == 1 and w.stats["warnings"] == 0 and not real.pending_exit


def test_insiders_count_net_of_what_they_buy_back_wallet_by_wallet(s):
    """A launch-minute volume bot that sells and buys back adds nothing; another insider's buys never
    offset a wallet's sales."""
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, _ = await _book(s, db)
            w = InsiderWatch(s, db, pm, lambda m: CURVE)
            w._watch = await w.targets()
            for i in range(3):                                                  # round trips, net zero
                await w.on_transaction(_tx("SNIPER", -0.4, -8e6, sig=f"S{i}"))
                await w.on_transaction(_tx("SNIPER", 0.4, 8e6, sig=f"B{i}"))
            churn = [round(r["cum_supply_pct"], 2) for r in await _rows(db, real.id)]
            await w.on_transaction(_tx("DEV", 1.0, 30e6, sig="DEV_BUY"))        # the creator buys 3%
            await w.on_transaction(_tx("SNIPER", -1.1, -21e6, sig="DUMP"))      # the sniper sells 2.1%
            return w, churn, await _rows(db, real.id)
        finally:
            await db.close()
    w, churn, rows = asyncio.run(go())
    assert churn == [0.8, 0.0, 0.8, 0.0, 0.8, 0.0]
    assert round(rows[-1]["cum_supply_pct"], 2) == 2.1 and w.stats["warnings"] == 2   # real and shadow


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
            w._watch = await w.targets()
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


def test_a_failed_write_never_keeps_the_insider_sale_from_happening(s):
    """12 Oct review: the event was written before the sale was queued, so "database is locked" left the
    position unsold and marked handled for good, also after a restart."""
    s.INSIDER_EXIT = True

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, shadow = await _book(s, db)
            w = InsiderWatch(s, db, pm, lambda m: CURVE)
            w._watch = await w.targets()

            async def locked(*a, **k):
                raise RuntimeError("database is locked")
            db.event = locked                                            # the event write fails
            orig_insert = db.insert

            async def insert(table, row):
                if table == "insider_trades":
                    raise RuntimeError("database is locked")             # so does the trade row
                return await orig_insert(table, row)
            db.insert = insert
            orig_exit, calls = pm.insider_exit, []

            async def flaky(pid, note):
                calls.append(pid)
                if len(calls) == 1:
                    raise RuntimeError("database is locked")             # the first attempt fails outright
                return await orig_exit(pid, note)
            pm.insider_exit = flaky
            await w.on_transaction(_tx("SNIPER", -1.2, -25e6, sig="DUMP1"))   # 2.5%: real fails, shadow sells
            first = real.pending_exit
            await w.on_transaction(_tx("SNIPER", -0.2, -2e6, sig="DUMP2"))    # the next insider sale tries again
            return real, shadow, first, calls
        finally:
            await db.close()
    real, shadow, first, calls = asyncio.run(go())
    assert first is None and real.pending_exit == "emergency_insider_sell"
    assert shadow.pending_exit == "emergency_insider_sell" and calls == [real.id, shadow.id, real.id]


def test_insider_exit_leaves_a_queued_full_sale_alone_and_waits_for_an_unsettled_buy(s):
    s.INSIDER_EXIT = True

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, shadow = await _book(s, db)
            await pm.queue_exit(real, "stop_loss")                    # already selling everything, urgently
            pm._entry_uncertain.add(shadow.id)                        # its buy's outcome is not known yet
            out = (await pm.insider_exit(real.id, "x"), await pm.insider_exit(shadow.id, "x"))
            events = await db.fetchall("SELECT kind FROM events WHERE kind='insider_exit'")
            await pm.settle()
            return out, real, events
        finally:
            await db.close()
    out, real, events = asyncio.run(go())
    assert out == (False, None) and real.pending_exit == "stop_loss" and events == []


def test_a_restart_picks_up_what_the_insiders_already_sold(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, _ = await _book(s, db)
            first = InsiderWatch(s, db, pm, lambda m: CURVE)
            first._watch = await first.targets()
            await first.on_transaction(_tx("SNIPER", -0.6, -15e6, sig="S1"))      # 1.5% before the restart
            second = InsiderWatch(s, db, pm, lambda m: CURVE)
            second._watch = await second.targets()
            await second.on_transaction(_tx("SNIPER", -0.3, -6e6, sig="S2"))      # 2.1% in all
            return second, await _rows(db, real.id)
        finally:
            await db.close()
    second, rows = asyncio.run(go())
    assert [round(r["cum_supply_pct"], 2) for r in rows] == [1.5, 2.1]
    assert second.stats["warnings"] == 2


def test_switching_insider_exit_on_sells_positions_that_crossed_before_the_restart(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, shadow = await _book(s, db)
            first = InsiderWatch(s, db, pm, lambda m: CURVE)              # INSIDER_EXIT=false: warned only
            first._watch = await first.targets()
            await first.on_transaction(_tx("SNIPER", -1.2, -25e6, sig="DUMP"))
            assert not real.pending_exit and first.stats["warnings"] == 2
            quiet = InsiderWatch(s, db, pm, lambda m: CURVE)              # a plain restart: no second warning
            for w in (await quiet.targets())[CURVE]:
                await quiet._load(w)
            s.INSIDER_EXIT = True                                          # /set INSIDER_EXIT=true restarts the bot
            second = InsiderWatch(s, db, pm, lambda m: CURVE)
            for w in (await second.targets())[CURVE]:
                await second._load(w)
            await pm.settle()
            return real, shadow, quiet, second
        finally:
            await db.close()
    real, shadow, quiet, second = asyncio.run(go())
    assert quiet.stats["warnings"] == 0 and quiet.stats["exits"] == 0
    assert real.pending_exit == shadow.pending_exit == "emergency_insider_sell" and second.stats["exits"] == 2


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


def _pos(pid, mint, kind="shadow"):
    return SimpleNamespace(id=pid, mint=mint, kind=kind, status="open", candidate_id=pid, opened_at=time.time())


async def _insiders_for(db, *cids):
    for cid in cids:
        await db.save_insiders(cid, "M", {"W": {"roles": ["early"], "tokens": 1.0}})


def test_the_stream_subscribes_the_new_set_before_dropping_the_old(s, monkeypatch):
    monkeypatch.setattr(insiders_mod, "RESUBSCRIBE_S", 0.0)
    K1, K2 = key("C1"), key("C2")

    async def go():
        db = await Database(s.DB_PATH).open()
        await _insiders_for(db, 1, 2, 3, 4, 5)
        book = SimpleNamespace(positions={1: _pos(1, "M1", "real")})
        w = InsiderWatch(s, db, book, {"M1": K1, "M2": K2, "M3": None}.get)
        ws, stop = FakeWS(), asyncio.Event()
        task = asyncio.create_task(w._session(ws, stop))

        async def step():
            ws.nudge()
            await asyncio.sleep(0.05)

        async def filed():
            return [r["position_id"] for r in await db.fetchall("SELECT position_id FROM insider_watch")]
        try:
            await step()
            assert ws.sent[0]["method"] == "transactionSubscribe" and ws.sent[0]["id"] == 1
            assert ws.sent[0]["params"][0] == {"accountInclude": [K1], "failed": False, "vote": False}
            assert ws.sent[0]["params"][1]["encoding"] == "json" and ws.sent[0]["params"][1]["commitment"] == "confirmed"
            assert await filed() == []                                      # nothing streamed yet
            ws.answer(1, 77)
            await step()
            assert await filed() == [1]
            book.positions[2] = _pos(2, "M2")
            book.positions[3] = _pos(3, "M3")                               # graduated: no curve to stream
            await step()
            assert ws.sent[1]["id"] == 2 and ws.sent[1]["params"][0]["accountInclude"] == [K1, K2]
            assert len(ws.sent) == 2                                        # 77 stays live until 2 is confirmed
            del book.positions[2]                                           # moved on before Helius answered
            await step()
            assert ws.sent[2]["id"] == 3 and ws.sent[2]["params"][0]["accountInclude"] == [K1]
            ws.answer(2, 78)                                                # the outdated one is dropped at once
            await step()
            assert ws.sent[3] == {"jsonrpc": "2.0", "id": 4, "method": "transactionUnsubscribe", "params": [78]}
            ws.answer(3, 79)                                                # the new one is live: drop 77
            await step()
            assert ws.sent[4] == {"jsonrpc": "2.0", "id": 5, "method": "transactionUnsubscribe", "params": [77]}
            assert len(ws.sent) == 5 and w.stats["watching"] == 1 and await filed() == [1]
            book.positions[4] = _pos(4, "M1")                               # joins a curve already streamed
            await step()
            assert len(ws.sent) == 5 and sorted(await filed()) == [1, 4]
            book.positions.clear()                                          # nothing held: drop it, no new one
            await step()
            assert ws.sent[5]["params"] == [79] and len(ws.sent) == 6
            book.positions[5] = _pos(5, "M2")
            await step()
            book.positions[5] = _pos(5, "M1")                               # moved on again
            await step()
            ws.answer(7, error={"code": -32000, "message": "busy"})        # an error to the outdated request
            await step()
            assert not task.done()
            ws.answer(8, error={"code": -32601, "message": "Method not found"})
            with pytest.raises(SubscriptionRefused, match="Method not found") as refused:
                await asyncio.wait_for(task, 2)
            assert refused.value.lasting
        finally:
            stop.set()
            if not task.done():
                await asyncio.wait_for(task, 3)
            await db.close()
    asyncio.run(go())


def test_only_a_method_or_plan_refusal_waits_half_an_hour(s, monkeypatch):
    monkeypatch.setattr(insiders_mod, "RESUBSCRIBE_S", 0.0)
    delays = []
    monkeypatch.setattr(insiders_mod, "backoff_delay", lambda attempt, **k: delays.append(attempt) or 0.0)

    async def go():
        db = await Database(s.DB_PATH).open()
        await _insiders_for(db, 1)
        book = SimpleNamespace(positions={1: _pos(1, "M1", "real")})
        errors = [{"code": -32000, "message": "internal error"},
                  {"code": -32603, "message": "transactionSubscribe is not available on your plan"}]
        stop = asyncio.Event()

        class Conn:
            def __init__(self):
                self.ws = FakeWS()

            async def __aenter__(self):
                err = errors.pop(0) if errors else None
                if err is None:
                    stop.set()
                    raise OSError("done")
                self.ws.nudge()
                asyncio.get_running_loop().call_later(0.05, self.ws.answer, 1, None, err)
                return self.ws

            async def __aexit__(self, *a):
                return False
        waits = []
        real_wait_for = asyncio.wait_for

        async def wait_for(aw, timeout):
            if timeout == REFUSED_RETRY_S:
                waits.append(timeout)
                timeout = 0.01
            return await real_wait_for(aw, timeout)
        monkeypatch.setattr(insiders_mod.asyncio, "wait_for", wait_for)
        w = InsiderWatch(dataclasses.replace(s, HELIUS_API_KEY="k"), db, book, {"M1": key("C1")}.get,
                         connect=lambda *a, **k: Conn())
        try:
            await real_wait_for(w.run(stop), 5)
            saved = json.loads(await db.kv_get("insider_watch_error"))
            return w, waits, saved
        finally:
            await db.close()
    w, waits, saved = asyncio.run(go())
    assert delays == [0] and waits == [REFUSED_RETRY_S]          # the transient error took the normal backoff
    assert "not available on your plan" in saved["error"] and w.reconnects == 2


def test_the_watch_streams_only_coins_with_insiders_and_only_real_ones_when_ahead_of_pace(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _insiders_for(db, 1, 2)
            book = SimpleNamespace(positions={1: _pos(1, "M1", "real"), 2: _pos(2, "M2"), 3: _pos(3, "M3"),
                                              4: _pos(4, "M4")})
            ahead = {"on": False}
            keys = {"M1": key("C1"), "M2": key("C2"), "M3": key("C3"), "M4": "not a key!"}
            w = InsiderWatch(s, db, book, keys.get, over_pace=lambda: ahead["on"])
            normal = sorted(await w.targets())
            ahead["on"] = True
            return normal, sorted(await w.targets())
        finally:
            await db.close()
    normal, ahead = asyncio.run(go())
    assert normal == [key("C1"), key("C2")]          # M3 has no insider set, M4's key is malformed
    assert ahead == [key("C1")]


def test_after_a_gap_real_positions_are_read_back_without_counting_twice(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, shadow = await _book(s, db)
            first = InsiderWatch(s, db, pm, lambda m: CURVE)
            first._watch = await first.targets()
            await first.on_transaction(_tx("SNIPER", -0.6, -12e6, sig="OLD"))     # before the restart
            bt = time.time()
            calls = []

            async def rpc(method, params):
                calls.append(method)
                if method == "getSignaturesForAddress":
                    return [{"signature": s_, "blockTime": bt, "err": None} for s_ in ("NEW", "OLD")]
                res = _tx("SNIPER", -0.5, -10e6, sig=params[0])
                return {"slot": 9, "blockTime": bt, **res["transaction"]}
            second = InsiderWatch(s, db, pm, lambda m: CURVE, helius=SimpleNamespace(credits=0, rpc=rpc))
            second._watch = await second.targets()
            await second._read_back(second._watch, None)
            return second, calls, await _rows(db, real.id), await _rows(db, shadow.id)
        finally:
            await db.close()
    second, calls, real_rows, shadow_rows = asyncio.run(go())
    assert calls == ["getSignaturesForAddress", "getTransaction", "getTransaction"]
    assert [r["signature"] for r in real_rows] == ["OLD", "NEW"]                  # OLD was not counted again
    assert [round(r["cum_supply_pct"], 2) for r in real_rows] == [1.2, 2.2] and len(shadow_rows) == 2
    assert second.stats["read_back"] == 2


def test_the_stream_counts_its_helius_credits_and_stops_while_they_are_spent(s, monkeypatch):
    from bot.engine import Engine
    monkeypatch.setattr(insiders_mod, "RESUBSCRIBE_S", 0.0)

    async def go():
        db = await Database(s.DB_PATH).open()
        await _insiders_for(db, 1)
        helius, spent = SimpleNamespace(credits=10), {"on": False}
        book = SimpleNamespace(positions={1: _pos(1, "M1", "real")})
        w = InsiderWatch(s, db, book, {"M1": key("C1")}.get, helius=helius, paused=lambda: spent["on"])
        w._meter(connection=True)                                          # opening a connection: 1 credit
        assert (w.credits, helius.credits) == (1, 11)
        ws, stop = FakeWS(), asyncio.Event()
        task = asyncio.create_task(w._session(ws, stop))
        try:
            ws.nudge()
            await asyncio.sleep(0.05)
            ws.answer(1, 5)
            ws.inbox.put_nowait(json.dumps({"jsonrpc": "2.0", "method": "noop", "pad": "x" * 120_000}))
            await asyncio.sleep(0.05)
            assert (w.credits, helius.credits) == (3, 13)                  # 2 credits per 0.1 MB received
            spent["on"] = True                                             # the month's credits are spent
            ws.nudge()
            await asyncio.sleep(0.05)
            assert ws.sent[-1] == {"jsonrpc": "2.0", "id": 2, "method": "transactionUnsubscribe", "params": [5]}
            assert w.stats["watching"] == 0
            eng = SimpleNamespace(insider_watch=w, s=dataclasses.replace(s, HELIUS_API_KEY=""), _credits_exhausted=True)
            assert Engine._insider_note(eng) == ""                         # no key: the watch never runs
            eng.s = dataclasses.replace(s, HELIUS_API_KEY="k")
            assert Engine._insider_note(eng) == " | insider watch: paused, the month's Helius credits are spent"
            eng._credits_exhausted = False
            assert Engine._insider_note(eng).endswith(", 3 Helius credits since start")
        finally:
            stop.set()
            await asyncio.wait_for(task, 3)
            await db.close()
    asyncio.run(go())


def test_the_watch_does_not_start_without_a_key_or_when_switched_off(s):
    async def go():
        stop = asyncio.Event()
        stop.set()
        for k, on in (("", True), ("abc", False)):
            s2 = dataclasses.replace(s, HELIUS_API_KEY=k, INSIDER_WATCH=on)
            w = InsiderWatch(s2, None, SimpleNamespace(positions={}), lambda m: None,
                             connect=lambda *a, **k: (_ for _ in ()).throw(AssertionError("connected")))
            await asyncio.wait_for(w.run(stop), 1)
    asyncio.run(go())


def test_the_report_shows_what_selling_at_the_warning_would_have_done(s):
    t0 = 1_700_000_000.0

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            async def position(kind, cost, tokens, proceeds, closed_at=None):
                return await db.insert("positions", {"kind": kind, "mint": "x", "status": "closed", "cost_sol": cost,
                                                     "tokens_initial": tokens, "proceeds_sol": proceeds,
                                                     "pnl_sol": proceeds - cost, "entry_price": 1e-7,
                                                     "opened_at": t0, "closed_at": closed_at})

            async def fill(pid, ts, reason, price, tokens, sol):
                await db.insert("fills", {"position_id": pid, "ts": ts, "side": "sell", "reason": reason,
                                          "price": price, "tokens": tokens, "sol": sol, "fee_sol": 0.001})
            # a loser: insiders sold 0.6% then 2.4%; the stop sold everything later at 4e-8
            a = await position("shadow", 0.05, 500_000, 0.019, t0 + 300)
            await fill(a, t0 + 300, "stop_loss", 4e-8, 500_000, 0.019)
            # a winner: half sold at +60% first, the insiders sold 2.5% after it, the rest sold at 1.3e-7
            b = await position("shadow", 0.05, 500_000, 0.07, t0 + 600)
            await fill(b, t0 + 10, "take_profit", 1.6e-7, 250_000, 0.038)
            await fill(b, t0 + 600, "trailing_stop", 1.3e-7, 250_000, 0.032)
            c = await position("real", 0.1, 1e6, 0.05)                    # watched, no insider sold
            # a runner before the insiders sold: INSIDER_EXIT would have left it alone
            d = await position("shadow", 0.05, 500_000, 0.09, t0 + 900)
            await fill(d, t0 + 10, "take_profit", 1.6e-7, 250_000, 0.038)
            await fill(d, t0 + 20, "core_trailing_stop", 1.5e-7, 200_000, 0.028)
            await fill(d, t0 + 900, "runner_target", 1e-6, 50_000, 0.024)
            e = await position("shadow", 0.05, 500_000, 0.04, t0 + 100)   # an insider only bought
            for pid in (a, b, c, d, e):
                await db.insert("insider_watch", {"position_id": pid, "mint": "x", "kind": "shadow",
                                                  "started_at": t0 - 5})
            for pid, ts, side, price, cum in ((a, t0 + 60, "sell", 9e-8, 0.6), (a, t0 + 90, "buy", 9.5e-8, 0.0),
                                              (a, t0 + 120, "sell", 8e-8, 2.4), (b, t0 + 30, "sell", 1.2e-7, 2.5),
                                              (d, t0 + 30, "sell", 1e-7, 3.0), (e, t0 + 50, "buy", 1e-7, 0.0),
                                              (a, t0 + 900, "sell", 1e-9, 9.0)):   # after A closed: never counts
                await db.insert("insider_trades", {"position_id": pid, "mint": "x", "ts": ts, "side": side,
                                                   "wallet": "W", "roles": "sniper", "tokens": 1, "sol": 0.1,
                                                   "price": price, "cum_supply_pct": cum})
            await db.kv_set("insider_watch_error", json.dumps({"at": t0, "error": "Helius refused the trade "
                                                                               "subscription: Method not found"}))
            return await insider_summary(db, s)
        finally:
            await db.close()
    m = asyncio.run(go())
    assert m["closed"] == 5 and m["with_sells"] == 3 and m["acting"] is False
    rows = {r["threshold"]: r for r in m["rows"]}
    a_2 = exit_fill(500_000, 8e-8, s, urgent=True).sol            # A sells everything at its 2.4% sale
    b_2 = 0.038 + exit_fill(250_000, 1.2e-7, s, urgent=True).sol  # B keeps its take-profit, sells the rest
    r2 = rows[2.0]
    assert r2["n"] == 2 and r2["won_anyway"] == 1                  # D was a runner by then: left out
    assert r2["actual"] == pytest.approx((-0.031 / 0.05 + 0.02 / 0.05) / 2)
    assert r2["if_sold"] == pytest.approx((a_2 / 0.05 - 1 + b_2 / 0.05 - 1) / 2)
    assert r2["delta_sol"] == pytest.approx(a_2 - 0.019 + b_2 - 0.07)
    assert rows[0.5]["n"] == 2 and rows[3.0]["n"] == 0
    text = "\n".join(insider_lines(m))
    assert "== Insider sells after the buy (exits on them: off, watching only) ==" in text
    assert "5 watched positions closed, 3 saw an insider sell after the buy" in text
    assert "stream: Helius refused the trade subscription: Method not found (since 11-14 22:13 UTC)" in text
    assert ">= 2   % of supply" in text and ">= 3" not in text
    assert insider_lines({"enabled": False}) == []


def test_old_insider_rows_are_pruned_and_a_failed_prune_is_harmless(s):
    from bot.engine import INSIDER_KEEP_DAYS, Engine

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            old, new = time.time() - (INSIDER_KEEP_DAYS + 1) * 86400, time.time()
            for pid, closed in ((1, old), (2, new)):
                await db.insert("positions", {"id": pid, "kind": "shadow", "mint": "x", "status": "closed",
                                              "closed_at": closed})
                await db.insert("insider_watch", {"position_id": pid, "mint": "x", "kind": "shadow", "started_at": 0})
                await db.insert("insider_trades", {"position_id": pid, "mint": "x", "ts": closed, "side": "sell"})
            await Engine._prune_insiders(SimpleNamespace(db=db))
            left = [r["position_id"] for r in await db.fetchall("SELECT position_id FROM insider_trades")]
            watch = [r["position_id"] for r in await db.fetchall("SELECT position_id FROM insider_watch")]

            async def broken(*a, **k):
                raise RuntimeError("database is locked")
            await Engine._prune_insiders(SimpleNamespace(db=SimpleNamespace(execute=broken)))   # logged, not raised
            return left, watch
        finally:
            await db.close()
    assert asyncio.run(go()) == ([2], [2])


def test_a_coin_tracked_without_its_curve_key_gets_the_derived_one():
    from bot.engine import Engine
    from bot.feeds.pumpchain import bonding_curve_key
    from bot.ingest import MintState
    mint = "So11111111111111111111111111111111111111112"
    eng = SimpleNamespace(ingest=SimpleNamespace(mints={mint: MintState(mint=mint)}))
    assert Engine._curve_key_of(eng, mint) == bonding_curve_key(mint) == "6PiyjiAPkp2KdZtqkyQYzVsD1Prv7t8v4TaYd8ip4YFd"
    eng.ingest.mints[mint].graduated = True
    assert Engine._curve_key_of(eng, mint) is None and Engine._curve_key_of(eng, "unknown") is None
    assert bonding_curve_key("not a key") is None


def test_the_insider_settings_and_their_phone_bounds(s):
    validate_settings(s)
    assert (s.INSIDER_WATCH, s.INSIDER_EXIT, s.INSIDER_EXIT_SUPPLY_PCT, s.INSIDER_WATCH_MAX) == (True, False, 2.0, 60)
    for bad in ({"INSIDER_EXIT_SUPPLY_PCT": 0.05}, {"INSIDER_EXIT_SUPPLY_PCT": 51}, {"INSIDER_WATCH_MAX": 0},
                {"HELIUS_WS_URL": "ws://plain"}):
        with pytest.raises(ConfigError):
            validate_settings(dataclasses.replace(s, **bad))
    assert validate_set("INSIDER_EXIT", "true", s) == "true"
    assert validate_set("INSIDER_EXIT_SUPPLY_PCT", "3", s) == "3"
    for k, raw in (("INSIDER_EXIT_SUPPLY_PCT", "0.4"), ("INSIDER_EXIT_SUPPLY_PCT", "21"),
                   ("INSIDER_WATCH_MAX", "201"), ("HELIUS_WS_URL", "wss://evil")):
        with pytest.raises(OpsError):
            validate_set(k, raw, s)


def test_an_insider_sale_that_could_not_be_queued_is_retried_at_the_next_refresh(s, monkeypatch):
    monkeypatch.setattr(insiders_mod, "RESUBSCRIBE_S", 0.0)
    s.INSIDER_EXIT = True

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            pm, real, shadow = await _book(s, db)
            pm._entry_uncertain.add(real.id)                           # its buy is not settled yet
            w = InsiderWatch(s, db, pm, lambda m: CURVE)
            w._watch = await w.targets()
            await w.on_transaction(_tx("SNIPER", -1.2, -25e6, sig="DUMP"))
            waiting = real.pending_exit
            pm._entry_uncertain.discard(real.id)                       # settled: no further insider trade needed
            ws, stop = FakeWS(), asyncio.Event()
            task = asyncio.create_task(w._session(ws, stop))
            ws.nudge()
            await asyncio.sleep(0.05)
            stop.set()
            await asyncio.wait_for(task, 3)
            await pm.settle()
            return real, waiting, w
        finally:
            await db.close()
    real, waiting, w = asyncio.run(go())
    assert waiting is None and real.pending_exit == "emergency_insider_sell"
    assert w.stats["warnings"] == 2 and w.stats["exits"] == 2          # each position counted once


def test_why_finds_a_coin_by_its_address_and_shows_when_the_insider_warning_fired(tmp_path):
    """10 Oct: the INSIDER WARNING lines number positions (#1781), and /why 1781 opens decision #1781,
    another coin. /why also takes the coin's address or its first letters (case-sensitive, as
    addresses are), and shows the warning among the position's fills at the time it fired."""
    from bot.commands import TelegramCommands
    from bot.telegram import Telegram
    from tests.test_commands import FakeHttp, _settings as _cmd_settings
    s = _cmd_settings(tmp_path)
    mint, lower = "AgHydcPwLYjSxqJfENQ2UpSmv6XhNEyNneaojNyVpump", "aghydc" + "1" * 38
    t0 = 1_760_000_000.0                                              # 09 Oct 2025 08:53:20 UTC

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            for m, sym in ((lower, "LOW"), (mint, "AGH")):
                await db.insert("mints", {"mint": m, "symbol": sym, "created_at": t0 - 600})
            await db.insert("candidates", {"mint": lower, "ts": t0 - 100, "metrics": "{}", "status": "evaluated",
                                           "decision": "PASS", "mean_confidence": 0.5, "gate_reason": "low"})
            cid = await db.insert("candidates", {"mint": mint, "ts": t0 - 10, "metrics": "{}", "status": "evaluated",
                                                 "decision": "BUY", "mean_confidence": 0.7, "gate_reason": "ok"})
            ids = {}
            for kind in ("shadow", "real"):
                ids[kind] = await db.insert("positions", {
                    "kind": kind, "mode": "live", "mint": mint, "candidate_id": cid, "status": "closed",
                    "size_usd": 10.0, "cost_sol": 0.05, "entry_price": 1e-7, "tokens_initial": 5e5,
                    "proceeds_sol": 0.03, "pnl_usd": -4.0, "pnl_sol": -0.02, "exit_reason": "stop_loss",
                    "opened_at": t0, "closed_at": t0 + 300})
                await db.insert("fills", {"position_id": ids[kind], "ts": t0, "side": "buy", "reason": "entry",
                                          "price": 1e-7, "tokens": 5e5, "sol": 0.05})
                await db.insert("fills", {"position_id": ids[kind], "ts": t0 + 300, "side": "sell",
                                          "reason": "stop_loss", "price": 6e-8, "tokens": 5e5, "sol": 0.03})
                for dt, side, price, pct in ((60, "sell", 9e-8, 0.8), (120, "sell", 8.1e-8, 2.4),
                                             (150, "buy", 8.4e-8, 2.0), (200, "sell", 7e-8, 4.6)):
                    await db.insert("insider_trades", {"position_id": ids[kind], "mint": mint, "ts": t0 + dt,
                                                       "side": side, "wallet": "W", "roles": "top", "tokens": 1e7,
                                                       "sol": 0.3, "price": price, "cum_supply_pct": pct})
            tc = TelegramCommands(Telegram(FakeHttp([]), s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID), db, s)
            out = {}
            for arg in ("AgHydc", mint, f"#{cid}", "aghydc", "AgHyd", "AgHydz", "AgHyd0", str(ids["shadow"])):
                out[arg], _ = await tc.answer("why", arg)
            return cid, ids, out
        finally:
            await db.close()
    cid, ids, out = asyncio.run(go())
    assert ids["shadow"] == 1 and cid == 2                    # the shadow's number is the other coin's decision
    assert out[str(ids["shadow"])].startswith("#1 LOW aghydc")
    text = out["AgHydc"]
    assert text.startswith(f"#{cid} AGH {mint}") and out[mint] == text and out[f"#{cid}"] == text
    warning = ("  08:55:20Z insider warning: insiders' net sales since the buy reached 2.4% of the supply "
               "(x0.81 entry); at most 4.6% while watched, 3 insider sells")
    real_head = next(i for i, ln in enumerate(text.splitlines()) if ln.startswith("real $10.00 [live]: closed"))
    assert text.splitlines()[real_head + 1] == warning
    shadow = text.split("shadow $10: ")[1].splitlines()
    assert shadow[1].startswith("  08:53:20Z entry") and shadow[2] == warning
    assert shadow[3].startswith("  08:58:20Z stop loss @ 6.000e-08 (x0.6 entry)")
    assert out["aghydc"].startswith("#1 LOW")                      # addresses are case-sensitive
    assert out["AgHyd"].startswith("/why takes a decision number") and out["AgHyd0"] == out["AgHyd"]
    assert out["AgHydz"] == "no evaluated coin's address starts with AgHydz (addresses are case-sensitive)"
    from bot.commands import COMMANDS
    assert all(1 <= len(d) <= 256 for _, d in COMMANDS)            # setMyCommands refuses the menu otherwise
