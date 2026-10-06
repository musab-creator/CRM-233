"""`python -m bot status`: what the bot is doing right now, read from the database.

Safe to run while the bot is running (SQLite WAL allows concurrent readers).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from .budget import utc_day, utc_month
from .config import Settings
from .db import Database
from .paper import mark_to_market
from .risk import kill_switch_active, utc_midnight
from .util import now_s


def _ago(ts: float | None, now: float) -> str:
    if not ts:
        return "never"
    d = now - ts
    return f"{d:.0f}s ago" if d < 120 else f"{d / 60:.0f}m ago" if d < 7200 else f"{d / 3600:.1f}h ago"


async def build_status(db: Database, s: Settings) -> str:
    now = now_s()
    lines: list[str] = []
    hb_raw = await db.kv_get("heartbeat")
    hb = json.loads(hb_raw) if hb_raw else {}
    alive = hb.get("ts")
    state = "RUNNING" if alive and now - alive < 180 else "NOT RUNNING (no heartbeat in 3 min)" if alive else "never started"
    lines.append(f"bot: {state}, last heartbeat {_ago(alive, now)}  mode={s.MODE}")
    if hb:
        lines.append(f"stream: {hb.get('tracked')} mints tracked, {hb.get('trades')} trades this session, "
                     f"last message {_ago(hb.get('last_msg_at'), now)}, reconnects {hb.get('reconnects')}, "
                     f"stalls {hb.get('stalls')}, candidate queue {hb.get('queue')}")
        if hb.get("paused"):
            lines.append(f"PAUSED: {hb['paused']}")
    if kill_switch_active(s):
        lines.append(f"KILL SWITCH: {s.STOP_FILE} present, no new entries, positions closing")

    llm = (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='llm' AND day=?", [utc_day(now)]))["s"]
    xs = (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='x' AND month=?", [utc_month(now)]))["s"]
    lines.append(f"budgets: LLM ${llm:.2f} of ${s.LLM_DAILY_BUDGET_USD:.2f} today, X ${xs:.2f} of "
                 f"${s.X_MONTHLY_BUDGET_USD:.2f} this month")

    start = utc_midnight(now)
    f = {}
    for k, sql in (("candidates", "SELECT COUNT(*) c FROM candidates WHERE ts>=?"),
                   ("evaluated", "SELECT COUNT(*) c FROM candidates WHERE ts>=? AND decision IS NOT NULL"),
                   ("gate BUY", "SELECT COUNT(*) c FROM candidates WHERE ts>=? AND decision='BUY'"),
                   ("closed trades", "SELECT COUNT(*) c FROM positions WHERE kind='real' AND status='closed' AND closed_at>=?")):
        f[k] = (await db.fetchone(sql, [start]))["c"]
    pnl = (await db.fetchone("SELECT COALESCE(SUM(pnl_usd),0) s FROM positions WHERE kind='real' AND status='closed'"
                             " AND closed_at>=?", [start]))["s"]
    lines.append("today (UTC): " + ", ".join(f"{k} {v}" for k, v in f.items()) + f", realized PnL ${pnl:+.2f}")

    pos = await db.fetchall("SELECT * FROM positions WHERE kind='real' AND status IN ('pending','open') ORDER BY id")
    lines += ["", f"open positions ({len(pos)}/{s.MAX_OPEN_POSITIONS}):"]
    if not pos:
        lines.append("  none")
    for p in pos:
        if p["status"] == "pending":
            lines.append(f"  #{p['id']} {p['mint']} pending entry (${p['size_usd']:.2f}), decided {_ago(p['decided_at'], now)}")
            continue
        value = (p["proceeds_sol"] or 0) + (mark_to_market(p["tokens_remaining"] or 0, p["last_price"] or 0, s)
                                            if p["last_price"] else 0)
        upnl = value - (p["cost_sol"] or 0)
        chg = (p["last_price"] / p["entry_price"] - 1) * 100 if p["last_price"] and p["entry_price"] else 0
        lines.append(f"  #{p['id']} {p['mint']} ${p['size_usd']:.2f} opened {_ago(p['opened_at'], now)}  "
                     f"price {chg:+.1f}% vs entry, peak {((p['peak_price'] or 0) / p['entry_price'] - 1) * 100:+.1f}%"
                     f"{', TP taken' if p['tp_done'] else ''}  net {upnl:+.4f} SOL"
                     f"{'  EXIT PENDING: ' + p['pending_exit'] if p['pending_exit'] else ''}")

    dec = await db.fetchall("SELECT c.id, c.mint, c.ts, c.decision, c.mean_confidence, c.gate_reason, m.symbol "
                            "FROM candidates c LEFT JOIN mints m ON m.mint=c.mint WHERE c.decision IS NOT NULL "
                            "ORDER BY c.ts DESC LIMIT 5")
    lines += ["", "last decisions:"]
    if not dec:
        lines.append("  none yet")
    for d in dec:
        vs = await db.fetchall("SELECT agent, vote, confidence, guard, error FROM votes WHERE candidate_id=? "
                               "ORDER BY agent", [d["id"]])
        vtxt = "  ".join(f"{v['agent']}={v['vote']}/{v['confidence']:.2f}"
                         f"{'(guard)' if v['guard'] else ''}{'(err)' if v['error'] else ''}" for v in vs)
        when = datetime.fromtimestamp(d["ts"], timezone.utc).strftime("%H:%M")
        lines.append(f"  {when} #{d['id']} {(d['symbol'] or '?')[:10]:10s} {d['decision']:4s} "
                     f"conf {d['mean_confidence'] or 0:.2f}  {vtxt}  | {d['gate_reason']}")
    return "\n".join(lines)
