"""Regression checks for truthful performance and operational evidence."""
import asyncio
import json
import logging
import math
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from bot.acceptance import Recorder, evaluate_run, first_full_cycle, funnel, run_acceptance
from bot.db import Database
from bot.report import agent_accuracy, build_report, render_markdown, render_text, trade_metrics, write_daily
from bot.status import build_status, health


def test_percentage_drawdown_is_independent_of_largest_dollar_drop():
    result = trade_metrics([-40, 240, -60], [-0.4, 2.4, -0.6], 100)
    assert result["max_drawdown_usd"] == 60
    assert result["max_drawdown_pct"] == 40  # earlier 100 -> 60, not later 300 -> 240


def test_breakeven_trades_are_not_reported_as_losses():
    result = trade_metrics([1, 0, -1], [0.01, 0, -0.01], 50)
    assert result["wins"] == result["losses"] == result["breakeven"] == 1
    assert result["win_rate"] == pytest.approx(1 / 3)
    assert result["avg_loss_usd"] == -1


@pytest.mark.parametrize("usd,sol", [([math.nan], [0]), ([1], [math.inf]), ([1], [])])
def test_metrics_reject_unreliable_inputs(usd, sol):
    with pytest.raises(ValueError):
        trade_metrics(usd, sol, 50)


async def _position(db, cid, pnl, *, mode="paper", kind="real", status="closed", closed=2000, mint="M"):
    return await db.insert("positions", {"candidate_id": cid, "mint": mint, "kind": kind, "mode": mode,
                                        "status": status, "pnl_sol": pnl,
                                        "pnl_usd": None if pnl is None else pnl * 100,
                                        "cost_sol": 0.05, "closed_at": closed, "size_usd": 5})


def test_daily_equity_mode_scope_and_missing_pnl_are_explicit(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            day_start = datetime(2026, 1, 2, tzinfo=timezone.utc).timestamp()
            await _position(db, 1, 1.0, closed=day_start - 10)
            await _position(db, 2, -0.15, closed=day_start + 10)
            await _position(db, 3, 9.99, mode="live", closed=day_start + 15)
            await _position(db, 4, 0.05, mode=None, closed=day_start + 20)
            await _position(db, 5, None, closed=day_start + 30)
            await db.kv_set("heartbeat", json.dumps({"ts": day_start, "simulated": True}))
            report = await build_report(db, s, day="2026-01-02")
            text = render_text(report)
            return report, text
        finally:
            await db.close()
    report, text = asyncio.run(go())
    assert report["all_time"]["closed_trades"] == 3
    assert report["all_time"]["pnl_usd"] == 90
    assert report["day_metrics"]["starting_equity_usd"] == 150
    assert report["day_metrics"]["max_drawdown_pct"] == 10
    assert report["legacy_unknown_mode_trades"] == 1
    assert report["unscored_closed_trades"] == 1
    assert report["data_source"] == "simulation"
    assert "simulation results do not verify real-data acceptance" in text
    assert "closed-trade realized equity" in text


def test_accuracy_uses_final_vote_and_exact_candidate_outcome(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            # Two decisions on the same mint have different outcomes.
            await _position(db, 1, 0.01, kind="shadow")
            await _position(db, 2, -0.01, kind="shadow")
            for cid, vote, confidence in ((1, "BUY", 0.8), (1, "PASS", 0.9), (2, "BUY", 0.7)):
                await db.insert("votes", {"candidate_id": cid, "mint": "M", "agent": "scout",
                                          "vote": vote, "confidence": confidence})
            return await agent_accuracy(db)
        finally:
            await db.close()
    accuracy = asyncio.run(go())["agents"]["scout"]
    assert accuracy["votes"] == 2
    assert accuracy["buy_votes"] == accuracy["buy_scored"] == 1
    assert accuracy["buy_winners"] == accuracy["pass_losers"] == 0
    assert accuracy["shadow_scored"] == 2


def test_open_real_trade_is_not_scored_using_a_closed_shadow(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _position(db, 1, 0.01, kind="shadow")
            await _position(db, 1, None, status="open", closed=None)
            await db.insert("votes", {"candidate_id": 1, "agent": "scout", "vote": "BUY", "confidence": 0.8})
            return await agent_accuracy(db, mode="paper")
        finally:
            await db.close()
    result = asyncio.run(go())
    assert result["agents"]["scout"]["buy_scored"] == 0
    assert result["scored_candidates"] == 0


def test_paper_accuracy_does_not_include_live_trade_votes(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _position(db, 1, 0.01, mode="live")
            await _position(db, 1, 0.01, kind="shadow")
            await db.insert("votes", {"candidate_id": 1, "agent": "scout", "vote": "BUY", "confidence": 0.8})
            return await agent_accuracy(db, mode="paper")
        finally:
            await db.close()
    assert asyncio.run(go())["agents"] == {}


def test_markdown_embeds_valid_json_when_profit_factor_is_infinite(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _position(db, 1, 0.01)
            return render_markdown(await build_report(db, s))
        finally:
            await db.close()
    markdown = asyncio.run(go())
    raw = markdown.split("```json\n", 1)[1].split("\n```", 1)[0]
    parsed = json.loads(raw, parse_constant=lambda value: pytest.fail(f"invalid JSON constant: {value}"))
    assert parsed["all_time"]["profit_factor"] == "inf"


def test_failed_report_publish_preserves_the_previous_complete_report(s, monkeypatch):
    import bot.report as report_module

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            directory = s.path(s.REPORTS_DIR)
            directory.mkdir()
            path = directory / "daily-2026-01-02.md"
            path.write_text("previous complete report")

            def failed_replace(source, destination):
                raise OSError("disk publish failed")

            monkeypatch.setattr(report_module.os, "replace", failed_replace)
            with pytest.raises(OSError, match="publish failed"):
                await write_daily(db, s, day="2026-01-02")
            assert path.read_text() == "previous complete report"
            assert list(directory.glob("*.tmp")) == []
        finally:
            await db.close()
    asyncio.run(go())


async def _cycle(db, created, vote_times):
    cid = await db.insert("candidates", {"mint": "M", "ts": created, "decision": "PASS",
                                         "gate_reason": "agent PASS", "mean_confidence": 0.7})
    for agent, timestamp in zip(("scout", "hunter", "analyst"), vote_times):
        await db.insert("votes", {"candidate_id": cid, "agent": agent, "vote": "PASS",
                                  "confidence": 0.7, "ts": timestamp})
    return cid


def test_acceptance_requires_entire_cycle_within_the_run(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _cycle(db, 900, [950, 950, 1010])  # old candidate with one new vote
            await _cycle(db, 1020, [990, 1030, 1030])  # one vote predates the run
            await _cycle(db, 1040, [1050, 1050, 1200])  # one vote occurs after its end
            assert await first_full_cycle(db, 1000, True, until=1100) == (None, 0)
            cid = await _cycle(db, 1060, [1070, 1070, 1070])
            cycle, total = await first_full_cycle(db, 1000, True, until=1100)
            assert total == 1 and cycle["id"] == cid
        finally:
            await db.close()
    asyncio.run(go())


def test_acceptance_short_run_cannot_pass_using_old_twelve_second_tolerance(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await _cycle(db, 1000, [1000, 1000, 1000])
            criteria = await evaluate_run(db, s, 1000, 1001, 0.2, None, Recorder(), {}, False)
            assert criteria[0].status == "FAIL"
        finally:
            await db.close()
    asyncio.run(go())


def test_acceptance_funnel_counts_fills_instead_of_queued_entries(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.insert("positions", {"kind": "real", "status": "pending", "decided_at": 1010})
            await db.insert("positions", {"kind": "real", "status": "closed", "opened_at": 1020})
            await db.insert("positions", {"kind": "real", "status": "open", "opened_at": 1200})
            return await funnel(db, 1000, until=1100)
        finally:
            await db.close()
    assert asyncio.run(go())["real_entries"] == 1


def test_simulation_pass_does_not_satisfy_real_acceptance(s, monkeypatch, capsys):
    import bot.acceptance as acceptance

    times = iter([1000, 4600])
    monkeypatch.setattr(acceptance, "now_s", lambda: next(times))

    class Engine:
        simulated = True
        crashes = {}
        ingest = SimpleNamespace(stats={})
        helius = SimpleNamespace(credits=0)

        async def run(self, seconds):
            db = await Database(s.DB_PATH).open()
            try:
                await _cycle(db, 1010, [1020, 1020, 1020])
            finally:
                await db.close()

    assert asyncio.run(run_acceptance(s, 60, lambda settings: Engine())) == 3
    text = capsys.readouterr().out
    assert "SIMULATION" in text and "INCOMPLETE" in text


def test_acceptance_factory_failure_removes_logging_handler_and_writes_failure(s, capsys):
    before = tuple(logging.getLogger().handlers)

    def fail(settings):
        raise RuntimeError("startup failed")

    assert asyncio.run(run_acceptance(s, 60, fail)) == 1
    assert tuple(logging.getLogger().handlers) == before
    assert "startup failed" in capsys.readouterr().out


@pytest.mark.parametrize("raw", ["broken", "[]", '{"ts": "not-a-time"}', '{"ts": NaN}'])
def test_corrupt_heartbeat_is_down_without_crashing_status(s, raw):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("heartbeat", raw)
            assert (await health(db, s, 10000))[0] == "DOWN"
            assert "invalid heartbeat" in await build_status(db, s)
        finally:
            await db.close()
    asyncio.run(go())


def test_old_vote_errors_do_not_poison_a_restarted_session(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("heartbeat", json.dumps({"ts": 10000, "started_at": 9990, "last_msg_at": 9999}))
            for _ in range(6):
                await db.insert("votes", {"agent": "scout", "error": "api 401", "ts": 1000})
            return await health(db, s, 10030)
        finally:
            await db.close()
    assert asyncio.run(go())[0] == "OK"


def test_status_handles_missing_entry_price_and_labels_simulation(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("heartbeat", json.dumps({"ts": 10000, "simulated": True}))
            await db.insert("positions", {"kind": "real", "mode": "paper", "status": "open", "mint": "M",
                                          "size_usd": 5, "entry_price": 0, "last_price": 0.01, "cost_sol": 0.05})
            return await build_status(db, s)
        finally:
            await db.close()
    text = asyncio.run(go())
    assert "SIMULATION" in text and "price n/a vs entry, peak n/a" in text


def test_health_reports_a_running_mode_configuration_mismatch(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("heartbeat", json.dumps({"ts": 10000, "started_at": 9990,
                                                     "last_msg_at": 9999, "mode": "live"}))
            return await health(db, s, 10030)
        finally:
            await db.close()
    state, line = asyncio.run(go())
    assert state == "DEGRADED" and "running mode=live" in line
