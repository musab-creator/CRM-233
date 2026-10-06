"""Ingest math, budgets, agent loop and report metrics."""
import asyncio
import json
import math
from types import SimpleNamespace

import pytest

from bot.agents.base import AgentSpec, run_agent
from bot.budget import Budget, BudgetExceeded, llm_cost_usd
from bot.config import load_dotenv, load_settings
from bot.db import Database
from bot.feeds.news import parse_feed
from bot.ingest import bonding_progress, trade_price
from bot.report import trade_metrics


def test_bonding_progress():
    assert bonding_progress(1_073_000_000) == 0
    assert bonding_progress(279_900_000) == pytest.approx(1.0)
    assert bonding_progress(None) == 0
    assert bonding_progress(10) == 1.0


def test_trade_price_prefers_trade_amounts():
    assert trade_price({"solAmount": 1, "tokenAmount": 1_000_000}) == 1e-6
    assert trade_price({"vSolInBondingCurve": 30, "vTokensInBondingCurve": 1_073_000_000}) == pytest.approx(30 / 1.073e9)
    assert trade_price({}) is None


def test_llm_cost():
    assert llm_cost_usd(1_000_000, 0, 0, 0, 3, 15) == 3
    assert llm_cost_usd(0, 1_000_000, 0, 0, 3, 15) == 15
    assert llm_cost_usd(0, 0, 1_000_000, 1_000_000, 3, 15) == pytest.approx(3.75 + 0.3)


def test_budget_reserve_and_stop(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        b = Budget(db, "llm", 1.0, "day")
        await b.reserve(0.6)
        with pytest.raises(BudgetExceeded):
            await b.reserve(0.5)
        await b.settle(0.6, 0.9)
        assert await b.spent() == pytest.approx(0.9)
        assert not await b.exhausted()
        await b.record(0.1)
        assert await b.exhausted()
        await db.close()
    asyncio.run(go())


def test_dotenv_and_types(tmp_path, monkeypatch):
    f = tmp_path / ".env"
    f.write_text("# c\nexport MODE=live\nBANKROLL_USD=75 # inline\nWATCHLIST_HANDLES='a, b'\nLIVE_DRY_RUN=false\n")
    assert load_dotenv(f)["MODE"] == "live"
    assert load_dotenv(f.parent / "missing.env") == {}
    monkeypatch.delenv("MODE", raising=False)
    s = load_settings(f)
    assert s.MODE == "live" and s.BANKROLL_USD == 75.0 and s.WATCHLIST_HANDLES == ["a", "b"]
    assert s.LIVE_DRY_RUN is False


def test_env_example_parses_cleanly():
    from pathlib import Path
    env = load_dotenv(Path(__file__).resolve().parent.parent / ".env.example")
    assert env["MODE"] == "paper" and env["TRUTH_SOCIAL_RSS_URL"] == "" and env["ANTHROPIC_API_KEY"] == ""
    assert not any(v.startswith("#") for v in env.values())
    s = load_settings(Path(__file__).resolve().parent.parent / ".env.example")
    assert s.PF_MIN_UNIQUE_BUYERS == 40 and s.LLM_MODEL == "claude-sonnet-4-6"


def test_rss_parse():
    xml = ("<rss><channel><item><title>Elon posts dog</title><link>https://x/1</link>"
           "<pubDate>Tue, 06 Oct 2026 03:00:00 GMT</pubDate></item></channel></rss>")
    items = parse_feed(xml, "rss:t")
    assert items[0]["title"] == "Elon posts dog" and items[0]["published_ts"] > 0


def test_report_metrics():
    m = trade_metrics([10, -5, 20, -10], [0.1, -0.05, 0.2, -0.1], 50)
    assert m["win_rate"] == 0.5
    assert m["expectancy_usd"] == pytest.approx(3.75)
    assert m["profit_factor"] == pytest.approx(2.0)
    assert m["max_drawdown_usd"] == pytest.approx(10)  # peak 75 -> 65
    assert m["pnl_sol"] == pytest.approx(0.15)
    assert trade_metrics([1], [0.01], 50)["profit_factor"] == math.inf
    assert trade_metrics([], [], 50)["win_rate"] is None


class ScriptedLLM:
    """Returns the scripted responses in order and records requests."""

    def __init__(self, *responses):
        self.messages = self
        self.responses = list(responses)
        self.requests = []

    async def create(self, **kw):
        self.requests.append({**kw, "messages": list(kw["messages"])})  # snapshot: the loop keeps appending
        return self.responses.pop(0)


def _resp(*blocks):
    return SimpleNamespace(content=list(blocks), stop_reason="tool_use",
                           usage=SimpleNamespace(input_tokens=1000, output_tokens=100,
                                                 cache_creation_input_tokens=0, cache_read_input_tokens=0))


def _tu(name, inp, i="t1"):
    return SimpleNamespace(type="tool_use", id=i, name=name, input=inp)


def test_agent_loop_runs_tools_then_votes(s):
    calls = []

    async def lookup(a):
        calls.append(a)
        return {"ok": True, "liquidity_usd": 12345.678}

    spec = AgentSpec("scout", "sys", [{"name": "lookup", "description": "d",
                                       "input_schema": {"type": "object", "properties": {}}}], {"lookup": lookup})
    llm = ScriptedLLM(_resp(_tu("lookup", {"q": 1})),
                      _resp(_tu("submit_vote", {"vote": "BUY", "confidence": 0.8, "reasons": ["r"],
                                                "evidence": ["liquidity $12.3k"]}, "t2")))

    async def go():
        db = await Database(s.DB_PATH).open()
        v = await run_agent(llm, s, spec, "ctx", Budget(db, "llm", 5, "day"))
        spent = await Budget(db, "llm", 5, "day").spent()
        await db.close()
        return v, spent
    v, spent = asyncio.run(go())
    assert v.vote == "BUY" and v.confidence == 0.8 and v.turns == 2 and not v.error
    assert v.raw_vote == "BUY" and v.grounding == 1.0 and v.tool_calls_ok == 1 and v.guard is None
    assert calls == [{"q": 1}]
    tool_result = llm.requests[1]["messages"][2]["content"][0]
    assert tool_result["type"] == "tool_result"
    assert json.loads(tool_result["content"]) == {"ok": True, "liquidity_usd": 12345.678}
    assert spent == pytest.approx(2 * llm_cost_usd(1000, 100, 0, 0, 3, 15))
    assert llm.requests[0]["model"] == "claude-sonnet-4-6"


def test_agent_invalid_vote_becomes_pass(s):
    spec = AgentSpec("hunter", "sys", [], {})
    llm = ScriptedLLM(_resp(_tu("submit_vote", {"vote": "MAYBE", "confidence": 0.8, "reasons": [], "evidence": []})))

    async def go():
        db = await Database(s.DB_PATH).open()
        v = await run_agent(llm, s, spec, "ctx", Budget(db, "llm", 5, "day"))
        await db.close()
        return v
    v = asyncio.run(go())
    assert v.vote == "PASS" and v.confidence == 0 and "invalid vote" in v.error


def test_agent_stops_when_budget_exhausted(s):
    spec = AgentSpec("analyst", "sys", [], {}, with_size=True)
    llm = ScriptedLLM()

    async def go():
        db = await Database(s.DB_PATH).open()
        b = Budget(db, "llm", 0.01, "day")
        v = await run_agent(llm, s, spec, "ctx", b)
        await db.close()
        return v
    v = asyncio.run(go())
    assert v.vote == "PASS" and "budget" in v.error and llm.requests == []


def _run(s, llm, spec, context="ctx", subject=None):
    async def go():
        db = await Database(s.DB_PATH).open()
        v = await run_agent(llm, s, spec, context, Budget(db, "llm", 5, "day"), subject_ids=subject)
        await db.close()
        return v
    return asyncio.run(go())


def _lookup_spec(result):
    async def lookup(a):
        return result
    return AgentSpec("analyst", "sys", [{"name": "lookup", "description": "d",
                                         "input_schema": {"type": "object", "properties": {}}}],
                     {"lookup": lookup}, with_size=True)


def _vote(vote, evidence):
    return {"vote": vote, "confidence": 0.9, "reasons": ["r"], "evidence": evidence, "size_usd": 7}


def test_guard_downgrades_buy_with_fabricated_evidence(s):
    spec = _lookup_spec({"top10_pct": 23.4, "holder": "So11111111111111111111111111111111111111112"})
    llm = ScriptedLLM(_resp(_tu("lookup", {})),
                      _resp(_tu("submit_vote", _vote("BUY", ["top10_pct 61.0", "whale 9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"]), "t2")))
    v = _run(s, llm, spec)
    assert v.raw_vote == "BUY" and v.vote == "PASS" and v.grounding == 0.0 and "grounding" in v.guard


def test_guard_keeps_buy_with_grounded_evidence(s):
    spec = _lookup_spec({"top10_pct": 23.4, "holder": "So11111111111111111111111111111111111111112"})
    llm = ScriptedLLM(_resp(_tu("lookup", {})),
                      _resp(_tu("submit_vote", _vote("BUY", ["top10 23.4%", "holder So11111111111111111111111111111111111111112",
                                                            "vibes are great"]), "t2")))
    v = _run(s, llm, spec)
    assert v.vote == "BUY" and v.grounding == 0.667 and v.guard is None and v.size_usd == 7


def test_guard_requires_a_successful_tool_call(s):
    # evidence matches the context, but the agent never looked anything up
    llm = ScriptedLLM(_resp(_tu("submit_vote", _vote("BUY", ["unique_buyers 52"]))))
    v = _run(s, llm, _lookup_spec({}), context='{"unique_buyers": 52}')
    assert v.vote == "PASS" and "tool call" in v.guard

    async def boom(a):
        raise RuntimeError("down")
    spec = AgentSpec("scout", "sys", [{"name": "lookup", "description": "d",
                                       "input_schema": {"type": "object", "properties": {}}}], {"lookup": boom})
    llm = ScriptedLLM(_resp(_tu("lookup", {})), _resp(_tu("submit_vote", _vote("BUY", ["unique_buyers 52"]), "t2")))
    v = _run(s, llm, spec, context='{"unique_buyers": 52}')
    assert v.vote == "PASS" and v.tool_calls_ok == 0


def test_guard_ignores_the_subject_mint_and_leaves_pass_alone(s):
    mint = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    spec = _lookup_spec({"mint": mint})
    llm = ScriptedLLM(_resp(_tu("lookup", {})), _resp(_tu("submit_vote", _vote("BUY", [f"mint {mint}"]), "t2")))
    assert _run(s, llm, spec, subject={mint}).vote == "PASS"
    llm = ScriptedLLM(_resp(_tu("lookup", {})), _resp(_tu("submit_vote", _vote("PASS", []), "t2")))
    v = _run(s, llm, spec, subject={mint})
    assert v.vote == "PASS" and v.guard is None


def test_old_database_is_migrated(tmp_path):
    import sqlite3
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE votes (id INTEGER PRIMARY KEY, candidate_id INTEGER, mint TEXT, agent TEXT, vote TEXT,"
                " confidence REAL, reasons TEXT, evidence TEXT, size_usd REAL, cost_usd REAL, turns INTEGER,"
                " error TEXT, ts REAL)")
    con.execute("INSERT INTO votes (agent, vote) VALUES ('scout', 'BUY')")
    con.commit()
    con.close()

    async def go():
        db = await Database(path).open()
        row = await db.fetchone("SELECT agent, vote, grounding, guard FROM votes")
        await db.close()
        return row
    assert asyncio.run(go()) == {"agent": "scout", "vote": "BUY", "grounding": None, "guard": None}
