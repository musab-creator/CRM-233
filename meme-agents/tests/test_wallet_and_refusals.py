"""10 Oct: the operator, phone-only, asked for the live wallet's balance in /status, and for a word when
the risk check turns a gate BUY away (it was only logged, so a BUY could vanish without a trace)."""
import asyncio
import json
import time
from types import SimpleNamespace

from bot.db import Database
from bot.engine import Engine
from bot.paper import PaperExecutor
from bot.positions import PositionManager
from bot.risk import RiskManager
from bot.status import build_status
from tests.test_paper import FixedPrice


def test_a_refused_gate_buy_is_told_once_per_kind_every_15_minutes(s, monkeypatch):
    clock = [1_000_000.0]
    monkeypatch.setattr("bot.positions.now_s", lambda: clock[0])
    s.MAX_OPEN_POSITIONS = 1

    async def go():
        db = await Database(s.DB_PATH).open()
        sent = []

        async def notify(text):
            sent.append(text)
        try:
            await db.kv_set("bankroll_sol", "0.15")
            await db.execute("INSERT INTO mints (mint, symbol) VALUES ('MINT2', 'TWO')")
            pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(), notifier=notify)
            assert await pm.create("MINT1", 1, "real", "C1", 10.0, 10_000)        # $10 = 0.1 SOL at $100
            assert await pm.create("MINT2", 2, "real", "C2", 10.0, 10_000) is None
            for i, dt in enumerate((60, 120)):                                     # the same refusal again
                clock[0] += dt
                assert await pm.create(f"MINT{3 + i}", 3 + i, "real", f"C{3 + i}", 10.0, 10_000) is None
            assert await pm.create("SHADOW", 9, "shadow", "C9", 5.0, 10_000)       # shadows are never refused
            await pm.settle()
            told = list(sent)
            s.MAX_OPEN_POSITIONS = 5                                               # another kind: told at once
            assert await pm.create("MINT5", 5, "real", "C5", 10.0, 10_000) is None
            assert await pm.create("MINT7", 7, "real", "C7", 8.0, 10_000) is None   # other numbers, same kind
            s.MAX_OPEN_POSITIONS = 1
            clock[0] += 721                                                        # 15 min after the first notice
            assert await pm.create("MINT6", 6, "real", "C6", 10.0, 10_000) is None
            await pm.settle()
            events = await db.fetchall("SELECT detail FROM events WHERE kind='risk_block'")
            return told, sent[len(told):], events
        finally:
            await db.close()
    told, later, events = asyncio.run(go())
    assert told == ["⚪ NO ENTRY TWO [paper] $10.00: risk check: max open positions (1)\nMINT2"]
    # 0.15 SOL bankroll - (0.1 SOL + 0.005 network fee) tied in #1 = 0.045 left, the buy needs 0.105
    assert later[0] == "⚪ NO ENTRY MINT5 [paper] $10.00: risk check: insufficient bankroll (0.0450 SOL < 0.1050 SOL)\nMINT5"
    assert later[1] == ("⚪ NO ENTRY MINT6 [paper] $10.00: risk check: max open positions (1)\n"
                        "2 more gate BUYs refused for this since the last notice\nMINT6")
    assert len(later) == 2 and len(events) == 6                                    # every refusal is still logged


def test_status_shows_the_live_wallet_and_warns_above_the_startup_limit(s):
    now = time.time()
    s.MODE, s.LIVE_MAX_WALLET_SOL = "live", 3.0

    async def status(hb):
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("heartbeat", json.dumps({"ts": now, "started_at": now - 60, **hb}))
            return await build_status(db, s)
        finally:
            await db.close()
    text = asyncio.run(status({"mode": "live", "wallet_sol": 1.25, "wallet_at": now - 600, "sol_usd": 150.0}))
    assert "wallet: 1.2500 SOL (~$187.50), read 10m ago" in text and "startup limit" not in text
    text = asyncio.run(status({"mode": "live", "wallet_sol": 3.2, "wallet_at": now - 30, "sol_usd": 150.0}))
    assert ("wallet: 3.2000 SOL (~$480.00), read 30s ago; above the 3 SOL startup limit (LIVE_MAX_WALLET_SOL): "
            "the next restart or /update starts with live entries locked until SOL is moved out") in text
    assert "wallet: not read yet" in asyncio.run(status({"mode": "live"}))
    s.MODE = "paper"
    assert "wallet:" not in asyncio.run(status({"mode": "paper", "wallet_sol": 1.0, "wallet_at": now}))


def test_the_engine_reads_the_live_wallet_every_5_minutes_and_keeps_the_last_good_read(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr("bot.engine.now_s", lambda: clock[0])

    class Helius:
        calls, fail = 0, False

        async def balance_sol(self, pubkey):
            assert pubkey == "PUB"
            self.calls += 1
            if self.fail:
                raise RuntimeError("rpc down")
            return 1.25 + self.calls / 100

    eng = SimpleNamespace(executor=SimpleNamespace(mode="live", pubkey="PUB"), helius=Helius(),
                          _credits_exhausted=False, _wallet=None)

    def beat(at):
        clock[0] = at
        asyncio.run(Engine._read_wallet(eng))
        return eng.helius.calls, eng._wallet
    assert beat(1000) == (1, (1.26, 1000))
    assert beat(1100) == (1, (1.26, 1000))                  # not again within 5 minutes
    eng.helius.fail = True
    assert beat(1300) == (2, (1.26, 1000))                  # a failed read keeps the last one, with its time
    eng.helius.fail = False
    assert beat(1360) == (3, (1.28, 1360))                  # ... and the next beat tries again
    eng._credits_exhausted = True
    assert beat(2000) == (3, (1.28, 1360))                  # no chain reads once the month's credits are spent
    eng._credits_exhausted, eng.executor = False, SimpleNamespace(mode="paper")
    assert beat(3000) == (3, (1.28, 1360))                  # paper mode has no wallet
