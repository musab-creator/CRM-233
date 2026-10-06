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
    """For each agent: how often its BUY vote preceded a winner (real outcome if traded, else shadow)."""
    rows = await db.fetchall("""
        SELECT v.agent, v.vote, v.error, v.candidate_id,
               (SELECT pnl_sol FROM positions p WHERE p.candidate_id=v.candidate_id AND p.kind='real'
                 AND p.status='closed' ORDER BY id LIMIT 1) AS real_pnl,
               (SELECT pnl_sol FROM positions p WHERE p.candidate_id=v.candidate_id AND p.kind='shadow'
                 AND p.status='closed' ORDER BY id LIMIT 1) AS shadow_pnl
        FROM votes v""")
    out: dict[str, dict] = {}
    for r in rows:
        a = out.setdefault(r["agent"], {"votes": 0, "buy_votes": 0, "buy_scored": 0, "buy_winners": 0,
                                        "pass_scored": 0, "pass_losers": 0, "errors": 0})
        a["votes"] += 1
        if r["error"]:
            a["errors"] += 1
            continue
        pnl = r["real_pnl"] if r["real_pnl"] is not None else r["shadow_pnl"]
        if r["vote"] == "BUY":
            a["buy_votes"] += 1
            if pnl is not None:
                a["buy_scored"] += 1
                a["buy_winners"] += int(pnl > 0)
        elif pnl is not None:
            a["pass_scored"] += 1
            a["pass_losers"] += int(pnl <= 0)
    for a in out.values():
        a["buy_accuracy"] = a["buy_winners"] / a["buy_scored"] if a["buy_scored"] else None
        a["pass_accuracy"] = a["pass_losers"] / a["pass_scored"] if a["pass_scored"] else None
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
    }
    spend = {
        "llm_usd_day": (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='llm' AND day=?",
                                          [day]))["s"],
        "x_usd_month": (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='x' AND month=?",
                                          [day[:7]]))["s"],
        "llm_budget_day": s.LLM_DAILY_BUDGET_USD,
        "x_budget_month": s.X_MONTHLY_BUDGET_USD,
    }
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
        "agents": await agent_accuracy(db),
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
    for name in ("scout", "hunter", "analyst"):
        a = r["agents"].get(name)
        if not a:
            continue
        lines.append(f"{name:8s} votes {a['votes']:4d}  BUY {a['buy_votes']:3d}  BUY->winner "
                     f"{a['buy_winners']}/{a['buy_scored']} ({_f(a['buy_accuracy'], '{:.0%}')})  "
                     f"PASS->loser {a['pass_losers']}/{a['pass_scored']} ({_f(a['pass_accuracy'], '{:.0%}')})  "
                     f"errors {a['errors']}")
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

