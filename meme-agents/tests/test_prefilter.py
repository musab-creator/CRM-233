import asyncio

from bot.feeds.rugcheck import normalise, top10_pct
from bot.ingest import MintState
from bot.prefilter import full_check, stage1, stage2

NOW = 1_800_000_000.0


def mint(age_min=20.0, buyers=50, inflow=20.0) -> MintState:
    st = MintState(mint="M", creator="C", bonding_curve_key="CURVE", first_trade_at=NOW - age_min * 60)
    st.buyers = {f"w{i}" for i in range(buyers)}
    st.buy_sol = inflow + 5
    st.sell_sol = 5
    return st


def rug(**kw) -> dict:
    base = {"has_report": True, "danger": [], "mint_authority": None, "freeze_authority": None,
            "top10_pct": 20.0, "score_normalised": 5}
    base.update(kw)
    return base


PAIR = {"liquidity": {"usd": 12_000}, "dexId": "pumpfun", "pairAddress": "P"}


def test_stage1_passes_inside_all_thresholds(s):
    r = stage1(mint(), NOW, s)
    assert r.passed, r.reasons


def test_stage1_age_window_bounds(s):
    assert not stage1(mint(age_min=4.9), NOW, s).passed
    assert stage1(mint(age_min=5.0), NOW, s).passed
    assert stage1(mint(age_min=90.0), NOW, s).passed
    assert not stage1(mint(age_min=90.1), NOW, s).passed


def test_stage1_buyers_and_inflow(s):
    assert not stage1(mint(buyers=39), NOW, s).passed
    assert stage1(mint(buyers=40), NOW, s).passed
    r = stage1(mint(inflow=14.99), NOW, s)
    assert not r.passed and "net inflow" in r.reason
    assert stage1(mint(inflow=15.0), NOW, s).passed


def test_creator_is_not_a_unique_buyer():
    from bot.ingest import Ingestor

    class DB:
        async def upsert_mints(self, rows): ...
    ing = Ingestor.__new__(Ingestor)
    ing.mints, ing._trade_buf, ing._dirty, ing.stats = {}, [], set(), {"creates": 0, "trades": 0}
    st = MintState(mint="M", creator="DEV")
    ing._apply(st, "buy", "DEV", 1.0, 100.0, {}, NOW)
    ing._apply(st, "buy", "A", 1.0, 100.0, {}, NOW)
    ing._apply(st, "buy", "A", 1.0, 100.0, {}, NOW)
    ing._apply(st, "sell", "DEV", 0.5, 50.0, {}, NOW)
    assert st.unique_buyers == 1
    assert st.net_inflow_sol == 2.5
    assert st.creator_sold_sol == 0.5


def test_stage2_passes_clean_token(s):
    assert stage2(rug(), PAIR, s).passed


def test_stage2_rejects_danger_authorities_concentration_liquidity(s):
    assert "danger" in stage2(rug(danger=["Freeze Authority still enabled"]), PAIR, s).reason
    assert "mint authority" in stage2(rug(mint_authority="X"), PAIR, s).reason
    assert "freeze authority" in stage2(rug(freeze_authority="X"), PAIR, s).reason
    assert not stage2(rug(top10_pct=35.0), PAIR, s).passed
    assert stage2(rug(top10_pct=34.9), PAIR, s).passed
    assert not stage2(rug(), {"liquidity": {"usd": 7_999}}, s).passed
    assert stage2(rug(), {"liquidity": {"usd": 8_000}}, s).passed
    assert "no dexscreener pair" in stage2(rug(), None, s).reason
    assert "unavailable" in stage2(None, PAIR, s).reason


def test_thresholds_are_config(s):
    s.PF_MIN_UNIQUE_BUYERS = 100
    s.PF_MIN_LIQUIDITY_USD = 50_000
    assert not stage1(mint(buyers=60), NOW, s).passed
    assert not stage2(rug(), PAIR, s).passed


def test_top10_excludes_bonding_curve_and_pools():
    holders = [{"address": "CURVE", "owner": "pump", "pct": 70.0},
               {"address": "POOLVAULT", "owner": "amm", "pct": 10.0}] + \
              [{"address": f"h{i}", "owner": f"o{i}", "pct": 2.0} for i in range(12)]
    assert top10_pct(holders, {"CURVE", "POOLVAULT"}) == 20.0
    report = {"topHolders": holders, "markets": [{"pubkey": "POOL", "liquidityA": "POOLVAULT"}],
              "token": {"mintAuthority": None, "freezeAuthority": None},
              "risks": [{"name": "Low Liquidity", "level": "warn"}]}
    n = normalise({"score_normalised": 3}, report, "CURVE")
    assert n["top10_pct"] == 20.0 and n["danger"] == [] and n["mint_authority"] is None


def test_full_check_skips_network_when_stage1_fails(s):
    class Boom:
        async def check(self, *a, **k):
            raise AssertionError("should not be called")

        async def pair(self, *a, **k):
            raise AssertionError("should not be called")

    r = asyncio.run(full_check(mint(buyers=1), NOW, s, Boom(), Boom()))
    assert not r.passed


def test_full_check_end_to_end(s):
    class Rug:
        async def check(self, m, curve):
            return rug()

    class Dex:
        async def pair(self, m):
            return PAIR

    r = asyncio.run(full_check(mint(), NOW, s, Rug(), Dex()))
    assert r.passed and r.metrics["liquidity_usd"] == 12_000
