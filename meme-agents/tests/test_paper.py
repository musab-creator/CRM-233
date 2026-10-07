import asyncio

import pytest

from bot.db import Database
from bot.paper import PaperExecutor, entry_fill, exit_fill, mark_to_market
from bot.positions import PositionManager
from bot.risk import RiskManager


def test_entry_fill_math(s):
    f = entry_fill(1.0, 1e-7, s)
    # 1.5% fees, 3% slippage, 0.005 SOL network
    assert f.exec_price == pytest.approx(1.03e-7)
    assert f.tokens == pytest.approx(0.985 / 1.03e-7)
    assert f.sol == pytest.approx(1.005)
    assert f.fee_sol == pytest.approx(0.015 + 0.005)


def test_exit_fill_math(s):
    f = exit_fill(1_000_000, 1e-7, s)
    gross = 1_000_000 * 1e-7 * 0.95
    assert f.sol == pytest.approx(gross * 0.985 - 0.005)
    assert f.fee_sol == pytest.approx(gross * 0.015 + 0.005)


def test_round_trip_at_flat_price_loses_costs(s):
    e = entry_fill(0.05, 2e-7, s)
    x = exit_fill(e.tokens, 2e-7, s)
    pnl = x.sol - e.sol
    expected = 0.05 * 0.985 / 1.03 * 0.95 * 0.985 - 0.005 - 0.05 - 0.005
    assert pnl == pytest.approx(expected)
    assert pnl < 0


def test_costs_are_config(s):
    s.ENTRY_SLIPPAGE_PCT = s.EXIT_SLIPPAGE_PCT = s.PUMPFUN_FEE_PCT = s.PUMPPORTAL_FEE_PCT = 0
    s.NETWORK_FEE_SOL = 0
    e = entry_fill(1.0, 1e-7, s)
    assert exit_fill(e.tokens, 1e-7, s).sol == pytest.approx(1.0)
    assert mark_to_market(0, 1e-7, s) == 0


def test_invalid_inputs(s):
    with pytest.raises(ValueError):
        entry_fill(0, 1e-7, s)
    with pytest.raises(ValueError):
        exit_fill(10, 0, s)


class FixedPrice:
    def get(self):
        return 100.0


async def _manager(s):
    db = await Database(s.DB_PATH).open()
    await db.kv_set("bankroll_sol", "0.5")
    pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice())
    return db, pm


def test_entry_fills_at_next_trade_after_decision_and_partial_tp(s):
    async def go():
        db, pm = await _manager(s)
        p = await pm.create("M", 1, "real", "C", 10.0, 10_000)
        assert p.status == "pending" and p.sol_in == pytest.approx(0.1)
        # a tick stamped before the decision must not fill
        await pm.on_tick("M", 1e-7, p.decided_at - 1, {})
        assert p.status == "pending"
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        assert p.status == "open" and p.entry_price == 1e-7
        assert p.cost_sol == pytest.approx(0.105)
        tokens = p.tokens_initial
        await pm.on_tick("M", 1.6e-7, p.decided_at + 2, {})  # +60% -> sell half
        assert p.tp_done and p.tokens_remaining == pytest.approx(tokens / 2)
        await pm.on_tick("M", 2.0e-7, p.decided_at + 3, {})  # new peak
        await pm.on_tick("M", 1.41e-7, p.decided_at + 4, {})  # -29.5% from peak: hold
        assert p.status == "open"
        await pm.on_tick("M", 1.39e-7, p.decided_at + 5, {})  # -30.5% from peak: trailing stop
        assert p.status == "closed" and p.exit_reason == "trailing_stop"
        expected = (exit_fill(tokens / 2, 1.6e-7, s).sol + exit_fill(tokens / 2, 1.39e-7, s).sol) - 0.105
        assert p.pnl_sol == pytest.approx(expected)
        assert p.pnl_usd == pytest.approx(expected * 100)
        fills = await db.fetchall("SELECT side, reason FROM fills ORDER BY id")
        assert [f["reason"] for f in fills] == ["entry", "take_profit", "trailing_stop"]
        await db.close()
    asyncio.run(go())


def test_risk_limits_block_entries(s):
    async def go():
        db, pm = await _manager(s)
        assert await pm.create("A", 1, "real", "C1", 5.0, None)
        assert await pm.create("B", 2, "real", "C1", 5.0, None) is None  # same creator
        assert await pm.create("B", 2, "real", "C2", 5.0, None)
        assert await pm.create("D", 3, "real", "C3", 5.0, None)
        assert await pm.create("E", 4, "real", "C4", 5.0, None) is None  # max 3 open
        assert await pm.create("E", 4, "shadow", "C4", 5.0, None)        # shadows ignore limits
        await db.close()
    asyncio.run(go())


def test_daily_loss_cap_pauses(s):
    async def go():
        db, pm = await _manager(s)
        s.BANKROLL_USD = 10  # cap = $5
        p = await pm.create("A", 1, "real", "C1", 10.0, None)
        await pm.on_tick("A", 1e-7, p.decided_at + 1, {})
        await pm.on_tick("A", 0.5e-7, p.decided_at + 2, {})  # -50% -> stop loss, ~-$5.6
        assert p.exit_reason == "stop_loss"
        assert pm.risk.paused_reason and "daily loss cap" in pm.risk.paused_reason
        assert await pm.create("B", 2, "real", "C2", 5.0, None) is None
        await db.close()
    asyncio.run(go())


def test_kill_switch_closes_positions_and_blocks_entries(s, tmp_path):
    async def go():
        db, pm = await _manager(s)
        p = await pm.create("A", 1, "real", "C1", 5.0, None)
        await pm.on_tick("A", 1e-7, p.decided_at + 1, {})
        (tmp_path / "STOP").write_text("")
        await pm.periodic()
        assert p.pending_exit == "kill_switch"
        await pm.on_tick("A", 1.1e-7, p.decided_at + 5, {})
        assert p.status == "closed" and p.exit_reason == "kill_switch"
        assert await pm.create("B", 2, "real", "C2", 5.0, None) is None
        await db.close()
    asyncio.run(go())


def test_silent_stream_falls_back_to_dexscreener_mark(s):
    class Dex:
        def __init__(self):
            self.price, self.liq = "1e-7", 10_000

        async def tokens(self, mints):
            return {m: {"priceNative": self.price, "liquidity": {"usd": self.liq}} for m in mints}

    async def go():
        db = await Database(s.DB_PATH).open()
        await db.kv_set("bankroll_sol", "0.5")
        dex = Dex()
        pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(), dex=dex)
        p = await pm.create("M", 1, "real", "C", 5.0, 10_000)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        p.last_tick_at -= 3600  # no stream ticks for an hour
        dex.price = "0.5e-7"    # -50% on DexScreener
        await pm.periodic()
        assert p.status == "closed" and p.exit_reason == "stop_loss"
        await db.close()
    asyncio.run(go())


def test_liquidity_drop_queues_emergency_exit(s):
    class Dex:
        async def tokens(self, mints):
            return {m: {"priceNative": "1e-7", "liquidity": {"usd": 4_000}} for m in mints}

    async def go():
        db = await Database(s.DB_PATH).open()
        await db.kv_set("bankroll_sol", "0.5")
        pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(), dex=Dex())
        p = await pm.create("M", 1, "real", "C", 5.0, 10_000)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        await pm.periodic()
        assert p.pending_exit == "emergency_liquidity_drop"
        await pm.on_tick("M", 0.9e-7, p.decided_at + 10, {})
        assert p.status == "closed" and p.exit_reason == "emergency_liquidity_drop"
        await db.close()
    asyncio.run(go())


def test_curve_depth_drives_the_liquidity_exit_when_dexscreener_has_none(s):
    """Bonding-curve pairs carry no DexScreener liquidity: a drained curve must still trigger
    the emergency exit, measured the same way as the entry liquidity (2 x real SOL x SOL/USD)."""
    class Dex:
        async def tokens(self, mints):
            return {m: {"dexId": "pumpfun", "priceNative": "1e-7"} for m in mints}  # no liquidity field

    depth = {"M": 9_000.0}

    async def go():
        db = await Database(s.DB_PATH).open()
        await db.kv_set("bankroll_sol", "0.5")
        pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(), dex=Dex(),
                             curve_liquidity=depth.get)
        p = await pm.create("M", 1, "real", "C", 5.0, 9_000)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        await pm.periodic()
        assert p.status == "open" and not p.pending_exit and p.last_liq_usd == 9_000
        depth["M"] = 4_400.0  # the dev pulled more than half the SOL out of the curve
        pm._last_liq_poll = 0
        await pm.periodic()
        assert p.pending_exit == "emergency_liquidity_drop"
        await db.close()
    asyncio.run(go())
