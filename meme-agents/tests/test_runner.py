"""The runner: after a take-profit, the core's trailing or time stop keeps RUNNER_FRACTION of the
original tokens when the sales cover the entry cost; the runner then exits on its target, its hold
limit, the stop loss or an emergency, and does not hold one of the position slots."""
import asyncio
import sqlite3

import pytest
from solders.keypair import Keypair

from bot.config import ConfigError, validate_settings
from bot.db import SCHEMA, Database
from bot.exits import ExitState, check_exit
from bot.live.executor import LiveExecutor
from bot.ops import OpsError, validate_set
from bot.paper import Fill, PaperExecutor
from bot.positions import PositionManager
from bot.risk import RiskManager
from bot.status import build_status
from tests.test_live_executor import FakeHttp, FakeRpc, unsigned_tx
from tests.test_paper import FixedPrice

RUNNER_COLUMNS = ("runner_fraction", "runner_target_multiple", "runner_max_hold_hours", "runner_active")


def _runner(s, **kw):
    s.RUNNER_ENABLED, s.RUNNER_FRACTION, s.RUNNER_TARGET_MULTIPLE = True, 0.10, 5.0
    s.TAKE_PROFIT_PCT, s.TAKE_PROFIT_SELL_FRACTION, s.TRAILING_STOP_PCT, s.STOP_LOSS_PCT = 60, 0.5, 30, 40
    for k, v in kw.items():
        setattr(s, k, v)
    return s


async def _open(s, kind="shadow", mint="M"):
    db = await Database(s.DB_PATH).open()
    await db.kv_set("bankroll_sol", "0.5")
    pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice())
    p = await pm.create(mint, 1, kind, "C", 10.0, 10_000)
    await pm.on_tick(mint, 1e-7, p.decided_at + 1, {})
    assert p.status == "open" and p.entry_price == 1e-7
    return db, pm, p


def _state(**kw):
    base = dict(entry_price=1e-7, peak_price=2e-7, tp_done=True, opened_at=0.0, runner_fraction=0.1,
                runner_target_multiple=300.0, runner_max_hold_hours=168.0, tokens_initial=1e7,
                tokens_remaining=5e6, cost_sol=1.0, proceeds_sol=0.8)
    base.update(kw)
    return ExitState(**base)


def test_exit_rules_with_a_runner_policy(s):
    _runner(s)
    # the core's trailing stop keeps 10% of the original tokens when the sales cover the cost
    sig = check_exit(_state(), 1.3e-7, 100, s)        # selling 4M tokens at 1.3e-7 brings ~0.52 SOL
    assert sig.reason == "core_trailing_stop" and sig.fraction == pytest.approx(0.8)
    # ... and sells everything when they would not
    assert check_exit(_state(proceeds_sol=0.1), 1.3e-7, 100, s).reason == "trailing_stop"
    assert check_exit(_state(proceeds_sol=0.1), 1.3e-7, 100, s).fraction == 1.0
    # without a runner policy nothing changes
    assert check_exit(_state(runner_fraction=0.0), 1.3e-7, 100, s).reason == "trailing_stop"
    # the time stop with no fresh price values the core at the last mark
    sig = check_exit(_state(last_price=1.3e-7), None, 7 * 3600, s)
    assert sig.reason == "core_time_stop" and sig.fraction == pytest.approx(0.8)
    # an active runner: no trailing stop, only the loss stop, its hold limit, its target, emergencies
    run = _state(runner_active=True, tokens_remaining=1e6, proceeds_sol=1.5)
    assert check_exit(run, 1.05e-7, 100, s) is None                       # far below its peak of 2e-7
    assert check_exit(run, 0.59e-7, 100, s).reason == "stop_loss"
    assert check_exit(run, 1e-7, 168 * 3600, s).reason == "runner_time_stop"
    assert check_exit(run, 3e-5, 100, s).reason == "runner_target"
    assert check_exit(run, 1e-7, 100, s, rug_danger=True).reason == "emergency_rugcheck_danger"
    assert check_exit(_state(runner_active=True, entry_liq_usd=1000), 1e-7, 100, s,
                      liq_usd=100).reason == "emergency_liquidity_drop"


def test_a_winner_keeps_a_runner_that_sells_at_its_target(s):
    async def go():
        db, pm, p = await _open(_runner(s))
        assert p.runner_fraction == 0.10 and p.runner_target_multiple == 5.0
        t, start = p.decided_at, p.tokens_initial
        await pm.on_tick("M", 1.7e-7, t + 2, {})                          # +70%: take-profit sells half
        assert p.tp_done and p.tokens_remaining == pytest.approx(start * 0.5)
        await pm.on_tick("M", 2.5e-7, t + 3, {})                          # new peak
        await pm.on_tick("M", 1.6e-7, t + 4, {})                          # -36% from the peak: core sale
        assert p.status == "open" and p.runner_active == 1 and p.pending_exit is None
        assert p.tokens_remaining == pytest.approx(start * 0.10)
        assert p.proceeds_sol >= p.cost_sol
        await pm.on_tick("M", 1.1e-7, t + 5, {})                          # far below the peak: kept
        assert p.status == "open" and p.runner_active == 1
        await pm.on_tick("M", 5.1e-7, t + 6, {})                          # 5.1x the entry: target
        assert p.status == "closed" and p.exit_reason == "runner_target"
        fills = await db.fetchall("SELECT reason FROM fills WHERE position_id=? ORDER BY id", [p.id])
        assert [f["reason"] for f in fills] == ["entry", "take_profit", "core_trailing_stop", "runner_target"]
        await db.close()
    asyncio.run(go())


def test_no_runner_when_the_sales_do_not_cover_the_cost(s):
    async def go():
        db, pm, p = await _open(_runner(s, TAKE_PROFIT_PCT=10))
        t = p.decided_at
        await pm.on_tick("M", 1.1e-7, t + 2, {})                          # +10%: take-profit sells half
        await pm.on_tick("M", 0.75e-7, t + 3, {})                         # trailing stop at a loss overall
        assert p.status == "closed" and p.exit_reason == "trailing_stop" and not p.runner_active
        await db.close()
    asyncio.run(go())


def test_the_runner_stops_at_the_loss_stop_and_its_hold_limit(s):
    async def go():
        db, pm, p = await _open(_runner(s))
        t = p.decided_at
        for i, price in enumerate((1.7e-7, 2.5e-7, 1.6e-7)):
            await pm.on_tick("M", price, t + 2 + i, {})
        assert p.runner_active == 1
        await pm.on_tick("M", 0.59e-7, t + 10, {})                        # 41% below the entry
        assert p.status == "closed" and p.exit_reason == "stop_loss"
        await db.close()
    asyncio.run(go())
    s2 = _runner(s)
    run = _state(runner_active=True, opened_at=1000.0, runner_max_hold_hours=2.0)
    assert check_exit(run, None, 1000 + 7199, s2) is None
    assert check_exit(run, None, 1000 + 7200, s2).reason == "runner_time_stop"


def test_a_partial_core_receipt_sells_the_rest_of_the_core_only(s):
    async def go():
        db, pm, p = await _open(_runner(s))
        t, start = p.decided_at, p.tokens_initial
        await pm.on_tick("M", 1.7e-7, t + 2, {})
        p.peak_price = 2.5e-7
        # a live receipt that sold only part of the core: the rest stays queued, the runner untouched
        part = Fill("sell", 1.6e-7, 1.6e-7, start * 0.2, p.cost_sol * 0.4, 0.0, remaining_tokens=start * 0.3)
        await pm._apply_exit(p, part, 0.8, 1.6e-7, t + 4, "core_trailing_stop")
        assert p.status == "open" and not p.runner_active and p.pending_exit == "core_trailing_stop"
        assert p.pending_exit_fraction == pytest.approx(2 / 3)
        rest = Fill("sell", 1.6e-7, 1.6e-7, start * 0.2, p.cost_sol * 0.4, 0.0, remaining_tokens=start * 0.1)
        await pm._apply_exit(p, rest, 2 / 3, 1.6e-7, t + 5, "core_trailing_stop")
        assert p.runner_active == 1 and p.pending_exit is None and p.tokens_remaining == pytest.approx(start * 0.1)
        await db.close()
    asyncio.run(go())


def test_a_short_receipt_sells_the_runner_too(s):
    async def go():
        db, pm, p = await _open(_runner(s))
        t, start = p.decided_at, p.tokens_initial
        await pm.on_tick("M", 1.7e-7, t + 2, {})
        short = Fill("sell", 1.6e-7, 1.6e-7, start * 0.4, 0.0001, 0.0, remaining_tokens=start * 0.1)
        await pm._apply_exit(p, short, 0.8, 1.6e-7, t + 4, "core_trailing_stop")
        assert not p.runner_active and p.pending_exit == "runner_unfunded" and p.pending_exit_fraction == 1.0
        await pm.on_tick("M", 1.6e-7, t + 5, {})
        assert p.status == "closed" and p.exit_reason == "runner_unfunded"
        await db.close()
    asyncio.run(go())


def test_a_stop_replaces_a_queued_core_sale(s):
    async def go():
        db, pm, p = await _open(_runner(s))
        await pm.on_tick("M", 1.7e-7, p.decided_at + 2, {})
        p.pending_exit, p.pending_exit_fraction = "core_trailing_stop", 0.8
        await pm.queue_exit(p, "stop_loss")
        assert p.pending_exit == "stop_loss" and p.pending_exit_fraction == 1.0
        await db.close()
    asyncio.run(go())


def test_the_policy_is_recorded_when_a_position_is_created(s):
    async def go():
        db, pm, p = await _open(_runner(s, RUNNER_TARGET_MULTIPLE=7.0))
        s.RUNNER_ENABLED, s.RUNNER_TARGET_MULTIPLE = False, 50.0          # changed later from the phone
        q = await pm.create("N", 2, "shadow", "D", 10.0, 10_000)
        assert q.runner_fraction == 0.0 and q.runner_target_multiple is None
        assert pm._state(p).runner_target_multiple == 7.0                 # the open one keeps its own
        again = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice())
        await again.load()
        loaded = again.positions[p.id]
        assert loaded.runner_fraction == 0.10 and loaded.runner_target_multiple == 7.0
        await db.close()
    asyncio.run(go())


def test_an_older_database_gains_the_runner_columns(s):
    conn = sqlite3.connect(s.DB_PATH)
    conn.executescript(SCHEMA)
    for col in RUNNER_COLUMNS:
        conn.execute(f"ALTER TABLE positions DROP COLUMN {col}")
    conn.execute("INSERT INTO positions (mint, kind, mode, creator, status, decided_at, size_usd, sol_in) "
                 "VALUES ('M', 'real', 'paper', 'C', 'open', 1, 10, 0.1)")
    conn.commit()
    conn.close()

    async def go():
        db = await Database(s.DB_PATH).open()
        row = await db.fetchone("SELECT * FROM positions WHERE mint='M'")
        await db.close()
        return row
    row = asyncio.run(go())
    assert row["runner_fraction"] == 0 and row["runner_active"] == 0 and row["runner_target_multiple"] is None


def test_a_runner_does_not_hold_a_position_slot(s):
    s.MAX_OPEN_POSITIONS = 1
    risk = RiskManager(s, 0)
    runners = [{"status": "open", "creator": f"C{i}", "runner_active": 1} for i in range(4)]
    assert risk.can_open("X", runners, 1.0, 0.1) == (True, "ok")
    ok, why = risk.can_open("X", runners + [{"status": "open", "creator": "Y", "runner_active": 0}], 1.0, 0.1)
    assert not ok and "max open positions" in why


def test_settings_and_phone_bounds(s):
    _runner(s)
    validate_settings(s)
    for key, value, message in (("RUNNER_FRACTION", 0.3, "between 0.01 and 0.25"),
                                ("RUNNER_TARGET_MULTIPLE", 1.0, "greater than 1"),
                                ("RUNNER_MAX_HOLD_HOURS", 5.0, "longer than TIME_STOP_HOURS"),
                                ("TAKE_PROFIT_SELL_FRACTION", 0.9, "stay below 1")):
        bad = _runner(type(s)())
        setattr(bad, key, value)
        with pytest.raises(ConfigError, match=message):
            validate_settings(bad)
    off = type(s)()
    off.RUNNER_MAX_HOLD_HOURS = 5.0                                       # irrelevant while the runner is off
    validate_settings(off)
    assert validate_set("RUNNER_ENABLED", "on") == "true"
    assert validate_set("RUNNER_TARGET_MULTIPLE", "300") == "300"
    for key, raw in (("RUNNER_FRACTION", "0.5"), ("RUNNER_TARGET_MULTIPLE", "5000"), ("RUNNER_MAX_HOLD_HOURS", "0")):
        with pytest.raises(OpsError):
            validate_set(key, raw)
    # cross-field rules apply against the running settings
    with pytest.raises(OpsError):
        validate_set("RUNNER_MAX_HOLD_HOURS", "2", current=_runner(type(s)()))


def test_a_runner_sale_goes_through_pumpportal_after_graduation(s):
    s.JUPITER_API_KEY = "jup-test"

    async def go():
        db = await Database(s.DB_PATH).open()
        kp = Keypair()
        http = FakeHttp(unsigned_tx(kp))
        ex = LiveExecutor(s, db, http, kp, is_graduated=lambda m: True)
        await ex.rpc.close()
        ex.rpc = FakeRpc()
        jupiter = []

        async def build_jupiter(*a, **k):
            jupiter.append(a)
            raise RuntimeError("Jupiter would refuse an order this small")
        ex.build_jupiter = build_jupiter
        with pytest.raises(RuntimeError):
            await ex.sell("MintAddr", 1000.0, 1e-7)                       # graduated: Jupiter by default
        f = await ex.sell("MintAddr", 1000.0, 1e-7, prefer_pumpportal=True)
        url, body = http.posts[-1]
        assert url.endswith("/api/trade-local") and body["pool"] == "auto" and body["action"] == "sell"
        assert len(jupiter) == 1 and f.tx_sig
        await db.close()
    asyncio.run(go())


def test_status_marks_a_runner(s):
    async def go():
        db, pm, p = await _open(_runner(s), kind="real")
        t = p.decided_at
        for i, price in enumerate((1.7e-7, 2.5e-7, 1.6e-7)):
            await pm.on_tick("M", price, t + 2 + i, {})
        assert p.runner_active == 1
        text = await build_status(db, s)
        await db.close()
        return text
    text = asyncio.run(go())
    assert "🏃 RUNNER 10% of the tokens" in text and "target 5x" in text
