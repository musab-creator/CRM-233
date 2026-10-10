"""Wallet memory (bot/wallets.py): what a candidate's launch buyers and creator did before it, known
only from what had happened by its evaluation, and measured against what the coins did."""
import asyncio
import dataclasses
import json
import time
from types import SimpleNamespace

import pytest

from bot.config import ConfigError, validate_settings
from bot.db import Database
from bot.ops import OpsError, validate_set
from bot.wallets import (BACKFILL_ATTEMPTS, FEATURES, MATURE_S, WalletBook, WalletMemory, coin_outcomes,
                         feature_check, launch_wallets, walk_forward, wallet_lines, wallet_summary)

H = 3600.0


def test_a_coin_counts_as_seen_at_once_as_judged_six_hours_later_and_as_a_hit_from_its_peak():
    b = WalletBook(7)
    b.add("A", 0.0, ["W1", "W2"], "DEV", x=3.0, x_at=1 * H)      # 3x an hour in
    b.add("B", 1 * H, ["W1"], "DEV", x=2.5, x_at=10 * H)         # 2.5x, but only ten hours in
    f = b.features(["W1", "W2", "W3"], "DEV2", 4, 5 * H)
    assert f == {"wm_creator_launches": 4, "wm_creator_best_x": None, "wm_launch_known": 1, "wm_launch_serial": 0,
                 "wm_launch_smart": 0, "wm_launch_2x_rate": None}
    assert b.stats["W1"] == [2, 0, 0]                            # seen twice, nothing judged yet
    b.advance(8 * H)
    assert b.stats["W1"] == [2, 2, 1] and b.stats["W2"] == [1, 1, 1]   # B judged at 7h, its peak still ahead
    b.advance(10 * H)
    assert b.stats["W1"] == [2, 2, 2]
    # the creator's best counts only once its peak happened, and never the coin itself
    assert b.features([], "DEV", 2, 2 * H)["wm_creator_best_x"] == 3.0
    assert b.features([], "DEV", 2, 11 * H, exclude="A")["wm_creator_best_x"] == 2.5
    b.advance(7 * 24 * H + 1)                                    # A leaves the 7-day window
    assert b.stats["W1"] == [1, 1, 1] and "W2" not in b.stats and set(b.coins) == {"B"}


def test_known_serial_smart_and_the_pooled_rate():
    b = WalletBook(7)
    t = 0.0
    for i in range(12):                                         # BOT buys every launch; SMART only winners
        winner = i % 3 == 0
        b.add(f"C{i}", t, ["BOT", "SMART"] if winner else ["BOT", "MID"], f"D{i}", x=4.0 if winner else 1.2, x_at=t)
        t += H
    f = b.features(["BOT", "SMART", "MID", "NEW"], None, None, t + MATURE_S)
    # BOT: 12 coins (serial, kept out of the rate); SMART: 4 coins, all 2x; MID: 8 coins, none
    assert f["wm_launch_known"] == 3 and f["wm_launch_serial"] == 1 and f["wm_launch_smart"] == 1
    assert f["wm_launch_2x_rate"] == round(4 / 12, 3) and f["wm_creator_launches"] is None
    assert b.summary() == {"coins": 12, "wallets": 3, "known": 3, "serial": 1, "smart": 1}


def test_a_second_evaluation_does_not_count_the_coin_itself():
    b = WalletBook(7)
    b.add("A", 0.0, ["W1"], None, x=3.0, x_at=0.0)
    b.add("B", 1.0, ["W1"], None)
    assert b.features(["W1"], None, None, 2.0, exclude="B")["wm_launch_known"] == 0
    assert b.features(["W1"], None, None, 2.0)["wm_launch_known"] == 1


def test_launch_wallets_are_bundles_snipers_and_first_buyers():
    ins = {"DEV": {"roles": ["creator"]}, "A": {"roles": ["bundle", "early"]}, "B": {"roles": ["top"]},
           "C": {"roles": ["sniper"]}, "D": {"roles": ["early", "top"]}}
    assert sorted(launch_wallets(ins)) == ["A", "C", "D"] and launch_wallets(None) == []


async def _coin(db, mint, ts, *, creator="DEV", ref=1e-7, peak=None, peak_at=None, shadow_peak=None,
                pnl=-0.01, status="closed", closed_at=None, spiked=False, wallets=("W1",), decision="PASS"):
    cid = await db.insert("candidates", {"mint": mint, "ts": ts, "decision": decision, "metrics": "{}"})
    await db.execute("INSERT OR IGNORE INTO mints (mint, creator, created_at) VALUES (?,?,?)", [mint, creator, ts - 60])
    if peak is not None:
        await db.insert("moonshots", {"mint": mint, "candidate_id": cid, "ref_price": ref, "ref_at": ts,
                                      "peak_price": peak, "peak_at": peak_at})
    pid = await db.insert("positions", {"mint": mint, "candidate_id": cid, "kind": "shadow", "status": status,
                                        "decided_at": ts, "opened_at": ts, "closed_at": closed_at or ts + 600,
                                        "entry_price": ref, "peak_price": shadow_peak or ref, "cost_sol": 0.05,
                                        "pnl_sol": pnl if status == "closed" else None, "pnl_usd": pnl * 100,
                                        "last_price": ref})
    if spiked:
        await db.insert("fills", {"position_id": pid, "ts": ts + 5, "side": "sell", "price": ref * 1000,
                                  "tokens": 1, "sol": 1})
    if wallets:
        await db.save_insiders(cid, mint, {w: {"roles": ["early"], "tokens": None} for w in wallets})
    return cid


def test_a_coin_outcome_is_its_best_known_peak_and_its_first_shadow(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            t0 = time.time() - 3 * 24 * H
            await _coin(db, "A", t0, peak=5e-7, peak_at=t0 + 2 * H, shadow_peak=3e-7, pnl=0.02)
            await _coin(db, "B", t0 + H, shadow_peak=2.5e-7, closed_at=t0 + 2 * H)             # no tracker row
            await _coin(db, "C", t0 + 2 * H, shadow_peak=9e-7, spiked=True)                      # a spiked shadow
            await _coin(db, "D", t0 + 3 * H, status="open")
            return await coin_outcomes(db, t0 - 1)
        finally:
            await db.close()
    o = asyncio.run(go())
    assert o["A"]["x"] == pytest.approx(5) and o["A"]["ret"] == pytest.approx(0.4) and o["A"]["creator"] == "DEV"
    assert o["B"]["x"] == pytest.approx(2.5) and o["B"]["x_at"] == pytest.approx(o["B"]["t"] + H)
    assert o["C"]["x"] is None and o["C"]["ret"] is None          # booked at a spike: no outcome
    assert o["D"]["x"] == pytest.approx(1) and o["D"]["ret"] is None


def test_live_numbers_come_from_the_book_and_count_the_creators_launches(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            now = time.time()
            await _coin(db, "A", now - 20 * H, peak=4e-7, peak_at=now - 19 * H, wallets=("W1", "W2"))
            await _coin(db, "B", now - 10 * H, peak=3e-7, peak_at=now - 9 * H, wallets=("W1",))
            await db.execute("INSERT INTO mints (mint, creator, created_at) VALUES ('X1','DEV',?), ('X2','DEV',?)",
                             [now - 5 * H, now - 8 * 24 * H])               # X2 is outside the 7-day memory
            mem = WalletMemory(s, db)
            assert await mem.features("NEW", {"W1": {"roles": ["early"]}}, "DEV") is None   # not loaded yet
            await mem.load()
            f = await mem.features("NEW", {"W1": {"roles": ["sniper"]}, "W2": {"roles": ["early"]},
                                           "DEV": {"roles": ["creator"]}}, "DEV")
            await _coin(db, "C", now - 60, wallets=("W2",))
            added = await mem.add_new()
            return f, added, mem
        finally:
            await db.close()
    f, added, mem = asyncio.run(go())
    assert f["wm_launch_known"] == 1 and f["wm_creator_launches"] == 3 and f["wm_creator_best_x"] == 4.0
    assert added == 1 and set(mem.book.coins) == {"A", "B", "C"}
    assert "wallet memory: 3 coins" in mem.note()


class FakeChain:
    enabled = True

    def __init__(self, results):
        self.results, self.calls = results, []

    async def early_trades(self, mint, curve, window_s, max_tx, max_pages=10, concurrency=None):
        self.calls.append((mint, curve, max_pages, concurrency))
        r = self.results[mint]
        if isinstance(r, Exception):
            raise r
        return r


def test_past_coins_are_read_back_newest_first_and_failures_stop_after_three_tries(s):
    """Newest first, never winners first: 12 Oct review, reading 2x coins first filled the walk-forward
    with winners and showed 'smart' buyers at 58% wins against 21% in a world where wallets mean nothing."""
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            now = time.time()
            await _coin(db, "So11111111111111111111111111111111111111112", now - 30 * H, wallets=())
            await _coin(db, "WIN", now - 40 * H, peak=5e-7, peak_at=now - 39 * H, wallets=())
            await _coin(db, "FAIL", now - 20 * H, wallets=())
            await _coin(db, "HAVE", now - 10 * H, wallets=("W9",))
            cid = await _coin(db, "TOPONLY", now - 5 * H, wallets=())          # its launch minute failed live
            await db.save_insiders(cid, "TOPONLY", {"DEV": {"roles": ["creator"], "tokens": 0.0},
                                                    "WHALE": {"roles": ["top"], "tokens": 5e6}})
            await db.execute("UPDATE mints SET bonding_curve_key='CURVE_' || mint WHERE mint IN ('WIN','FAIL','TOPONLY')")
            trades = [{"ts": 1, "slot": 5, "side": "buy", "trader": "DEV", "sol": 1.0},
                      {"ts": 1, "slot": 5, "side": "buy", "trader": "B1", "sol": 0.5},
                      {"ts": 2, "slot": 6, "side": "buy", "trader": "ME", "sol": 0.1},
                      {"ts": 3, "slot": 7, "side": "buy", "trader": "E1", "sol": 0.2}]
            chain = FakeChain({"WIN": {"trades": trades, "reached_launch": True},
                               "TOPONLY": {"trades": trades, "reached_launch": True},
                               "So11111111111111111111111111111111111111112": {"trades": [], "reached_launch": False},
                               "FAIL": RuntimeError("timeout")})
            mem = WalletMemory(s, db, chain, exclude={"ME", None})
            await mem.load()
            await mem.refresh()
            order = [o["mint"] for o in reversed(mem._queue)]
            got = [await mem.read_back_once() for _ in range(5)]
            for _ in range(BACKFILL_ATTEMPTS):
                await mem.refresh()
                await mem.read_back_once()
            await mem.refresh()
            rows = await db.fetchall("SELECT wallet, roles, source FROM insiders WHERE mint='WIN' ORDER BY wallet")
            top = await db.fetchall("SELECT wallet, roles, source FROM insiders WHERE mint='TOPONLY' ORDER BY wallet")
            back = {r["mint"]: (r["status"], r["attempts"]) for r in await db.fetchall("SELECT * FROM wallet_backfill")}
            return order, got, rows, top, back, chain, mem
        finally:
            await db.close()
    order, got, rows, top, back, chain, mem = asyncio.run(go())
    assert order == ["TOPONLY", "FAIL", "So11111111111111111111111111111111111111112", "WIN"]
    assert got == ["ok", "error", "empty", "ok", None]
    assert [(r["wallet"], r["roles"], r["source"]) for r in rows] == [
        ("B1", "bundle,sniper,early", "read_back"), ("DEV", "creator", "read_back"),
        ("E1", "sniper,early", "read_back")]                                   # never the bot's own wallet
    # rows recorded at evaluation are never replaced; the read-back only adds the launch buyers
    assert [(r["wallet"], r["source"]) for r in top] == [("B1", "read_back"), ("DEV", None), ("E1", "read_back"),
                                                         ("WHALE", None)]
    assert back["WIN"] == ("ok", 1) and back["FAIL"] == ("error", BACKFILL_ATTEMPTS)
    assert back["So11111111111111111111111111111111111111112"] == ("empty", 1)
    assert [c[0] for c in chain.calls] == ["TOPONLY", "FAIL", "So11111111111111111111111111111111111111112",
                                           "WIN", "FAIL", "FAIL"]
    assert chain.calls[3] == ("WIN", "CURVE_WIN", 100, 3)                      # three reads in flight at most
    assert chain.calls[2][1] == "6PiyjiAPkp2KdZtqkyQYzVsD1Prv7t8v4TaYd8ip4YFd"   # derived from the mint
    assert {"WIN", "TOPONLY"} <= set(mem.book.coins) and mem._queue == []


def test_the_walk_forward_scores_each_coin_on_what_was_known_then(s):
    """Wallets that bought early into coins that ran come back in more winners: the walk-forward
    shows it, without a coin's own outcome ever reaching its numbers."""
    from bot.wallets import BURN_IN_S, HORIZON_S

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            now = time.time()
            t0 = now - 6 * 24 * H
            for i in range(120):
                t = t0 + i * H
                good = i % 4 == 0
                await _coin(db, f"M{i}", t, creator=f"D{i}", peak=(6e-7 if good else 1.1e-7), peak_at=t + H,
                            pnl=0.03 if good else -0.02,
                            wallets=(("S1", "S2", f"F{i}") if good else (f"F{i}", f"G{i}")))
            return now, t0, await walk_forward(db, s, now), await wallet_summary(db, s)
        finally:
            await db.close()
    now, t0, wf, m = asyncio.run(go())
    start = (t0 // 86400) * 86400
    want = [i for i in range(120) if start + BURN_IN_S <= t0 + i * H <= now - HORIZON_S]
    assert wf["covered_from"] == start and len(wf["rows"]) == len(want) > 40 and m["scored"] == len(want)
    smart = next(c for c in feature_check(wf["rows"]) if c["feature"] == "wm_launch_smart")
    assert smart["split"] == "above" and smart["hi"]["x2_rate"] == 1.0 and smart["lo"]["x2_rate"] == 0.0
    assert smart["hi"]["win_rate"] == 1.0 and smart["lo"]["win_rate"] == 0.0
    first_good = next(r for r in wf["rows"] if r["x2"])
    assert first_good["flow"]["wm_launch_known"] == 2              # S1 and S2, from earlier coins only
    text = "\n".join(wallet_lines(m))
    assert "== Wallet memory (launch buyers' and creators' records; the agents do not see these yet) ==" in text
    assert "coins with launch buyers: 120 of 120 evaluated in 14 days" in text
    assert f"walk-forward over {len(want)} coins from" in text and "wm_launch_smart" in text
    assert "reached twice the bot's price within 24 hours" in text
    assert wallet_lines(None) == []


def test_the_walk_forward_scores_only_fully_recorded_days(s):
    """Coins whose launch buyers are missing (not read back yet, or not readable) are not random: if
    only some days' winners were on record, their buyers would look smart. Days below COVERAGE_MIN are
    left out of the replay and of the scores, from the newest such day back."""
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            now = time.time()
            today = (now // 86400) * 86400
            for day in range(1, 6):                          # five days back, 20 coins a day
                for k in range(20):
                    t = today - day * 86400 + k * 3600
                    good = k % 5 == 0
                    recorded = day <= 3 or good                 # days 4-5: only the winners were read back
                    await _coin(db, f"D{day}K{k}", t, creator=f"C{day}{k}", peak=(5e-7 if good else 1.2e-7),
                                peak_at=t + H, wallets=(("SAME",) if recorded else ()))
            return today, await walk_forward(db, s, now)
        finally:
            await db.close()
    today, wf = asyncio.run(go())
    assert wf["covered_from"] == today - 3 * 86400                  # days 4 and 5 fall short of 90%
    assert all(r["flow"]["wm_launch_serial"] <= 1 for r in wf["rows"])
    assert wf["with_launch"] == 60 + 8 and wf["coins"] == 100


def test_the_live_signal_check_includes_the_wallet_numbers(s):
    from bot.report import SIGNALS, _flow_outcomes

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            cid = await db.insert("candidates", {"mint": "A", "ts": time.time(), "decision": "PASS",
                                                 "metrics": json.dumps({"flow": {"effective_buyers": 3},
                                                                        "wallets": {"wm_launch_smart": 1}})})
            await db.insert("positions", {"mint": "A", "candidate_id": cid, "kind": "shadow", "status": "closed",
                                          "cost_sol": 0.05, "pnl_sol": 0.01, "pnl_usd": 1.0, "closed_at": time.time()})
            return await _flow_outcomes(db)
        finally:
            await db.close()
    rows = asyncio.run(go())
    assert rows[0]["flow"] == {"effective_buyers": 3, "wm_launch_smart": 1}
    assert set(FEATURES) <= set(SIGNALS)


def test_the_launch_memory_settings_and_their_phone_bounds(s):
    validate_settings(s)
    assert (s.LAUNCH_MEMORY_DAYS, s.LAUNCH_BACKFILL_PER_MIN) == (7.0, 10.0)
    for bad in ({"LAUNCH_MEMORY_DAYS": 15}, {"LAUNCH_MEMORY_DAYS": -1}, {"LAUNCH_MEMORY_DAYS": 0.2},
                {"LAUNCH_BACKFILL_PER_MIN": 61}):
        with pytest.raises(ConfigError):                 # under a day, coins would leave before being judged
            validate_settings(dataclasses.replace(s, **bad))
    validate_settings(dataclasses.replace(s, LAUNCH_MEMORY_DAYS=0))
    assert validate_set("LAUNCH_MEMORY_DAYS", "0", s) == "0" and validate_set("LAUNCH_BACKFILL_PER_MIN", "30", s) == "30"
    for key, raw in (("LAUNCH_BACKFILL_PER_MIN", "61"), ("LAUNCH_MEMORY_DAYS", "15"), ("LAUNCH_MEMORY_DAYS", "0.5")):
        with pytest.raises(OpsError):
            validate_set(key, raw, s)


def test_launch_buyers_load_a_page_at_a_time_without_losing_any(s):
    from bot.wallets import launch_rows

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            now = time.time()
            for i in range(7):
                await _coin(db, f"P{i}", now - H, wallets=tuple(f"W{j}" for j in range(5)) + (f"ONLY{i}",))
            await db.save_insiders(1, "P0", {"TOPPY": {"roles": ["top"], "tokens": 1.0}})   # not a launch buyer
            return await launch_rows(db, now - 2 * H, page=4), await launch_rows(db, now - 2 * H)
        finally:
            await db.close()
    paged, whole = asyncio.run(go())
    assert paged == whole and len(paged) == 7 and all(len(ws) == 6 for ws in paged.values())
    assert "TOPPY" not in paged["P0"]


def test_a_book_that_cannot_load_retries_once_a_minute(s, monkeypatch):
    import bot.wallets as wm
    calls = []

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            mem = WalletMemory(s, db)

            async def broken():
                calls.append(1)
                raise RuntimeError("database is locked")
            mem.load = broken
            stop = asyncio.Event()
            task = asyncio.create_task(mem.run(stop))
            await asyncio.sleep(0.3)
            stop.set()
            await asyncio.wait_for(task, 7)
        finally:
            await db.close()
    asyncio.run(go())
    assert calls == [1]


def test_a_coin_without_launch_buyers_gets_no_numbers_not_zeros(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            mem = WalletMemory(s, db)
            await mem.load()
            return await mem.features("X", {"DEV": {"roles": ["creator"]}, "W": {"roles": ["top"]}}, "DEV")
        finally:
            await db.close()
    assert asyncio.run(go()) is None                    # the launch minute could not be read: a gap, not zeros


def test_new_coins_are_looked_at_once(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            now = time.time()
            mem = WalletMemory(s, db)
            await mem.load()
            await _coin(db, "A", now - 60, wallets=("W1",))
            await _coin(db, "B", now - 50, wallets=())                     # no launch buyers on record
            first = await mem.add_new()
            calls = []
            orig = db.fetchall

            async def counting(sql, params=()):
                calls.append(sql)
                return await orig(sql, params)
            db.fetchall = counting
            second = await mem.add_new()
            return first, second, calls, mem
        finally:
            await db.close()
    first, second, calls, mem = asyncio.run(go())
    assert (first, second) == (1, 0) and set(mem.book.coins) == {"A"}
    assert len(calls) == 1 and "FROM insiders" not in calls[0]           # B is not looked up every minute


def test_read_back_rows_stay_out_of_the_insider_watch(s):
    from bot.insiders import InsiderWatch

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.save_insiders(7, "M", {"LIVE": {"roles": ["top"], "tokens": 1.0}})
            await db.save_insiders(7, "M", {"BACK": {"roles": ["early"], "tokens": None},
                                            "LIVE": {"roles": ["early"], "tokens": None}}, source="read_back")
            w = InsiderWatch(s, db, SimpleNamespace(positions={}), lambda m: None)
            return await w._insiders_of(7)
        finally:
            await db.close()
    assert asyncio.run(go()) == {"LIVE": {"roles": ["top"], "tokens": 1.0}}


def test_a_read_back_keeps_at_most_three_transaction_reads_in_flight():
    from bot.feeds.pumpchain import HeliusChain

    class Helius:
        key = "k"

        def __init__(self):
            self.live = self.peak = 0

        async def rpc(self, method, params):
            if method == "getSignaturesForAddress":
                return [{"signature": f"S{i}", "slot": i, "blockTime": 100 + i, "err": None} for i in range(20)]
            self.live += 1
            self.peak = max(self.peak, self.live)
            await asyncio.sleep(0.01)
            self.live -= 1
            return None

    async def go():
        h = Helius()
        await HeliusChain(h).early_trades("M", "C", 60, 80, concurrency=3)
        capped = h.peak
        h.peak = 0
        await HeliusChain(h).early_trades("M", "C", 60, 80)
        return capped, h.peak
    assert asyncio.run(go()) == (3, 20)                 # the live path keeps its parallel reads


def test_read_backs_run_only_well_inside_the_months_helius_pace(s):
    from bot.engine import Engine, month_fraction

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            from bot.budget import utc_month
            eng = SimpleNamespace(db=db, s=dataclasses.replace(s, HELIUS_MONTHLY_CREDITS=1_000_000),
                                  helius=SimpleNamespace(credits=0), _credits_saved=0, _credits_over_pace=False,
                                  _credits_exhausted=False, _credits_headroom=False)
            pace = 1_000_000 * max(month_fraction(time.time()), 1 / 30)
            out = []
            for used in (0.5 * pace, 0.9 * pace):
                await db.kv_set(f"helius_credits:{utc_month()}", str(int(used)))
                await Engine._record_credits(eng)
                out.append((eng._credits_headroom, eng._credits_over_pace))
            return out
        finally:
            await db.close()
    assert asyncio.run(go()) == [(True, False), (False, False)]      # stops before the pace line, not at 110%


def test_a_coin_added_again_never_takes_an_old_coins_events():
    b = WalletBook(1)
    b.add("A", 0.0, ["W"], None)
    b.advance(86400 + 1)                                  # judged at 6h, gone after a day
    assert "A" not in b.coins
    b._push(90000.0, "judge", "A", 0)                     # a stale event for the old copy
    b.add("A", 90000.0, ["W"], None)
    b.advance(90001.0)
    assert b.coins["A"]["judged"] is False and b.stats["W"] == [1, 0, 0]
