"""`python -m bot report`: performance metrics and reports/daily-YYYY-MM-DD.md."""
from __future__ import annotations

import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .budget import utc_day
from .config import Settings
from .db import SPIKE_FACTOR, SPIKED_SHADOWS_SQL, Database
from .insiders import insider_lines, insider_summary
from .wallets import FEATURES as WALLET_FEATURES
from .wallets import wallet_lines, wallet_summary
from .moonshots import render_lines as moonshot_lines
from .moonshots import summary as moonshot_summary
from .paper import mark_to_market
from .util import now_s


def trade_metrics(pnls_usd: list[float], pnls_sol: list[float], bankroll_usd: float) -> dict:
    if len(pnls_usd) != len(pnls_sol):
        raise ValueError("USD and SOL PnL lists must describe the same closed trades")
    if not all(math.isfinite(v) for v in [bankroll_usd, *pnls_usd, *pnls_sol]):
        raise ValueError("trade metrics require finite PnL and starting equity")
    n = len(pnls_usd)
    wins = [p for p in pnls_usd if p > 0]
    losses = [p for p in pnls_usd if p < 0]
    gross_win, gross_loss = math.fsum(wins), -math.fsum(losses)
    equity, peak, max_dd, max_dd_pct = bankroll_usd, bankroll_usd, 0.0, 0.0
    for p in pnls_usd:
        equity += p
        peak = max(peak, equity)
        dd = peak - equity
        max_dd = max(max_dd, dd)
        max_dd_pct = max(max_dd_pct, dd / peak * 100 if peak > 0 else 0.0)
    return {
        "closed_trades": n,
        "wins": len(wins),
        "losses": len(losses),
        "breakeven": n - len(wins) - len(losses),
        "starting_equity_usd": bankroll_usd,
        "drawdown_basis": "closed-trade realized equity; excludes open positions",
        "win_rate": len(wins) / n if n else None,
        "expectancy_usd": math.fsum(pnls_usd) / n if n else None,
        "expectancy_sol": math.fsum(pnls_sol) / n if n else None,
        "avg_win_usd": gross_win / len(wins) if wins else None,
        "avg_loss_usd": -gross_loss / len(losses) if losses else None,
        "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else (math.inf if gross_win > 0 else None),
        "max_drawdown_usd": max_dd,
        "max_drawdown_pct": max_dd_pct,
        "pnl_usd": math.fsum(pnls_usd),
        "pnl_sol": math.fsum(pnls_sol),
    }



async def spiked_shadow_count(db: Database) -> int:
    row = await db.fetchone(f"SELECT COUNT(DISTINCT position_id) c FROM ({SPIKED_SHADOWS_SQL})")
    return int(row["c"] or 0) if row else 0


async def agent_accuracy(db: Database, mode: str | None = None) -> dict:
    """Per agent: how often its BUY vote preceded a winner (real outcome if traded, else shadow),
    how often PASS avoided a loser, the lift of its BUYs over the base win rate, and its Brier
    score (P(win) = confidence for BUY, 1 - confidence for PASS; 0.25 = coin flip, lower = better)."""
    rows = await db.fetchall("""
        SELECT v.agent, v.vote, v.confidence, v.error, v.guard, v.candidate_id,
               (SELECT pnl_sol FROM positions p WHERE p.candidate_id=v.candidate_id AND p.kind='real'
                 AND p.status='closed' AND (? IS NULL OR p.mode=? OR p.mode IS NULL)
                 ORDER BY p.closed_at DESC, p.id DESC LIMIT 1) AS real_pnl,
               EXISTS(SELECT 1 FROM positions p WHERE p.candidate_id=v.candidate_id AND p.kind='real'
                 AND p.status IN ('open','closed') AND (? IS NULL OR p.mode=? OR p.mode IS NULL)) AS traded,
               (SELECT pnl_sol FROM positions p WHERE p.candidate_id=v.candidate_id AND p.kind='shadow'
                 AND p.status='closed' AND p.id NOT IN (""" + SPIKED_SHADOWS_SQL + """)
                 ORDER BY p.closed_at DESC, p.id DESC LIMIT 1) AS shadow_pnl
        FROM votes v WHERE NOT EXISTS (
          SELECT 1 FROM votes newer WHERE newer.candidate_id=v.candidate_id
            AND newer.agent=v.agent AND newer.id>v.id)
          AND (? IS NULL OR NOT EXISTS (
            SELECT 1 FROM positions p WHERE p.candidate_id=v.candidate_id AND p.kind='real')
            OR EXISTS (SELECT 1 FROM positions p WHERE p.candidate_id=v.candidate_id AND p.kind='real'
                       AND (p.mode=? OR p.mode IS NULL)))
        """, [mode, mode, mode, mode, mode, mode])
    out: dict[str, dict] = {}
    outcomes: dict[int, bool] = {}
    for r in rows:
        a = out.setdefault(r["agent"], {"votes": 0, "buy_votes": 0, "buy_scored": 0, "buy_winners": 0,
                                        "pass_scored": 0, "pass_losers": 0, "errors": 0, "guarded": 0,
                                        "real_scored": 0, "shadow_scored": 0,
                                        "_brier": [], })
        a["votes"] += 1
        a["guarded"] += int(bool(r.get("guard")))
        confidence = r["confidence"]
        if (r["error"] or r["vote"] not in ("BUY", "PASS") or not isinstance(confidence, (int, float))
                or not math.isfinite(confidence) or not 0 <= confidence <= 1):
            a["errors"] += 1
            continue
        # A closed shadow cannot substitute for a real trade whose result is still open.
        pnl = r["real_pnl"] if r["traded"] else r["shadow_pnl"]
        if pnl is not None and not math.isfinite(pnl):
            pnl = None
        if pnl is not None:
            a["real_scored" if r["traded"] else "shadow_scored"] += 1
            outcomes[r["candidate_id"]] = pnl > 0
            p_win = confidence if r["vote"] == "BUY" else 1 - confidence
            a["_brier"].append((p_win - (1.0 if pnl > 0 else 0.0)) ** 2)
        if r["vote"] == "BUY":
            a["buy_votes"] += 1
            if pnl is not None:
                a["buy_scored"] += 1
                a["buy_winners"] += int(pnl > 0)
        elif pnl is not None:
            a["pass_scored"] += 1
            a["pass_losers"] += int(pnl <= 0)
    base = sum(outcomes.values()) / len(outcomes) if outcomes else None
    for a in out.values():
        b = a.pop("_brier")
        a["brier"] = sum(b) / len(b) if b else None
        a["scored"] = len(b)
        a["buy_accuracy"] = a["buy_winners"] / a["buy_scored"] if a["buy_scored"] else None
        a["pass_accuracy"] = a["pass_losers"] / a["pass_scored"] if a["pass_scored"] else None
        a["buy_lift"] = a["buy_accuracy"] / base if a["buy_accuracy"] is not None and base else None
    return {"agents": out, "base_win_rate": base, "scored_candidates": len(outcomes)}


async def _scored_candidates(db: Database) -> list[dict]:
    """Evaluated candidates with a closed shadow position, their final votes, and stored metrics."""
    cands = await db.fetchall("""
        SELECT c.id, c.metrics, p.pnl_sol, p.pnl_usd, p.cost_sol
        FROM candidates c JOIN positions p ON p.candidate_id=c.id AND p.kind='shadow' AND p.status='closed'
        WHERE c.decision IS NOT NULL AND p.id NOT IN (""" + SPIKED_SHADOWS_SQL + """)
          AND p.id=(SELECT q.id FROM positions q WHERE q.candidate_id=c.id
                    AND q.kind='shadow' AND q.status='closed' ORDER BY q.closed_at DESC, q.id DESC LIMIT 1)
        ORDER BY p.closed_at, p.id""")
    votes = await db.fetchall("SELECT candidate_id, agent, vote, confidence, error FROM votes v "
                              "WHERE agent IN ('scout', 'hunter', 'analyst') AND NOT EXISTS "
                              "(SELECT 1 FROM votes newer WHERE newer.candidate_id=v.candidate_id "
                              "AND newer.agent=v.agent AND newer.id>v.id)")
    by_c: dict[int, list[dict]] = {}
    for v in votes:
        by_c.setdefault(v["candidate_id"], []).append(v)
    out = []
    for c in cands:
        vs = by_c.get(c["id"], [])
        if (set(v["agent"] for v in vs) != {"scout", "hunter", "analyst"} or len(vs) != 3
                or any(v["error"] or v["vote"] not in ("BUY", "PASS")
                       or not isinstance(v["confidence"], (int, float))
                       or not math.isfinite(v["confidence"]) or not 0 <= v["confidence"] <= 1 for v in vs)
                or not isinstance(c["cost_sol"], (int, float)) or not math.isfinite(c["cost_sol"])
                or c["cost_sol"] <= 0 or c["pnl_sol"] is None or not math.isfinite(c["pnl_sol"])
                or c["pnl_usd"] is None or not math.isfinite(c["pnl_usd"])):
            continue
        try:
            metrics = json.loads(c["metrics"] or "{}")
        except (json.JSONDecodeError, TypeError):
            metrics = {}
        if not isinstance(metrics, dict):
            metrics = {}
        analyst = next(v for v in vs if v["agent"] == "analyst")
        out.append({"buys": sum(v["vote"] == "BUY" for v in vs),
                    "mean_conf": sum(v["confidence"] for v in vs) / 3,
                    "analyst_buy": analyst["vote"] == "BUY", "analyst_conf": analyst["confidence"],
                    "ret": c["pnl_sol"] / c["cost_sol"], "pnl_usd": c["pnl_usd"] or 0.0,
                    "win": c["pnl_sol"] > 0,
                    "flow": metrics["flow"] if isinstance(metrics.get("flow"), dict) else {}})
    return out


def _bucket(rows: list[dict]) -> dict:
    n = len(rows)
    return {"n": n, "win_rate": sum(r["win"] for r in rows) / n if n else None,
            "avg_return": sum(r["ret"] for r in rows) / n if n else None,
            "pnl_usd": sum(r["pnl_usd"] for r in rows)}


def gate_sweep(scored: list[dict], thresholds=(0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9)) -> list[dict]:
    """What the gate would have selected at other settings, judged on shadow outcomes."""
    rows = [{"rule": "pre-filter only (no agents)", "threshold": None, **_bucket(scored)}]
    for need, label in ((3, "unanimous BUY"), (2, "2 of 3 BUY")):
        for t in thresholds:
            sel = [r for r in scored if r["buys"] >= need and r["mean_conf"] >= t]
            rows.append({"rule": label, "threshold": t, **_bucket(sel)})
    # Under GATE_NEUTRAL_VOTES the gate reduces to "Analyst BUY at 0.75+, nothing found against the
    # token by Scout or Hunter", so the Analyst's own BUYs by confidence are the lower bound of what
    # the live gate would select; a Scout or Hunter PASS can only remove candidates from this set.
    for t in (0.65, 0.7, 0.75, 0.8, 0.85, 0.9):
        sel = [r for r in scored if r.get("analyst_buy") and (r.get("analyst_conf") or 0) >= t]
        rows.append({"rule": "analyst BUY alone", "threshold": t, **_bucket(sel)})
    return rows


SIGNALS = ("sniper_top3_share", "bundle_like_buy_share", "early_buyer_retention", "effective_buyers",
           "top5_buyer_share", "dev_sold_pct_of_bought", "net_flow_sol_5m", "drawdown_from_peak_pct",
           "same_slot_as_launch_buyers", "bundle_like_share_of_launch_minute", "max_same_size_cluster_wallets",
           "sniper_top3_share_of_launch_minute", *WALLET_FEATURES)

# Triage's bundling red flags (agents/prompts.py TRIAGE), checked against what flagged tokens did
TRIAGE_FLAGS = (("same_slot_as_launch_buyers", ">=", 3), ("bundle_like_buy_share", ">", 0.2),
                ("bundle_like_share_of_launch_minute", ">", 0.2), ("max_same_size_cluster_wallets", ">=", 5))


def signal_check(scored: list[dict]) -> list[dict]:
    """For each flow feature: outcomes above vs at-or-below its median across scored candidates."""
    out = []
    for name in SIGNALS:
        vals = [(r["flow"].get(name), r) for r in scored if isinstance(r["flow"].get(name), (int, float))
                and math.isfinite(r["flow"][name])]
        if len(vals) < 4:
            continue
        xs = sorted(v for v, _ in vals)
        med = xs[len(xs) // 2]
        hi = [r for v, r in vals if v > med]
        lo = [r for v, r in vals if v <= med]
        split = "above"
        if not hi:
            # the median is also the largest value (9 Oct: dev_sold_pct_of_bought, most devs had sold
            # 100%), so "above" is empty: compare the tokens at that value with the ones below it
            hi = [r for v, r in vals if v >= med]
            lo = [r for v, r in vals if v < med]
            split = "at"
        out.append({"signal": name, "median": med, "split": split, "above": _bucket(hi), "at_or_below": _bucket(lo)})
    return out


async def _flow_outcomes(db: Database) -> list[dict]:
    """Every evaluated candidate with a closed shadow, triage-skipped ones included (they have no
    committee votes, so _scored_candidates leaves them out): its flow features and what it did."""
    rows = await db.fetchall("""
        SELECT c.metrics, p.pnl_sol, p.pnl_usd, p.cost_sol
        FROM candidates c JOIN positions p ON p.candidate_id=c.id AND p.kind='shadow' AND p.status='closed'
        WHERE c.decision IS NOT NULL AND p.id NOT IN (""" + SPIKED_SHADOWS_SQL + """)
          AND p.id=(SELECT q.id FROM positions q WHERE q.candidate_id=c.id
                    AND q.kind='shadow' AND q.status='closed' ORDER BY q.closed_at DESC, q.id DESC LIMIT 1)""")
    out = []
    for r in rows:
        if not all(isinstance(r[k], (int, float)) and math.isfinite(r[k]) for k in ("pnl_sol", "pnl_usd", "cost_sol")) \
                or r["cost_sol"] <= 0:
            continue
        try:
            metrics = json.loads(r["metrics"] or "{}")
        except (json.JSONDecodeError, TypeError):
            metrics = {}
        flow = metrics.get("flow") if isinstance(metrics, dict) else None
        wallets = metrics.get("wallets") if isinstance(metrics, dict) else None
        out.append({"ret": r["pnl_sol"] / r["cost_sol"], "pnl_usd": r["pnl_usd"], "win": r["pnl_sol"] > 0,
                    "flow": {**(flow if isinstance(flow, dict) else {}),
                             **(wallets if isinstance(wallets, dict) else {})}})
    return out


def flag_check(rows: list[dict]) -> list[dict]:
    """Tokens that raise each of triage's bundling flags against the ones that do not."""
    out = []
    for name, op, limit in TRIAGE_FLAGS:
        vals = [(r["flow"].get(name), r) for r in rows if isinstance(r["flow"].get(name), (int, float))
                and not isinstance(r["flow"].get(name), bool) and math.isfinite(r["flow"][name])]
        hit = [r for v, r in vals if (v >= limit if op == ">=" else v > limit)]
        miss = [r for v, r in vals if not (v >= limit if op == ">=" else v > limit)]
        out.append({"flag": f"{name} {op} {limit:g}", "flagged": _bucket(hit), "clear": _bucket(miss)})
    return out


def _finite(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else None


def _open_row(p: dict, s: Settings) -> dict:
    """An open position plus what its sales so far realized: the proceeds minus the cost of the share
    of tokens sold. A runner has banked its take-profit and core sales while it stays open for days
    (9 Oct: #862 had banked about 0.12 SOL that no closed-trade figure counted)."""
    row = {"id": p["id"], "mint": p["mint"], "status": p["status"], "size_usd": p["size_usd"],
           "entry_price": p["entry_price"], "last_price": p["last_price"], "runner": bool(p.get("runner_active"))}
    cost, init = _finite(p.get("cost_sol")), _finite(p.get("tokens_initial"))
    rem, last = _finite(p.get("tokens_remaining")), _finite(p.get("last_price"))
    if p["status"] != "open" or not cost or cost <= 0 or not init or init <= 0 or rem is None or not 0 <= rem < init:
        return row
    sold = 1 - rem / init
    got = _finite(p.get("proceeds_sol")) or 0.0
    banked = got - cost * sold
    rate = _finite(p.get("sol_usd_entry"))
    row.update({"sold_share": sold, "proceeds_sol": got, "banked_sol": banked,
                "banked_usd": banked * rate if rate and rate > 0 else None,
                "held_sol": mark_to_market(rem, last, s) if last and last > 0 else None})
    return row


def _open_banked(rows: list[dict]) -> dict | None:
    banked = [r for r in rows if "banked_sol" in r]
    if not banked:
        return None
    usd = [r["banked_usd"] for r in banked]
    return {"n": len(banked), "sol": math.fsum(r["banked_sol"] for r in banked),
            "usd": math.fsum(usd) if all(u is not None for u in usd) else None}


async def build_report(db: Database, s: Settings, day: str | None = None) -> dict:
    now = now_s()
    day = day or utc_day(now)
    day_start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    day_end = day_start + 86400
    closed_recorded = await db.fetchall(
        "SELECT * FROM positions WHERE kind='real' AND status='closed' AND (mode=? OR mode IS NULL) "
        "ORDER BY closed_at, id", [s.MODE])
    closed = [p for p in closed_recorded if all(isinstance(p[k], (int, float)) and math.isfinite(p[k])
                                              for k in ("pnl_usd", "pnl_sol"))]
    closed_day = [p for p in closed if day_start <= (p["closed_at"] or 0) < day_end]
    opening_equity = s.BANKROLL_USD + math.fsum(p["pnl_usd"] for p in closed
                                               if p["closed_at"] is not None and p["closed_at"] < day_start)
    shadows_recorded = await db.fetchall("SELECT pnl_sol, pnl_usd, exit_reason FROM positions WHERE kind='shadow' "
                                        "AND status='closed' AND id NOT IN (" + SPIKED_SHADOWS_SQL + ") "
                                        "ORDER BY closed_at, id")
    shadows = [p for p in shadows_recorded if all(isinstance(p[k], (int, float)) and math.isfinite(p[k])
                                                for k in ("pnl_usd", "pnl_sol"))]
    open_pos = await db.fetchall("SELECT * FROM positions WHERE kind='real' AND status IN ('pending','open') "
                                "AND (mode=? OR mode IS NULL)", [s.MODE])
    raw_heartbeat = await db.kv_get("heartbeat")
    try:
        heartbeat = json.loads(raw_heartbeat or "{}")
    except (json.JSONDecodeError, TypeError):
        heartbeat = {}
    if not isinstance(heartbeat, dict):
        heartbeat = {}
    funnel = {
        "mints_seen": (await db.fetchone("SELECT COUNT(*) c FROM mints WHERE first_trade_at>=? AND first_trade_at<?",
                                         [day_start, day_end]))["c"],
        "prefilter_checked": (await db.fetchone("SELECT COUNT(*) c FROM prefilter_results WHERE ts>=? AND ts<?",
                                                [day_start, day_end]))["c"],
        "candidates": (await db.fetchone("SELECT COUNT(*) c FROM candidates WHERE ts>=? AND ts<?",
                                         [day_start, day_end]))["c"],
        "evaluated": (await db.fetchone("SELECT COUNT(*) c FROM candidates WHERE ts>=? AND ts<? AND decision IS NOT NULL",
                                        [day_start, day_end]))["c"],
        "gate_buy": (await db.fetchone("SELECT COUNT(*) c FROM candidates WHERE ts>=? AND ts<? AND decision='BUY'",
                                       [day_start, day_end]))["c"],
        "triage_skipped": (await db.fetchone("SELECT COUNT(*) c FROM candidates WHERE ts>=? AND ts<? AND "
                                             "gate_reason LIKE 'triage:%'", [day_start, day_end]))["c"],
    }
    spend = {
        "llm_usd_day": (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='llm' AND day=?",
                                          [day]))["s"],
        "x_usd_month": (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='x' AND month=?",
                                          [day[:7]]))["s"],
        "llm_budget_day": s.LLM_DAILY_BUDGET_USD,
        "x_budget_month": s.X_MONTHLY_BUDGET_USD,
    }
    scored = await _scored_candidates(db)
    flows = await _flow_outcomes(db)
    exit_reasons: dict[str, int] = {}
    for p in closed:
        exit_reasons[p["exit_reason"] or "?"] = exit_reasons.get(p["exit_reason"] or "?", 0) + 1
    shadow_exits: dict[str, int] = {}
    for p in shadows:
        shadow_exits[p["exit_reason"] or "?"] = shadow_exits.get(p["exit_reason"] or "?", 0) + 1
    open_rows = [_open_row(p, s) for p in open_pos]
    return {
        "generated_at": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"),
        "mode": s.MODE,
        "data_source": "simulation" if heartbeat.get("simulated") is True else
                       "real feeds" if heartbeat.get("simulated") is False else "unrecorded",
        "legacy_unknown_mode_trades": sum(p["mode"] is None for p in closed_recorded),
        "unscored_closed_trades": len(closed_recorded) - len(closed),
        "day": day,
        "all_time": trade_metrics([p["pnl_usd"] or 0 for p in closed], [p["pnl_sol"] or 0 for p in closed],
                                  s.BANKROLL_USD),
        "day_metrics": trade_metrics([p["pnl_usd"] or 0 for p in closed_day],
                                     [p["pnl_sol"] or 0 for p in closed_day], opening_equity),
        "shadow": trade_metrics([p["pnl_usd"] or 0 for p in shadows], [p["pnl_sol"] or 0 for p in shadows],
                                s.BANKROLL_USD),
        **_agent_section(await agent_accuracy(db, s.MODE)),
        "gate_sweep": gate_sweep(scored),
        "signals": signal_check(flows),
        "triage_flags": flag_check(flows),
        "shadow_extremes": await shadow_extremes(db),
        "shadow_spiked": await spiked_shadow_count(db),
        "funnel_day": funnel,
        "spend": spend,
        "exit_reasons": exit_reasons,
        "shadow_exit_reasons": dict(sorted(shadow_exits.items(), key=lambda kv: -kv[1])),
        "open_positions": open_rows,
        "open_banked": _open_banked(open_rows),
        "moonshots": await moonshot_summary(db, s),
        "insiders": await insider_summary(db, s),
        "wallets": await wallet_summary(db, s),
        "trades": [{"id": p["id"], "mint": p["mint"], "opened": _iso(p["opened_at"]), "closed": _iso(p["closed_at"]),
                    "size_usd": p["size_usd"], "exit": p["exit_reason"], "pnl_sol": p["pnl_sol"],
                    "pnl_usd": p["pnl_usd"]} for p in closed],
        "recent_decisions": await db.fetchall(
            "SELECT c.id, c.mint, m.symbol, c.decision, c.mean_confidence, c.gate_reason, c.ts "
            "FROM candidates c LEFT JOIN mints m ON m.mint=c.mint WHERE c.decision IS NOT NULL "
            "ORDER BY c.ts DESC LIMIT 15"),
    }


async def shadow_extremes(db: Database, top: int = 5) -> dict:
    """The shape of the shadow book's returns: median, the best and worst shadows with their exit,
    hold time and prices, and how much of the total PnL the best few carry. A mean return in the
    hundreds of percent is either a few real runners or a few bad marks; this is how to tell."""
    rows = await db.fetchall(
        "SELECT p.id, p.mint, p.candidate_id, m.symbol, p.cost_sol, p.pnl_sol, p.pnl_usd, p.exit_reason, "
        "p.opened_at, p.closed_at, p.entry_price, p.last_price FROM positions p LEFT JOIN mints m ON m.mint=p.mint "
        "WHERE p.kind='shadow' AND p.status='closed' AND p.id NOT IN (" + SPIKED_SHADOWS_SQL + ")")
    scored = []
    for p in rows:
        if not all(isinstance(p[k], (int, float)) and math.isfinite(p[k]) for k in ("cost_sol", "pnl_sol", "pnl_usd")) \
                or p["cost_sol"] <= 0:
            continue
        scored.append({"id": p["id"], "candidate_id": p["candidate_id"], "symbol": p["symbol"] or (p["mint"] or "?")[:8],
                       "ret": p["pnl_sol"] / p["cost_sol"], "pnl_usd": p["pnl_usd"], "exit": p["exit_reason"] or "?",
                       "held_s": max(0.0, (p["closed_at"] or 0) - (p["opened_at"] or p["closed_at"] or 0)),
                       "entry_price": p["entry_price"], "last_price": p["last_price"]})
    if not scored:
        return {"n": 0, "median_return": None, "best": [], "worst": [], "top_pnl_share": None, "over_10x": 0}
    scored.sort(key=lambda r: r["ret"])
    n = len(scored)
    median = scored[n // 2]["ret"] if n % 2 else (scored[n // 2 - 1]["ret"] + scored[n // 2]["ret"]) / 2
    total = math.fsum(r["pnl_usd"] for r in scored)
    best = list(reversed(scored[-top:]))
    top_pnl = math.fsum(r["pnl_usd"] for r in best)
    return {"n": n, "median_return": median, "best": best, "worst": scored[:top],
            "top_pnl_share": (top_pnl / total) if total > 0 else None, "top_pnl_usd": top_pnl,
            "over_10x": sum(r["ret"] >= 10 for r in scored)}


def _agent_section(acc: dict) -> dict:
    return {"agents": acc["agents"], "base_win_rate": acc["base_win_rate"],
            "scored_candidates": acc["scored_candidates"]}


def _iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M") if ts else ""


def _f(v, fmt="{:.2f}", none="n/a"):
    if v is None:
        return none
    if isinstance(v, float) and math.isinf(v):
        return "inf"
    return fmt.format(v)


def render_text(r: dict) -> str:
    m = r["all_time"]
    banked = []
    ob = r.get("open_banked")
    if ob:
        usd = f"  /  ${ob['usd']:+.2f}" if ob["usd"] is not None else ""
        both = f"  /  ${m['pnl_usd'] + ob['usd']:+.2f}" if ob["usd"] is not None else ""
        banked = [f"+ open positions' sales {ob['sol']:+.4f} SOL{usd}  (proceeds minus the cost of the tokens "
                  f"sold, {ob['n']} position{'s' if ob['n'] != 1 else ''}; dollars at the buy's SOL price)",
                  f"= realized so far   {m['pnl_sol'] + ob['sol']:+.4f} SOL{both}"]
    lines = [
        f"meme-agents report ({r['mode']} mode), generated {r['generated_at']}",
        "",
        "== Closed trades (all time) ==",
            f"closed trades     {m['closed_trades']}  (wins {m['wins']}, losses {m['losses']}, "
            f"breakeven {m.get('breakeven', 0)})",
        f"win rate          {_f(m['win_rate'], '{:.1%}')}",
        f"expectancy/trade  ${_f(m['expectancy_usd'])}  ({_f(m['expectancy_sol'], '{:+.4f}')} SOL)",
        f"profit factor     {_f(m['profit_factor'])}",
        f"max drawdown      ${_f(m['max_drawdown_usd'])}  ({_f(m['max_drawdown_pct'], '{:.1f}')}%) "
        "[closed-trade realized equity]",
        f"PnL               {m['pnl_sol']:+.4f} SOL  /  ${m['pnl_usd']:+.2f}",
        *banked,
        "",
        f"== Day {r['day']} ==",
        f"closed {r['day_metrics']['closed_trades']}, PnL ${r['day_metrics']['pnl_usd']:+.2f}  | funnel: "
        + ", ".join(f"{k} {v}" for k, v in r["funnel_day"].items()),
        f"spend: LLM ${r['spend']['llm_usd_day']:.2f}/${r['spend']['llm_budget_day']:.2f} today, "
        f"X ${r['spend']['x_usd_month']:.2f}/${r['spend']['x_budget_month']:.2f} this month",
        "",
        "== Per-agent accuracy (BUY vote -> winner; real outcome if traded, else shadow) ==",
    ]
    lines.insert(1, f"data source: {r.get('data_source', 'unrecorded')} "
                    "(simulation results do not verify real-data acceptance)" if r.get("data_source") == "simulation"
                 else f"data source: {r.get('data_source', 'unrecorded')}")
    if r.get("legacy_unknown_mode_trades"):
        lines.insert(2, f"legacy trades with unrecorded mode included: {r['legacy_unknown_mode_trades']}")
    if r.get("unscored_closed_trades"):
        lines.insert(2, f"closed trades excluded from metrics for missing/invalid PnL: {r['unscored_closed_trades']}")
    if not r["agents"]:
        lines.append("no votes recorded yet")
    for name in ("triage", "scout", "hunter", "analyst", "forensics", "social"):
        a = r["agents"].get(name)
        if not a:
            continue
        lines.append(f"{name:8s} votes {a['votes']:4d}  BUY {a['buy_votes']:3d}  BUY->winner "
                     f"{a['buy_winners']}/{a['buy_scored']} ({_f(a['buy_accuracy'], '{:.0%}')}, "
                     f"lift {_f(a['buy_lift'], '{:.2f}x')})  "
                     f"PASS->loser {a['pass_losers']}/{a['pass_scored']} ({_f(a['pass_accuracy'], '{:.0%}')})  "
                     f"Brier {_f(a['brier'], '{:.3f}')}  guarded {a['guarded']}  errors {a['errors']}  "
                     f"scored real {a.get('real_scored', 0)}, shadow {a.get('shadow_scored', 0)}")
    if r["agents"]:
        lines.append(f"base win rate of scored candidates: {_f(r['base_win_rate'], '{:.0%}')} "
                     f"over {r['scored_candidates']}  (lift > 1 = agent's BUYs beat the base rate; "
                     "Brier 0.25 = coin flip, lower is better)")
    small = "  (small sample: n < 30, treat as noise)" if r["scored_candidates"] < 30 else ""
    lines += ["", "== Gate what-if on recorded votes (shadow outcomes, $5 each) ==" + small,
              "(analyst BUY alone = what the neutral gate selects before Scout or Hunter remove anything)",
              f"{'rule':28s} {'thresh':>6s} {'n':>4s} {'win':>6s} {'avg ret':>8s} {'PnL $':>8s}"]
    for g in r["gate_sweep"]:
        if g["rule"] != "pre-filter only (no agents)" and g["n"] == 0:
            continue
        lines.append(f"{g['rule']:28s} {_f(g['threshold'], '{:.2f}', '-'):>6s} {g['n']:>4d} "
                     f"{_f(g['win_rate'], '{:.0%}'):>6s} {_f(g['avg_return'], '{:+.1%}'):>8s} {g['pnl_usd']:>+8.2f}")
    if r["signals"]:
        lines += ["", "== Signal check: shadow outcomes above vs at/below each feature's median ==",
                  "(every evaluated candidate, triage-skipped ones included)"]
        if any(sg.get("split") == "at" for sg in r["signals"]):
            lines.append("(\"at\" where the median is also the top value: the tokens at it vs the ones below)")
        for sg in r["signals"]:
            a, b = sg["above"], sg["at_or_below"]
            at = sg.get("split") == "at"
            lines.append(f"{sg['signal']:26s} median {sg['median']:<9.4g} {'at' if at else 'above'}: n {a['n']:>3d} win "
                         f"{_f(a['win_rate'], '{:.0%}'):>4s} ret {_f(a['avg_return'], '{:+.1%}'):>7s}  |  "
                         f"below: n {b['n']:>3d} win {_f(b['win_rate'], '{:.0%}'):>4s} "
                         f"ret {_f(b['avg_return'], '{:+.1%}'):>7s}")
    flags = [f for f in r.get("triage_flags") or [] if f["flagged"]["n"] or f["clear"]["n"]]
    if flags:
        lines += ["", "== Triage's bundling flags on shadow outcomes (flagged tokens are skipped) =="]
        for f in flags:
            a, b = f["flagged"], f["clear"]
            lines.append(f"{f['flag']:40s} flagged: n {a['n']:>3d} win {_f(a['win_rate'], '{:.0%}'):>4s} "
                         f"ret {_f(a['avg_return'], '{:+.1%}'):>7s}  |  clear: n {b['n']:>3d} win "
                         f"{_f(b['win_rate'], '{:.0%}'):>4s} ret {_f(b['avg_return'], '{:+.1%}'):>7s}")
    sh = r["shadow"]
    lines += ["", f"shadow book (every evaluated candidate): {sh['closed_trades']} closed, "
              f"win rate {_f(sh['win_rate'], '{:.1%}')}, PnL ${sh['pnl_usd']:+.2f}"]
    if r.get("shadow_spiked"):
        lines.append(f"excluded {r['shadow_spiked']} shadows whose exit was booked at a price spike "
                     f"(a sell above {SPIKE_FACTOR:g}x the final mark); their returns are not real")
    ex = r.get("shadow_extremes") or {}
    if ex.get("n"):
        share = f", the best {len(ex['best'])} carry ${ex['top_pnl_usd']:+,.0f}" + (
            f" ({ex['top_pnl_share']:.0%} of it)" if ex.get("top_pnl_share") is not None else "")
        lines.append(f"shadow returns: median {ex['median_return']:+.1%}, {ex['over_10x']} shadows at +1000% or more{share}")
        def _row(x):
            held = x["held_s"]
            held_txt = f"{held / 3600:.1f}h" if held >= 3600 else f"{held / 60:.0f}m"
            prices = (f"  {x['entry_price']:.3g} -> {x['last_price']:.3g}"
                      if isinstance(x.get("entry_price"), (int, float)) and isinstance(x.get("last_price"), (int, float))
                      else "")
            return (f"  {x['ret']:+9.0%}  {str(x['symbol'])[:10]:<10} cand {x['candidate_id'] or '?':<5} "
                    f"{x['exit'].replace('_', ' '):<24} held {held_txt:<6} ${x['pnl_usd']:+.2f}{prices}")
        lines.append("  best:")
        lines += [_row(x) for x in ex["best"]]
        lines.append("  worst:")
        lines += [_row(x) for x in ex["worst"]]
    if r.get("shadow_exit_reasons"):
        lines.append("shadow exit reasons: " + ", ".join(f"{k} {v}" for k, v in r["shadow_exit_reasons"].items()))
    if r["exit_reasons"]:
        lines.append("real trades' exit reasons: " + ", ".join(f"{k} {v}" for k, v in r["exit_reasons"].items()))
    lines += moonshot_lines(r.get("moonshots"))
    lines += insider_lines(r.get("insiders"))
    lines += wallet_lines(r.get("wallets"))
    if r["open_positions"]:
        lines += ["", "== Open =="]
        for p in r["open_positions"]:
            row = f"#{p['id']} {p['mint']} {p['status']} ${_f(p['size_usd'])}" + (" (runner)" if p.get("runner") else "")
            if "banked_sol" in p:
                usd = f" (${p['banked_usd']:+.2f})" if p.get("banked_usd") is not None else ""
                held = (f", the {1 - p['sold_share']:.0%} still held is worth {p['held_sol']:.4f} SOL now"
                        if p.get("held_sol") is not None else "")
                row += (f"\n    sold {p['sold_share']:.0%} of the tokens for {p['proceeds_sol']:.4f} SOL: "
                        f"banked {p['banked_sol']:+.4f} SOL{usd}{held}")
            lines.append(row)
    if r["trades"]:
        lines += ["", "== Closed trades =="]
        for t in r["trades"][-30:]:
            lines.append(f"#{t['id']:<4} {str(t['mint'] or '?')[:10]}… {t['opened']} -> {t['closed']}  "
                         f"${_f(t['size_usd'])}  {t['exit'] or '?':<26} "
                         f"{_f(t['pnl_sol'], '{:+.4f}')} SOL  ${_f(t['pnl_usd'], '{:+.2f}')}")
    if r["recent_decisions"]:
        lines += ["", "== Recent gate decisions =="]
        for d in r["recent_decisions"]:
            lines.append(f"cand {d['id']:<4} {(d['symbol'] or '')[:10]:<10} {d['decision']:<4} "
                         f"mean conf {_f(d['mean_confidence'], '{:.2f}')}  {d['gate_reason']}")
    return "\n".join(lines)


def render_markdown(r: dict) -> str:
    return f"# Daily report {r['day']}\n\n```\n{render_text(r)}\n```\n\n<details><summary>raw</summary>\n\n```json\n" \
           f"{json.dumps(_json_safe(r), indent=2, default=str, allow_nan=False)}\n```\n</details>\n"


def _json_safe(value):
    """Profit factor can be infinite; preserve it as a label in valid report JSON."""
    if isinstance(value, float) and not math.isfinite(value):
        return "inf" if value == math.inf else "-inf" if value == -math.inf else None
    if isinstance(value, dict):
        return {key: _json_safe(v) for key, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


async def write_daily(db: Database, s: Settings, day: str | None = None) -> tuple[str, Path]:
    r = await build_report(db, s, day)
    out_dir = s.path(s.REPORTS_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"daily-{r['day']}.md"
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=out_dir,
                                         prefix=f".{path.name}.", suffix=".tmp", delete=False) as f:
            temporary = Path(f.name)
            f.write(render_markdown(r))
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return render_text(r), path
