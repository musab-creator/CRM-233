"""10 Oct: 14 of the 36 bought coins doubled but only 9 of 33 trades won, and 9 of the 28 coins that
went 10x had been sold by the shadow's exits for under +100%. Each coin now keeps how deep it fell
before its peak and before its first 2x, and when those came; the report says what a wider stop or a
later time stop would have kept and cost. Measured only: no exit rule reads any of it."""
import asyncio

import pytest

from bot.db import Database
from bot.moonshots import MoonshotTracker, advance, summary
from bot.paper import PaperExecutor
from bot.positions import PositionManager
from bot.report import build_report, render_text
from bot.risk import RiskManager
from tests.test_moonshots import Dex, _row, _seed
from tests.test_paper import FixedPrice

H = 3600.0
T0 = 1_760_000_000.0


def _read(price):
    return {"price": price, "mcap_usd": price * 2e11, "sol_usd": 200.0, "supply": 1e9}


DIP_COLS = ("low_price", "low_at", "low_before_peak", "first_2x_at", "low_before_2x", "price_6h", "price_12h",
            "price_24h", "low_0h_6h", "low_6h_12h", "low_12h_24h")


def test_a_low_needs_two_reads_and_the_first_2x_keeps_the_low_before_it():
    row = _row(dips=1, ref_price=1e-6, ref_at=T0, **dict.fromkeys(DIP_COLS))
    for at, price in ((900, 0.9e-6), (1800, 0.5e-6), (2700, 0.45e-6)):
        row = advance(row, _read(price), T0 + at)
    # (0.9, 0.5) confirms 0.9; (0.5, 0.45) confirms 0.5: a low counts when two reads reach it
    assert (row["low_price"], row["low_at"]) == (0.5e-6, T0 + 2700)
    row = advance(row, _read(0.45e-6), T0 + 3000)         # the second read at 0.45: now it counts
    assert row["low_price"] == 0.45e-6
    row = advance(row, _read(3e-6), T0 + 3600)            # one read at 3x confirms nothing
    assert row["first_2x_at"] is None
    row = advance(row, _read(2.5e-6), T0 + 4500)          # two reads at 2x or more: the first 2x
    assert (row["first_2x_at"], row["low_before_2x"]) == (T0 + 4500, 0.45e-6)
    assert (row["peak_price"], row["peak_at"], row["low_before_peak"]) == (2.5e-6, T0 + 4500, 0.45e-6)
    for at, price in ((5400, 5e-6), (6300, 6e-6)):
        row = advance(row, _read(price), T0 + at)
    assert (row["peak_price"], row["low_before_peak"], row["first_2x_at"]) == (5e-6, 0.45e-6, T0 + 4500)
    for at, price in ((7200, 0.3e-6), (8100, 0.2e-6)):    # a fall after the peak is no dip before it
        row = advance(row, _read(price), T0 + at)
    assert row["low_price"] == 0.3e-6 and row["low_before_peak"] == 0.45e-6
    assert row["low_0h_6h"] == 0.3e-6 and row["low_6h_12h"] is None
    # the price 6 h on is the first read after 6 h, and only within 2 h of it
    row = advance(row, _read(0.4e-6), T0 + 6 * H + 600)
    row = advance(row, _read(0.35e-6), T0 + 6 * H + 1500)
    assert row["price_6h"] == 0.4e-6 and row["low_6h_12h"] == 0.4e-6
    row = advance(row, _read(0.6e-6), T0 + 14.5 * H)       # 2.5 h after the 12 h mark: no picture of it
    assert row["price_12h"] is None
    row = advance(row, _read(0.7e-6), T0 + 24 * H + 60)
    assert row["price_24h"] == 0.7e-6


def test_a_coin_tracked_before_dips_were_recorded_gets_none():
    row = _row(ref_price=1e-6, ref_at=T0, dips=None, **dict.fromkeys(DIP_COLS))   # its first reads came long ago
    for at, price in ((900, 0.5e-6), (1800, 0.4e-6), (2700, 3e-6), (3600, 3e-6), (6 * H + 60, 1e-6)):
        row = advance(row, _read(price), T0 + at)
    assert row["peak_price"] == 3e-6                       # the peak works as before
    assert all(row[k] is None for k in DIP_COLS)


def test_the_tracker_marks_new_coins_for_dips(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _seed(db, 1, "NEW", T0 - 600, entry=1e-6)
            dex = Dex({"NEW": 0.7e-6})
            tr = MoonshotTracker(s, db, dex)
            tr.gap_s = 0
            await tr.poll_once(T0)
            dex.prices["NEW"] = 0.6e-6
            await tr.poll_once(T0 + 900)
            return await db.fetchone("SELECT dips, low_price, low_0h_6h FROM moonshots WHERE mint='NEW'")
        finally:
            await db.close()
    assert asyncio.run(go()) == {"dips": 1, "low_price": 0.7e-6, "low_0h_6h": 0.7e-6}


def test_the_shadow_marks_its_trough_peak_time_and_first_2x_trade_by_trade(s):
    s.STOP_LOSS_PCT, s.TRAILING_ARM_PCT = 40.0, 0.0          # the marks are the subject, not the exits

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("bankroll_sol", "0.5")
            pm = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice())
            p = await pm.create("M", 1, "shadow", "C", 10.0, 10_000)
            t = p.decided_at
            await pm.on_tick("M", 1e-7, t + 1, {})
            assert (p.trough_price, p.trough_at, p.peak_at) == (1e-7, t + 1, t + 1)
            for dt, price in ((10, 0.8e-7), (20, 0.9e-7), (30, 1.5e-7), (40, 1.2e-7), (50, 2.1e-7)):
                await pm.on_tick("M", price, t + dt, {})
            assert (p.trough_price, p.trough_at) == (0.8e-7, t + 10)
            assert (p.peak_price, p.peak_at, p.trough_before_peak) == (2.1e-7, t + 50, 0.8e-7)
            assert (p.first_2x_at, p.trough_before_2x) == (t + 50, 0.8e-7)
            await pm.periodic()
            saved = await db.fetchone("SELECT trough_price, peak_at, first_2x_at, trough_before_2x FROM positions "
                                      "WHERE id=?", [p.id])
            assert saved == {"trough_price": 0.8e-7, "peak_at": t + 50, "first_2x_at": t + 50,
                             "trough_before_2x": 0.8e-7}
            # a position open across the update into this code has no marks from its entry: none are made up
            old = await db.insert("positions", {"mint": "OLD", "candidate_id": 2, "kind": "shadow", "mode": "paper",
                                                "creator": "D", "status": "open", "decided_at": t, "opened_at": t,
                                                "size_usd": 5.0, "sol_in": 0.05, "cost_sol": 0.05,
                                                "entry_price": 1e-7, "peak_price": 1.4e-7, "last_price": 1e-7,
                                                "last_tick_at": t, "tokens_initial": 1e6, "tokens_remaining": 1e6})
            again = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice())
            await again.load()
            q = again.positions[old]
            for dt, price in ((10, 0.7e-7), (20, 2.2e-7)):
                await again.on_tick("OLD", price, t + dt, {})
            return q
        finally:
            await db.close()
    q = asyncio.run(go())
    assert q.peak_price == 2.2e-7                          # the trailing stop's peak works as before
    assert (q.trough_price, q.peak_at, q.first_2x_at) == (None, None, None)


SEEN = T0 - 48 * H


async def _coin(db, mint, *, shadow: dict, tracker: dict, exit_reason="stop_loss", exit_price=0.6e-6, dips=1):
    await db.execute("INSERT OR IGNORE INTO mints (mint, symbol) VALUES (?,?)", [mint, mint])
    await db.insert("positions", {"mint": mint, "candidate_id": None, "kind": "shadow", "mode": "paper",
                                  "status": "closed", "opened_at": SEEN, "closed_at": SEEN + 2 * H,
                                  "entry_price": 1e-6, "last_price": exit_price, "cost_sol": 0.05,
                                  "pnl_sol": 0.05 * (exit_price / 1e-6 - 1), "pnl_usd": 10 * (exit_price / 1e-6 - 1),
                                  "exit_reason": exit_reason, "sol_usd_entry": 200.0,
                                  "peak_price": 1.1e-6, "peak_at": SEEN + 60, **shadow})
    await db.insert("moonshots", {"mint": mint, "ref_price": 1e-6, "ref_at": SEEN, "ref_sol_usd": 200.0,
                                  "readings": 100, "first_at": SEEN + 900, "dips": dips, **tracker})


def test_the_report_says_how_deep_winners_dipped_and_what_wider_or_later_stops_change(s, monkeypatch):
    monkeypatch.setattr("bot.moonshots.now_s", lambda: T0)
    s.STOP_LOSS_PCT, s.TIME_STOP_HOURS, s.POSITION_MIN_USD = 40.0, 6.0, 5.0

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            # doubled 3 h in after dipping -45% (the shadow was stopped at -42%): a -50% stop keeps it
            await _coin(db, "DEEP", shadow={"trough_price": 0.58e-6, "trough_at": SEEN + 600},
                        tracker={"low_before_2x": 0.55e-6, "first_2x_at": SEEN + 3 * H, "peak_price": 2.5e-6,
                                 "peak_at": SEEN + 4 * H, "low_before_peak": 0.55e-6, "low_price": 0.55e-6})
            # the shadow itself saw the 2x half an hour in, after a -10% dip; the coin went on to 12x
            await _coin(db, "TEN", exit_reason="trailing_stop", exit_price=1.6e-6,
                        shadow={"trough_price": 0.9e-6, "trough_at": SEEN + 300, "first_2x_at": SEEN + 1800,
                                "trough_before_2x": 0.9e-6, "peak_price": 2.2e-6, "peak_at": SEEN + 1800,
                                "trough_before_peak": 0.9e-6},
                        tracker={"peak_price": 12e-6, "peak_at": SEEN + 40 * H, "low_before_peak": 0.9e-6})
            # stopped at -40%, then fell to -70% inside 6 h and never doubled: a wider stop only costs
            await _coin(db, "FALL", shadow={"trough_price": 0.6e-6, "trough_at": SEEN + 900},
                        tracker={"low_0h_6h": 0.3e-6, "low_price": 0.2e-6, "price_6h": 0.3e-6})
            # stopped at -42%, fell to -48% and was back at -25% at 6 h: held, it sells 15% of the stake better
            await _coin(db, "BETWEEN", shadow={"trough_price": 0.58e-6, "trough_at": SEEN + 1200},
                        tracker={"low_0h_6h": 0.52e-6, "price_6h": 0.75e-6})
            # the time stop sold at -10%; +20% at 12 h, but through -40% by 24 h
            await _coin(db, "TIMED", exit_reason="time_stop", exit_price=0.9e-6,
                        shadow={"trough_price": 0.78e-6, "trough_at": SEEN + 2 * H, "peak_price": 1.3e-6},
                        tracker={"low_0h_6h": 0.85e-6, "low_6h_12h": 0.85e-6, "price_12h": 1.2e-6,
                                 "low_12h_24h": 0.5e-6, "price_24h": 0.55e-6})
            # the time stop sold at -5%; it doubled 9 h in, never below -30% first
            await _coin(db, "LATE", exit_reason="time_stop", exit_price=0.95e-6,
                        shadow={"trough_price": 0.78e-6, "trough_at": SEEN + 2 * H},
                        tracker={"first_2x_at": SEEN + 9 * H, "low_before_2x": 0.7e-6, "peak_price": 2.2e-6,
                                 "peak_at": SEEN + 10 * H, "low_before_peak": 0.7e-6, "low_6h_12h": 0.7e-6})
            # tracked before dips were recorded: left out of every count below
            await _coin(db, "LEGACY", dips=None, shadow={}, tracker={"peak_price": 5e-6, "peak_at": SEEN + H})
            m = await summary(db, s)
            report = render_text(await build_report(db, s))
            return m, report
        finally:
            await db.close()
    m, text = asyncio.run(go())
    d = m["dips"]
    assert d["n"] == 6 and d["doubled"] == 3
    assert d["dip_before_2x"] == {"above -20%": 1, "-20 to -40%": 1, "-40 to -50%": 1, "-50 to -60%": 0,
                                  "-60% or lower": 0}
    assert d["median_dip_before_2x"] == pytest.approx(-0.30)
    assert (d["ten_x"], d["ten_x_through_stop"]) == (1, 0)
    assert d["time_to_2x"] == [1, 1, 1, 0, 0] and d["time_to_peak"] == [1, 1, 1, 0]
    assert d["median_dip_before_peak"] == pytest.approx(-0.30)
    assert (d["judged"], d["doubled_in_window"]) == (6, 2)
    w50, w60 = d["wider"]
    assert (w50["stop"], w50["kept"], w50["fell_through"], w50["held"], w50["kept_later"]) == (0.5, 1, 1, 1, 0)
    assert w50["held_median"] == pytest.approx(0.15) and w50["usd"] == pytest.approx(5 * (0.15 - 0.10))
    assert (w60["kept"], w60["fell_through"], w60["held"]) == (1, 1, 1)
    assert w60["usd"] == pytest.approx(5 * (0.15 - 0.20))
    # a tighter stop: FALL and BETWEEN fell through -40% anyway (sold earlier, 20/15/10% of the stake saved);
    # TIMED and LATE dipped -22% but not -25%, so only -20% sells them early (unread at 6 h: not valued);
    # DEEP dipped through -40% itself and TEN only -10%: no coin that doubled is cut
    t20, t25, t30 = d["tighter"]
    assert (t20["stop"], t20["cut"], t20["through"], t20["early"], t20["early_unread"]) == (0.2, 0, 2, 2, 2)
    assert t20["usd"] == pytest.approx(5 * 0.2 * 2) and t20["early_median_6h"] is None
    assert (t25["stop"], t25["cut"], t25["through"], t25["early"]) == (0.25, 0, 2, 0)
    assert (t30["stop"], t30["through"], t30["usd"]) == (0.3, 2, pytest.approx(5 * 0.1 * 2))
    assert "a tighter stop, on the same 6 coins (not replayed, shares of a $5 stake):" in text
    assert "  -20% cuts 0 that dipped -20% to -40% and then doubled within 6h (not valued)" in text
    assert ("  -20% saves 20% of the stake on the 2 that fell through -40% anyway; sells 2 more that dipped -20% to -40% "
            "without doubling instead of holding them to 6h (2 unread at 6h); measured on these $+2.00") in text
    assert "  -30% saves 10% of the stake on the 2 that fell through -40% anyway; measured on these $+1.00" in text
    h12, h24 = d["later"]
    assert (h12["hours"], h12["doubled"], h12["stopped"], h12["sold"]) == (12, 1, 0, 1)
    assert h12["median_move"] == pytest.approx(0.30) and h12["usd"] == pytest.approx(1.5)
    assert (h24["doubled"], h24["stopped"], h24["sold"]) == (1, 1, 0)
    assert h24["median_move"] == pytest.approx(-0.30) and h24["usd"] == pytest.approx(-1.5)
    assert "== Dips before the run: 6 coins seen since" in text
    assert ("reached 2x: 3 of 6; their lowest price before the 2x: above -20% 1 | -20 to -40% 1 | -40 to -50% 1 | "
            "-50 to -60% 0 | -60% or lower 0  (median -30%)") in text
    assert "of them reached 10x: 1; 0 of those fell through -40% before their 2x" in text
    assert "time to 2x: under 1h 1 | 1-6h 1 | 6-12h 1 | 12-24h 0 | over 24h 0" in text
    assert "  -50% keeps 1 that dipped -40% to -50% and then doubled within 6h, median peak 2.5x (not valued)" in text
    assert ("  -50% costs: 1 fell through -50% without doubling, 10% of the stake more each; 1 dipped -40% to -50% "
            "without doubling and would be held to 6h, selling a median +15% of the stake better than at -40%; "
            "measured on these $+0.25") in text
    assert "  -60% costs: 1 fell through -60% without doubling, 20% of the stake more each" in text
    assert ("  to 12h (2 old enough): 1 doubled after the sale (not valued), 0 fell through -40% first (sold there), "
            "1 sold at 12h; against the time stop's sale: median +30%, 1 better, measured change $+1.50") in text
    assert ("  to 24h (2 old enough): 1 doubled after the sale (not valued), 1 fell through -40% first (sold there), "
            "0 sold at 24h; against the time stop's sale: median -30%, 0 better, measured change $-1.50") in text


def _rec(ref_at, **dips):
    base = dict.fromkeys(("low", "low_6h", "low_before_peak", "peak_after_s", "low_before_2x", "x2_after_s",
                          "time_stop_sale", "p6h", "p12h", "p24h", "low_0h_6h", "low_6h_12h", "low_12h_24h"))
    return {"ref_at": ref_at, "multiple": 1.0, "dips": {**base, **dips}}


def test_the_dip_section_says_what_it_cannot_judge_yet_and_follows_the_time_stop(s):
    from bot.moonshots import dip_lines, dip_summary
    s.STOP_LOSS_PCT, s.TIME_STOP_HOURS = 40.0, 6.0
    young = [_rec(T0 - H, low=-0.3, low_6h=-0.3), _rec(T0 - 2 * H, low=-0.5, low_6h=-0.5)]
    text = "\n".join(dip_lines(dip_summary(young, s, T0)))
    assert "a wider or tighter stop: judged once a coin's first 6h are over (none yet)" in text
    assert "-50% keeps" not in text and "-30% saves" not in text
    assert "a later time stop: the time stop has sold none of these coins yet" in text and "to 12h" not in text
    # a 3 h time stop: the fall to -45% at 4 h, after its sale at -10%, counts toward holding it to 12 h
    s.TIME_STOP_HOURS = 3.0
    sold = [_rec(T0 - 30 * H, low=-0.45, low_6h=-0.45, low_0h_6h=-0.45, time_stop_sale=-0.1, p12h=0.5,
                 low_6h_12h=-0.2)]
    d = dip_summary(sold, s, T0)
    assert (d["later"][0]["hours"], d["later"][0]["stopped"], d["later"][0]["sold"]) == (12, 1, 0)
    assert "judged with a 6h time stop, today's is 3h" in "\n".join(dip_lines(d))
