"""End-to-end: the real engine on the offline simulator must complete full decision cycles
(candidate -> three agent votes with tool calls -> gate result -> shadow position) without
logging a single error. This is the 'Done when' cycle criterion, run in CI.

Both data paths run: the default (launches from the free stream, per-token state read from the
chain) and the paid PumpPortal trade stream for every launch."""
import asyncio
import json
import logging

import pytest

from bot.config import load_settings
from bot.db import Database
from bot.sim import SIM_OVERRIDES, build_sim_engine

FAST = dict(PF_MIN_AGE_MIN="0.15", PF_MIN_UNIQUE_BUYERS="5", PF_MIN_NET_INFLOW_SOL="1", PF_SCAN_INTERVAL_S="1",
            PF_MIN_LIQUIDITY_USD="500", CURVE_FIRST_POLL_S="2", CURVE_POLL_SCALE="0.05",
            CURVE_POLL_CALLS_PER_MIN="240", CURVE_HOT_POLL_S="1", HOLDERS_REFRESH_S="5")


def _settings(tmp_path, **extra):
    o = dict(SIM_OVERRIDES, DB_PATH=str(tmp_path / "e2e.db"), REPORTS_DIR=str(tmp_path / "rep"),
             STOP_FILE=str(tmp_path / "STOP"), LOG_FILE="", **FAST)
    o.update(extra)
    return load_settings(overrides=o)


@pytest.mark.parametrize("stream", ["off", "all"])
def test_engine_completes_decision_cycles_without_errors(tmp_path, caplog, stream):
    s = _settings(tmp_path, PUMPPORTAL_TRADE_STREAM=stream)
    eng = build_sim_engine(s, seed=3, launch_every_s=1.5)
    caplog.set_level(logging.INFO)
    asyncio.run(eng.run(25))

    async def read():
        db = await Database(s.DB_PATH).open()
        out = {
            "evaluated": await db.fetchall("SELECT id, mint, decision, gate_reason, metrics FROM candidates "
                                           "WHERE decision IS NOT NULL"),
            "votes": await db.fetchall("SELECT candidate_id, agent, vote, raw_vote, confidence, tool_calls_ok, "
                                       "grounding, guard, error FROM votes"),
            "shadows": await db.fetchall("SELECT candidate_id FROM positions WHERE kind='shadow'"),
            "reals": await db.fetchall("SELECT candidate_id FROM positions WHERE kind='real'"),
            "blocks": (await db.fetchone("SELECT COUNT(*) c FROM events WHERE kind='risk_block'"))["c"],
            "trades": (await db.fetchone("SELECT COUNT(*) c FROM trades"))["c"],
            "credits": await db.kv_get(next(iter([k["k"] for k in await db.fetchall(
                "SELECT k FROM kv WHERE k LIKE 'helius_credits:%'")]), "none")),
        }
        await db.close()
        return out
    r = asyncio.run(read())

    errors = [rec for rec in caplog.records if rec.levelno >= logging.ERROR]
    assert not errors, [e.getMessage() for e in errors]
    assert not eng.crashes
    assert r["evaluated"], "no candidate reached a gate decision"
    full = [c for c in r["evaluated"] if not (c["gate_reason"] or "").startswith("triage:")]
    assert full, "triage skipped every candidate"
    for c in full:
        vs = [v for v in r["votes"] if v["candidate_id"] == c["id"] and v["agent"] != "triage"]
        assert sorted(v["agent"] for v in vs) == ["analyst", "hunter", "scout"]
        tri = [v for v in r["votes"] if v["candidate_id"] == c["id"] and v["agent"] == "triage"]
        assert len(tri) == 1 and tri[0]["error"] is None
        assert tri[0]["vote"] == "BUY" or tri[0]["confidence"] < s.TRIAGE_MIN_CONFIDENCE  # let through
    for c in r["evaluated"]:
        if (c["gate_reason"] or "").startswith("triage:"):
            assert c["decision"] == "PASS"
            assert [v["agent"] for v in r["votes"] if v["candidate_id"] == c["id"]] == ["triage"]
        assert all(v["error"] is None and v["tool_calls_ok"] >= 1 for v in vs)
        assert c["decision"] in ("BUY", "PASS") and c["gate_reason"]
        flow = json.loads(c["metrics"])["flow"]
        if stream == "off":
            # per-token state came from the chain: curve reads, holder counts, launch-minute trades
            assert flow["source"] == "chain" and flow["launch_minute_trades"] > 0 and "error" not in flow
            assert flow["wallets_ex_dev"] >= 5 and flow["curve_reads"] >= 1
            assert json.loads(c["metrics"])["prefilter"]["inflow_source"] == "curve"
        else:
            assert "distinct_buyers_ex_dev" in flow and flow["trades"] > 0
    if stream == "off":
        assert eng.ingest.stats["curve_reads"] > 0 and eng.ingest.stats["stream_trades"] == 0
        assert int(r["credits"]) > 0  # Helius credits are metered and persisted
    else:
        assert r["trades"] > 100 and eng.ingest.stats["stream_trades"] > 100
    assert {sh["candidate_id"] for sh in r["shadows"]} >= {c["id"] for c in r["evaluated"]}
    assert any("DECISION" in rec.getMessage() for rec in caplog.records)
    # grounded BUYs must survive the guard (a guard that rejects everything would pass silently otherwise)
    assert any(v["raw_vote"] == "BUY" and v["vote"] == "BUY" and v["guard"] is None for v in r["votes"])
    # every gate BUY becomes a real entry unless the risk manager blocked it
    buys = {c["id"] for c in r["evaluated"] if c["decision"] == "BUY"}
    assert len({p["candidate_id"] for p in r["reals"]} & buys) + r["blocks"] >= len(buys)


def test_engine_stops_evaluating_when_the_llm_budget_cannot_cover_an_evaluation(tmp_path, caplog):
    """Below the worst case of one evaluation, candidates are skipped, not run into budget errors."""
    s = _settings(tmp_path, LLM_DAILY_BUDGET_USD="0.05")  # below three first calls (~$0.04 each)
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
