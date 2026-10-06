"""End-to-end: the real engine on the offline simulator must complete full decision cycles
(candidate -> three agent votes with tool calls -> gate result -> shadow position) without
logging a single error. This is the 'Done when' cycle criterion, run in CI."""
import asyncio
import logging

from bot.config import load_settings
from bot.db import Database
from bot.sim import SIM_OVERRIDES, build_sim_engine


def test_engine_completes_decision_cycles_without_errors(tmp_path, caplog):
    o = dict(SIM_OVERRIDES, DB_PATH=str(tmp_path / "e2e.db"), REPORTS_DIR=str(tmp_path / "rep"),
             STOP_FILE=str(tmp_path / "STOP"), LOG_FILE="", PF_MIN_AGE_MIN="0.15", PF_MIN_UNIQUE_BUYERS="5",
             PF_MIN_NET_INFLOW_SOL="1", PF_SCAN_INTERVAL_S="1", PF_MIN_LIQUIDITY_USD="500")
    s = load_settings(overrides=o)
    eng = build_sim_engine(s, seed=3, launch_every_s=1.5)
    caplog.set_level(logging.INFO)
    asyncio.run(eng.run(25))

    async def read():
        db = await Database(s.DB_PATH).open()
        out = {
            "evaluated": await db.fetchall("SELECT id, decision, gate_reason, metrics FROM candidates "
                                           "WHERE decision IS NOT NULL"),
            "votes": await db.fetchall("SELECT candidate_id, agent, vote, raw_vote, confidence, tool_calls_ok, "
                                       "grounding, guard, error FROM votes"),
            "shadows": await db.fetchall("SELECT candidate_id FROM positions WHERE kind='shadow'"),
            "reals": await db.fetchall("SELECT candidate_id FROM positions WHERE kind='real'"),
            "blocks": (await db.fetchone("SELECT COUNT(*) c FROM events WHERE kind='risk_block'"))["c"],
            "trades": (await db.fetchone("SELECT COUNT(*) c FROM trades"))["c"],
        }
        await db.close()
        return out
    r = asyncio.run(read())

    errors = [rec for rec in caplog.records if rec.levelno >= logging.ERROR]
    assert not errors, [e.getMessage() for e in errors]
    assert r["trades"] > 100
    assert r["evaluated"], "no candidate reached a gate decision"
    for c in r["evaluated"]:
        vs = [v for v in r["votes"] if v["candidate_id"] == c["id"]]
        assert sorted(v["agent"] for v in vs) == ["analyst", "hunter", "scout"]
        assert all(v["error"] is None and v["tool_calls_ok"] >= 1 for v in vs)
        assert c["decision"] in ("BUY", "PASS") and c["gate_reason"]
        assert '"flow"' in c["metrics"]
    assert {sh["candidate_id"] for sh in r["shadows"]} >= {c["id"] for c in r["evaluated"]}
    assert any("DECISION" in rec.getMessage() for rec in caplog.records)
    # grounded BUYs must survive the guard (a guard that rejects everything would pass silently otherwise)
    assert any(v["raw_vote"] == "BUY" and v["vote"] == "BUY" and v["guard"] is None for v in r["votes"])
    # every gate BUY becomes a real entry unless the risk manager blocked it
    buys = {c["id"] for c in r["evaluated"] if c["decision"] == "BUY"}
    assert len({p["candidate_id"] for p in r["reals"]} & buys) + r["blocks"] >= len(buys)


def test_engine_stops_evaluating_when_the_llm_budget_cannot_cover_an_evaluation(tmp_path, caplog):
    """Below the worst case of one evaluation, candidates are skipped, not run into budget errors."""
    o = dict(SIM_OVERRIDES, DB_PATH=str(tmp_path / "b.db"), REPORTS_DIR=str(tmp_path / "rep"),
             STOP_FILE=str(tmp_path / "STOP"), LOG_FILE="", PF_MIN_AGE_MIN="0.15", PF_MIN_UNIQUE_BUYERS="5",
             PF_MIN_NET_INFLOW_SOL="1", PF_SCAN_INTERVAL_S="1", PF_MIN_LIQUIDITY_USD="500",
             LLM_DAILY_BUDGET_USD="0.05")  # below three first calls (~$0.04 each)
    s = load_settings(overrides=o)
    eng = build_sim_engine(s, seed=3, launch_every_s=1.5)
    caplog.set_level(logging.INFO)
    asyncio.run(eng.run(18))

    async def read():
        db = await Database(s.DB_PATH).open()
        out = (await db.fetchall("SELECT status, gate_reason FROM candidates"),
               (await db.fetchone("SELECT COUNT(*) c FROM votes"))["c"],
               (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='llm'"))["s"])
        await db.close()
        return out
    cands, n_votes, spent = asyncio.run(read())
    assert cands and all(c["status"] == "skipped_budget" for c in cands)
    assert n_votes == 0 and spent == 0
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
