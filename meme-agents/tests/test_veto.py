"""The veto stage: forensics and social agents can turn a unanimous BUY into a PASS, never the reverse."""
import asyncio
import time

import pytest

from bot.agents.base import Vote
from bot.agents.forensics import funding_graph, wallet_profile
from bot.agents.social import author_stats
from bot.agents.tools import ToolContext, build_veto_specs
from bot.consensus import GateResult, apply_vetoes, gate, veto_reason

NOW = 1_791_300_000.0


def _core(conf=0.8):
    return [Vote(a, "BUY", conf, tool_calls_ok=1, grounding=1.0) for a in ("scout", "hunter", "analyst")]


def _veto(agent="forensics", vote="PASS", conf=0.9, tools_ok=1, grounding=1.0, error=None):
    return Vote(agent, vote, conf, reasons=["two holders share funder Fund1"], evidence=["Fund1"],
                tool_calls_ok=tools_ok, grounding=grounding, error=error)


def test_grounded_confident_veto_blocks_a_buy(s):
    buy = gate(_core(), s)
    assert buy.decision == "BUY"
    out = apply_vetoes(buy, [_veto()], s)
    assert out.decision == "PASS" and out.reason == "veto from forensics: two holders share funder Fund1"
    assert out.size_usd is None and out.mean_confidence == buy.mean_confidence
    both = apply_vetoes(buy, [_veto("forensics"), _veto("social")], s)
    assert both.reason.count("veto from") == 2


def test_weak_or_ungrounded_vetoes_are_ignored(s):
    buy = gate(_core(), s)
    assert veto_reason(_veto(conf=0.69), s) is None            # below VETO_MIN_CONFIDENCE
    assert veto_reason(_veto(tools_ok=0), s) is None           # no successful tool call
    assert veto_reason(_veto(grounding=0.2), s) is None        # evidence not in tool results
    assert veto_reason(_veto(error="timeout"), s) is None      # errored agent
    assert veto_reason(_veto(vote="BUY"), s) is None           # no finding
    assert veto_reason(_veto(agent="scout"), s) is None        # not a veto agent
    for v in (_veto(conf=0.69), _veto(tools_ok=0), _veto(grounding=0.2), _veto(error="x"), _veto(vote="BUY")):
        assert apply_vetoes(buy, [v], s).decision == "BUY"


def test_vetoes_never_create_a_buy(s):
    p = GateResult("PASS", 0.5, "PASS from hunter", None)
    assert apply_vetoes(p, [_veto(vote="BUY", conf=1.0)], s) is p


def _tx(ts, native=(), tokens=(), source="PUMP_FUN", type_="SWAP"):
    return {"timestamp": ts, "type": type_, "source": source,
            "native_transfers": [{"from": f, "to": t, "sol": sol} for f, t, sol in native],
            "token_transfers": [{"mint": m, "from": "x", "to": "y", "amount": 1} for m in tokens]}


def test_wallet_profile_and_funding_graph():
    txs = [_tx(NOW - 3600, native=[("Fund1", "W1", 2.5)], source="SYSTEM_PROGRAM", type_="TRANSFER"),
           _tx(NOW - 1800, tokens=["MintA"]), _tx(NOW - 900, tokens=["MintB"]),
           _tx(NOW - 600, native=[("W1", "Buyer9", 1.0)], source="SYSTEM_PROGRAM", type_="TRANSFER")]
    p1 = wallet_profile("W1", txs, NOW, limit=20)
    assert p1["tx_seen"] == 4 and not p1["history_truncated"] and p1["oldest_seen_days"] == round(3600 / 86400, 2)
    assert p1["first_funder"] == "Fund1" and p1["funders"] == [{"from": "Fund1", "sol": 2.5}]
    assert p1["sol_out_to"] == [{"to": "Buyer9", "sol": 1.0}]
    assert p1["distinct_tokens_touched"] == 2 and p1["pump_fun_txs"] == 2 and p1["types"]["TRANSFER"] == 2
    p2 = wallet_profile("W2", [_tx(NOW - 100, native=[("Fund1", "W2", 1.0)])], NOW)
    p3 = wallet_profile("W3", [_tx(NOW - 100, native=[("Creator", "W3", 0.4)])], NOW)
    old = wallet_profile("W4", [_tx(NOW - 86400 * 400, native=[("Other", "W4", 5.0)])] * 20, NOW)
    g = funding_graph([p1, p2, p3, old], creator="Creator")
    assert g["wallets"] == 4 and g["largest_shared_funder_cluster"] == 2
    assert g["shared_funders"] == [{"funder": "Fund1", "wallets": ["W1", "W2"]}]
    assert g["creator_funded_wallets"] == ["W3"]
    assert g["fresh_wallets"] == ["W1", "W2", "W3"] and g["fresh_share"] == 0.75   # W4: old, truncated history
    assert wallet_profile("Z", [], NOW)["oldest_seen_days"] is None


def test_author_stats_flags_bot_farms():
    posts = [{"author_id": "1", "text": "buy $X now"}, {"author_id": "1", "text": "buy $X now"},
             {"author_id": "2", "text": "buy $X now!"}, {"author_id": "3", "text": "lol what is $X"}]
    users = [{"id": "1", "username": "a", "created_at": "2026-09-30T00:00:00Z", "followers": 3, "following": 900},
             {"id": "2", "username": "b", "created_at": "2026-10-01T00:00:00Z", "followers": 10, "following": 50},
             {"id": "3", "username": "c", "created_at": "2019-05-01T00:00:00Z", "followers": 5000, "following": 300,
              "verified": True}]
    st = author_stats(users, posts, NOW)
    assert st["authors_profiled"] == 3 and st["authors_in_posts"] == 3 and st["verified"] == 1
    assert st["share_under_30_days"] == pytest.approx(2 / 3, abs=0.01) and st["share_under_50_followers"] == 0.67
    assert st["share_follow_heavy"] == 0.33 and st["max_posts_by_one_author"] == 2
    assert st["duplicate_text_ratio"] == 0.25
    assert st["authors"][0]["posts_about_token"] == 2 and st["authors"][2]["age_days"] > 2000
    assert author_stats([], [], NOW)["median_account_age_days"] is None


class FakeHelius:
    def __init__(self):
        self.calls = []

    async def holders(self, mint, exclude=None):
        return {"holders": [{"owner": "Curve", "is_pool_or_curve": True}, {"owner": "Creator"},
                            {"owner": "H1"}, {"owner": "H2"}, {"owner": "H3"}]}

    async def address_transactions(self, address, limit=20):
        self.calls.append(address)
        funder = "Fund1" if address in ("H1", "H2") else "Creator" if address == "H3" else "Exchange"
        return [_tx(NOW - 500, native=[(funder, address, 1.0)]), _tx(NOW - 400, tokens=["M9"])]


class FakeRug:
    async def report(self, mint):
        return {}


class FakeX:
    def __init__(self):
        self.user_calls = []

    async def search(self, query, max_results=10, since_ts=None):
        return {"posts": [{"post_id": f"18433277760112394{i:02d}", "author": f"{i}", "text": "gm $X"}
                          for i in range(4)]}

    async def users(self, ids):
        self.user_calls.append(list(ids))
        return {"users": [{"id": i, "created_at": "2026-10-05T00:00:00Z", "followers": 1, "following": 500}
                          for i in ids]}


def test_veto_tools_resolve_wallets_and_authors(s, tmp_path):
    hel, x = FakeHelius(), FakeX()

    async def flow(mint):
        return {"sniper_wallets": ["S1", "S2", "Creator"], "snipers_still_holding": "2/3"}

    ctx = ToolContext(s, None, None, FakeRug(), hel, x, None,
                      {"mint": "MINT", "creator": "Creator", "bonding_curve_key": "Curve", "since_ts": NOW - 3600},
                      flow=flow)
    forensics, social = build_veto_specs(ctx)
    assert forensics.name == "forensics" and social.name == "social"

    async def go():
        hf = await forensics.impl["holder_funding"]({})
        sn = await forensics.impl["sniper_wallets"]({})
        ch = await forensics.impl["creator_history"]({})
        sr = await social.impl["x_search"]({"query": "$X -is:retweet"})
        au = await social.impl["x_authors"]({})
        return hf, sn, ch, sr, au

    hf, sn, ch, sr, au = asyncio.run(go())
    assert [w["wallet"] for w in hf["wallets"]] == ["H1", "H2", "H3"]        # curve and creator excluded
    assert hf["graph"]["shared_funders"] == [{"funder": "Fund1", "wallets": ["H1", "H2"]}]
    assert hf["graph"]["creator_funded_wallets"] == ["H3"]
    assert [w["wallet"] for w in sn["wallets"]] == ["S1", "S2"] and sn["snipers_still_holding"] == "2/3"
    assert ch["wallet"] == "Creator" and ch["first_funder"] == "Exchange"
    assert sr["post_count"] == 4 and au["authors_profiled"] == 4 and au["share_under_50_followers"] == 1.0
    assert x.user_calls == [["0", "1", "2", "3"]]                              # authors taken from the search
    assert "Curve" not in hel.calls and "Creator" in hel.calls


def test_veto_prompts_and_model_roles():
    from bot.agents.prompts import ROLE_PROMPTS
    for name in ("forensics", "social"):
        assert f"Your role: {name.title()}" in ROLE_PROMPTS[name] and "can only block" in ROLE_PROMPTS[name]
    assert time.time() > NOW - 86400 * 365  # sanity: NOW is a plausible timestamp for these fixtures
