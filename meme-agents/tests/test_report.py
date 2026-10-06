import asyncio

import pytest

from bot.db import Database
from bot.report import agent_accuracy, build_report, gate_sweep, render_text, signal_check


def row(buys, conf, ret, flow=None):
    return {"buys": buys, "mean_conf": conf, "ret": ret, "pnl_usd": ret * 5, "win": ret > 0, "flow": flow or {}}


def test_gate_sweep_counts_and_baseline():
    scored = [row(3, 0.70, 0.5), row(2, 0.80, -0.4), row(3, 0.60, -0.2), row(1, 0.90, 0.3)]
    g = {(r["rule"], r["threshold"]): r for r in gate_sweep(scored)}
    base = g[("pre-filter only (no agents)", None)]
    assert base["n"] == 4 and base["win_rate"] == 0.5 and base["avg_return"] == pytest.approx(0.05)
    assert g[("unanimous BUY", 0.65)]["n"] == 1 and g[("unanimous BUY", 0.65)]["win_rate"] == 1.0
    assert g[("unanimous BUY", 0.6)]["n"] == 2
    assert g[("2 of 3 BUY", 0.65)]["n"] == 2 and g[("2 of 3 BUY", 0.65)]["pnl_usd"] == pytest.approx(0.5)
    assert g[("unanimous BUY", 0.9)]["n"] == 0


def test_signal_check_splits_at_median():
    scored = [row(3, 0.7, r, {"sniper_top3_share": x}) for x, r in
              [(0.1, 0.4), (0.2, 0.3), (0.6, -0.4), (0.7, -0.5), (0.8, -0.3)]]
    sig = {s["signal"]: s for s in signal_check(scored)}["sniper_top3_share"]
    assert sig["median"] == 0.6
    assert sig["above"]["n"] == 2 and sig["above"]["win_rate"] == 0
    assert sig["at_or_below"]["n"] == 3 and sig["at_or_below"]["win_rate"] == pytest.approx(2 / 3)


def test_brier_lift_and_full_report(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        await db.kv_set("bankroll_sol", "0.5")
        for cid, pnl in ((1, 0.01), (2, -0.01)):
            await db.insert("candidates", {"id": cid, "mint": f"M{cid}", "ts": 1.0, "metrics": {},
                                           "status": "evaluated", "decision": "PASS"})
            await db.insert("positions", {"mint": f"M{cid}", "candidate_id": cid, "kind": "shadow",
                                          "status": "closed", "pnl_sol": pnl, "pnl_usd": pnl * 100,
                                          "cost_sol": 0.04, "closed_at": 2.0})
        # scout: BUY 0.8 on the winner, PASS 0.9 on the loser -> Brier ((0.8-1)^2 + (0.1-0)^2) / 2
        await db.insert("votes", {"candidate_id": 1, "agent": "scout", "vote": "BUY", "confidence": 0.8})
        await db.insert("votes", {"candidate_id": 2, "agent": "scout", "vote": "PASS", "confidence": 0.9})
        acc = await agent_accuracy(db)
        r = await build_report(db, s)
        text = render_text(r)
        await db.close()
        return acc, text
    acc, text = asyncio.run(go())
    a = acc["agents"]["scout"]
    assert a["brier"] == pytest.approx((0.04 + 0.01) / 2)
    assert acc["base_win_rate"] == 0.5 and a["buy_lift"] == pytest.approx(2.0)
    assert "Brier 0.025" in text and "Gate what-if" in text
