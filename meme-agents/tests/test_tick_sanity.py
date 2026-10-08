"""One bad price must not book a paper exit: the tick guard, the SOL-quoted DexScreener mark,
the fill lines in /why, and the report's exclusion of shadows that were booked at a spike."""
import asyncio

import pytest

from bot.config import ConfigError, validate_settings
from bot.db import Database
from bot.feeds.dexscreener import WSOL, sol_price_native
from bot.paper import PaperExecutor
from bot.positions import PositionManager
from bot.report import build_report, render_text, shadow_extremes, spiked_shadow_count
from bot.risk import RiskManager
from bot.util import now_s
from tests.test_paper import FixedPrice


async def _open(s, dex=None, kind="shadow"):
    db = await Database(s.DB_PATH).open()
    await db.kv_set("bankroll_sol", "0.5")
    pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(), dex=dex)
    p = await pm.create("M", 1, kind, "C", 5.0, 10_000)
    await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
    assert p.status == "open" and p.entry_price == 1e-7
    return db, pm, p


def test_a_spike_tick_is_held_and_books_nothing(s):
    async def go():
        db, pm, p = await _open(s)
        t = p.decided_at
        await pm.on_tick("M", 8e-5, t + 2, {"txType": "buy", "signature": "sig1"})   # 800x: held
        assert p.status == "open" and not p.tp_done and p.last_price == 1e-7 and p.peak_price == 1e-7
        await pm.on_tick("M", 1.1e-7, t + 3, {})                                       # normal again
        assert p.last_price == 1.1e-7 and not p.tp_done and p.id not in pm._suspect
        fills = await db.fetchall("SELECT side FROM fills WHERE position_id=?", [p.id])
        assert [f["side"] for f in fills] == ["buy"]
        await db.close()
    asyncio.run(go())


def test_a_second_tick_near_the_first_confirms_a_real_move(s):
    async def go():
        db, pm, p = await _open(s)
        t = p.decided_at
        await pm.on_tick("M", 3e-6, t + 2, {})          # 30x: held
        assert not p.tp_done
        await pm.on_tick("M", 2.5e-6, t + 4, {})        # second tick within 3x of it: confirmed, take-profit
        assert p.tp_done and p.last_price == 2.5e-6
        # a crash is confirmed the same way, and the stop then fires
        await pm.on_tick("M", 1e-9, t + 5, {})
        assert p.status == "open"
        await pm.on_tick("M", 1.2e-9, t + 6, {})
        assert p.status == "closed" and p.exit_reason == "stop_loss"
        await db.close()
    asyncio.run(go())


def test_the_confirmation_window_closes(s):
    async def go():
        db, pm, p = await _open(s)
        t = p.decided_at
        await pm.on_tick("M", 3e-6, t + 2, {})
        await pm.on_tick("M", 3e-6, t + 2 + 301, {})     # too late to confirm the first: held again
        assert not p.tp_done and p.last_price == 1e-7
        await db.close()
    asyncio.run(go())


def test_factor_zero_disables_the_guard(s):
    s.TICK_SANITY_FACTOR = 0

    async def go():
        db, pm, p = await _open(s)
        await pm.on_tick("M", 8e-5, p.decided_at + 2, {})
        assert p.tp_done
        await db.close()
    asyncio.run(go())


def test_factor_must_be_above_one_or_zero(s):
    s.TICK_SANITY_FACTOR = 1.0
    with pytest.raises(ConfigError):
        validate_settings(s)
    s.TICK_SANITY_FACTOR = 0
    validate_settings(s)


def test_dexscreener_mark_needs_a_sol_quoted_pair():
    usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    assert sol_price_native({"priceNative": "0.0002", "quoteToken": {"address": usdc}}) is None
    assert sol_price_native({"priceNative": "1e-7"}) is None
    assert sol_price_native({"priceNative": "1e-7", "quoteToken": {"address": WSOL}}) == 1e-7
    assert sol_price_native({"priceNative": "0", "quoteToken": {"address": WSOL}}) is None
    assert sol_price_native(None) is None


def test_usdc_quoted_dexscreener_pair_never_marks_a_position(s):
    class Dex:
        def __init__(self):
            self.quote = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

        async def tokens(self, mints):
            return {m: {"priceNative": "2e-5", "liquidity": {"usd": 10_000}, "quoteToken": {"address": self.quote}}
                    for m in mints}

    async def go():
        dex = Dex()
        db, pm, p = await _open(s, dex=dex)
        p.last_tick_at -= 3600
        await pm.periodic()
        assert p.last_price == 1e-7 and not p.tp_done         # USDC price ignored outright
        dex.quote = WSOL
        pm._last_liq_poll = 0
        await pm.periodic()
        assert p.last_price == 1e-7 and p.id in pm._suspect    # SOL-quoted but 200x: held
        pm._last_liq_poll = 0
        await pm.periodic()
        assert p.tp_done                                        # the next poll confirms it
        await db.close()
    asyncio.run(go())


async def _spiked_book(db):
    """Two closed shadows: one real -40% stop, one booked at an 800x spike then a trailing stop."""
    t = now_s()
    await db.insert("mints", {"mint": "A" * 32, "symbol": "REAL", "created_at": t - 9000})
    await db.insert("mints", {"mint": "B" * 32, "symbol": "PAIR", "created_at": t - 9000})
    ca = await db.insert("candidates", {"mint": "A" * 32, "ts": t - 8000, "metrics": "{}", "status": "evaluated",
                                        "decision": "PASS", "mean_confidence": 0.6, "gate_reason": "PASS from scout"})
    cb = await db.insert("candidates", {"mint": "B" * 32, "ts": t - 8000, "metrics": "{}", "status": "evaluated",
                                        "decision": "PASS", "mean_confidence": 0.6, "gate_reason": "PASS from scout"})
    for cid, agent in ((ca, "analyst"), (cb, "analyst")):
        await db.insert("votes", {"candidate_id": cid, "mint": "x", "agent": agent, "vote": "BUY",
                                  "confidence": 0.7, "ts": t})
    pa = await db.insert("positions", {"kind": "shadow", "mode": "paper", "mint": "A" * 32, "candidate_id": ca,
                                       "creator": "C", "status": "closed", "size_usd": 5.0, "cost_sol": 0.05,
                                       "proceeds_sol": 0.03, "pnl_sol": -0.02, "pnl_usd": -2.0,
                                       "exit_reason": "stop_loss", "entry_price": 1e-7, "last_price": 0.6e-7,
                                       "opened_at": t - 7000, "closed_at": t - 6000})
    pb = await db.insert("positions", {"kind": "shadow", "mode": "paper", "mint": "B" * 32, "candidate_id": cb,
                                       "creator": "C", "status": "closed", "size_usd": 5.0, "cost_sol": 0.05,
                                       "proceeds_sol": 19.7, "pnl_sol": 19.65, "pnl_usd": 1965.0,
                                       "exit_reason": "trailing_stop", "entry_price": 1.48e-6, "last_price": 1.31e-6,
                                       "opened_at": t - 7000, "closed_at": t - 6760})
    await db.insert("fills", {"position_id": pa, "ts": t - 7000, "side": "buy", "reason": "entry", "price": 1e-7,
                              "tokens": 480_000, "sol": 0.055})
    await db.insert("fills", {"position_id": pa, "ts": t - 6000, "side": "sell", "reason": "stop_loss",
                              "price": 0.6e-7, "tokens": 480_000, "sol": 0.03})
    await db.insert("fills", {"position_id": pb, "ts": t - 7000, "side": "buy", "reason": "entry", "price": 1.48e-6,
                              "tokens": 32_000, "sol": 0.055})
    await db.insert("fills", {"position_id": pb, "ts": t - 6800, "side": "sell", "reason": "take_profit",
                              "price": 1.2e-3, "tokens": 16_000, "sol": 19.68})
    await db.insert("fills", {"position_id": pb, "ts": t - 6760, "side": "sell", "reason": "trailing_stop",
                              "price": 1.31e-6, "tokens": 16_000, "sol": 0.02})
    await db.insert_trades([("sig", "B" * 32, "T", "buy", 0.6, 500.0, 1.2e-3, None, None, None, "pump", t - 6799)])
    return ca, cb


def test_report_leaves_out_shadows_booked_at_a_spike(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _spiked_book(db)
            assert await spiked_shadow_count(db) == 1
            ex = await shadow_extremes(db)
            assert ex["n"] == 1 and ex["best"][0]["symbol"] == "REAL"
            r = await build_report(db, s)
        finally:
            await db.close()
        return r
    r = asyncio.run(go())
    assert r["shadow_spiked"] == 1 and r["shadow"]["closed_trades"] == 1
    assert r["shadow"]["pnl_usd"] == pytest.approx(-2.0)
    assert r["agents"]["analyst"]["shadow_scored"] == 1 and r["agents"]["analyst"]["buy_winners"] == 0
    assert all(row["n"] <= 1 for row in r["gate_sweep"])
    text = render_text(r)
    assert "excluded 1 shadows whose exit was booked at a price spike" in text
    assert "+39300%" not in text and "PAIR       cand" not in text


def test_why_lists_every_fill_and_flags_the_spike(tmp_path):
    from bot.commands import TelegramCommands
    from bot.telegram import Telegram
    from tests.test_commands import FakeHttp, _msg, _settings as _cmd_settings
    s = _cmd_settings(tmp_path)

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            ca, cb = await _spiked_book(db)
            http = FakeHttp([[_msg(1, f"/why {cb}"), _msg(2, f"/why {ca}")]])
            tc = TelegramCommands(Telegram(http, s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID), db, s)
            await tc.poll_once()
        finally:
            await db.close()
        return [j["text"] for m, j in http.posts if m == "sendMessage"]
    spiked, real = asyncio.run(go())
    assert "shadow $5: +$1965.00 (+39300%) · trailing stop" in spiked
    assert "entry @ 1.480e-06 · 32,000 tokens · 0.0550 SOL" in spiked
    assert "take profit @ 1.200e-03 (x810.8 entry) · 16,000 tokens · 19.6800 SOL" in spiked
    assert "⚠️ price spike: nearest stored trade buy 0.6000 SOL / 500 tokens = 1.200e-03 (pump)" in spiked
    assert "trailing stop @ 1.310e-06 (x0.8851 entry)" in spiked and spiked.count("⚠️") == 1
    assert "stop loss @ 6.000e-08 (x0.6 entry)" in real and "⚠️" not in real
