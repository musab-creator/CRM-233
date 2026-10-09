"""9 Oct: "I'm looking for the 500x". The shadow book closes every evaluated coin at the bot's exits
within hours, so a coin that went 100x days later showed up nowhere. The tracker watches each one
for MOONSHOT_TRACK_DAYS and the report says which went 10x/100x/500x and what the bot did."""
import asyncio
import dataclasses

import pytest

from bot.commands import TelegramCommands
from bot.config import ConfigError, validate_settings
from bot.db import Database
from bot.feeds.dexscreener import WSOL
from bot.feeds.http import HttpError
from bot.moonshots import NEVER_LISTED_MISSES, MoonshotTracker, advance, reading
from bot.ops import OpsError, validate_set
from bot.report import build_report, render_text
from bot.telegram import Telegram

USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
DAY = 86400.0
T0 = 1_760_000_000.0


def pair(mint, price, liq=10_000.0, quote=WSOL, sol_usd=200.0, supply=1e9):
    return {"chainId": "solana", "pairAddress": f"P{mint}{quote[:4]}{liq}", "baseToken": {"address": mint},
            "quoteToken": {"address": quote}, "priceNative": str(price), "priceUsd": str(price * sol_usd),
            "liquidity": {"usd": liq}, "marketCap": price * sol_usd * supply}


def test_a_reading_is_the_deepest_pool_quoted_in_sol():
    r = reading([pair("M", 9e-6, liq=50_000, quote=USDC),        # a USDC pool's native price is not in SOL
                 pair("M", 2e-6, liq=3_000), pair("M", 3e-6, liq=40_000)])
    assert r["price"] == 3e-6
    assert r["mcap_usd"] == pytest.approx(3e-6 * 200 * 1e9) and r["sol_usd"] == pytest.approx(200)
    assert r["supply"] == pytest.approx(1e9)
    assert reading([pair("M", 9e-6, quote=USDC)]) is None and reading([]) is None


def _row(**kw):
    base = {"peak_price": None, "peak_at": None, "peak_mcap_usd": None, "prev_price": None, "last_price": None,
            "last_mcap_usd": None, "last_at": None, "first_at": None, "supply": None, "polls": 0, "readings": 0,
            "misses": 0, "alerted_at": None, "done": 0}
    return {**base, **kw}


def test_a_peak_needs_two_reads_in_a_row():
    def r(price):
        return {"price": price, "mcap_usd": price * 2e11, "sol_usd": 200.0, "supply": 1e9}
    row = advance(_row(), r(1e-6), 1)
    assert row["peak_price"] is None and row["first_at"] == 1          # one read confirms nothing
    row = advance(row, r(5e-5), 2)                                      # a one-poll spike to 50x ...
    row = advance(row, r(1e-6), 3)
    assert row["peak_price"] == 1e-6                                    # ... never counts
    row = advance(row, r(3e-5), 4)
    row = advance(row, r(4e-5), 5)                                      # two reads at 30x or more
    assert row["peak_price"] == 3e-5 and row["peak_at"] == 5
    assert row["peak_mcap_usd"] == pytest.approx(3e-5 * 200 * 1e9)
    row = advance(row, None, 6)                                         # an empty read keeps the chain
    assert (row["misses"], row["last_price"], row["peak_price"]) == (1, 4e-5, 3e-5)
    row = advance(row, r(4e-5), 7)
    assert row["peak_price"] == 4e-5 and row["misses"] == 0 and row["readings"] == 6


class Dex:
    def __init__(self, prices):
        self.prices, self.calls, self.fail = prices, [], False

    async def token_pair_lists(self, mints):
        self.calls.append(list(mints))
        if self.fail:
            raise HttpError(503, "down")
        return {m: [pair(m, self.prices[m])] if m in self.prices else [] for m in mints}


async def _seed(db, cid, mint, opened_at, decision="PASS", gate_reason="2 of 3 BUY", entry=1e-7,
                shadow_peak=None, shadow_exit="trailing_stop", shadow_pnl=0.01, symbol=None):
    await db.execute("INSERT OR IGNORE INTO mints (mint, symbol) VALUES (?,?)", [mint, symbol or mint])
    await db.insert("candidates", {"id": cid, "mint": mint, "ts": opened_at, "metrics": {}, "status": "evaluated",
                                   "decision": decision, "gate_reason": gate_reason})
    await db.insert("positions", {"mint": mint, "candidate_id": cid, "kind": "shadow", "status": "closed",
                                  "opened_at": opened_at, "closed_at": opened_at + 3600, "entry_price": entry,
                                  "peak_price": shadow_peak or entry * 1.5, "last_price": entry,
                                  "cost_sol": 0.05, "pnl_sol": shadow_pnl, "pnl_usd": shadow_pnl * 200,
                                  "exit_reason": shadow_exit, "sol_usd_entry": 200.0})


def test_the_tracker_watches_each_coin_once_alerts_once_and_stops_after_the_window(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _seed(db, 1, "OLD", T0 - 15 * DAY)              # outside the 14 days: never tracked
            await _seed(db, 2, "MOON", T0 - 3600)
            await _seed(db, 3, "MOON", T0 - 1800)                 # evaluated again: still one coin, first price
            await _seed(db, 4, "DUD", T0 - 600)
            dex = Dex({"MOON": 2e-7, "DUD": 5e-8})
            sent = []

            async def notify(text):
                sent.append(text)
            tr = MoonshotTracker(s, db, dex, notify)
            tr.gap_s = 0
            first = await tr.poll_once(T0)
            assert first["added"] == 2 and first["due"] == 2 and first["priced"] == 2
            assert sorted(dex.calls[0]) == ["DUD", "MOON"]
            row = await db.fetchone("SELECT * FROM moonshots WHERE mint='MOON'")
            assert (row["candidate_id"], row["ref_price"], row["ref_at"]) == (2, 1e-7, T0 - 3600)
            assert await tr.poll_once(T0 + 60) == {"added": 0, "due": 0, "priced": 0, "failed": 0, "alerts": 0}
            dex.prices["MOON"] = 2e-5                              # 200x the price the bot saw
            await tr.poll_once(T0 + 900)
            assert sent == []                                      # one read: not confirmed yet
            dex.prices["MOON"] = 1.5e-5
            await tr.poll_once(T0 + 1800)
            assert len(sent) == 1 and "MOON reached 150x the price the bot saw" in sent[0]
            assert "committee PASS (2 of 3 BUY)" in sent[0] and "mint MOON" in sent[0]
            assert "(~$20.0k -> ~$3.00M market cap), 1.5h after it was seen." in sent[0]
            dex.prices["MOON"] = 4e-5
            await tr.poll_once(T0 + 2700)
            await tr.poll_once(T0 + 3600)
            assert len(sent) == 1                                  # alerted once per coin
            assert (await db.fetchone("SELECT peak_price p FROM moonshots WHERE mint='MOON'"))["p"] == 4e-5
            await tr.poll_once(T0 + 15 * DAY)
            return await db.fetchall("SELECT mint, done FROM moonshots ORDER BY mint")
        finally:
            await db.close()
    assert asyncio.run(go()) == [{"mint": "DUD", "done": 1}, {"mint": "MOON", "done": 1}]


def test_coins_older_than_a_day_are_read_every_fourth_pass(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _seed(db, 1, "AGED", T0 - 2 * DAY)
            await _seed(db, 2, "NEW", T0 - 600)
            dex = Dex({"AGED": 1e-7, "NEW": 1e-7})
            tr = MoonshotTracker(s, db, dex)
            tr.gap_s = 0
            due = [(await tr.poll_once(T0 + k * 900))["due"] for k in range(5)]
            return due
        finally:
            await db.close()
    assert asyncio.run(go()) == [2, 1, 1, 1, 2]


def test_a_coin_dexscreener_never_prices_is_dropped_and_an_outage_keeps_every_row(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _seed(db, 1, "GHOST", T0 - 600)
            await _seed(db, 2, "LIVE", T0 - 600)
            dex = Dex({"LIVE": 1e-7})
            tr = MoonshotTracker(s, db, dex)
            tr.gap_s = 0
            dex.fail = True
            out = await tr.poll_once(T0)
            assert out["failed"] == 1 and out["priced"] == 0
            assert (await db.fetchone("SELECT polls FROM moonshots WHERE mint='LIVE'"))["polls"] == 0
            dex.fail = False
            for k in range(NEVER_LISTED_MISSES):
                await tr.poll_once(T0 + (k + 1) * 900)
            return {r["mint"]: r["done"] for r in await db.fetchall("SELECT mint, done FROM moonshots")}
        finally:
            await db.close()
    assert asyncio.run(go()) == {"GHOST": 2, "LIVE": 0}


def test_the_report_counts_peaks_by_what_the_bot_did(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            now = T0
            await _seed(db, 1, "BOUGHT", now - DAY, decision="BUY", gate_reason="unanimous BUY", symbol="BGT",
                        shadow_pnl=0.02)
            await db.insert("positions", {"mint": "BOUGHT", "candidate_id": 1, "kind": "real", "mode": s.MODE,
                                          "status": "closed", "entry_price": 1.2e-7, "size_usd": 10.0,
                                          "cost_sol": 0.05, "pnl_sol": 0.02, "pnl_usd": 4.0,
                                          "exit_reason": "trailing_stop", "opened_at": now - DAY, "closed_at": now})
            await _seed(db, 2, "SKIP", now - DAY, gate_reason="triage: same_slot_as_launch_buyers 4", symbol="SKP",
                        shadow_pnl=-0.02, shadow_exit="stop_loss")
            await _seed(db, 3, "VETO", now - DAY, gate_reason="veto from forensics: insiders", symbol="VTO")
            await _seed(db, 4, "PASS", now - DAY, gate_reason="1 of 3 BUY", symbol="PSS",
                        shadow_peak=3e-7)                         # 3x while its shadow was open
            await _seed(db, 5, "FLAT", now - DAY, gate_reason="0 of 3 BUY", symbol="FLT")
            tr = MoonshotTracker(s, db, Dex({}))
            await tr.sync(now)
            for mint, peak in (("BOUGHT", 1.2e-5), ("SKIP", 6e-5), ("VETO", 1.5e-6)):
                await db.execute("UPDATE moonshots SET peak_price=?, peak_at=?, peak_mcap_usd=?, last_price=?, "
                                 "readings=2, first_at=?, supply=1e9 WHERE mint=?",
                                 [peak, now, peak * 2e11, peak / 2, now - DAY + 900, mint])
            r = await build_report(db, s)
            return r, render_text(r)
        finally:
            await db.close()
    r, text = asyncio.run(go())
    m = r["moonshots"]
    assert m["n"] == 5 and m["priced"] == 3
    c = m["counts"]
    assert (c["all"]["2x"], c["all"]["10x"], c["all"]["100x"], c["all"]["500x"]) == (5 - 1, 3, 2, 1)
    assert c["bought"] == {"n": 1, "2x": 1, "10x": 1, "100x": 1, "500x": 0}
    assert c["triage skipped"]["500x"] == 1 and c["vetoed"]["10x"] == 1 and c["committee PASS"]["n"] == 2
    assert c["committee PASS"]["2x"] == 1                          # the shadow's own 3x peak counts
    assert c["gate BUY, no entry"]["n"] == 0
    assert m["over_10x"] == 3 and m["over_10x_shadow_sold_under_2x"] == 3
    top = m["top"]
    assert [t["symbol"] for t in top] == ["SKP", "BGT", "VTO", "PSS"]
    assert top[0]["multiple"] == pytest.approx(600) and top[0]["now_multiple"] == pytest.approx(300)
    assert top[0]["ref_mcap_usd"] == pytest.approx(1e-7 * 200 * 1e9)
    assert top[3]["peak_source"] == "shadow"
    assert top[1]["trade"]["peak_vs_entry"] == pytest.approx(100)
    assert "== Moonshot tracker: every evaluated coin, watched 14 days from the price the bot saw ==" in text
    assert "  all                      4       3       2       1       5" in text
    assert "  triage skipped           1       1       1       1       1" in text
    assert "exits: 3 coins reached 10x or more; the bot's exits (on the shadow) had sold 3 of them for under +100%" \
        in text
    assert ("    600x SKP seen 10-08 08:53 (~$20.0k -> ~$12.00M market cap), 24.0h after it was seen, now 300x | #2 "
            "triage skipped: triage: same_slot_as_launch_buyers 4 | shadow stop_loss -40%") in text
    assert "trade #2 $10, closed by trailing_stop for $+4.00; the peak was 100x its entry" in text
    assert "3.0x PSS" in text and "while its shadow was open" in text


def test_moonshots_from_the_phone_and_the_settings(s):
    validate_settings(s)
    assert (s.MOONSHOT_TRACK_DAYS, s.MOONSHOT_POLL_MIN, s.MOONSHOT_ALERT_MULTIPLE) == (14.0, 15.0, 100.0)
    for bad in ({"MOONSHOT_ALERT_MULTIPLE": 1.5}, {"MOONSHOT_TRACK_DAYS": 61}, {"MOONSHOT_POLL_MIN": 0.5}):
        with pytest.raises(ConfigError):
            validate_settings(dataclasses.replace(s, **bad))
    validate_settings(dataclasses.replace(s, MOONSHOT_TRACK_DAYS=0, MOONSHOT_POLL_MIN=0, MOONSHOT_ALERT_MULTIPLE=0))
    assert validate_set("MOONSHOT_ALERT_MULTIPLE", "500", s) == "500"
    assert validate_set("MOONSHOT_ALERT_MULTIPLE", "0", s) == "0"
    with pytest.raises(OpsError):
        validate_set("MOONSHOT_ALERT_MULTIPLE", "1", s)
    with pytest.raises(OpsError):
        validate_set("MOONSHOT_TRACK_DAYS", "30", s)                # server-side only

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            tc = TelegramCommands(Telegram(None, "", ""), db, s)
            empty, _ = await tc.answer("moonshots", "")
            await _seed(db, 1, "MOON", T0 - 600, symbol="MN")
            tr = MoonshotTracker(s, db, Dex({}))
            await tr.sync(T0)
            await db.execute("UPDATE moonshots SET peak_price=2e-5, peak_at=?, readings=2 WHERE mint='MOON'", [T0])
            full, _ = await tc.answer("moonshots", "")
            s.MOONSHOT_TRACK_DAYS = 0
            off, _ = await tc.answer("moonshots", "")
            return empty, full, off
        finally:
            await db.close()
    empty, full, off = asyncio.run(go())
    assert empty.startswith("no coin tracked yet")
    assert full.startswith("== Moonshot tracker") and "200x MN" in full
    assert off.startswith("the moonshot tracker is off")
