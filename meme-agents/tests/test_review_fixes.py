"""Regression tests for the independent review's findings (X cache, budget, config, guards)."""
import asyncio
import json
import time
from types import SimpleNamespace

import httpx
import pytest

from bot.agents.base import AgentSpec, run_agent, worst_case_call_usd
from bot.budget import Budget
from bot.config import ConfigError, load_settings
from bot.db import Database
from bot.feeds.helius import Helius, RpcError
from bot.feeds.rugcheck import Rugcheck
from bot.feeds.xapi import XClient, iso
from tests.test_misc import ScriptedLLM, _resp, _tu


# --- X cache --------------------------------------------------------------------------
def _x(s, responses, seen):
    def handler(request: httpx.Request):
        seen.append(dict(request.url.params))
        return httpx.Response(200, json=responses.pop(0))
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client


def _post(pid, ago_s):
    return {"id": pid, "text": f"post {pid}", "author_id": "a" + pid,
            "created_at": iso(time.time() - ago_s).replace("Z", ".000Z")}


def test_x_search_is_windowed_incremental_and_never_drops_known_posts(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        seen = []
        responses = [
            {"data": [_post("101", 3600), _post("102", 1800)], "meta": {"newest_id": "102"}},
            {"data": [_post("103", 60)], "meta": {"newest_id": "103"}},
            {"data": [_post("103", 60)], "meta": {"newest_id": "103"}},   # same post, another query
        ]
        http = _x(s, responses, seen)
        x = XClient(http, "https://api.x.com/2", "T", db, Budget(db, "x", 20, "month"), 0.005, 0.01)
        r1 = await x.search("$PEPE", 10, since_ts=time.time() - 7200)
        assert [p["post_id"] for p in r1["posts"]] == ["102", "101"] and "start_time" in seen[0]
        # a new token reusing the ticker launched 10 minutes ago: older posts are not its evidence
        r2 = await x.search("$PEPE", 10, since_ts=time.time() - 600)
        assert seen[1].get("since_id") == "102" and "start_time" not in seen[1]
        assert [p["post_id"] for p in r2["posts"]] == ["103"]
        # a post already stored by another query is linked, not dropped
        r3 = await x.search("pepe coin", 10, since_ts=time.time() - 600)
        assert [p["post_id"] for p in r3["posts"]] == ["103"]
        spent = await Budget(db, "x", 20, "month").spent()
        assert spent == pytest.approx(4 * 0.005)
        await http.aclose()
        await db.close()
    asyncio.run(go())


def test_x_stale_since_id_falls_back_to_start_time(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        await db.kv_set("xsince:search:$OLD", json.dumps({"id": "5", "fetched": time.time() - 7 * 86400}))
        seen = []
        http = _x(s, [{"data": [], "meta": {}}], seen)
        x = XClient(http, "https://api.x.com/2", "T", db, Budget(db, "x", 20, "month"), 0.005, 0.01)
        await x.search("$OLD", 10, since_ts=time.time() - 600)
        assert "since_id" not in seen[0] and "start_time" in seen[0]
        await http.aclose()
        await db.close()
    asyncio.run(go())


# --- config / chain fail-closed --------------------------------------------------------
def test_boolean_typos_refuse_instead_of_flipping_safety_flags(tmp_path):
    env = tmp_path / ".env"
    for bad in ("ture", "y", "dry", "enabled"):
        env.write_text(f"LIVE_DRY_RUN={bad}\n")
        with pytest.raises(ConfigError, match="LIVE_DRY_RUN"):
            load_settings(env)
    env.write_text("LIVE_DRY_RUN=false\nPF_REQUIRE_NULL_AUTHORITIES=on\n")
    st = load_settings(env)
    assert st.LIVE_DRY_RUN is False and st.PF_REQUIRE_NULL_AUTHORITIES is True
    env.write_text("PF_MIN_UNIQUE_BUYERS=lots\n")
    with pytest.raises(ConfigError, match="PF_MIN_UNIQUE_BUYERS"):
        load_settings(env)


def test_missing_balance_fails_closed():
    async def go():
        def handler(request):
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"context": {}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            h = Helius(http, "https://rpc.test", "https://api.test", "k", 10, 2)
            with pytest.raises(RpcError):
                await h.balance_sol("pk")
    asyncio.run(go())


def test_rugcheck_cache_is_bounded():
    rc = Rugcheck(None, "https://x", 1)
    now = time.time()
    for i in range(2500):
        rc._cache[f"m{i}"] = (now - (3700 if i < 300 else 0) + i * 1e-3, {})
    rc._prune()
    assert len(rc._cache) <= 2000 and "m0" not in rc._cache and "m2499" in rc._cache


# --- LLM budget and truncated turns ----------------------------------------------------
def test_worst_case_reservation_covers_a_full_output_and_cache_write(s):
    msgs = [{"role": "user", "content": "x" * 30_000}]
    w = worst_case_call_usd(s, [{"type": "text", "text": "sys"}], [], msgs)
    assert w >= s.LLM_MAX_TOKENS * s.LLM_PRICE_OUT_PER_MTOK / 1e6 + 10_000 * s.LLM_PRICE_IN_PER_MTOK * 1.25 / 1e6


def test_agent_refuses_to_call_when_the_worst_case_does_not_fit(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        llm = ScriptedLLM()
        b = Budget(db, "llm", 0.02, "day")  # less than one worst-case call ($0.031 of output alone)
        v = await run_agent(llm, s, AgentSpec("scout", "sys", [], {}), "ctx", b)
        await db.close()
        return v, llm
    v, llm = asyncio.run(go())
    assert v.vote == "PASS" and "budget" in v.error and llm.requests == []


def test_truncated_turn_is_discarded_not_trusted(s):
    async def lookup(a):
        return {"liquidity_usd": 12345.678}
    spec = AgentSpec("analyst", "sys", [{"name": "lookup", "description": "d",
                                         "input_schema": {"type": "object", "properties": {}}}],
                     {"lookup": lookup}, with_size=True)
    vote = {"vote": "BUY", "confidence": 0.9, "reasons": ["r"], "evidence": ["liquidity $12.3k"], "size_usd": 7}
    truncated = SimpleNamespace(content=[_tu("submit_vote", vote, "t0")], stop_reason="max_tokens",
                                usage=SimpleNamespace(input_tokens=10, output_tokens=2048,
                                                      cache_creation_input_tokens=0, cache_read_input_tokens=0))
    llm = ScriptedLLM(truncated, _resp(_tu("lookup", {})), _resp(_tu("submit_vote", {**vote, "vote": "PASS"}, "t2")))

    async def go():
        db = await Database(s.DB_PATH).open()
        v = await run_agent(llm, s, spec, "ctx", Budget(db, "llm", 5, "day"))
        await db.close()
        return v
    v = asyncio.run(go())
    assert v.raw_vote == "PASS" and v.turns == 3
    second = llm.requests[1]["messages"]
    assert len(second) == 1 and "cut off" in second[0]["content"]  # the truncated turn was dropped


# --- grounding refinements --------------------------------------------------------------
def test_tool_error_payloads_are_not_successful_lookups(s):
    async def disabled(a):
        return {"error": "X API disabled", "posts": []}
    spec = AgentSpec("scout", "sys", [{"name": "x_search", "description": "d",
                                       "input_schema": {"type": "object", "properties": {}}}], {"x_search": disabled})
    llm = ScriptedLLM(_resp(_tu("x_search", {})),
                      _resp(_tu("submit_vote", {"vote": "BUY", "confidence": 0.9, "reasons": ["r"],
                                                "evidence": ["unique_buyers 52"]}, "t2")))

    async def go():
        db = await Database(s.DB_PATH).open()
        v = await run_agent(llm, s, spec, '{"unique_buyers": 52}', Budget(db, "llm", 5, "day"))
        await db.close()
        return v
    v = asyncio.run(go())
    assert v.tool_calls_ok == 0 and v.vote == "PASS" and "tool call" in v.guard


def test_buy_must_cite_something_from_tool_results(s):
    async def ok(a):
        return {"holders": 120}
    spec = AgentSpec("analyst", "sys", [{"name": "holders", "description": "d",
                                         "input_schema": {"type": "object", "properties": {}}}],
                     {"holders": ok}, with_size=True)
    llm = ScriptedLLM(_resp(_tu("holders", {})),
                      _resp(_tu("submit_vote", {"vote": "BUY", "confidence": 0.9, "reasons": ["r"],
                                                "evidence": ["unique_buyers 52", "net inflow 17.5"],
                                                "size_usd": 5}, "t2")))

    async def go():
        db = await Database(s.DB_PATH).open()
        v = await run_agent(llm, s, spec, '{"unique_buyers": 52, "net_inflow_sol": 17.5}',
                            Budget(db, "llm", 5, "day"))
        await db.close()
        return v
    v = asyncio.run(go())
    assert v.grounding == 1.0 and v.vote == "PASS" and "nothing from tool results" in v.guard
