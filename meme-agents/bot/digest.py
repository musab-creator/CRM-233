"""Hourly Telegram digest: the hour's closed trades (wins first), the open positions, the hour's
decisions and today's totals. Built from the database, so it matches `status` and `report`."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from .budget import utc_day, utc_month
from .config import Settings
from .db import Database
from .risk import utc_midnight


def hour_start(ts: float) -> float:
    d = datetime.fromtimestamp(ts, timezone.utc)
    return d.replace(minute=0, second=0, microsecond=0).timestamp()


def fmt_hold(seconds: float) -> str:
    m = int(max(0.0, seconds) // 60)
    return f"{m // 60}h{m % 60:02d}m" if m >= 60 else f"{m}m"


def usd(v: float) -> str:
    return f"{'+' if v >= 0 else '-'}${abs(v):.2f}"


def _symbol(p) -> str:
    return p["symbol"] or p["mint"][:6]


async def hourly_digest(db: Database, s: Settings, since: float, until: float) -> tuple[str, int]:
    """(text, winning trades) for the real positions closed in [since, until)."""
    closed = await db.fetchall(
        "SELECT p.*, m.symbol FROM positions p LEFT JOIN mints m ON m.mint = p.mint "
        "WHERE p.kind='real' AND p.status='closed' AND p.closed_at >= ? AND p.closed_at < ? ORDER BY p.pnl_usd DESC",
        [since, until])
    open_ = await db.fetchall(
        "SELECT p.*, m.symbol FROM positions p LEFT JOIN mints m ON m.mint = p.mint "
        "WHERE p.kind='real' AND p.status IN ('open', 'pending') ORDER BY p.id", [])
    cands = await db.fetchone(
        "SELECT COUNT(*) n, COALESCE(SUM(decision='BUY'), 0) buys FROM candidates WHERE ts >= ? AND ts < ?",
        [since, until])
    today = await db.fetchone(
        "SELECT COUNT(*) n, COALESCE(SUM(pnl_usd > 0), 0) wins, COALESCE(SUM(pnl_usd), 0) pnl FROM positions "
        "WHERE kind='real' AND status='closed' AND closed_at >= ?", [utc_midnight(until - 1)])
    llm = (await db.fetchone("SELECT COALESCE(SUM(usd), 0) s FROM ledger WHERE kind='llm' AND day=?",
                             [utc_day(until - 1)]))["s"]
    xs = (await db.fetchone("SELECT COALESCE(SUM(usd), 0) s FROM ledger WHERE kind='x' AND month=?",
                            [utc_month(until - 1)]))["s"]

    h0, h1 = datetime.fromtimestamp(since, timezone.utc), datetime.fromtimestamp(until, timezone.utc)
    lines = [f"meme-agents {h0:%H:%M}-{h1:%H:%M} UTC ({s.MODE})"]
    wins = 0
    for p in closed:
        pnl = float(p["pnl_usd"] or 0)
        wins += pnl > 0
        ret = f" ({(float(p['proceeds_sol'] or 0) / p['cost_sol'] - 1) * 100:+.0f}%)" if p["cost_sol"] else ""
        held = fmt_hold((p["closed_at"] or 0) - (p["opened_at"] or p["closed_at"] or 0))
        lines.append(f"{'✅ WIN' if pnl > 0 else '❌ LOSS'} {usd(pnl)}{ret} {_symbol(p)} · "
                     f"{(p['exit_reason'] or 'exit').replace('_', ' ')} · held {held}")
    if not closed:
        lines.append("no trades closed this hour")
    if open_:
        parts = []
        for p in open_:
            if p["status"] == "pending":
                parts.append(f"{_symbol(p)} ${p['size_usd']:.0f} entry pending")
                continue
            chg = (f" {(p['last_price'] / p['entry_price'] - 1) * 100:+.0f}%"
                   if p["entry_price"] and p["last_price"] else "")
            parts.append(f"{_symbol(p)} ${p['size_usd']:.0f}{chg} ({fmt_hold(until - (p['opened_at'] or until))})")
        lines.append(f"open {len(open_)}: " + ", ".join(parts))
    else:
        lines.append("open: none")
    lines.append(f"this hour: {cands['n']} candidates, {int(cands['buys'])} gate BUY")
    hb_raw = await db.kv_get("heartbeat")
    hb = json.loads(hb_raw) if hb_raw else {}
    if hb.get("regime") and hb["regime"] != "normal":
        lines.append(f"regime: {hb['regime']} x{hb.get('regime_multiplier', 0):g} · "
                     + "; ".join(hb.get("regime_reasons") or [])[:160])
    lines.append(f"today: {today['n']} closed, {int(today['wins'])} wins, PnL {usd(float(today['pnl']))} · "
                 f"LLM ${llm:.2f}/{s.LLM_DAILY_BUDGET_USD:.0f} · X ${xs:.2f}/{s.X_MONTHLY_BUDGET_USD:.0f}")
    return "\n".join(lines), wins
