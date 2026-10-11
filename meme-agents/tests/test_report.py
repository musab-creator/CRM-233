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


def test_triage_bundling_flags_are_checked_on_every_shadow_including_skipped_ones(s):
    """Triage skips on its bundling flags; the report shows what flagged tokens did, so the flags can
    be judged on outcomes (a triage-skipped candidate has a shadow but no committee votes)."""
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            rows = [(1, {"same_slot_as_launch_buyers": 4, "max_same_size_cluster_wallets": 6}, 0.02),
                    (2, {"same_slot_as_launch_buyers": 3}, -0.03),
                    (3, {"same_slot_as_launch_buyers": 1, "bundle_like_share_of_launch_minute": 0.3}, -0.04),
                    (4, {"same_slot_as_launch_buyers": 0, "max_same_size_cluster_wallets": 2}, 0.01)]
            for cid, flow, pnl in rows:
                await db.insert("candidates", {"id": cid, "mint": f"M{cid}", "ts": 1.0, "metrics": {"flow": flow},
                                               "status": "evaluated", "decision": "PASS",
                                               "gate_reason": "triage: bundling" if cid < 3 else None})
                await db.insert("positions", {"mint": f"M{cid}", "candidate_id": cid, "kind": "shadow",
                                              "status": "closed", "pnl_sol": pnl, "pnl_usd": pnl * 100,
                                              "cost_sol": 0.05, "closed_at": 2.0})
            return await build_report(db, s)
        finally:
            await db.close()
    r = asyncio.run(go())
    flags = {f["flag"]: f for f in r["triage_flags"]}
    slot = flags["same_slot_as_launch_buyers >= 3"]
    assert slot["flagged"]["n"] == 2 and slot["flagged"]["win_rate"] == 0.5
    assert slot["clear"]["n"] == 2 and slot["clear"]["win_rate"] == 0.5
    assert flags["bundle_like_share_of_launch_minute > 0.2"]["flagged"]["n"] == 1
    assert flags["bundle_like_buy_share > 0.2"]["flagged"]["n"] == 0          # no row carries it
    assert flags["max_same_size_cluster_wallets >= 5"]["flagged"]["n"] == 1
    sig = {x["signal"]: x for x in r["signals"]}
    assert sig["same_slot_as_launch_buyers"]["above"]["n"] + sig["same_slot_as_launch_buyers"]["at_or_below"]["n"] == 4
    text = render_text(r)
    assert "== Triage's bundling flags on shadow outcomes" in text
    assert "same_slot_as_launch_buyers >= 3" in text and "triage-skipped ones included" in text


def test_open_runners_count_at_todays_price_in_the_shadow_totals(s):
    """10 Oct: 7 of the 15 best moonshots were runners still open, and every shadow figure counted
    closed shadows only, so the book's best coins were missing from it for up to a week."""
    from bot.paper import mark_to_market
    from bot.report import shadow_extremes

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.insert("mints", {"mint": "M3", "symbol": "QI"})
            for cid in (1, 2, 3, 4, 5):
                await db.insert("candidates", {"id": cid, "mint": f"M{cid}", "ts": 1.0, "status": "evaluated",
                                               "metrics": {"flow": {"sniper_top3_share": cid / 10}},
                                               "decision": "BUY" if cid == 5 else "PASS"})
                for agent in ("scout", "hunter", "analyst"):
                    await db.insert("votes", {"candidate_id": cid, "agent": agent, "vote": "BUY", "confidence": 0.8})
            for cid, pnl in ((1, -0.02), (2, 0.01)):
                await db.insert("positions", {"mint": f"M{cid}", "candidate_id": cid, "kind": "shadow",
                                              "status": "closed", "pnl_sol": pnl, "pnl_usd": pnl * 150,
                                              "cost_sol": 0.05, "closed_at": 2.0})
            runner = {"status": "open", "runner_active": 1, "cost_sol": 0.05, "proceeds_sol": 0.12,
                      "tokens_initial": 1e6, "tokens_remaining": 1e5, "entry_price": 5e-8, "last_price": 5e-6,
                      "sol_usd_entry": 150.0, "tp_done": 1, "opened_at": 1.0}
            await db.insert("positions", {"mint": "M3", "candidate_id": 3, "kind": "shadow", **runner})
            # an open shadow that is not a runner is still inside its normal exits: it waits
            await db.insert("positions", {"mint": "M4", "candidate_id": 4, "kind": "shadow", **runner,
                                          "runner_active": 0})
            # a bought coin: the agents are judged on the real runner, the shadow book on the shadow
            await db.insert("positions", {"mint": "M5", "candidate_id": 5, "kind": "real", "mode": s.MODE,
                                          "size_usd": 7.5, **runner, "last_price": 1e-8})
            await db.insert("positions", {"mint": "M5", "candidate_id": 5, "kind": "shadow", **runner,
                                          "last_price": 1e-8})
            plain = await agent_accuracy(db)
            ex = await shadow_extremes(db, s=s)
            return plain, ex, await build_report(db, s)
        finally:
            await db.close()
    plain, ex, r = asyncio.run(go())
    up = 0.12 + mark_to_market(1e5, 5e-6, s) - 0.05                # banked sales + the runner at its mark - cost
    down = 0.12 + mark_to_market(1e5, 1e-8, s) - 0.05               # the runner is near worthless: still +0.07
    assert up == pytest.approx(0.5369, abs=1e-4) and down == pytest.approx(0.0699, abs=1e-4)
    assert r["shadow"]["closed_trades"] == 2                         # the closed book is unchanged
    assert r["shadow_runners"] == {"n": 2, "wins": 2, "pnl_sol": pytest.approx(up + down),
                                   "pnl_usd": pytest.approx((up + down) * 150)}
    both = r["shadow_with_runners"]
    assert both["closed_trades"] == 4 and both["win_rate"] == 0.75
    assert both["pnl_usd"] == pytest.approx((-0.02 + 0.01 + up + down) * 150)
    base = r["gate_sweep"][0]
    assert base["n"] == 4 and base["open"] == 2 and r["gate_sweep_open"] == 2
    assert r["signals_open"] == 2
    assert r["scored_candidates"] == 4 and r["scored_open_runners"] == 2
    scout = r["agents"]["scout"]
    assert scout["runner_scored"] == 2 and scout["real_scored"] == 1 and scout["buy_winners"] == 3
    assert plain["scored_candidates"] == 2 and plain["open_runners"] == 0   # without settings: closed only
    assert ex["open"] == 2 and ex["over_10x"] == 1 and ex["best"][0]["exit"] == "open runner"
    assert ex["best"][0]["symbol"] == "QI" and ex["best"][0]["ret"] == pytest.approx(up / 0.05)
    text = render_text(r)
    assert f"+ 2 open runners at today's price: 2 up, PnL ${(up + down) * 150:+.2f}" in text
    assert "= together 4: win rate 75.0%" in text and "minus the cost; dollars at the buy's SOL price)" in text
    assert "(includes 2 open runners at today's price, counted in the 'open' column; today's price = the sales" in text
    assert "over 4 (2 of them open runners at today's price)" in text
    assert "(2 of these coins are open runners at today's price; today's price = " in text
    assert "open runner" in text and "; the 2 open runners count at today's price" in text


def test_real_trades_are_measured_against_their_own_shadows(s):
    """11 Oct: live trades lost about -31% a trade against about -20% for the shadow rows matching the live
    gate. The same coin's shadow holds the selection equal, so the gap is what execution cost."""
    from bot.paper import open_result
    from bot.report import execution_gap, report_section

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            def real(cid, cost, pnl, entry, exit_reason):
                return db.insert("positions", {"mint": f"M{cid}", "candidate_id": cid, "kind": "real", "mode": s.MODE,
                                               "status": "closed", "size_usd": 10.0, "cost_sol": cost, "pnl_sol": pnl,
                                               "pnl_usd": pnl * 100, "entry_price": entry, "exit_reason": exit_reason,
                                               "sol_usd_entry": 100.0, "opened_at": 1.0, "closed_at": 2.0})

            def shadow(cid, cost, pnl, entry, exit_reason):
                return db.insert("positions", {"mint": f"M{cid}", "candidate_id": cid, "kind": "shadow",
                                               "status": "closed", "cost_sol": cost, "pnl_sol": pnl, "pnl_usd": pnl * 100,
                                               "entry_price": entry, "exit_reason": exit_reason, "opened_at": 1.0,
                                               "closed_at": 2.0})
            await real(1, 0.1, -0.03, 1.1e-7, "stop_loss")             # -30% live, -10% shadow: 20 points lost
            await shadow(1, 0.05, -0.005, 1e-7, "stop_loss")
            await shadow(1, 0.05, -0.02, 1e-7, "time_stop")            # an older shadow on the same coin: ignored
            await db.execute("UPDATE positions SET closed_at=1.5 WHERE candidate_id=1 AND exit_reason='time_stop'")
            await real(2, 0.1, 0.02, 0.95e-7, "trailing_stop")         # +20% live, -20% shadow: the live trade won
            await shadow(2, 0.05, -0.01, 1e-7, "stop_loss")
            await real(3, 0.1, -0.01, 1e-7, "emergency_insider_sell")  # -10% live; its shadow is an open runner
            runner = await db.insert("positions", {"mint": "M3", "candidate_id": 3, "kind": "shadow", "status": "open",
                                                   "runner_active": 1, "cost_sol": 0.05, "proceeds_sol": 0.12,
                                                   "tokens_initial": 1e6, "tokens_remaining": 1e5, "entry_price": 1e-7,
                                                   "last_price": 5e-6, "sol_usd_entry": 150.0, "opened_at": 1.0})
            await real(4, 0.1, -0.05, 1e-7, "stop_loss")               # no shadow at all: left out, counted
            x = await execution_gap(db, s)
            r = await build_report(db, s)
            row = await db.fetchone("SELECT * FROM positions WHERE id=?", [runner])
            return x, r, open_result(row, s)["ret"]
        finally:
            await db.close()
    x, r, runner_ret = asyncio.run(go())
    gaps = sorted([-0.3 - (-0.1), 0.2 - (-0.2), -0.1 - runner_ret])
    assert x["n"] == 3 and x["unpaired"] == 1 and x["open_shadows"] == 1
    assert x["median_gap"] == pytest.approx(gaps[1]) and x["mean_gap"] == pytest.approx(sum(gaps) / 3)
    assert x["gap_sol"] == pytest.approx(0.1 * sum(gaps)) and x["gap_usd"] == pytest.approx(0.1 * sum(gaps) * 100)
    assert x["median_entry_gap"] == pytest.approx(0.0)                 # +10%, -5%, 0%: the middle one
    assert (x["same_exit"], x["shadow_won_real_lost"], x["real_won_shadow_lost"]) == (1, 1, 1)
    text = render_text(r)
    assert "== Real trades against their own shadows (same coin, same decision; the shadow ran the paper rules) ==" in text
    assert f"3 pairs (1 without a shadow to compare): the paper trade returned a median {gaps[1] * 100:+.1f} points " \
           f"against its shadow (mean {sum(gaps) / 3 * 100:+.1f}); it bought a median +0.0% from the shadow's entry " \
           f"price; at the paper stake that is {0.1 * sum(gaps):+.4f} SOL / ${0.1 * sum(gaps) * 100:+.2f}" in text
    assert ("same exit on both 1 of 3; the shadow won where the paper trade lost 1; the paper trade won where the "
            "shadow lost 1; 1 shadow still open as a runner, at today's price") in text
    # one section at a time, for the phone
    section = report_section(text, "execution")
    assert section.startswith("== Real trades against") and "== Per-agent" not in section and "same exit on both" in section
    assert report_section(text, "Gate").startswith("== Gate what-if") and "== Signal" not in report_section(text, "gate")
    assert report_section(text, "bogus").startswith("/report takes one of: summary, day, execution, agents, gate")
    assert report_section(text, "dips") == "the report has no dips section right now"
    assert "a shadow stakes POSITION_MIN_USD, now $5" in text
