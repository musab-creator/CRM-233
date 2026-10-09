"""`python -m bot status`: what the bot is doing right now, read from the database.

Safe to run while the bot is running (SQLite WAL allows concurrent readers).
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone

from .budget import pace_released, utc_day, utc_month
from .config import Settings
from .db import Database
from .paper import mark_to_market
from .risk import kill_switch_active, utc_midnight
from .util import now_s, redact


HEARTBEAT_STALE_S = 180   # the bot writes one every 60 s
STREAM_STALE_S = 300      # pump.fun launches every few seconds: 5 silent minutes means blind
FAILING_VOTES = 6         # this many failed votes in a row (two candidates) means the agents are down


def _read_heartbeat(raw: str | None) -> tuple[dict, str | None]:
    if not raw:
        return {}, None
    try:
        hb = json.loads(raw)
        if not isinstance(hb, dict):
            raise ValueError("not an object")
        for key in ("ts", "started_at", "last_msg_at", "stopped_at"):
            if hb.get(key) is not None:
                number = float(hb[key])
                if not math.isfinite(number) or number < 0:
                    raise ValueError("invalid timestamp")
                hb[key] = number
        if not hb.get("ts"):
            raise ValueError("missing timestamp")
        return hb, None
    except (json.JSONDecodeError, TypeError, ValueError, OverflowError):
        return {}, "heartbeat is malformed or has an invalid timestamp"


ERROR_TAGS = (("llm budget", "budget"), ("rate limited", "rate"), ("timed out", "timeout"), ("timeout", "timeout"),
              ("connection", "net"), ("api ", "api"), ("refusal", "refusal"), ("no vote after", "noanswer"),
              ("invalid vote", "invalid"))


def _err_tag(error) -> str:
    """Why an agent failed, in a word: a budget starve and an API outage need different fixes."""
    if not error:
        return ""
    e = str(error).lower()
    for needle, tag in ERROR_TAGS:
        if needle in e:
            return f"(err:{tag})"
    return "(err)"


def _positive(value) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def _ago(ts: float | None, now: float) -> str:
    if not ts:
        return "never"
    d = now - ts
    return f"{d:.0f}s ago" if d < 120 else f"{d / 60:.0f}m ago" if d < 7200 else f"{d / 3600:.1f}h ago"


async def health(db: Database, s: Settings, now: float | None = None) -> tuple[str, str]:
    """(state, one line) for monitoring: OK, PAUSED (alive, needs a human), DEGRADED (alive, but
    the agents fail, for example an expired key), DOWN or BLIND."""
    now = now_s() if now is None else now
    raw = await db.kv_get("heartbeat")
    if not raw:
        return "DOWN", "no heartbeat recorded: the bot has not run against this database"
    hb, error = _read_heartbeat(raw)
    if error:
        return "DOWN", error
    if hb["ts"] > now + 10 or (hb.get("started_at") or 0) > now + 10:
        return "DOWN", "heartbeat timestamp is in the future: check the server clock"
    if hb.get("stopped_at"):
        return "DOWN", f"stopped cleanly {_ago(hb['stopped_at'], now)}"
    if now - (hb.get("ts") or 0) > HEARTBEAT_STALE_S:
        return "DOWN", f"last heartbeat {_ago(hb.get('ts'), now)}"
    started = hb.get("started_at") or hb.get("ts")
    if now - started > STREAM_STALE_S and now - (hb.get("last_msg_at") or 0) > STREAM_STALE_S:
        return "BLIND", (f"no PumpPortal message for {_ago(hb.get('last_msg_at'), now)} "
                         f"(reconnects {hb.get('reconnects')}, stalls {hb.get('stalls')})")
    extra = f", {hb['crashes']} loop restart(s)" if hb.get("crashes") else ""
    if kill_switch_active(s):
        return "PAUSED", f"kill switch {s.STOP_FILE} is present: entries stopped, positions closing{extra}"
    if hb.get("mode") in ("paper", "live") and hb["mode"] != s.MODE:
        return "DEGRADED", f"running mode={hb['mode']} differs from configured mode={s.MODE}{extra}"
    if hb.get("helius_exhausted"):
        return "PAUSED", (f"Helius credits for the month are spent ({hb.get('helius_credits_month')}): no chain "
                          f"reads until the 1st; raise HELIUS_MONTHLY_CREDITS or upgrade the Helius plan{extra}")
    # an expired or revoked ANTHROPIC_API_KEY keeps the bot alive but turns every vote into an error
    recent = await db.fetchall("SELECT error FROM votes WHERE ts>=? OR ts IS NULL ORDER BY id DESC LIMIT ?",
                              [started, FAILING_VOTES])
    if len(recent) == FAILING_VOTES and all(r["error"] and "budget" not in r["error"].lower() for r in recent):
        return "DEGRADED", f"the last {FAILING_VOTES} agent votes failed: {redact(recent[0]['error'])[:160]}"
    if hb.get("paused"):
        return "PAUSED", f"{hb['paused']}{extra}"
    return "OK", (f"up {_ago(started, now).replace(' ago', '')}, {hb.get('launches')} launches, "
                  f"{hb.get('cycles')} decisions, queue {hb.get('queue')}, Helius credits "
                  f"{hb.get('helius_credits_month')} this month{extra}")


async def build_status(db: Database, s: Settings) -> str:
    now = now_s()
    lines: list[str] = []
    hb_raw = await db.kv_get("heartbeat")
    hb, heartbeat_error = _read_heartbeat(hb_raw)
    alive = hb.get("ts")
    state = ("NOT RUNNING (invalid heartbeat)" if heartbeat_error else
             "STOPPED (clean shutdown)" if hb.get("stopped_at") else
             "RUNNING" if alive and now - alive < 180 else
             "NOT RUNNING (no heartbeat in 3 min)" if alive else "never started")
    running_mode = hb.get("mode") if hb.get("mode") in ("paper", "live") else s.MODE
    code = hb.get("code") if isinstance(hb.get("code"), str) and re.fullmatch(r"[0-9a-f]{7}(\+dirty)?", hb["code"]) else None
    lines.append(f"bot: {state}, last heartbeat {_ago(alive, now)}  mode={running_mode}"
                 + (f"  code={code}" if code else ""))
    if heartbeat_error:
        lines.append(heartbeat_error)
    if hb.get("mode") in ("paper", "live") and running_mode != s.MODE:
        lines.append(f"configuration differs: MODE={s.MODE}, running bot mode={running_mode}")
    if hb.get("simulated") is True:
        lines.append("SIMULATION: feeds and Claude votes are synthetic")
    if hb:
        lines.append(f"stream: {hb.get('tracked')} mints tracked, {hb.get('trades')} trades this session, "
                     f"last message {_ago(hb.get('last_msg_at'), now)}, reconnects {hb.get('reconnects')}, "
                     f"stalls {hb.get('stalls')}, candidate queue {hb.get('queue')}")
        if hb.get("paused"):
            lines.append(f"PAUSED: {hb['paused']}")
        if hb.get("regime") and hb["regime"] != "normal":
            lines.append(f"regime: {hb['regime']} x{_positive(hb.get('regime_multiplier')) or 0:g} ({hb.get('regime_source')}): "
                         + "; ".join(map(str, hb.get("regime_reasons") or [])))
    if kill_switch_active(s):
        lines.append(f"KILL SWITCH: {s.STOP_FILE} present, no new entries, positions closing")

    llm = (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='llm' AND day=?",
                             [utc_day(now)]))["s"]
    xs = (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='x' AND month=?",
                            [utc_month(now)]))["s"]
    burst = s.LLM_BUDGET_BURST_HOURS if s.LLM_BUDGET_PACING else None
    released = pace_released(s.LLM_DAILY_BUDGET_USD, burst, now)
    paced = f" (${released:.2f} released so far, paced)" if released < s.LLM_DAILY_BUDGET_USD else ""
    helius = (" (SPENT: chain reads stopped)" if hb.get("helius_exhausted") else
              " (ahead of pace: reads slowed)" if hb.get("helius_over_pace") else "")
    lines.append(f"budgets: LLM ${llm:.2f} of ${s.LLM_DAILY_BUDGET_USD:.2f} today{paced}, X ${xs:.2f} of "
                 f"${s.X_MONTHLY_BUDGET_USD:.2f} this month, Helius credits {hb.get('helius_credits_month') or 0} of "
                 f"{s.HELIUS_MONTHLY_CREDITS} this month{helius}")

    start = utc_midnight(now)
    f = {}
    for k, sql in (("candidates", "SELECT COUNT(*) c FROM candidates WHERE ts>=?"),
                   ("evaluated", "SELECT COUNT(*) c FROM candidates WHERE ts>=? AND decision IS NOT NULL"),
                   ("triage skipped",
                    "SELECT COUNT(*) c FROM candidates WHERE ts>=? AND gate_reason LIKE 'triage:%'"),
                   ("gate BUY", "SELECT COUNT(*) c FROM candidates WHERE ts>=? AND decision='BUY'"),
                   ("closed trades", "SELECT COUNT(*) c FROM positions WHERE kind='real' AND status='closed' AND closed_at>=?")):
        f[k] = (await db.fetchone(sql, [start]))["c"]
    pnl = (await db.fetchone("SELECT COALESCE(SUM(pnl_usd),0) s FROM positions WHERE kind='real' AND status='closed'"
                             " AND closed_at>=?", [start]))["s"]
    lines.append("today (UTC): " + ", ".join(f"{k} {v}" for k, v in f.items()) + f", realized PnL ${pnl:+.2f}")
    errs = await db.fetchall("SELECT v.error FROM votes v JOIN candidates c ON c.id=v.candidate_id "
                             "WHERE c.ts>=? AND v.error IS NOT NULL AND v.error != ''", [start])
    if errs:
        by: dict[str, int] = {}
        for e in errs:
            tag = _err_tag(e["error"]).strip("()").removeprefix("err:").removeprefix("err") or "other"
            by[tag] = by.get(tag, 0) + 1
        lines.append("agent errors today: " + ", ".join(f"{k} {v}" for k, v in sorted(by.items(), key=lambda kv: -kv[1]))
                     + " (an errored agent is a PASS; budget = the paced LLM budget ran out mid-evaluation)")

    pos = await db.fetchall("SELECT * FROM positions WHERE kind='real' AND status IN ('pending','open') "
                           "AND (mode=? OR mode IS NULL) ORDER BY id", [running_mode])
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
        entry = _positive(p["entry_price"])
        last, peak = _positive(p["last_price"]), _positive(p["peak_price"])
        chg = f"{(last / entry - 1) * 100:+.1f}%" if entry and last else "n/a"
        peak_change = f"{(peak / entry - 1) * 100:+.1f}%" if entry and peak else "n/a"
        lines.append(f"  #{p['id']} {p['mint']} ${p['size_usd']:.2f} opened {_ago(p['opened_at'], now)}  "
                     f"price {chg} vs entry, peak {peak_change}"
                     f"{', TP taken' if p['tp_done'] else ''}  net {upnl:+.4f} SOL"
                     f"{'  EXIT PENDING: ' + p['pending_exit'] if p['pending_exit'] else ''}")
        if p.get("runner_active"):
            share = 100 * (p["tokens_remaining"] or 0) / p["tokens_initial"] if p["tokens_initial"] else 0
            target = p.get("runner_target_multiple") or s.RUNNER_TARGET_MULTIPLE
            left = (p.get("runner_max_hold_hours") or s.RUNNER_MAX_HOLD_HOURS) - (now - (p["opened_at"] or now)) / 3600
            lines.append(f"    🏃 RUNNER {share:.0f}% of the tokens, price {last / entry if entry and last else 0:.2f}x "
                         f"of entry, target {target:g}x, time exit in {max(0.0, left):.1f} h")

    dec = await db.fetchall("SELECT c.id, c.mint, c.ts, c.decision, c.mean_confidence, c.gate_reason, m.symbol "
                            "FROM candidates c LEFT JOIN mints m ON m.mint=c.mint WHERE c.decision IS NOT NULL "
                            "ORDER BY c.ts DESC LIMIT 5")
    lines += ["", "last decisions:"]
    if not dec:
        lines.append("  none yet")
    for d in dec:
        vs = await db.fetchall("SELECT agent, vote, confidence, guard, error FROM votes WHERE candidate_id=? "
                               "ORDER BY agent", [d["id"]])
        vtxt = "  ".join(f"{v['agent']}={v['vote']}/{v['confidence'] or 0:.2f}"
                         f"{'(guard)' if v['guard'] else ''}{_err_tag(v['error'])}" for v in vs)
        when = datetime.fromtimestamp(d["ts"], timezone.utc).strftime("%H:%M")
        lines.append(f"  {when} #{d['id']} {(d['symbol'] or '?')[:10]:10s} {d['decision']:4s} "
                     f"conf {d['mean_confidence'] or 0:.2f}  {vtxt}  | {d['gate_reason']}")
    return redact("\n".join(lines))
