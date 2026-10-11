"""9 Oct: GIGACHAD's stop filled at -44% because a held coin's curve was read every 15 s at best, in
the same queue as thousands of launches, and a decided buy waited for that read too. Real positions
now have their own loop (POSITION_POLL_S, 2 s), and a graduated position is marked from DexScreener
every POSITION_DEX_POLL_S (10 s) instead of once a minute."""
import asyncio
import dataclasses
import time

import pytest

from bot.config import ConfigError, validate_settings
from bot.db import Database
from bot.engine import Engine
from bot.feeds.dexscreener import WSOL
from bot.feeds.pumpchain import Curve
from bot.ingest import MintState
from bot.ops import OpsError, validate_set
from bot.paper import PaperExecutor
from bot.positions import PositionManager
from bot.risk import RiskManager
from tests.test_paper import FixedPrice


class Chain:
    enabled = True

    def __init__(self):
        self.asked: list[list[str]] = []
        self.curve = {}

    async def curves(self, keys):
        self.asked.append(list(keys))
        return {k: self.curve[k] for k in keys if k in self.curve}


def _curve(v_sol):
    return Curve(8e8, v_sol, 5e8, v_sol - 30.0, 1e9, False)


def test_real_positions_are_read_on_their_own_loop_and_their_stop_acts_on_the_next_read(s):
    async def go():
        eng = Engine(s)
        await eng.db.open()
        try:
            await eng.db.kv_set("bankroll_sol", "5")
            chain = eng.chain = Chain()
            pm = eng.positions = PositionManager(s, eng.db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(),
                                                 curve_liquidity=eng._curve_liquidity)
            eng.ingest.tick_handlers.append(pm.on_tick)
            for mint, key in (("REAL", "KR"), ("SHADOW", "KS"), ("LAUNCH", "KL")):
                eng.ingest.mints[mint] = MintState(mint=mint, bonding_curve_key=key, v_sol=40.0, v_tokens=8e8,
                                                   curve_at=time.time() - 30, real_sol=10.0)
                chain.curve[key] = _curve(40.0)
            real = await pm.create("REAL", 1, "real", "C", 10.0, None)
            await pm.create("SHADOW", 2, "shadow", "C2", 10.0, None)
            chain.curve["KR"] = _curve(41.0)                     # a trade after the decision
            assert await eng.poll_position_curves_once() == 1
            assert chain.asked == [["KR"]]                      # shadows and launches stay on the launch poller
            assert real.status == "open" and real.entry_price == pytest.approx(41.0 / 8e8)
            chain.curve["KR"] = _curve(24.0)                     # -41%: the next read sells
            await eng.poll_position_curves_once()
            assert real.status == "closed" and real.exit_reason == "stop_loss"
            assert await eng.poll_position_curves_once() == 0   # nothing held: no call, no credit
            assert len(chain.asked) == 2
            # a buy decided on a quiet curve fills at the next read, not at the next trade
            quiet = await pm.create("REAL", 3, "real", "C", 10.0, None)
            await eng.poll_position_curves_once()
            assert quiet.status == "open" and quiet.entry_price == pytest.approx(24.0 / 8e8)
        finally:
            await eng.db.close()
            await eng.http.aclose()
    asyncio.run(go())


def test_the_position_loop_is_off_at_zero_and_slows_down_when_credits_run_ahead(s):
    async def go():
        s.POSITION_POLL_S = 0
        eng = Engine(s)
        eng.chain = Chain()
        eng.stop.set()
        await asyncio.wait_for(eng.position_price_poller(), 1)
        assert eng.chain.asked == []
        await eng.http.aclose()
    asyncio.run(go())


class Pools:
    def __init__(self, price):
        self.price, self.calls = price, 0

    async def token_pair_lists(self, mints):
        self.calls += 1
        return {m: [{"dexId": "pumpswap", "pairAddress": "Pool", "quoteToken": {"address": WSOL},
                     "priceNative": str(self.price), "liquidity": {"usd": 50_000}}] for m in mints}


def test_a_graduated_real_position_is_marked_from_dexscreener_every_few_seconds(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("bankroll_sol", "5")
            dex = Pools(2e-7)
            pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(), dex=dex,
                                 curve_liquidity=lambda m: None)          # graduated: no curve to read
            real = await pm.create("G", 1, "real", "C", 10.0, None)
            shadow = await pm.create("H", 2, "shadow", "C2", 10.0, None)
            t0 = time.time()
            await pm.on_tick("G", 1e-7, real.decided_at + 1, {})
            await pm.on_tick("H", 1e-7, shadow.decided_at + 1, {})
            real.last_tick_at = shadow.last_tick_at = t0 - 30
            await pm._mark_graduated(t0)
            assert real.last_price == pytest.approx(2e-7) and real.tp_done      # +100%: the take-profit acted
            assert shadow.last_price == pytest.approx(1e-7)                     # shadows keep the minute poll
            calls = dex.calls
            await pm._mark_graduated(t0 + 5)                                    # inside POSITION_DEX_POLL_S
            assert dex.calls == calls
            dex.price = 1.5e-7
            real.last_tick_at = t0
            await pm._mark_graduated(t0 + 11)
            assert real.last_price == pytest.approx(1.5e-7)
        finally:
            await db.close()
    asyncio.run(go())


def test_marks_are_written_only_when_they_change(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("bankroll_sol", "5")
            pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice())
            p = await pm.create("M", 1, "shadow", "C", 10.0, None)
            await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
            written, depth = [], [0]
            real = db.executemany

            async def spy(sql, rows):                       # Database.executemany re-enters itself in its transaction
                if sql.startswith("UPDATE positions SET last_price") and not depth[0]:
                    written.append(len(rows))
                depth[0] += 1
                try:
                    await real(sql, rows)
                finally:
                    depth[0] -= 1
            db.executemany = spy
            await pm.periodic()
            await pm.periodic()                                                 # nothing moved
            await pm.on_tick("M", 1.1e-7, p.decided_at + 5, {})
            await pm.periodic()
            row = await db.fetchone("SELECT last_price FROM positions WHERE id=?", [p.id])
            return written, row["last_price"]
        finally:
            await db.close()
    written, last = asyncio.run(go())
    assert written == [1, 0, 1] and last == pytest.approx(1.1e-7)


def test_the_poll_settings_and_their_phone_bounds(s):
    validate_settings(s)
    assert (s.POSITION_POLL_S, s.POSITION_DEX_POLL_S) == (2.0, 10.0)
    for bad in ({"POSITION_POLL_S": 0.5}, {"POSITION_POLL_S": 61}, {"POSITION_DEX_POLL_S": 3}):
        with pytest.raises(ConfigError):
            validate_settings(dataclasses.replace(s, **bad))
    validate_settings(dataclasses.replace(s, POSITION_POLL_S=0, POSITION_DEX_POLL_S=0))
    assert validate_set("POSITION_POLL_S", "1", s) == "1"
    assert validate_set("CURVE_POLL_CALLS_PER_MIN", "30", s) == "30"
    assert validate_set("CURVE_HOT_POLL_S", "5", s) == "5"
    for key, raw in (("POSITION_POLL_S", "0.5"), ("POSITION_POLL_S", "16"), ("CURVE_POLL_CALLS_PER_MIN", "61"),
                     ("CURVE_HOT_POLL_S", "2")):
        with pytest.raises(OpsError):
            validate_set(key, raw, s)


def test_a_slow_rugcheck_pass_no_longer_holds_up_the_position_loop(s):
    """Rugcheck reads every open position, shadows included, two requests each at 2 a second: with a
    hundred open shadows a pass took minutes, inside the 2 s position loop. It runs beside it now."""
    class SlowRug:
        def __init__(self):
            self.calls, self.gate = [], asyncio.Event()

        async def check(self, mint, max_age_s=0):
            self.calls.append(mint)
            await self.gate.wait()
            return {"danger": [], "risks": []}

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("bankroll_sol", "5")
            rug = SlowRug()
            pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(), rugcheck=rug)
            shadow = await pm.create("SHADOW", 1, "shadow", "C1", 10.0, None)
            real = await pm.create("REAL", 2, "real", "C2", 10.0, None)
            await pm.on_tick("SHADOW", 1e-7, shadow.decided_at + 1, {})
            await pm.on_tick("REAL", 1e-7, real.decided_at + 1, {})
            await asyncio.wait_for(pm.periodic(), 1)            # returns although Rugcheck hangs
            await asyncio.sleep(0)
            assert rug.calls == ["REAL"]                        # real positions are checked first
            real.opened_at -= s.TIME_STOP_HOURS * 3600 + 1
            await asyncio.wait_for(pm.periodic(), 1)            # the time stop is not held up ...
            assert real.pending_exit == "time_stop"
            await pm.on_tick("REAL", 1e-7, time.time() + 1, {})  # ... and fills on the next read
            assert real.status == "closed" and real.exit_reason == "time_stop"
            rug.gate.set()
            await pm.settle()
            assert rug.calls == ["REAL", "SHADOW"]
        finally:
            await db.close()
    asyncio.run(go())


def test_a_slow_telegram_no_longer_holds_up_the_next_stop(s):
    """Each entry and exit notice waited up to 10 s for Telegram inside the position lock, so in a
    fast dump the second position's stop waited behind the first one's message."""
    sent, gate = [], asyncio.Event()

    async def slow_telegram(text):
        await gate.wait()
        sent.append(text)

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("bankroll_sol", "5")
            pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(), notifier=slow_telegram)
            a = await pm.create("A", 1, "real", "C1", 10.0, None)
            b = await pm.create("B", 2, "real", "C2", 10.0, None)
            t0 = time.time()
            await pm.on_tick("A", 1e-7, t0 + 1, {})
            await pm.on_tick("B", 1e-7, t0 + 1, {})
            await asyncio.wait_for(pm.on_tick("A", 0.5e-7, t0 + 2, {}), 1)    # A's stop: its notice waits
            await asyncio.wait_for(pm.on_tick("B", 0.5e-7, t0 + 3, {}), 1)    # B's stop is not held behind it
            assert a.exit_reason == b.exit_reason == "stop_loss"
            assert sent == []
            gate.set()
            await pm.settle()
        finally:
            await db.close()
    asyncio.run(go())
    assert [x.split(" ")[0] for x in sent] == ["🟢", "🟢", "❌", "❌"]                 # in order, none lost
    assert "LOSS A" in sent[2] and "LOSS B" in sent[3]
    assert "· filled 1s after the decision" in sent[0]                                # the buy's latency is shown
