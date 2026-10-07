"""The hourly Telegram digest and its setting."""
import asyncio

import pytest

from bot.config import ConfigError, load_settings
from bot.db import Database
from bot.digest import fmt_hold, hour_start, hourly_digest, usd

H = 3600.0
T0 = 1_791_300_000.0  # 2026-10-06 ~16:00 UTC


def test_hour_start_and_formatting():
    assert hour_start(T0 + 1234) == hour_start(T0) and hour_start(T0 + H) - hour_start(T0) == H
    assert fmt_hold(59) == "0m" and fmt_hold(25 * 60) == "25m" and fmt_hold(72 * 60 + 30) == "1h12m"
    assert usd(2.1) == "+$2.10" and usd(-2) == "-$2.00" and usd(0) == "+$0.00"


def test_hourly_digest_lists_wins_first_then_open_positions(tmp_path):
    s = load_settings(tmp_path / "none.env", overrides={"DB_PATH": str(tmp_path / "d.db"), "LOG_FILE": ""})
    since = hour_start(T0)
    until = since + H

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            for mint, sym in (("M1", "BUMP"), ("M2", "PIT"), ("M3", "ALLY"), ("M4", None)):
                await db.insert("mints", {"mint": mint, "symbol": sym, "created_at": since})
            base = {"kind": "real", "mode": "paper", "creator": "C", "size_usd": 5.0, "sol_in": 0.04,
                    "decided_at": since, "entry_price": 1e-7, "tokens_initial": 1e6}
            await db.insert("positions", {**base, "mint": "M2", "status": "closed", "opened_at": since + 100,
                                          "closed_at": since + 1600, "cost_sol": 0.04, "proceeds_sol": 0.024,
                                          "pnl_sol": -0.016, "pnl_usd": -2.0, "exit_reason": "stop_loss"})
            await db.insert("positions", {**base, "mint": "M1", "status": "closed", "opened_at": since - 3000,
                                          "closed_at": since + 1500, "cost_sol": 0.04, "proceeds_sol": 0.0568,
                                          "pnl_sol": 0.0168, "pnl_usd": 2.1, "exit_reason": "take_profit"})
            # closed in the previous hour: not this hour's, but part of today's totals
            await db.insert("positions", {**base, "mint": "M4", "status": "closed", "opened_at": since - 4000,
                                          "closed_at": since - 10, "cost_sol": 0.04, "proceeds_sol": 0.05,
                                          "pnl_sol": 0.01, "pnl_usd": 1.2, "exit_reason": "time_stop"})
            await db.insert("positions", {**base, "mint": "M3", "status": "open", "opened_at": until - 34 * 60,
                                          "cost_sol": 0.04, "tokens_remaining": 1e6, "last_price": 1.12e-7})
            await db.insert("positions", {**base, "mint": "M4", "status": "pending"})
            await db.insert("positions", {**base, "mint": "M1", "kind": "shadow", "status": "closed",
                                          "closed_at": since + 10, "pnl_usd": 50})  # shadows never appear
            for i in range(3):
                await db.insert("candidates", {"mint": f"M{i + 1}", "ts": since + 60 * i, "status": "evaluated",
                                               "decision": "BUY" if i == 0 else "PASS"})
            await db.insert("ledger", {"kind": "llm", "ts": since + 5, "day": "2026-10-06", "month": "2026-10",
                                       "usd": 4.1})
            return await hourly_digest(db, s, since, until)
        finally:
            await db.close()

    text, wins = asyncio.run(go())
    lines = text.split("\n")
    assert wins == 1
    assert lines[0].startswith("meme-agents ") and "UTC (paper)" in lines[0]
    assert lines[1] == "✅ WIN +$2.10 (+42%) BUMP · take profit · held 1h15m"
    assert lines[2] == "❌ LOSS -$2.00 (-40%) PIT · stop loss · held 25m"
    assert lines[3] == "open 2: ALLY $5 +12% (34m), M4 $5 entry pending"
    assert lines[4] == "this hour: 3 candidates, 1 gate BUY"
    assert lines[5].startswith("today: 3 closed, 2 wins, PnL +$1.30 · LLM $4.10/5 · X $0.00/20")


def test_hourly_digest_quiet_hour(tmp_path):
    s = load_settings(tmp_path / "none.env", overrides={"DB_PATH": str(tmp_path / "q.db"), "LOG_FILE": ""})

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            return await hourly_digest(db, s, hour_start(T0), hour_start(T0) + H)
        finally:
            await db.close()

    text, wins = asyncio.run(go())
    assert wins == 0 and "no trades closed this hour" in text and "open: none" in text


def test_digest_mode_is_validated(tmp_path):
    assert load_settings(tmp_path / "none.env", overrides={"TELEGRAM_DIGEST": "Wins"}).TELEGRAM_DIGEST == "wins"
    with pytest.raises(ConfigError):
        load_settings(tmp_path / "none.env", overrides={"TELEGRAM_DIGEST": "hourly"})
