"""A paced LLM budget must fund whole committees, never partial ones: the pre-check covers what a
full evaluation costs lately, a tight budget runs one committee at a time and re-checks after
waiting, and the status says why an agent failed (a starved agent is an automatic PASS)."""
import asyncio
import json

from bot.config import load_settings
from bot.db import Database
from bot.sim import SIM_OVERRIDES, build_sim_engine
from bot.status import _err_tag, build_status
from bot.util import now_s


def _settings(tmp_path, **extra):
    o = dict(SIM_OVERRIDES, DB_PATH=str(tmp_path / "b.db"), REPORTS_DIR=str(tmp_path / "rep"),
             STOP_FILE=str(tmp_path / "STOP"), LOG_FILE="", **extra)
    return load_settings(overrides=o)


def test_full_evaluation_estimate_uses_recent_committees_not_triage_skips(tmp_path):
    s = _settings(tmp_path)
    eng = build_sim_engine(s)

    async def run():
        await eng.db.open()
        try:
            assert await eng._typical_evaluation_usd() == 0.0                      # no history: no estimate
            for i, cost in enumerate([0.10, 0.12, 0.14, 0.16]):
                await eng.db.insert("candidates", {"mint": f"m{i}", "ts": now_s(), "metrics": "{}", "status": "evaluated",
                                                   "decision": "PASS", "gate_reason": "agent error: scout", "llm_cost_usd": cost})
            assert await eng._typical_evaluation_usd() == 0.0                      # four samples are not enough
            await eng.db.insert("candidates", {"mint": "skip", "ts": now_s(), "metrics": "{}", "status": "evaluated",
                                               "decision": "PASS", "gate_reason": "triage: bundled", "llm_cost_usd": 0.005})
            await eng.db.insert("candidates", {"mint": "m4", "ts": now_s(), "metrics": "{}", "status": "evaluated",
                                               "decision": "BUY", "gate_reason": "unanimous", "llm_cost_usd": 0.18})
            # five committees (a triage-only skip is not one): 1.5 x their mean
            assert abs(await eng._typical_evaluation_usd() - 1.5 * (0.10 + 0.12 + 0.14 + 0.16 + 0.18) / 5) < 1e-9
        finally:
            await eng.db.close()
    asyncio.run(run())


def test_tight_budget_runs_one_committee_at_a_time_and_rechecks_after_waiting(tmp_path, monkeypatch):
    s = _settings(tmp_path)
    eng = build_sim_engine(s)
    # enough for one committee, not two: once one has started, the other finds the money gone
    active, peak, ran, state = [0], [0], [], {"spent": False}

    async def fake_remaining():
        return 0.10 if state["spent"] else 0.30

    async def fake_estimate():
        return 0.20

    async def fake_committee(cid, mint, ctx_data, context, tctx, specs):
        state["spent"] = True
        active[0] += 1
        peak[0] = max(peak[0], active[0])
        await asyncio.sleep(0.05)
        active[0] -= 1
        ran.append(cid)
        await eng.db.update("candidates", "id", cid, {"status": "evaluated", "decision": "PASS"})
        return {"candidate_id": cid, "decision": "PASS", "votes": []}

    async def run():
        await eng.db.open()
        try:
            monkeypatch.setattr(eng.llm_budget, "remaining", fake_remaining)
            monkeypatch.setattr(eng, "_typical_evaluation_usd", fake_estimate)
            monkeypatch.setattr(eng, "_evaluate_with_llm", fake_committee)

            async def no_positions(mint, status):   # the position manager only exists inside run()
                return None
            monkeypatch.setattr(eng, "_finish_mint", no_positions)
            a = await eng.db.insert("candidates", {"mint": "A" * 32, "ts": now_s(), "metrics": json.dumps({"symbol": "A"})})
            b = await eng.db.insert("candidates", {"mint": "B" * 32, "ts": now_s(), "metrics": json.dumps({"symbol": "B"})})
            await asyncio.gather(eng.evaluate(a), eng.evaluate(b))
            rows = {r["id"]: r for r in await eng.db.fetchall("SELECT id, status, gate_reason FROM candidates")}
            assert peak[0] == 1 and len(ran) == 1
            skipped = [r for r in rows.values() if r["status"] == "skipped_budget"]
            assert len(skipped) == 1 and "for one full evaluation" in skipped[0]["gate_reason"]
            assert not eng._eval_gate.locked()
        finally:
            await eng.db.close()
    asyncio.run(run())


def test_status_names_the_cause_of_agent_errors(tmp_path):
    assert _err_tag(None) == "" and _err_tag("") == ""
    assert _err_tag("llm budget: llm budget: 0.0300 needed, 0.0012 left") == "(err:budget)"
    assert _err_tag("api 529: overloaded") == "(err:api)"
    assert _err_tag("rate limited: 429") == "(err:rate)"
    assert _err_tag("connection: peer reset") == "(err:net)"
    assert _err_tag("something new") == "(err)"
    s = _settings(tmp_path)

    async def run():
        db = await Database(s.DB_PATH).open()
        try:
            cid = await db.insert("candidates", {"mint": "M" * 32, "ts": now_s(), "metrics": "{}", "status": "evaluated",
                                                 "decision": "PASS", "mean_confidence": 0.2,
                                                 "gate_reason": "agent error: scout, analyst"})
            for agent, err in (("scout", "llm budget: 0.03 needed, 0.00 left"), ("analyst", "llm budget: x"),
                               ("hunter", None)):
                await db.insert("votes", {"candidate_id": cid, "mint": "M" * 32, "agent": agent, "vote": "PASS",
                                          "confidence": 0.0 if err else 0.6, "error": err, "ts": now_s()})
            text = await build_status(db, s)
        finally:
            await db.close()
        return text
    text = asyncio.run(run())
    assert "agent errors today: budget 2 (" in text
    assert "scout=PASS/0.00(err:budget)" in text and "hunter=PASS/0.60 " in text
