"""Operations: acceptance verdicts, health states, the single-instance lock, systemd notify,
and the preflight probe's summaries."""
import asyncio
import json
import logging
import os
import socket

import pytest

from bot.acceptance import Recorder, evaluate_run, first_full_cycle, funnel, reason_keys
from bot.db import Database
from bot.preflight import K, summarize_pairs, summarize_stream
from bot.status import health
from bot.util import InstanceLock, sd_notify


def test_reason_keys_split_rules_and_drop_numbers():
    r = "rugcheck danger: Top 10 holders high ownership, Low Liquidity; liquidity $5,432 < $8,000; top10 41.2% >= 35.0%"
    assert reason_keys(r) == ["rugcheck danger: Top 10 holders high ownership", "rugcheck danger: Low Liquidity",
                              "liquidity below minimum", "top-10 holders above maximum"]
    assert reason_keys("dexscreener pair reports no liquidity") == ["dexscreener pair reports no liquidity"]


async def _seed(db, t0, *, agents=("scout", "hunter", "analyst"), error=None, decision="PASS"):
    cid = await db.insert("candidates", {"mint": "M1", "ts": t0 + 10, "metrics": {"prefilter": {"age_min": 6}},
                                         "status": "evaluated", "decision": decision, "mean_confidence": 0.7,
                                         "gate_reason": "PASS from scout"})
    for a in agents:
        await db.insert("votes", {"candidate_id": cid, "mint": "M1", "agent": a, "vote": "PASS", "confidence": 0.7,
                                  "reasons": ["r"], "evidence": [], "error": error, "ts": t0 + 20})
    await db.insert("prefilter_results", {"mint": "M2", "ts": t0 + 5, "passed": 0,
                                          "reason": "rugcheck danger: Low Liquidity", "metrics": {}})
    await db.insert("prefilter_results", {"mint": "M1", "ts": t0 + 6, "passed": 1, "reason": "ok", "metrics": {}})
    return cid


_RUNS = iter(range(10_000))


def _evaluate(s, seed_kw=None, **kw):
    path = f"{s.DB_PATH}.{next(_RUNS)}"  # a fresh database per evaluation

    async def go():
        db = await Database(path).open()
        await _seed(db, 1000.0, **(seed_kw or {}))
        rec = kw.pop("rec", Recorder())
        args = dict(started=1000.0, ended=1000.0 + 60 * 60, minutes=60, crash=None, rec=rec, crashes={},
                    no_llm=False)
        args.update(kw)
        crit = await evaluate_run(db, s, **args)
        f = await funnel(db, 1000.0)
        await db.close()
        return crit, f
    return asyncio.run(go())


def test_acceptance_passes_a_clean_full_run(s):
    crit, f = _evaluate(s)
    assert [c.status for c in crit] == ["PASS", "PASS"]
    assert f["stage1_passed"] == 2 and f["stage2_passed"] == 1
    assert f["stage2_sole_blocker"] == {"rugcheck danger: Low Liquidity": 1}


def test_acceptance_fails_on_errors_restarts_interruptions_and_missing_cycles(s):
    rec = Recorder()
    rec.emit(logging.LogRecord("bot.x", logging.ERROR, __file__, 1, "boom api-key=abcdefghijkl", None, None))
    crit, _ = _evaluate(s, rec=rec, crashes={"scanner": 1}, ended=1000.0 + 30 * 60)
    assert crit[0].status == "FAIL"
    assert "1 ERROR" in crit[0].detail and "scanner x1" in crit[0].detail and "interrupted" in crit[0].detail
    assert "abcdefghijkl" not in rec.errors[0]  # keys are masked in the report
    crit, _ = _evaluate(s, crash="StartupError: no network")
    assert crit[0].status == "FAIL" and "StartupError" in crit[0].detail
    # a vote with an agent error, or a missing agent, is not a full cycle
    assert _evaluate(s, seed_kw={"error": "api 529"})[0][1].status == "FAIL"
    assert _evaluate(s, seed_kw={"agents": ("scout", "hunter")})[0][1].status == "FAIL"


def test_acceptance_without_llm_is_skipped_not_passed(s):
    crit, _ = _evaluate(s, seed_kw={"error": "ANTHROPIC_API_KEY not set"}, no_llm=True)
    assert crit[1].status == "SKIP" and "1 candidate(s)" in crit[1].detail


def test_first_full_cycle_ignores_cycles_from_before_the_run(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        await _seed(db, 1000.0)
        out = await first_full_cycle(db, 5000.0, need_clean_votes=True)
        await db.close()
        return out
    assert asyncio.run(go()) == (None, 0)


def test_health_states(s):
    async def go(hb, now):
        db = await Database(s.DB_PATH).open()
        if hb is not None:
            await db.kv_set("heartbeat", json.dumps(hb))
        out = await health(db, s, now)
        await db.close()
        return out
    assert asyncio.run(go(None, 100))[0] == "DOWN"
    state, line = asyncio.run(go({"ts": 10_000, "stopped_at": 10_010}, 10_030))
    assert state == "DOWN" and "stopped cleanly" in line
    base = {"ts": 10_000, "started_at": 9_000, "last_msg_at": 9_990, "launches": 50, "cycles": 2, "queue": 0}
    assert asyncio.run(go(base, 10_400))[0] == "DOWN"                       # heartbeat 400 s old
    assert asyncio.run(go({**base, "last_msg_at": 9_000}, 10_030))[0] == "BLIND"
    assert asyncio.run(go({**base, "started_at": 9_950, "last_msg_at": 0}, 10_030))[0] == "OK"  # just started
    state, line = asyncio.run(go({**base, "paused": "daily loss cap hit"}, 10_030))
    assert state == "PAUSED" and "daily loss cap" in line
    state, line = asyncio.run(go({**base, "crashes": 2}, 10_030))
    assert state == "OK" and "2 loop restart" in line


def test_health_flags_agents_that_keep_failing(s):
    async def go(errors):
        db = await Database(s.DB_PATH).open()
        await db.execute("DELETE FROM votes")
        await db.kv_set("heartbeat", json.dumps({"ts": 10_000, "started_at": 9_000, "last_msg_at": 9_990}))
        for e in errors:
            await db.insert("votes", {"candidate_id": 1, "agent": "scout", "vote": "PASS", "error": e})
        out = await health(db, s, 10_030)
        await db.close()
        return out
    state, line = asyncio.run(go(["api 401: authentication_error"] * 6))
    assert state == "DEGRADED" and "401" in line
    assert asyncio.run(go(["api 401"] * 5 + [None]))[0] == "OK"          # one good vote among them
    assert asyncio.run(go(["llm budget: exhausted"] * 6))[0] == "OK"     # the budget stopping them is by design


def test_instance_lock_refuses_a_second_holder(tmp_path):
    a, b = InstanceLock(tmp_path / "bot.db.lock"), InstanceLock(tmp_path / "bot.db.lock")
    assert a.acquire()
    assert not b.acquire()
    a.release()
    assert b.acquire()
    b.release()


def test_engine_refuses_to_start_on_a_database_in_use(tmp_path):
    from bot.config import load_settings
    from bot.engine import Engine, StartupError
    s = load_settings(overrides={"DB_PATH": str(tmp_path / "x.db"), "HELIUS_API_KEY": "k", "LOG_FILE": ""})
    held = InstanceLock(str(tmp_path / "x.db") + ".lock")
    assert held.acquire()

    async def go():
        with pytest.raises(StartupError, match="already using"):
            await Engine(s).run(1)
    asyncio.run(go())
    held.release()


def test_sd_notify_speaks_systemds_protocol(tmp_path, monkeypatch):
    path = str(tmp_path / "notify.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    srv.bind(path)
    try:
        monkeypatch.setenv("NOTIFY_SOCKET", path)
        assert sd_notify("READY=1")
        assert srv.recv(64) == b"READY=1"
        monkeypatch.delenv("NOTIFY_SOCKET")
        assert not sd_notify("READY=1")  # outside systemd: a no-op
    finally:
        srv.close()
        os.unlink(path)


def test_probe_summaries():
    create = {"txType": "create", "mint": "M", "traderPublicKey": "D", "bondingCurveKey": "C", "solAmount": 1,
              "initialBuy": 3.4e7, "vSolInBondingCurve": 31.0, "vTokensInBondingCurve": K / 31.0, "name": "n",
              "symbol": "S", "signature": "sig"}
    cap = {"creates": [create, {**create, "mint": "M2"}], "trades": {}, "seconds": 60, "trade_subs": 2,
           "notices": [{"message": "trade data requires an API key"}], "migrations": [], "other_tx": {}}
    st = summarize_stream(cap)
    assert st["launches"] == 2 and st["launches_per_min"] == 2.0 and st["create_fields_missing"] == []
    assert st["create_reserves_product_vs_k_median"] == 1.0
    assert st["trades_received"] == 0 and st["notices"][0]["message"].startswith("trade data")
    st = summarize_stream({**cap, "creates": [{"mint": "X"}]})
    assert "bondingCurveKey" in st["create_fields_missing"]
    pairs = summarize_pairs({"A": {"dexId": "pumpfun", "liquidity": {"usd": 9000.4}, "txns": {"m5": {"buys": 3}}},
                             "B": {"dexId": "pumpfun"}, "C": None})
    assert pairs["pumpfun"]["pairs"] == 2 and pairs["pumpfun"]["liquidity_present"] == 1
    assert pairs["pumpfun"]["liquidity_usd_samples"] == [9000] and pairs["no pair"]["pairs"] == 1
