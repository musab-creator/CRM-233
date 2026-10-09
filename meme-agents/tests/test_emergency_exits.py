"""Emergency exits measured right (9 Oct: COMPANY sold for a liquidity "drop" that happened before the
buy, Agent sold on a rugcheck flag nobody could name): the liquidity reference is taken at the buy, one
source per phase, a buy into a draining curve is refused, DexScreener failing leaves the curve check on,
live emergencies sell at once, the reasons are kept for /why, and curves priced in another token are
never read as SOL."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from bot.commands import TelegramCommands
from bot.db import Database
from bot.feeds.dexscreener import WSOL
from bot.feeds.pumpchain import Curve, HeliusChain, decode_curve, encode_curve
from bot.ingest import Ingestor
from bot.paper import PaperExecutor
from bot.positions import PositionManager
from bot.risk import RiskManager
from bot.telegram import Telegram
from tests.test_commands import FakeHttp
from tests.test_paper import FixedPrice

USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
CREATOR = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
POOL = {"dexId": "pumpswap", "pairAddress": "Pool1", "quoteToken": {"address": WSOL}, "priceNative": "1e-7"}


class Dex:
    def __init__(self, pair=None, fail=False):
        self.pair, self.fail = pair, fail

    async def tokens(self, mints):
        if self.fail:
            raise RuntimeError("HTTP 403")
        return {m: self.pair for m in mints}


async def _manager(s, dex=None, depth=None, ex=None, rug=None, sent=None):
    db = await Database(s.DB_PATH).open()
    await db.kv_set("bankroll_sol", "0.5")

    async def notify(text):
        (sent if sent is not None else []).append(text)
    pm = PositionManager(s, db, RiskManager(s, 0), ex or PaperExecutor(s), FixedPrice(), dex=dex, rugcheck=rug,
                         notifier=notify, curve_liquidity=(depth.get if depth is not None else None))
    return db, pm


async def _poll(pm):
    pm._last_liq_poll = 0
    await pm.periodic()


def test_the_liquidity_reference_is_taken_at_the_buy_not_the_scan(s):
    async def go():
        depth = {"M": 4_680.0}                          # the curve fell from $9,600 while the committee voted
        db, pm = await _manager(s, Dex(), depth)
        p = await pm.create("M", 1, "shadow", "C", 10.0, 9_600)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        assert p.entry_liq_usd == 4_680.0 and p.liq_source == "curve"
        await _poll(pm)
        assert p.status == "open" and not p.pending_exit         # no "drop" the bot never owned
        depth["M"] = 2_300.0                                     # half of what it bought into: a drain
        await _poll(pm)
        assert p.pending_exit == "emergency_liquidity_drop"
        await db.close()
    asyncio.run(go())


def test_no_curve_depth_at_the_buy_takes_the_reference_on_the_next_pass(s):
    async def go():
        db, pm = await _manager(s, Dex(dict(POOL, liquidity={"usd": 20_000})))
        p = await pm.create("M", 1, "shadow", "C", 10.0, 9_600)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        assert p.entry_liq_usd is None and pm._last_liq_poll == 0
        await pm.periodic()
        assert p.entry_liq_usd == 20_000 and p.liq_source == "pool:Pool1" and not p.pending_exit
        await db.close()
    asyncio.run(go())


def test_a_real_buy_into_a_draining_curve_is_refused(s):
    async def go():
        depth = {"M": 7_000.0}                          # 30% below the scan's $10,000
        db, pm = await _manager(s, Dex(), depth)
        real = await pm.create("M", 1, "real", "C", 10.0, 10_000)
        shadow = await pm.create("M", 1, "shadow", "C", 10.0, 10_000)
        await pm.on_tick("M", 1e-7, real.decided_at + 1, {})
        assert real.status == "cancelled" and "curve depth fell 30% between the scan and the buy" in real.exit_reason
        assert shadow.status == "open"                           # the shadow still scores the decision
        depth["N"] = 9_000.0                                     # 10% down: within the default 20%
        ok = await pm.create("N", 2, "real", "D", 10.0, 10_000)
        await pm.on_tick("N", 1e-7, ok.decided_at + 1, {})
        assert ok.status == "open"
        s.ENTRY_MAX_LIQ_SLIP_PCT = 0                             # off
        depth["O"] = 1_000.0
        off = await pm.create("O", 3, "real", "E", 10.0, 10_000)
        await pm.on_tick("O", 1e-7, off.decided_at + 1, {})
        assert off.status == "open"
        await db.close()
    asyncio.run(go())


@pytest.mark.parametrize("pair", [
    {"dexId": "pumpfun", "liquidity": {"usd": 0}, "priceNative": "1e-7", "quoteToken": {"address": WSOL}},
    {"dexId": "raydium", "pairAddress": "Side", "liquidity": {"usd": 150}, "priceNative": "1e-7",
     "quoteToken": {"address": WSOL}},
])
def test_a_side_pool_or_a_zero_figure_never_stands_in_for_the_curve(s, pair):
    async def go():
        depth = {"M": 9_000.0}
        db, pm = await _manager(s, Dex(pair), depth)
        p = await pm.create("M", 1, "shadow", "C", 10.0, 9_000)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        for _ in range(3):
            await _poll(pm)
        assert p.status == "open" and not p.pending_exit and p.last_liq_usd == 9_000
        await db.close()
    asyncio.run(go())


def test_a_dexscreener_failure_leaves_the_curve_check_running(s):
    async def go():
        depth = {"M": 9_600.0}
        db, pm = await _manager(s, Dex(fail=True), depth)
        p = await pm.create("M", 1, "shadow", "C", 10.0, 9_600)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        depth["M"] = 1_200.0
        await _poll(pm)
        assert p.pending_exit == "emergency_liquidity_drop"
        await db.close()
    asyncio.run(go())


def test_graduation_starts_a_new_reference_on_the_pool(s):
    async def go():
        depth = {"M": 9_000.0}
        dex = Dex(dict(POOL, liquidity={"usd": 30_000}))
        db, pm = await _manager(s, dex, depth)
        p = await pm.create("M", 1, "shadow", "C", 10.0, 9_000)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        del depth["M"]                                           # graduated: no curve depth any more
        await _poll(pm)
        assert p.entry_liq_usd == 30_000 and p.liq_source == "pool:Pool1" and not p.pending_exit
        dex.pair = dict(POOL, liquidity={"usd": 12_000})
        await _poll(pm)
        assert p.pending_exit == "emergency_liquidity_drop"
        rows = await db.fetchall("SELECT detail FROM events WHERE kind='liq_drop'")
        d = json.loads(rows[0]["detail"])
        assert d["entry_liq_usd"] == 30_000 and d["liq_usd"] == 12_000 and d["source"] == "pool:Pool1"
        await db.close()
    asyncio.run(go())


def test_the_rugcheck_danger_names_are_kept_shown_and_announced(s):
    class Rug:
        async def check(self, mint, max_age_s=0):
            return {"danger": ["Mint Authority still enabled"], "score_normalised": 81,
                    "risks": [{"name": "Mint Authority still enabled", "level": "danger", "value": ""},
                              {"name": "Low amount of LP Providers", "level": "warn"}]}

    sent: list[str] = []

    async def go():
        db, pm = await _manager(s, rug=Rug(), sent=sent)
        p = await pm.create("M", 7, "real", "C", 10.0, None)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        await pm.periodic()
        assert p.pending_exit == "emergency_rugcheck_danger"
        tc = TelegramCommands(Telegram(FakeHttp([]), "1:a", "42"), db, s)
        lines = await tc._emergency_lines(7)
        await db.close()
        return lines
    lines = asyncio.run(go())
    assert any("⚠️ RUGCHECK DANGER" in t and "Mint Authority still enabled" in t for t in sent)
    assert len(lines) == 1 and "real: rugcheck danger Mint Authority still enabled (score 81)" in lines[0]


def test_a_live_emergency_sells_without_waiting_for_a_trade(s):
    class Live(PaperExecutor):
        mode = "live"

        def __init__(self, s):
            super().__init__(s)
            self.sells = []

        async def sell(self, mint, tokens, price, fraction=1.0, **kw):
            self.sells.append((mint, fraction))
            return await super().sell(mint, tokens, price, fraction)

    async def go():
        ex = Live(s)
        db, pm = await _manager(s, ex=ex)
        p = await pm.create("M", 1, "real", "C", 10.0, None)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        await pm.drain(2)
        assert p.status == "open"
        async with pm.lock:
            await pm.queue_exit(p, "emergency_liquidity_drop")
            await pm.queue_exit(p, "emergency_liquidity_drop")      # a second trigger while it sells: no second sale
        await pm.drain(2)
        assert ex.sells == [("M", 1.0)] and p.status == "closed" and p.exit_reason == "emergency_liquidity_drop"
        await db.close()
    asyncio.run(go())


def test_the_quote_token_is_decoded_and_sol_is_the_default(s):
    sol = Curve(1.0e9, 32.19, 7.2e8, 2.19, 1e9, False, CREATOR)
    assert decode_curve(encode_curve(sol)).quote_mint is None
    usdc = Curve(1.073e9, 4.292, 7.93e8, 0.0, 1e9, False, CREATOR, USDC)
    raw = encode_curve(usdc)
    assert len(raw) == 166 and decode_curve(raw).quote_mint == USDC
    wsol = Curve(1.073e9, 30.0, 7.93e8, 0.0, 1e9, False, CREATOR, WSOL)
    assert decode_curve(encode_curve(wsol)).quote_mint is None
    for size in (49, 81, 83):                                    # older, shorter accounts: SOL
        assert decode_curve(raw[:size]).quote_mint is None


def test_a_curve_priced_in_another_token_is_never_read_as_sol(s):
    mint = "M" * 44

    async def go():
        db = await Database(s.DB_PATH).open()
        ing = Ingestor(s, db)
        await ing.handle({"txType": "create", "mint": mint, "traderPublicKey": "D" * 44, "bondingCurveKey": "K" * 44,
                          "solAmount": 0.0, "initialBuy": 0, "vSolInBondingCurve": 30.0,
                          "vTokensInBondingCurve": 1.073e9}, ts=1000)
        held = "H" * 44
        await ing.handle({"txType": "create", "mint": held, "traderPublicKey": "D" * 44, "bondingCurveKey": "J" * 44,
                          "solAmount": 0.0, "initialBuy": 0, "vSolInBondingCurve": 30.0,
                          "vTokensInBondingCurve": 1.073e9}, ts=1000)
        ing.pinned.add(held)
        usdc = Curve(1.073e9, 4.292, 7.93e8, 0.0, 1e9, False, None, USDC)
        assert await ing.apply_curve(mint, usdc, 1060) is False
        assert mint not in ing.mints and ing.stats["non_sol_quote"] == 1
        row = await db.fetchone("SELECT status, status_reason FROM mints WHERE mint=?", [mint])
        assert row["status"] == "dropped" and row["status_reason"] == f"non-SOL quote {USDC}"
        assert await ing.apply_curve(held, usdc, 1060) is False   # a held coin is kept, its curve not applied
        assert held in ing.mints and not ing.mints[held].curve_at
        # a rejected read is not "the curve read" either
        await ing.apply_curve(held, Curve(1.073e9, 0.4222, 7.93e8, 0.0, 1e9, False), 1070)
        assert not ing.mints[held].curve_at and ing.stats["curve_rejected"] == 1
        await db.close()
    asyncio.run(go())


def test_only_pumps_own_accounts_are_decoded(s):
    import base64
    data = base64.b64encode(encode_curve(Curve(1.0e9, 32.0, 7e8, 2.0, 1e9, False))).decode()

    class H:
        key = "k"

        async def rpc(self, method, params):
            return {"value": [{"owner": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "data": [data, "base64"]},
                              {"owner": "Other111111111111111111111111111111111111", "data": [data, "base64"]}]}

    out = asyncio.run(HeliusChain(H()).curves(["A", "B"]))
    assert out["A"] is not None and out["B"] is None


def test_why_shows_a_liquidity_drop(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        await db.event("liq_drop", {"position_id": 3, "candidate_id": 9, "mint": "M", "kind": "real",
                                    "entry_liq_usd": 9600, "liq_usd": 4000, "source": "curve"}, 1_000_000)
        await db.event("liq_drop", {"position_id": 4, "candidate_id": 10, "mint": "N", "kind": "real",
                                    "entry_liq_usd": 1, "liq_usd": 0, "source": "curve"}, 1_000_001)
        tc = TelegramCommands(Telegram(FakeHttp([]), "1:a", "42"), db, s, engine=SimpleNamespace(ready_at=None))
        lines = await tc._emergency_lines(9)
        await db.close()
        return lines
    assert asyncio.run(go()) == ["  13:46Z real: liquidity $9,600 -> $4,000 on curve"]


class Pools:
    """DexScreener with every pair per mint (token_pair_lists), as the batched endpoint returns them."""

    def __init__(self, pairs):
        self.pairs = pairs

    async def token_pair_lists(self, mints):
        return {m: list(self.pairs) for m in mints}


def _pool(addr, usd, dex="pumpswap", quote=WSOL):
    return {"dexId": dex, "pairAddress": addr, "quoteToken": {"address": quote}, "priceNative": "1e-7",
            "liquidity": {"usd": usd}}


def test_a_deeper_side_pool_never_hides_the_own_pool_draining(s):
    async def go():
        dex = Pools([_pool("Own", 20_000), _pool("Side", 12_000, dex="meteora")])
        db, pm = await _manager(s, dex)
        p = await pm.create("M", 1, "shadow", "C", 10.0, None)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        await pm.periodic()
        assert p.liq_source == "pool:Own" and p.entry_liq_usd == 20_000
        # a second, deeper PumpSwap pool appears: the one measured before stays the reference
        dex.pairs = [_pool("Own", 15_000), _pool("Other", 50_000), _pool("Side", 12_000, dex="meteora")]
        await _poll(pm)
        assert p.liq_source == "pool:Own" and p.entry_liq_usd == 20_000 and not p.pending_exit
        dex.pairs = [_pool("Own", 8_000), _pool("Side", 12_000, dex="meteora")]   # the side pool is deeper now
        await _poll(pm)
        assert p.pending_exit == "emergency_liquidity_drop"
        await db.close()
    asyncio.run(go())


def test_the_reference_survives_a_restart(s):
    async def go():
        dex = Pools([_pool("Own", 30_000)])
        db, pm = await _manager(s, dex)
        p = await pm.create("M", 1, "shadow", "C", 10.0, None)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        await pm.periodic()
        assert p.entry_liq_usd == 30_000
        again = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice(), dex=dex)
        await again.load()
        q = again.positions[p.id]
        assert q.entry_liq_usd == 30_000 and q.liq_source == "pool:Own"
        dex.pairs = [_pool("Own", 12_000)]                                       # -60% after the restart
        await again.periodic()
        assert q.pending_exit == "emergency_liquidity_drop"
        await db.close()
    asyncio.run(go())


def test_an_emergency_is_reported_once_while_it_waits(s):
    class Rug:
        async def check(self, mint, max_age_s=0):
            return {"danger": ["Freeze Authority still enabled"], "risks": [], "score_normalised": 90}

    sent: list[str] = []

    async def go():
        depth = {"M": 9_000.0}
        db, pm = await _manager(s, Dex(), depth, rug=Rug(), sent=sent)
        p = await pm.create("M", 1, "real", "C", 10.0, 9_000)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        depth["M"] = 3_000.0
        for _ in range(3):
            pm._last_rug_poll = 0
            await _poll(pm)
        events = await db.fetchall("SELECT kind FROM events WHERE kind IN ('liq_drop', 'rug_danger')")
        await db.close()
        return sorted(e["kind"] for e in events)
    assert asyncio.run(go()) == ["liq_drop", "rug_danger"]
    assert sum("RUGCHECK DANGER" in t for t in sent) == 1


def test_a_held_coin_priced_in_another_token_is_sold_and_pending_buys_dropped(s):
    sent: list[str] = []

    async def go():
        db, pm = await _manager(s, sent=sent)
        quotes = {}
        pm.quote_of = quotes.get
        p = await pm.create("M", 1, "real", "C", 10.0, None)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        pending = await pm.create("N", 2, "real", "D", 10.0, None)
        quotes.update({"M": USDC, "N": USDC})
        await pm.periodic()
        assert p.pending_exit == "emergency_non_sol_quote"
        assert pending.status == "cancelled" and pending.exit_reason == f"priced in {USDC}, not SOL"
        await pm.periodic()
        await db.close()
    asyncio.run(go())
    assert sum("turned out to be priced in" in t for t in sent) == 1        # said once, not every pass
    assert any(t.startswith("⚪ NO ENTRY N") and f"priced in {USDC}, not SOL" in t for t in sent)


def test_an_emergency_queued_during_another_sale_sells_when_that_lands(s):
    class SlowLive(PaperExecutor):
        mode = "live"

        def __init__(self, s):
            super().__init__(s)
            self.sells, self.gate = [], asyncio.Event()

        async def sell(self, mint, tokens, price, fraction=1.0, **kw):
            self.sells.append(fraction)
            if len(self.sells) == 1:
                await self.gate.wait()                  # the take-profit sale is slow to confirm
            return await super().sell(mint, tokens, price, fraction)

    async def go():
        ex = SlowLive(s)
        db, pm = await _manager(s, ex=ex)
        p = await pm.create("M", 1, "real", "C", 10.0, None)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        await pm.drain(1)
        await pm.on_tick("M", 2e-7, p.decided_at + 2, {})                     # take-profit sale in flight
        await asyncio.sleep(0)
        async with pm.lock:
            await pm.queue_exit(p, "emergency_liquidity_drop")
        assert ex.sells == [s.TAKE_PROFIT_SELL_FRACTION]                      # no second sale while one is out
        ex.gate.set()
        await pm.drain(2)
        assert p.status == "open" and p.pending_exit == "emergency_liquidity_drop"
        await pm.periodic()                                                   # the emergency goes out now
        await pm.drain(2)
        assert len(ex.sells) == 2 and p.status == "closed" and p.exit_reason == "emergency_liquidity_drop"
        await db.close()
    asyncio.run(go())
