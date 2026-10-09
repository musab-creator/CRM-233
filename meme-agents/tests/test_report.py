import asyncio

import pytest

from bot.db import Database
from bot.report import agent_accuracy, build_report, gate_sweep, render_text, signal_check


def row(buys, conf, ret, flow=None, analyst=None):
    r = {"buys": buys, "mean_conf": conf, "ret": ret, "pnl_usd": ret * 5, "win": ret > 0, "flow": flow or {}}
    if analyst is not None:
        r["analyst_buy"], r["analyst_conf"] = analyst
    return r


def test_gate_sweep_counts_and_baseline():
    scored = [row(3, 0.70, 0.5), row(2, 0.80, -0.4), row(3, 0.60, -0.2), row(1, 0.90, 0.3)]
    g = {(r["rule"], r["threshold"]): r for r in gate_sweep(scored)}
    base = g[("pre-filter only (no agents)", None)]
    assert base["n"] == 4 and base["win_rate"] == 0.5 and base["avg_return"] == pytest.approx(0.05)
    assert g[("unanimous BUY", 0.65)]["n"] == 1 and g[("unanimous BUY", 0.65)]["win_rate"] == 1.0
    assert g[("unanimous BUY", 0.6)]["n"] == 2
    assert g[("2 of 3 BUY", 0.65)]["n"] == 2 and g[("2 of 3 BUY", 0.65)]["pnl_usd"] == pytest.approx(0.5)
    assert g[("unanimous BUY", 0.9)]["n"] == 0
    assert g[("analyst BUY alone", 0.75)]["n"] == 0        # rows without analyst fields never select


def test_gate_sweep_analyst_alone_is_the_neutral_gate_lower_bound():
    scored = [row(1, 0.5, 0.8, analyst=(True, 0.82)), row(2, 0.6, -0.3, analyst=(True, 0.76)),
              row(1, 0.5, -0.5, analyst=(True, 0.70)), row(0, 0.4, 0.9, analyst=(False, 0.8))]
    g = {(r["rule"], r["threshold"]): r for r in gate_sweep(scored)}
    assert g[("analyst BUY alone", 0.75)]["n"] == 2 and g[("analyst BUY alone", 0.75)]["win_rate"] == 0.5
    assert g[("analyst BUY alone", 0.75)]["pnl_usd"] == pytest.approx(2.5)
    assert g[("analyst BUY alone", 0.65)]["n"] == 3 and g[("analyst BUY alone", 0.85)]["n"] == 0
    assert g[("unanimous BUY", 0.5)]["n"] == 0            # the old rule still reads the vote count


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


def test_signal_check_compares_at_the_median_when_it_is_the_top_value():
    # 9 Oct: dev_sold_pct_of_bought had median 100, so "above" was always empty
    scored = [row(3, 0.7, r, {"dev_sold_pct_of_bought": x}) for x, r in
              [(100, -0.6), (100, -0.5), (100, 0.4), (40, 0.3), (0, -0.2)]]
    sig = {s["signal"]: s for s in signal_check(scored)}["dev_sold_pct_of_bought"]
    assert sig["median"] == 100 and sig["split"] == "at"
    assert sig["above"]["n"] == 3 and sig["above"]["win_rate"] == pytest.approx(1 / 3)
    assert sig["at_or_below"]["n"] == 2 and sig["at_or_below"]["win_rate"] == 0.5
    text_rows = [row(3, 0.7, r, {"sniper_top3_share": x}) for x, r in [(0.1, 0.4), (0.2, 0.3), (0.6, -0.4), (0.7, -0.5)]]
    assert {s["signal"]: s for s in signal_check(text_rows)}["sniper_top3_share"]["split"] == "above"


def test_report_counts_what_open_positions_already_banked(s):
    """A runner keeps its position open for days after banking its take-profit and core sales; the
    report must not show only the closed trades' loss (9 Oct: -$15.19 shown, #862 had banked ~0.12 SOL)."""
    async def go():
        db = await Database(s.DB_PATH).open()
        await db.insert("positions", {"mint": "LOSS", "kind": "real", "mode": s.MODE, "status": "closed",
                                      "size_usd": 10.0, "cost_sol": 0.1, "pnl_sol": -0.05, "pnl_usd": -5.5,
                                      "exit_reason": "stop_loss", "opened_at": 1.0, "closed_at": 2.0})
        await db.insert("positions", {"mint": "RUNNER", "kind": "real", "mode": s.MODE, "status": "open",
                                      "size_usd": 10.0, "sol_in": 0.1, "cost_sol": 0.1, "tokens_initial": 1e7,
                                      "tokens_remaining": 1e6, "proceeds_sol": 0.25, "entry_price": 1e-8,
                                      "last_price": 1.2e-8, "sol_usd_entry": 110.0, "tp_done": 1,
                                      "runner_active": 1, "opened_at": 1.0})
        await db.insert("positions", {"mint": "FRESH", "kind": "real", "mode": s.MODE, "status": "open",
                                      "size_usd": 10.0, "sol_in": 0.1, "cost_sol": 0.1, "tokens_initial": 1e7,
                                      "tokens_remaining": 1e7, "proceeds_sol": 0.0, "entry_price": 1e-8,
                                      "last_price": 1e-8, "sol_usd_entry": 110.0, "opened_at": 1.0})
        for reason in ("stop_loss", "stop_loss", "trailing_stop"):
            await db.insert("positions", {"mint": "S", "kind": "shadow", "status": "closed", "cost_sol": 0.05,
                                          "pnl_sol": -0.01, "pnl_usd": -1.0, "exit_reason": reason, "closed_at": 2.0})
        r = await build_report(db, s)
        await db.close()
        return r
    r = asyncio.run(go())
    runner, fresh = r["open_positions"]
    assert runner["sold_share"] == pytest.approx(0.9)
    assert runner["banked_sol"] == pytest.approx(0.25 - 0.1 * 0.9)          # proceeds minus the cost of 90%
    assert runner["banked_usd"] == pytest.approx(0.16 * 110)
    assert 0 < runner["held_sol"] < 1e6 * 1.2e-8                            # liquidation value after fees
    assert "banked_sol" not in fresh                                        # nothing sold, nothing banked
    assert r["open_banked"] == {"n": 1, "sol": pytest.approx(0.16), "usd": pytest.approx(17.6)}
    assert r["all_time"]["pnl_sol"] == pytest.approx(-0.05)                 # closed-trade metrics unchanged
    assert r["shadow_exit_reasons"] == {"stop_loss": 2, "trailing_stop": 1}
    text = render_text(r)
    assert "+ open positions' sales +0.1600 SOL  /  $+17.60" in text
    assert "= realized so far   +0.1100 SOL  /  $+12.10" in text
    assert "sold 90% of the tokens for 0.2500 SOL: banked +0.1600 SOL ($+17.60), the 10% still held" in text
    assert "shadow exit reasons: stop_loss 2, trailing_stop 1" in text
    assert "real trades' exit reasons: stop_loss 1" in text


def test_report_without_partial_sales_adds_no_banked_lines(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        await db.insert("positions", {"mint": "P", "kind": "real", "mode": s.MODE, "status": "pending",
                                      "size_usd": 10.0, "sol_in": 0.1})
        r = await build_report(db, s)
        await db.close()
        return r
    r = asyncio.run(go())
    assert r["open_banked"] is None and "realized so far" not in render_text(r)
