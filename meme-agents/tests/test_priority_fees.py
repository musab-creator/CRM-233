"""9 Oct: a flat 0.004 SOL priority fee on every transaction was 9-22% of a $10 trade. Buys and
planned sells now pay PRIORITY_FEE_SOL, a stop loss, an emergency, the kill switch and a retried
sale URGENT_PRIORITY_FEE_SOL; the paper and shadow books charge what is sent. Live entries keep
one sale's fee in the wallet for each position already open, so up to 20 positions stay sellable."""
import asyncio
import dataclasses
import time

import pytest

from bot.config import ConfigError, validate_settings
from bot.db import Database
from bot.paper import PaperExecutor, exit_fill
from bot.positions import PositionManager, urgent_exit
from bot.risk import RiskManager
from tests.test_live_safety import MINT, FakeChain, FixedPrice, _executor


def test_which_sales_are_urgent():
    for reason in ("stop_loss", "kill_switch", "emergency_liquidity_drop", "emergency_rugcheck_danger",
                   "emergency_non_sol_quote"):
        assert urgent_exit(reason)
    for reason in ("take_profit", "trailing_stop", "time_stop", "core_trailing_stop", "core_time_stop",
                   "runner_target", "runner_time_stop", "runner_unfunded"):
        assert not urgent_exit(reason)
        assert urgent_exit(reason, attempts=1)                 # a retried sale must land


def test_settings_keep_the_fees_ordered_and_inside_the_spend_check(s):
    validate_settings(s)
    assert (s.PRIORITY_FEE_SOL, s.URGENT_PRIORITY_FEE_SOL, s.NETWORK_FEE_SOL) == (0.001, 0.004, 0.005)
    for changes in ({"PRIORITY_FEE_SOL": 0.0}, {"PRIORITY_FEE_SOL": 0.003, "URGENT_PRIORITY_FEE_SOL": 0.002},
                    {"URGENT_PRIORITY_FEE_SOL": 0.0045}, {"NETWORK_FEE_SOL": 0.004}):
        with pytest.raises(ConfigError):
            validate_settings(dataclasses.replace(s, **changes))


def test_pumpportal_is_sent_the_fee_for_the_trade(s):
    async def go():
        chain = FakeChain(sol=1.0)
        db, http, ex = await _executor(s, chain)
        try:
            def bought(c):
                c.sol -= 0.0512
                c.tok[MINT] = 480_000.0
            ex.rpc.effect = bought
            f = await ex.buy(MINT, 0.05, 1e-7)
            await ex.acknowledge_fill(MINT, "buy", f.tx_sig)          # as PositionManager does once recorded
            assert http.posts[-1][1]["priorityFee"] == 0.001
            ex.rpc.effect = lambda c: c.tok.__setitem__(MINT, 240_000.0)
            f = await ex.sell(MINT, 240_000.0, 1e-7, fraction=0.5)
            await ex.acknowledge_fill(MINT, "sell", f.tx_sig)
            assert http.posts[-1][1]["priorityFee"] == 0.001         # a planned sale
            ex.rpc.effect = lambda c: c.tok.__setitem__(MINT, 0.0)
            await ex.sell(MINT, 240_000.0, 1e-7, fraction=1.0, urgent=True)
            assert len(http.posts) == 3 and http.posts[-1][1]["priorityFee"] == 0.004   # a stop loss or emergency
        finally:
            await db.close()
    asyncio.run(go())


class Recording(PaperExecutor):
    def __init__(self, s, fails=0):
        super().__init__(s)
        self.fails, self.urgent = fails, []

    async def sell(self, mint, tokens, price, fraction=1.0, urgent=False):
        self.urgent.append(urgent)
        if len(self.urgent) <= self.fails:
            raise RuntimeError("rpc down")
        return exit_fill(tokens, price, self.s, urgent)


async def _manager(s, executor, bankroll="0.5"):
    db = await Database(s.DB_PATH).open()
    await db.kv_set("bankroll_sol", bankroll)
    return db, PositionManager(s, db, RiskManager(s, 0), executor, FixedPrice())


def test_take_profit_pays_the_planned_fee_and_the_stop_loss_the_urgent_one(s):
    async def go():
        ex = Recording(s)
        db, pm = await _manager(s, ex)
        try:
            p = await pm.create("M", 1, "real", "C", 5.0, None)
            await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
            tokens = p.tokens_initial
            await pm.on_tick("M", 1.6e-7, p.decided_at + 2, {})       # take-profit: half
            await pm.on_tick("M", 0.59e-7, p.decided_at + 3, {})      # -41%: stop loss on the rest
            assert ex.urgent == [False, True] and p.exit_reason == "stop_loss"
            planned = exit_fill(tokens / 2, 1.6e-7, s).sol
            assert planned - exit_fill(tokens / 2, 1.6e-7, s, urgent=True).sol == pytest.approx(0.003)
        finally:
            await db.close()
    asyncio.run(go())


def test_a_sale_retried_after_a_failure_pays_the_urgent_fee(s):
    async def go():
        ex = Recording(s, fails=1)
        db, pm = await _manager(s, ex)
        try:
            p = await pm.create("M", 1, "real", "C", 5.0, None)
            t0 = time.time()
            await pm.on_tick("M", 1e-7, t0, {})
            await pm.on_tick("M", 1.6e-7, t0 + 1, {})                 # take-profit fails once
            assert ex.urgent == [False] and p.exit_attempts == 1
            await pm.on_tick("M", 1.6e-7, t0 + 7, {})                 # retried after the backoff
            assert ex.urgent == [False, True] and p.tp_done
        finally:
            await db.close()
    asyncio.run(go())


class Wallet:
    def __init__(self, sol):
        self.sol = sol

    async def balance_sol(self, pubkey):
        return self.sol


class LiveWallet(PaperExecutor):
    mode, dry_run, pubkey = "live", False, "pk"

    def __init__(self, s, sol):
        super().__init__(s)
        self.chain = Wallet(sol)


def test_live_entries_keep_a_sale_fee_for_each_open_position(s):
    async def go():
        s.MAX_OPEN_POSITIONS = 20
        # $5 at $100/SOL = 0.05 SOL. A buy needs 0.05 * 1.015 + 0.005 network + 0.0025 rent, plus one
        # sale's fee (0.005) for every position held, itself included; a pending buy holds 0.055 of cash
        db, pm = await _manager(s, LiveWallet(s, 0.122))
        try:
            assert await pm.create("A", 1, "real", "C1", 5.0, None)          # needs 0.06325 of 0.122
            # 0.067 SOL left: enough for the buy alone, not for it plus the two sales' fees (0.06825)
            assert await pm.create("B", 2, "real", "C2", 5.0, None) is None
            pm.executor.chain.sol = 0.124
            assert await pm.create("B", 2, "real", "C2", 5.0, None)
        finally:
            await db.close()
    asyncio.run(go())


def test_paper_can_hold_more_than_ten_positions_when_allowed(s):
    async def go():
        s.MAX_OPEN_POSITIONS = 15
        db, pm = await _manager(s, PaperExecutor(s), bankroll="5")
        try:
            for i in range(15):
                assert await pm.create(f"M{i}", i, "real", f"C{i}", 5.0, None)
            assert await pm.create("M15", 15, "real", "C15", 5.0, None) is None    # the 16th waits for a slot
        finally:
            await db.close()
    asyncio.run(go())


class LiveRecorder(PaperExecutor):
    """Live mode (sales run off the tick path through _live_exit), paper fills, kwargs recorded."""
    mode = "live"

    def __init__(self, s):
        super().__init__(s)
        self.sells = []

    async def sell(self, mint, tokens, price, fraction=1.0, **kw):
        self.sells.append(kw)
        return exit_fill(tokens, price, self.s, kw.get("urgent", False))


def test_live_sales_carry_the_urgent_flag_through(s):
    async def go():
        ex = LiveRecorder(s)
        db, pm = await _manager(s, ex)
        try:
            p = await pm.create("M", 1, "real", "C", 5.0, None)
            await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
            await pm.drain(2)
            await pm.on_tick("M", 1.6e-7, p.decided_at + 2, {})       # take-profit: planned
            await pm.drain(2)
            await pm.on_tick("M", 0.59e-7, p.decided_at + 3, {})      # stop loss: urgent
            await pm.drain(2)
            assert ex.sells == [{}, {"urgent": True}] and p.exit_reason == "stop_loss"
        finally:
            await db.close()
    asyncio.run(go())


def test_an_emergency_takes_over_a_queued_planned_sale(s):
    async def go():
        ex = LiveRecorder(s)
        db, pm = await _manager(s, ex)
        try:
            p = await pm.create("M", 1, "real", "C", 5.0, None)
            await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
            await pm.drain(2)
            await pm.queue_exit(p, "time_stop")                       # queued, waiting for the next trade
            assert p.pending_exit == "time_stop" and ex.sells == []
            await pm.queue_exit(p, "emergency_liquidity_drop")        # sells now, with the urgent fee
            await pm.drain(2)
            assert ex.sells == [{"urgent": True}] and p.exit_reason == "emergency_liquidity_drop"
        finally:
            await db.close()
    asyncio.run(go())


def test_the_stop_loss_takes_over_a_queued_planned_sale(s):
    async def go():
        ex = Recording(s)
        db, pm = await _manager(s, ex)
        try:
            p = await pm.create("M", 1, "real", "C", 5.0, None)
            await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
            await pm.queue_exit(p, "time_stop")
            await pm.on_tick("M", 0.59e-7, p.decided_at + 2, {})      # the next trade is below the stop
            assert ex.urgent == [True] and p.exit_reason == "stop_loss"
        finally:
            await db.close()
    asyncio.run(go())
