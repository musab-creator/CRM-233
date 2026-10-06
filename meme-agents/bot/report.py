"""`python -m bot report`: performance metrics and reports/daily-YYYY-MM-DD.md."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

from .budget import utc_day
from .config import Settings
from .db import Database
from .util import now_s


def trade_metrics(pnls_usd: list[float], pnls_sol: list[float], bankroll_usd: float) -> dict:
    n = len(pnls_usd)
    wins = [p for p in pnls_usd if p > 0]
    losses = [p for p in pnls_usd if p <= 0]
    gross_win, gross_loss = sum(wins), -sum(losses)
    equity, peak, max_dd, max_dd_pct = bankroll_usd, bankroll_usd, 0.0, 0.0
    for p in pnls_usd:
        equity += p
        peak = max(peak, equity)
        dd = peak - equity
        if dd > max_dd:
            max_dd, max_dd_pct = dd, (dd / peak * 100 if peak > 0 else 0.0)
    return {
        "closed_trades": n,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": len(wins) / n if n else None,
        "expectancy_usd": sum(pnls_usd) / n if n else None,
        "expectancy_sol": sum(pnls_sol) / n if n else None,
        "avg_win_usd": gross_win / len(wins) if wins else None,
        "avg_loss_usd": -gross_loss / len(losses) if losses else None,
        "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else (math.inf if gross_win > 0 else None),
        "max_drawdown_usd": max_dd,
        "max_drawdown_pct": max_dd_pct,
        "pnl_usd": sum(pnls_usd),
        "pnl_sol": sum(pnls_sol),
    }


async def agent_accuracy(db: Database) -> dict:
    """Per agent: how often its BUY vote preceded a winner (real outcome if traded, else shadow),
    how often PASS avoided a loser, the lift of its BUYs over the base win rate, and its Brier
    score (P(win) = confidence for BUY, 1 - confidence for PASS; 0.25 = coin flip, lower = better)."""
    rows = await db.fetchall("""
        SELECT v.agent, v.vote, v.confidence, v.error, v.guard, v.candidate_id,
               (SELECT pnl_sol FROM positions p WHERE p.candidate_id=v.candidate_id AND p.kind='real'
                 AND p.status='closed' ORDER BY id LIMIT 1) AS real_pnl,
               (SELECT pnl_sol FROM positions p WHERE p.candidate_id=v.candidate_id AND p.kind='shadow'
                 AND p.status='closed' ORDER BY id LIMIT 1) AS shadow_pnl
        FROM votes v""")
    out: dict[str, dict] = {}
    outcomes: dict[int, bool] = {}
    for r in rows:
        a = out.setdefault(r["agent"], {"votes": 0, "buy_votes": 0, "buy_scored": 0, "buy_winners": 0,
                                        "pass_scored": 0, "pass_losers": 0, "errors": 0, "guarded": 0,
                                        "_brier": [], })
        a["votes"] += 1
        a["guarded"] += int(bool(r.get("guard")))
        if r["error"]:
            a["errors"] += 1
            continue
        pnl = r["real_pnl"] if r["real_pnl"] is not None else r["shadow_pnl"]
        if pnl is not None:
            outcomes[r["candidate_id"]] = pnl > 0
            p_win = r["confidence"] if r["vote"] == "BUY" else 1 - r["confidence"]
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
        WHERE c.decision IS NOT NULL""")
    votes = await db.fetchall("SELECT candidate_id, agent, vote, confidence, error FROM votes "
                              "WHERE agent IN ('scout', 'hunter', 'analyst')")
    by_c: dict[int, list[dict]] = {}
    for v in votes:
        by_c.setdefault(v["candidate_id"], []).append(v)
    out = []
    for c in cands:
        vs = by_c.get(c["id"], [])
        if len(vs) != 3 or any(v["error"] for v in vs) or not c["cost_sol"]:
            continue
        try:
            metrics = json.loads(c["metrics"] or "{}")
        except json.JSONDecodeError:
            metrics = {}
        out.append({"buys": sum(v["vote"] == "BUY" for v in vs),
                    "mean_conf": sum(v["confidence"] for v in vs) / 3,
                    "ret": c["pnl_sol"] / c["cost_sol"], "pnl_usd": c["pnl_usd"] or 0.0,
                    "win": c["pnl_sol"] > 0, "flow": metrics.get("flow") or {}})
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
    return rows


SIGNALS = ("sniper_top3_share", "bundle_like_buy_share", "early_buyer_retention", "effective_buyers",
           "top5_buyer_share", "dev_sold_pct_of_bought", "net_flow_sol_5m", "drawdown_from_peak_pct")


def signal_check(scored: list[dict]) -> list[dict]:
    """For each flow feature: outcomes above vs at-or-below its median across scored candidates."""
    out = []
    for name in SIGNALS:
        vals = [(r["flow"].get(name), r) for r in scored if isinstance(r["flow"].get(name), (int, float))]
        if len(vals) < 4:
            continue
        xs = sorted(v for v, _ in vals)
        med = xs[len(xs) // 2]
        hi = [r for v, r in vals if v > med]
        lo = [r for v, r in vals if v <= med]
        out.append({"signal": name, "median": med, "above": _bucket(hi), "at_or_below": _bucket(lo)})
    return out


async def build_report(db: Database, s: Settings, day: str | None = None) -> dict:
    now = now_s()
    day = day or utc_day(now)
    day_start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    day_end = day_start + 86400
    closed = await db.fetchall(
        "SELECT * FROM positions WHERE kind='real' AND status='closed' ORDER BY closed_at")
    closed_day = [p for p in closed if day_start <= (p["closed_at"] or 0) < day_end]
    shadows = await db.fetchall("SELECT pnl_sol, pnl_usd FROM positions WHERE kind='shadow' AND status='closed'")
    open_pos = await db.fetchall("SELECT * FROM positions WHERE kind='real' AND status IN ('pending','open')")
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
    exit_reasons: dict[str, int] = {}
    for p in closed:
        exit_reasons[p["exit_reason"] or "?"] = exit_reasons.get(p["exit_reason"] or "?", 0) + 1
    return {
        "generated_at": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"),
        "mode": s.MODE,
        "day": day,
        "all_time": trade_metrics([p["pnl_usd"] or 0 for p in closed], [p["pnl_sol"] or 0 for p in closed],
                                  s.BANKROLL_USD),
        "day_metrics": trade_metrics([p["pnl_usd"] or 0 for p in closed_day],
                                     [p["pnl_sol"] or 0 for p in closed_day], s.BANKROLL_USD),
        "shadow": trade_metrics([p["pnl_usd"] or 0 for p in shadows], [p["pnl_sol"] or 0 for p in shadows],
                                s.BANKROLL_USD),
        **_agent_section(await agent_accuracy(db)),
        "gate_sweep": gate_sweep(scored),
        "signals": signal_check(scored),
        "funnel_day": funnel,
        "spend": spend,
        "exit_reasons": exit_reasons,
        "open_positions": [{"id": p["id"], "mint": p["mint"], "status": p["status"], "size_usd": p["size_usd"],
                            "entry_price": p["entry_price"], "last_price": p["last_price"]} for p in open_pos],
        "trades": [{"id": p["id"], "mint": p["mint"], "opened": _iso(p["opened_at"]), "closed": _iso(p["closed_at"]),
                    "size_usd": p["size_usd"], "exit": p["exit_reason"], "pnl_sol": p["pnl_sol"],
                    "pnl_usd": p["pnl_usd"]} for p in closed],
        "recent_decisions": await db.fetchall(
            "SELECT c.id, c.mint, m.symbol, c.decision, c.mean_confidence, c.gate_reason, c.ts "
            "FROM candidates c LEFT JOIN mints m ON m.mint=c.mint WHERE c.decision IS NOT NULL "
            "ORDER BY c.ts DESC LIMIT 15"),
    }


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
    lines = [
        f"meme-agents report ({r['mode']} mode), generated {r['generated_at']}",
        "",
        "== Closed trades (all time) ==",
        f"closed trades     {m['closed_trades']}  (wins {m['wins']}, losses {m['losses']})",
        f"win rate          {_f(m['win_rate'], '{:.1%}')}",
        f"expectancy/trade  ${_f(m['expectancy_usd'])}  ({_f(m['expectancy_sol'], '{:+.4f}')} SOL)",
        f"profit factor     {_f(m['profit_factor'])}",
        f"max drawdown      ${_f(m['max_drawdown_usd'])}  ({_f(m['max_drawdown_pct'], '{:.1f}')}%)",
        f"PnL               {m['pnl_sol']:+.4f} SOL  /  ${m['pnl_usd']:+.2f}",
        "",
        f"== Day {r['day']} ==",
        f"closed {r['day_metrics']['closed_trades']}, PnL ${r['day_metrics']['pnl_usd']:+.2f}  | funnel: "
        + ", ".join(f"{k} {v}" for k, v in r["funnel_day"].items()),
        f"spend: LLM ${r['spend']['llm_usd_day']:.2f}/${r['spend']['llm_budget_day']:.2f} today, "
        f"X ${r['spend']['x_usd_month']:.2f}/${r['spend']['x_budget_month']:.2f} this month",
        "",
        "== Per-agent accuracy (BUY vote -> winner; real outcome if traded, else shadow) ==",
    ]
    if not r["agents"]:
        lines.append("no votes recorded yet")
    for name in ("triage", "scout", "hunter", "analyst"):
        a = r["agents"].get(name)
        if not a:
            continue
        lines.append(f"{name:8s} votes {a['votes']:4d}  BUY {a['buy_votes']:3d}  BUY->winner "
                     f"{a['buy_winners']}/{a['buy_scored']} ({_f(a['buy_accuracy'], '{:.0%}')}, "
                     f"lift {_f(a['buy_lift'], '{:.2f}x')})  "
                     f"PASS->loser {a['pass_losers']}/{a['pass_scored']} ({_f(a['pass_accuracy'], '{:.0%}')})  "
                     f"Brier {_f(a['brier'], '{:.3f}')}  guarded {a['guarded']}  errors {a['errors']}")
    if r["agents"]:
        lines.append(f"base win rate of scored candidates: {_f(r['base_win_rate'], '{:.0%}')} "
                     f"over {r['scored_candidates']}  (lift > 1 = agent's BUYs beat the base rate; "
                     "Brier 0.25 = coin flip, lower is better)")
    small = "  (small sample: n < 30, treat as noise)" if r["scored_candidates"] < 30 else ""
    lines += ["", "== Gate what-if on recorded votes (shadow outcomes, $5 each) ==" + small,
              f"{'rule':28s} {'thresh':>6s} {'n':>4s} {'win':>6s} {'avg ret':>8s} {'PnL $':>8s}"]
    for g in r["gate_sweep"]:
        if g["rule"] != "pre-filter only (no agents)" and g["n"] == 0:
            continue
        lines.append(f"{g['rule']:28s} {_f(g['threshold'], '{:.2f}', '-'):>6s} {g['n']:>4d} "
                     f"{_f(g['win_rate'], '{:.0%}'):>6s} {_f(g['avg_return'], '{:+.1%}'):>8s} {g['pnl_usd']:>+8.2f}")
    if r["signals"]:
        lines += ["", "== Signal check: shadow outcomes above vs at/below each feature's median =="]
        for sg in r["signals"]:
            a, b = sg["above"], sg["at_or_below"]
            lines.append(f"{sg['signal']:26s} median {sg['median']:<9.4g} above: n {a['n']:>3d} win "
                         f"{_f(a['win_rate'], '{:.0%}'):>4s} ret {_f(a['avg_return'], '{:+.1%}'):>7s}  |  "
                         f"below: n {b['n']:>3d} win {_f(b['win_rate'], '{:.0%}'):>4s} "
                         f"ret {_f(b['avg_return'], '{:+.1%}'):>7s}")
    sh = r["shadow"]
    lines += ["", f"shadow book (every evaluated candidate): {sh['closed_trades']} closed, "
              f"win rate {_f(sh['win_rate'], '{:.1%}')}, PnL ${sh['pnl_usd']:+.2f}"]
    if r["exit_reasons"]:
        lines.append("exit reasons: " + ", ".join(f"{k} {v}" for k, v in r["exit_reasons"].items()))
    if r["open_positions"]:
        lines += ["", "== Open =="] + [f"#{p['id']} {p['mint']} {p['status']} ${p['size_usd']:.2f}"
                                       for p in r["open_positions"]]
    if r["trades"]:
        lines += ["", "== Closed trades =="]
        for t in r["trades"][-30:]:
            lines.append(f"#{t['id']:<4} {t['mint'][:10]}… {t['opened']} -> {t['closed']}  ${t['size_usd']:.2f}  "
                         f"{t['exit']:<26} {t['pnl_sol']:+.4f} SOL  ${t['pnl_usd']:+.2f}")
    if r["recent_decisions"]:
        lines += ["", "== Recent gate decisions =="]
        for d in r["recent_decisions"]:
            lines.append(f"cand {d['id']:<4} {(d['symbol'] or '')[:10]:<10} {d['decision']:<4} "
                         f"mean conf {_f(d['mean_confidence'], '{:.2f}')}  {d['gate_reason']}")
    return "\n".join(lines)


def render_markdown(r: dict) -> str:
    return f"# Daily report {r['day']}\n\n```\n{render_text(r)}\n```\n\n<details><summary>raw</summary>\n\n```json\n" \
           f"{json.dumps(r, indent=2, default=str)}\n```\n</details>\n"


async def write_daily(db: Database, s: Settings, day: str | None = None) -> tuple[str, Path]:
    r = await build_report(db, s, day)
    out_dir = s.path(s.REPORTS_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"daily-{r['day']}.md"
    path.write_text(render_markdown(r))
    return render_text(r), path

