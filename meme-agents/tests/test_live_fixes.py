"""Fixes from the first 60-minute live paper run (6 Oct 2026): one bad SOL/USD tick, the LLM
budget spent in the first two hours of the day, Helius pacing, and launch-slot ordering."""
import asyncio
import json
from datetime import datetime, timezone

from pytest import approx

from bot.budget import Budget, pace_released
from bot.config import load_settings
from bot.db import Database
from bot.engine import credit_pace
from bot.feeds.dexscreener import WSOL, sol_usd_from_pairs
from bot.feeds.prices import SolPrice
from bot.feeds.pumpchain import HeliusChain
from bot.status import health
from tests.test_chain import A, B, CURVE, MINT, FakeRpc, _bal, _tx

USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


def _ts(s: str) -> float:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()


def _pair(price, liq, quote=USDC, base=WSOL):
    return {"chainId": "solana", "baseToken": {"address": base}, "quoteToken": {"address": quote},
            "priceUsd": str(price), "liquidity": {"usd": liq}}


def test_sol_usd_is_the_median_over_deep_stablecoin_pairs():
    pairs = [_pair(121.1, 50e6), _pair(121.3, 10e6, quote="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
             _pair(166.66, 2e6),                       # one wrong pair cannot move the median
             _pair(150.0, 100e6, quote="XYZ"),         # not a stablecoin pair: ignored
             _pair(0.001, 90e6, base="TOKEN")]         # SOL is the quote here, not the base: ignored
    assert sol_usd_from_pairs(pairs) == 121.3
    # fewer than two deep stablecoin pairs: fall back to the deepest wrapped-SOL pair
    assert sol_usd_from_pairs([_pair(121.1, 50e6), _pair(150.0, 100e6, quote="XYZ")]) == 150.0
    assert sol_usd_from_pairs([]) is None


def test_sol_price_holds_an_outlier_until_it_repeats():
    sp = SolPrice(None)
    assert sp.accept(121.0) and sp.get() == 121.0
    assert not sp.accept(166.66) and sp.get() == 121.0           # the live glitch: one +37% reading
    assert sp.accept(121.5) and sp.outliers == []                 # back to normal, outlier forgotten
    assert not sp.accept(160.0) and not sp.accept(161.0)
    assert sp.accept(162.0) and sp.get() == 162.0                 # third in a row: the market really moved
    assert not sp.accept(100.0) and sp.get() == 162.0             # a -38% reading is held again
    # the first reading is always accepted, and refresh() applies the same rule
    assert SolPrice(None).accept(5.0)

    async def fetch():
        return 166.66
    sp2 = SolPrice(fetch)
    sp2.accept(121.0)
    assert asyncio.run(sp2.refresh()) == 121.0 and sp2.outliers == [166.66]


def test_budget_pacing_releases_the_daily_limit_through_the_day():
    assert pace_released(5.0, None, _ts("2026-10-06T01:00:00")) == 5.0                         # pacing off
    assert pace_released(5.0, 2.0, _ts("2026-10-06T00:00:00")) == approx(5.0 * 2 / 24)         # burst at midnight
    assert pace_released(5.0, 2.0, _ts("2026-10-06T10:00:00")) == approx(5.0 * 12 / 24)
    assert pace_released(5.0, 2.0, _ts("2026-10-06T22:00:00")) == 5.0                          # never above the limit
    assert pace_released(5.0, 2.0, _ts("2026-10-06T23:59:00")) == 5.0
    # pacing is for daily budgets only: the X month budget ignores it
    assert Budget(None, "x", 20.0, "month", burst_h=2.0).burst_h is None
    assert Budget(None, "llm", 5.0, "day", burst_h=2.0).burst_h == 2.0


def test_helius_credit_pace_flags():
    mid = _ts("2026-10-16T00:00:00")                       # 15/31 of the month elapsed
    assert credit_pace(400_000, 1_000_000, mid) == (False, False)
    assert credit_pace(600_000, 1_000_000, mid) == (True, False)   # > 1.1 x 484k
    assert credit_pace(1_000_000, 1_000_000, mid) == (True, True)
    # the first day counts as a full day's allowance, so a normal first hour is not "over pace"
    first_hour = _ts("2026-10-01T01:00:00")
    assert credit_pace(30_000, 1_000_000, first_hour) == (False, False)
    assert credit_pace(40_000, 1_000_000, first_hour) == (True, False)


def test_status_reports_paused_when_the_helius_budget_is_spent(tmp_path):
    s = load_settings(tmp_path / "none.env", overrides={"DB_PATH": str(tmp_path / "h.db"), "LOG_FILE": ""})

    async def go(exhausted):
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("heartbeat", json.dumps({"ts": 10_000, "started_at": 9_000, "last_msg_at": 9_990,
                                                     "launches": 5, "cycles": 0, "queue": 0,
                                                     "helius_credits_month": 1_000_000, "helius_exhausted": exhausted}))
            return await health(db, s, 10_030)
        finally:
            await db.close()
    state, line = asyncio.run(go(True))
    assert state == "PAUSED" and "HELIUS_MONTHLY_CREDITS" in line
    assert asyncio.run(go(False))[0] == "OK"


def test_early_trades_keep_block_order_inside_the_launch_slot():
    # the RPC lists the launch slot's transactions newest first: the sniper bundled with the
    # create comes before the create itself
    page = [{"signature": "snipe", "slot": 800, "blockTime": 1000, "err": None},
            {"signature": "first", "slot": 800, "blockTime": 1000, "err": None}]
    create = _tx([A, CURVE], [5_000_000_000, 0], [4_000_000_000, 1_000_000_000], [],
                 [_bal(2, A, 30_000_000_000_000)], slot=800, ts=1000)
    snipe = _tx([B, CURVE], [1_000_000_000, 1_000_000_000], [900_000_000, 1_100_000_000], [],
                [_bal(2, B, 3_000_000_000_000)], slot=800, ts=1000)
    rpc = FakeRpc(sig_pages=[list(page)], txs={"first": create, "snipe": snipe})
    out = asyncio.run(HeliusChain(rpc).early_trades(MINT, CURVE, window_s=60, max_tx=80))
    assert [(t["trader"], t["seq"]) for t in out["trades"]] == [(A, 0), (B, 1)]
    # with a transaction cap, the create transaction is the one kept, not the newest in the slot
    rpc = FakeRpc(sig_pages=[list(page)], txs={"first": create, "snipe": snipe})
    out = asyncio.run(HeliusChain(rpc).early_trades(MINT, CURVE, window_s=60, max_tx=1))
    assert out["transactions"] == 1 and [t["trader"] for t in out["trades"]] == [A]
