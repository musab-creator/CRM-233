"""Telegram commands: the bot's control panel from the chat, without logging in to the server.

Read: /status, /digest, /report, /trades, /log, /settings. Act: /pause and /resume (entries
only), /stop (the STOP kill switch: no entries, close every position). /panel shows the same
as buttons; the destructive ones ask for a confirmation tap. Only messages from
TELEGRAM_CHAT_ID are answered; anything else is logged and ignored. The loop long-polls
`getUpdates`, so it needs no open port.

Server actions (/update, /restart, /set, /dryrun) are not run here: the bot runs with its code
and `.env` read-only and no privileges, so they are queued as files for the ops companion
service (bot/ops.py, deploy/meme-agents-ops.service), which re-checks each one against the same
allowlist and reports back into the chat. Nothing in this chat can unlock live mode, raise the
wallet cap, turn dry run off or touch a key: those stay in `.env` on the server.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from datetime import datetime, timezone

import httpx

from .config import _FALSE, Settings
from .db import Database
from .digest import fmt_hold, hour_start, hourly_digest, usd
from .moonshots import render_lines as moonshot_lines
from .moonshots import summary as moonshot_summary
from .ops import (
    SERVICE,
    OpsError,
    current_settings,
    describe,
    format_queue,
    format_result,
    late_note,
    quarantine,
    request,
    results,
    settable_text,
    validate_set,
    watcher_alive,
)
from .report import _open_row, build_report, render_text
from .risk import kill_switch_active
from .status import build_status, health
from .telegram import Telegram, TelegramConflict
from .util import backoff_delay, now_s, redact

log = logging.getLogger("bot.commands")

COMMANDS: list[tuple[str, str]] = [
    ("panel", "buttons for everything below"),
    ("status", "what the bot is doing right now"),
    ("digest", "this hour so far: trades, open positions, spend"),
    ("report", "the full report, all time and today"),
    ("moonshots", "every evaluated coin's peak over 14 days: which went 10x/100x/500x and what the bot did"),
    ("trades", "the last closed trades"),
    ("why", "/why [id or address]: every vote on the latest decision, on decision #id, or on the coin whose "
            "address starts with those letters (6 or more), with its reasons and what its positions did"),
    ("log", "/log [n] [word]: the last n lines of the bot's log, or the last n that contain word"),
    ("settings", "the current settings (read-only)"),
    ("pause", "no new entries; open positions keep running"),
    ("resume", "allow entries again (clears pause and the kill switch)"),
    ("stop", "kill switch: no new entries, close every position"),
    ("update", "deploy the latest tested code from GitHub and restart"),
    ("restart", "restart the bot service"),
    ("set", "/set KEY=VALUE changes a bounded setting; /set alone lists them"),
    ("dryrun", "/dryrun on: live mode stops sending real transactions (one way)"),
    ("ops", "queued and finished server actions"),
    ("help", "this list"),
]
PAUSE_REASON = "paused from Telegram (/resume to continue)"
B58 = frozenset("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
STALE_COMMAND_S = 120   # commands sent while the bot was down are not answered on restart
RESULTS_POLL_S = 2.0    # how often finished server actions are looked for
RESULT_GIVE_UP_S = 600  # a result Telegram keeps refusing is set aside after this long
LOSS_CAP_PREFIX = "daily loss cap hit:"
# panel buttons that ask before acting: what -> the callback data of its "Yes" button
CONFIRM = {"stop": "stop", "update": "update", "restart": "restart", "dryrun": "dryrun on"}
SHOWN_SETTINGS = (
    "MODE", "LIVE_DRY_RUN", "LLM_MODEL", "LLM_DAILY_BUDGET_USD", "LLM_BUDGET_PACING", "LLM_CONCURRENCY", "X_MONTHLY_BUDGET_USD",
    "BANKROLL_USD", "MAX_OPEN_POSITIONS", "POSITION_MIN_USD", "POSITION_MAX_USD", "DAILY_LOSS_CAP_PCT",
    "STOP_LOSS_PCT", "TAKE_PROFIT_PCT", "TAKE_PROFIT_SELL_FRACTION", "TRAILING_STOP_PCT", "TIME_STOP_HOURS",
    "RUNNER_ENABLED", "RUNNER_FRACTION", "RUNNER_TARGET_MULTIPLE", "RUNNER_MAX_HOLD_HOURS", "RUNNER_STOP_LOSS",
    "EMERGENCY_LIQ_DROP_PCT", "ENTRY_MAX_LIQ_SLIP_PCT", "POSITION_POLL_S", "POSITION_DEX_POLL_S",
    "INSIDER_WATCH", "INSIDER_EXIT", "INSIDER_EXIT_SUPPLY_PCT", "INSIDER_WATCH_MAX", "LAUNCH_MEMORY_DAYS",
    "LAUNCH_BACKFILL_PER_MIN",
    "CURVE_POLL_CALLS_PER_MIN", "CURVE_HOT_POLL_S", "PRIORITY_FEE_SOL", "URGENT_PRIORITY_FEE_SOL", "TICK_SANITY_FACTOR", "PF_MIN_AGE_MIN", "PF_MAX_AGE_MIN", "PF_MIN_UNIQUE_BUYERS",
    "PF_MIN_NET_INFLOW_SOL", "PF_MAX_TOP10_PCT", "PF_MIN_LIQUIDITY_USD", "CONSENSUS_MIN_MEAN_CONFIDENCE", "GATE_NEUTRAL_VOTES",
    "TRIAGE_ENABLED", "TRIAGE_MIN_CONFIDENCE", "VETO_ENABLED", "VETO_MIN_CONFIDENCE", "REGIME_ENABLED",
    "REGIME_REFRESH_MIN", "TELEGRAM_DIGEST", "HELIUS_MONTHLY_CREDITS", "MOONSHOT_TRACK_DAYS", "MOONSHOT_ALERT_MULTIPLE",
)
PANEL = [[("Status", "status"), ("Digest", "digest"), ("Report", "report")],
         [("Trades", "trades"), ("Why", "why"), ("Log", "log"), ("Settings", "settings")],
         [("Pause", "pause"), ("Resume", "resume"), ("Stop", "confirm:stop")],
         [("Update", "confirm:update"), ("Restart", "confirm:restart"), ("Dry run ON", "confirm:dryrun")],
         [("Moonshots", "moonshots"), ("Ops", "ops")]]


def parse_command(text: str | None) -> tuple[str, str] | None:
    """('status', 'rest of the line') for '/status@my_bot rest', None for anything else."""
    if not text or not text.startswith("/"):
        return None
    head, _, rest = text[1:].partition(" ")
    name = head.split("@", 1)[0].strip().lower()
    return (name, rest.strip()) if name else None


def keyboard(rows: list[list[tuple[str, str]]]) -> dict:
    return {"inline_keyboard": [[{"text": t, "callback_data": d} for t, d in row] for row in rows]}


def tail_lines(path, n: int) -> list[str]:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return list(deque(f, maxlen=n))
    except OSError:
        return []


class TelegramCommands:
    def __init__(self, tg: Telegram, db: Database, s: Settings, engine=None):
        self.tg, self.db, self.s, self.engine = tg, db, s, engine
        self.offset: int | None = None
        self.started_at = now_s()
        self._unknown_chats: set[str] = set()
        self._refused: dict[str, float] = {}     # result file -> first time Telegram refused it

    # --- answers ---------------------------------------------------------------------
    async def answer(self, name: str, arg: str) -> tuple[str, dict | None]:
        """(reply text, inline keyboard or None)."""
        if name in ("start", "help"):
            return "meme-agents commands:\n" + "\n".join(f"/{c}  {d}" for c, d in COMMANDS), None
        if name == "panel":
            return "meme-agents control panel", keyboard(PANEL)
        if name.startswith("confirm:"):
            what = name.split(":", 1)[1]
            if what not in CONFIRM:
                return f"nothing to confirm for {what}", None
            return (f"/{what}: {dict(COMMANDS).get(what, what)}. Sure?",
                    keyboard([[("Yes, " + what, CONFIRM[what]), ("Cancel", "cancel")]]))
        if name == "cancel":
            return "cancelled", None
        if name == "status":
            state, line = await health(self.db, self.s)
            return f"{state}: {line}\n\n" + await build_status(self.db, self.s), None
        if name == "digest":
            now = now_s()
            text, _ = await hourly_digest(self.db, self.s, hour_start(now), now)
            return text, None
        if name == "report":
            return render_text(await build_report(self.db, self.s)), None
        if name == "moonshots":
            if self.s.MOONSHOT_TRACK_DAYS <= 0:
                return "the moonshot tracker is off (MOONSHOT_TRACK_DAYS=0 in .env)", None
            text = "\n".join(moonshot_lines(await moonshot_summary(self.db, self.s, top=15))).strip()
            return text or "no coin tracked yet: the tracker starts with the next coin the bot evaluates", None
        if name == "trades":
            return await self._trades(10), None
        if name == "why":
            return await self._why(arg.strip() or None), None
        if name == "log":
            words = arg.split()
            n = next((int(w) for w in words if w.isdigit()), 30)
            needle = next((w.lower() for w in words if not w.isdigit()), None)
            n = max(5, min(80, n))
            if not self.s.LOG_FILE:
                lines = []
            elif needle:
                lines = [ln for ln in tail_lines(self.s.path(self.s.LOG_FILE), 5000) if needle in ln.lower()][-n:]
            else:
                lines = tail_lines(self.s.path(self.s.LOG_FILE), n)
            return ("".join(lines).rstrip() or ("no log file" if not self.s.LOG_FILE else f"nothing matches {needle}")), None
        if name == "settings":
            vals = [f"{k}={getattr(self.s, k)}" for k in SHOWN_SETTINGS if hasattr(self.s, k)]
            return ("current settings (running values; /set changes the operational ones, keys and the live-mode "
                    "locks change in .env on the server):\n" + "\n".join(vals)), None
        if name == "pause":
            if self.engine is None:
                return "pause needs the running bot", None
            if self.engine.risk.paused_reason:
                return f"already paused: {self.engine.risk.paused_reason}", None
            self.engine.risk.paused_reason = PAUSE_REASON
            log.warning("entries paused from Telegram")
            return "paused: no new entries; open positions keep running their exits. /resume to continue", None
        if name == "resume":
            notes = []
            if self.engine is not None and self.engine.risk.paused_reason == PAUSE_REASON:
                self.engine.risk.paused_reason = None
                notes.append("pause cleared")
            elif self.engine is not None and self.engine.risk.paused_reason:
                notes.append(f"still paused by the bot itself ({self.engine.risk.paused_reason})")
            path = self.s.path(self.s.STOP_FILE)
            if kill_switch_active(self.s):
                path.unlink()
                log.warning("kill switch removed from Telegram: %s", path)
                notes.append("kill switch OFF")
            if not notes:
                return "nothing was paused; entries are allowed", None
            if notes[0].startswith("still paused"):
                return notes[0] + " (/restart reset ends a loss-cap pause; a plain /restart keeps it)", None
            return "; ".join(notes) + ". New entries allowed again", None
        if name == "stop":
            path = self.s.path(self.s.STOP_FILE)
            if kill_switch_active(self.s):
                return f"kill switch already on ({path}): no new entries, positions closing", None
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("stopped from Telegram\n")
            log.warning("kill switch set from Telegram: %s", path)
            return (f"kill switch ON ({path}): no new entries, every position is being closed. "
                    "/resume turns it off"), None
        if name in ("update", "restart"):
            note = {
                "update": "the server fetches the branch it tracks, builds and tests it in a separate "
                          "environment (a few minutes), then restarts the bot. The result arrives here",
                "restart": "the service restarts; open positions are kept and resumed. The result arrives here",
            }[name]
            reset = arg.lower() == "reset"
            paused = self._loss_cap_paused()
            if paused and reset:
                note += ". This ends the daily-loss pause and restarts the loss window"
            elif paused:
                note += ". The daily-loss pause is kept across this restart (/restart reset would end it)"
            return self._queue(name, {}, note, keep_pause=paused and not reset)
        if name == "set":
            if not arg:
                return settable_text(self.s), None
            key, sep, value = arg.partition("=")
            if not sep:
                return "use /set KEY=VALUE; /set alone lists the keys and their limits", None
            if key.strip().upper() == "LIVE_DRY_RUN" and value.strip().lower() not in _FALSE:
                return await self.answer("dryrun", "on")         # same checks as /dryrun on (open positions)
            try:
                value = validate_set(key, value, current_settings(self.s))
            except OpsError as e:
                return str(e), None
            return self._queue("set", {"key": key.strip().upper(), "value": value},
                               "written to .env on the server; a Restart button follows when it is done")
        if name == "dryrun":
            words = arg.lower().split()
            if not words or words[0] != "on":
                return ("/dryrun on is the only direction from the phone: the bot keeps running in live mode "
                        "but stops sending real transactions. Turning real sends back on needs LIVE_DRY_RUN=false "
                        "in .env on the server and a restart"), None
            if not self.s.is_live:
                return "MODE=paper: nothing is ever sent. /dryrun applies to live mode only", None
            if self.s.LIVE_DRY_RUN:
                return "dry run is already on (LIVE_DRY_RUN=true): live mode, nothing is sent", None
            held = self.engine.positions.active("real") if self.engine is not None else []
            if held and words[1:] != ["force"]:
                return (f"not queued: {len(held)} open live position(s). After the restart they would be closed "
                        "in paper and the tokens stay in the wallet. Send /stop, wait until /status shows no open "
                        "positions (the sells confirm on chain), then /dryrun on. /dryrun on force switches anyway"), None
            paused = self._loss_cap_paused()
            note = ("LIVE_DRY_RUN=true is written and the bot restarts without real sends"
                    + (f"; {len(held)} open position(s) will be closed in paper, tokens stay in the wallet" if held else "")
                    + (". The daily-loss pause is kept" if paused else ""))
            return self._queue("set", {"key": "LIVE_DRY_RUN", "value": "true", "restart": True}, note, keep_pause=paused)
        if name == "ops":
            return format_queue(self.s), None
        return f"unknown command /{name}. /help lists them", None

    def _loss_cap_paused(self) -> bool:
        return self.engine is not None and str(self.engine.risk.paused_reason or "").startswith(LOSS_CAP_PREFIX)

    def _queue(self, action: str, args: dict, note: str, keep_pause: bool = False) -> tuple[str, dict | None]:
        """Hand an action to the ops service, or explain why it cannot be."""
        if not watcher_alive(self.s):
            return (f"not queued: the ops service is not running on the server, so nothing can act on this. "
                    f"Once, on the server: bash deploy/install.sh --ops (deploy/VPS.md, 'Control from your phone'); "
                    f"if it was installed: sudo systemctl restart {SERVICE}-ops"), None
        try:
            req = request(self.s, action, args, keep_pause=keep_pause)
        except OpsError as e:
            return str(e), None
        except OSError as e:
            log.warning("ops request failed: %s", e)
            return "not queued: the request file could not be written; the log has the error", None
        return f"queued: {describe(req)}. {note}", None

    async def deliver_results(self) -> int:
        """Send every finished server action to the chat, then drop its result file. A result
        Telegram refuses stays for the next round; one that cannot be read, or keeps failing, is
        set aside so it never blocks the ones behind it."""
        sent = 0
        up = getattr(self.engine, "ready_at", None)     # when this bot process came up
        for path, res in results(self.s):
            try:
                text = format_result(res)
                markup = None
                args = res.get("args") if isinstance(res.get("args"), dict) else {}
                if res.get("ok") and res.get("action") == "set" and not args.get("restart"):
                    try:
                        restarted = up is not None and float(res.get("finished") or 0) < up
                    except (TypeError, ValueError):
                        restarted = False
                    if restarted:                       # this process loaded .env after the change
                        text = text.replace(". Restart to apply", "; the bot has restarted since and loaded .env "
                                            "(/settings shows the value it runs with)", 1)
                    else:
                        markup = keyboard([[("Restart now", "confirm:restart")]])
                text = redact(late_note(res, up_since=up) + text)
                ok = await (self.tg.send(text, reply_markup=markup) if markup else self.tg.send_long(text))
                if ok:
                    try:
                        path.unlink()
                    except OSError:
                        pass
                    self._refused.pop(str(path), None)
                    sent += 1
                elif now_s() - self._refused.setdefault(str(path), now_s()) > RESULT_GIVE_UP_S:
                    quarantine(path, "Telegram kept refusing it")   # counted from the first refusal, not its age
                    self._refused.pop(str(path), None)
            except Exception as e:                # a result file the bot cannot make sense of
                quarantine(path, f"unreadable result: {type(e).__name__}: {e}")
        return sent

    async def _trades(self, n: int) -> str:
        rows = await self.db.fetchall(
            "SELECT p.*, m.symbol FROM positions p LEFT JOIN mints m ON m.mint = p.mint "
            "WHERE p.kind='real' AND p.status='closed' ORDER BY p.closed_at DESC LIMIT ?", [n])
        if not rows:
            return "no closed trades yet"
        out = [f"last {len(rows)} closed trades:"]
        for p in rows:
            pnl = float(p["pnl_usd"] or 0)
            ret = f" ({(float(p['proceeds_sol'] or 0) / p['cost_sol'] - 1) * 100:+.0f}%)" if p["cost_sol"] else ""
            held = fmt_hold((p["closed_at"] or 0) - (p["opened_at"] or p["closed_at"] or 0))
            out.append(f"{'✅' if pnl > 0 else '❌'} {usd(pnl)}{ret} {p['symbol'] or p['mint'][:6]} · "
                       f"{(p['exit_reason'] or 'exit').replace('_', ' ')} · held {held}")
        return "\n".join(out)

    async def _why(self, ref: str | None) -> str:
        """One decision in full: every vote with its first reasons, the gate's verdict, and what the
        shadow position did afterwards. The status shows only votes and confidences; this is for
        reading why the gate stays shut.

        `ref` is a decision number (DECISION #id in the log) or a coin's address or its first letters:
        trade and insider lines number positions, not decisions, so /why with their number would show
        another coin; each of them prints the coin's address."""
        cid = None
        if ref and ref.lstrip("#").isdecimal():
            cid = int(ref.lstrip("#"))
        elif ref:
            if len(ref) < 6 or not set(ref) <= B58:
                return ("/why takes a decision number (DECISION #id in the log) or a coin's address, or its "
                        "first 6 or more letters")
            row = await self.db.fetchone("SELECT id FROM candidates WHERE mint >= ? AND mint < ? "
                                         "ORDER BY decision IS NULL, ts DESC LIMIT 1", [ref, ref + "~"])
            if not row:
                return f"no evaluated coin's address starts with {ref} (addresses are case-sensitive)"
            cid = row["id"]
        if cid is None:
            row = await self.db.fetchone("SELECT id FROM candidates WHERE decision IS NOT NULL ORDER BY ts DESC LIMIT 1")
            if not row:
                return "no decisions yet"
            cid = row["id"]
        c = await self.db.fetchone("SELECT c.*, m.symbol FROM candidates c LEFT JOIN mints m ON m.mint=c.mint "
                                   "WHERE c.id=?", [cid])
        if not c:
            return f"no candidate #{cid}"
        if not c["decision"]:
            return f"#{cid} {c['symbol'] or ''} {c['mint']}: {c['status']}, no decision" + (
                f" ({c['gate_reason']})" if c["gate_reason"] else "")
        when = datetime.fromtimestamp(float(c["ts"]), timezone.utc).strftime("%Y-%m-%d %H:%M")
        lines = [f"#{cid} {c['symbol'] or '?'} {c['mint']}",
                 f"{when}Z: {c['decision']} (mean conf {float(c['mean_confidence'] or 0):.2f}) · {c['gate_reason']}"]
        votes = await self.db.fetchall("SELECT agent, vote, confidence, guard, error, reasons FROM votes "
                                       "WHERE candidate_id=? ORDER BY id", [cid])
        for v in votes:
            reasons = v["reasons"]
            if isinstance(reasons, str):
                try:
                    reasons = json.loads(reasons)
                except ValueError:
                    reasons = [reasons]
            head = f"{v['agent']}: {v['vote']} {float(v['confidence'] or 0):.2f}"
            if v["guard"]:
                head += f" (guard: {v['guard']})"
            if v["error"]:
                head += f" (error: {str(v['error'])[:100]})"
            lines.append(head)
            lines += [f"  - {str(r)[:220]}" for r in (reasons or [])[:2]]
        for real in await self.db.fetchall("SELECT id, mode, status, size_usd, cost_sol, proceeds_sol, pnl_usd, "
                                           "exit_reason, entry_price, opened_at, closed_at FROM positions "
                                           "WHERE candidate_id=? AND kind='real' ORDER BY id", [cid]):
            head = f"real ${float(real['size_usd'] or 0):.2f} [{real['mode']}]: {real['status']}"
            if real["status"] == "closed":
                ret = (f" ({(float(real['proceeds_sol'] or 0) / real['cost_sol'] - 1) * 100:+.0f}%)"
                       if real["cost_sol"] else "")
                held = fmt_hold((real["closed_at"] or 0) - (real["opened_at"] or real["closed_at"] or 0))
                head += (f" {usd(float(real['pnl_usd'] or 0))}{ret} · "
                         f"{(real['exit_reason'] or 'exit').replace('_', ' ')} · held {held}")
            elif real["exit_reason"]:
                head += f" · {real['exit_reason']}"
            lines.append(head)
            warning = await self._insider_warning(real)
            if warning:
                lines.append(warning[1])
        lines += await self._emergency_lines(cid)
        shadow = await self.db.fetchone("SELECT id, mint, status, size_usd, cost_sol, proceeds_sol, pnl_usd, "
                                        "exit_reason, entry_price, opened_at, closed_at, tokens_initial, "
                                        "tokens_remaining, last_price, peak_price, sol_usd_entry, runner_active "
                                        "FROM positions WHERE candidate_id=? AND kind='shadow' ORDER BY id DESC LIMIT 1",
                                        [cid])
        if shadow and shadow["status"] == "closed":
            ret = (f" ({(float(shadow['proceeds_sol'] or 0) / shadow['cost_sol'] - 1) * 100:+.0f}%)"
                   if shadow["cost_sol"] else "")
            held = fmt_hold((shadow["closed_at"] or 0) - (shadow["opened_at"] or shadow["closed_at"] or 0))
            lines.append(f"shadow ${float(shadow['size_usd'] or 0):.0f}: {usd(float(shadow['pnl_usd'] or 0))}{ret} · "
                         f"{(shadow['exit_reason'] or 'exit').replace('_', ' ')} · held {held}")
            lines += await self._fill_lines(shadow)
        elif shadow:
            lines += self._open_shadow_lines(shadow)
            lines += await self._fill_lines(shadow)
        return redact("\n".join(lines))

    def _open_shadow_lines(self, shadow) -> list[str]:
        """An open shadow (9 Oct: QI's ran 158x as a runner, and /why said only "open"): where the price
        is against the entry, and what its sales so far banked and what it still holds."""
        head = f"shadow ${float(shadow['size_usd'] or 0):.0f}: {shadow['status']}"
        entry = float(shadow["entry_price"] or 0)
        if shadow["runner_active"]:
            head += " (runner)"
        if entry > 0 and shadow["last_price"]:
            head += f" · now x{float(shadow['last_price']) / entry:,.3g} the entry"
            if shadow["peak_price"]:
                head += f", peak x{float(shadow['peak_price']) / entry:,.3g}"
        out = [head]
        row = _open_row(dict(shadow), self.s)
        if "banked_sol" in row:
            dollars = f" ({usd(row['banked_usd'])})" if row.get("banked_usd") is not None else ""
            held = (f", the {1 - row['sold_share']:.0%} still held is worth {row['held_sol']:.4f} SOL now"
                    if row.get("held_sol") is not None else "")
            out.append(f"  sold {row['sold_share']:.0%} of the tokens for {row['proceeds_sol']:.4f} SOL: banked "
                       f"{row['banked_sol']:+.4f} SOL{dollars}{held}")
        return out

    async def _emergency_lines(self, cid: int) -> list[str]:
        """What made an emergency exit fire for this decision's positions (bot/positions.py records it)."""
        out, seen = [], set()
        rows = await self.db.fetchall("SELECT ts, kind, detail FROM events WHERE kind IN ('liq_drop', 'rug_danger') "
                                      "AND json_extract(detail, '$.candidate_id') = ? ORDER BY id LIMIT 40", [cid])
        for r in rows:
            try:
                d = json.loads(r["detail"] or "{}")
            except ValueError:
                continue
            if (d.get("position_id"), r["kind"]) in seen:          # the first report per position says it
                continue
            seen.add((d.get("position_id"), r["kind"]))
            when = time.strftime("%H:%MZ", time.gmtime(r["ts"] or 0))
            if r["kind"] == "liq_drop":
                out.append(f"  {when} {d.get('kind')}: liquidity ${float(d.get('entry_liq_usd') or 0):,.0f} -> "
                           f"${float(d.get('liq_usd') or 0):,.0f} on {d.get('source')}")
            else:
                names = ", ".join(str(x.get("name", "?")) for x in d.get("risks") or []) or \
                    ", ".join(map(str, d.get("danger") or []))
                out.append(f"  {when} {d.get('kind')}: rugcheck danger {names} (score {d.get('score_normalised')})")
        return out

    async def _fill_lines(self, pos) -> list[str]:
        """Every fill of one position with its price against the entry, so a booked return can be
        checked against the prices it came from. A sell far from the entry is marked and matched
        to the stored trade nearest in time: a match names the stream trade that priced it, no
        match means a curve read or a DexScreener mark did."""
        fills = await self.db.fetchall("SELECT ts, side, reason, price, tokens, sol FROM fills "
                                       "WHERE position_id=? ORDER BY id", [pos["id"]])
        entry = float(pos["entry_price"] or 0)
        factor = max(self.s.TICK_SANITY_FACTOR, 1.0) if self.s.TICK_SANITY_FACTOR else 20.0
        warning = await self._insider_warning(pos)
        out = []
        for f in fills:
            if warning and float(f["ts"] or 0) > warning[0]:
                out.append(warning[1])
                warning = None
            price = float(f["price"] or 0)
            when = datetime.fromtimestamp(float(f["ts"] or 0), timezone.utc).strftime("%H:%M:%S")
            x = f" (x{price / entry:,.4g} entry)" if entry > 0 and f["side"] == "sell" else ""
            line = (f"  {when}Z {str(f['reason'] or f['side']).replace('_', ' ')} @ {price:.3e}{x} · "
                    f"{float(f['tokens'] or 0):,.0f} tokens · {float(f['sol'] or 0):.4f} SOL")
            if f["side"] == "sell" and entry > 0 and (price > entry * factor or price < entry / factor):
                near = await self.db.fetchone(
                    "SELECT ts, side, sol, tokens, price_sol, pool FROM trades WHERE mint=? AND ABS(ts-?)<=5 "
                    "ORDER BY ABS(ts-?) LIMIT 1", [pos["mint"], f["ts"], f["ts"]])
                if near:
                    line += (f"\n    ⚠️ price spike: nearest stored trade {near['side']} {float(near['sol'] or 0):.4f} SOL / "
                             f"{float(near['tokens'] or 0):,.0f} tokens = {float(near['price_sol'] or 0):.3e} "
                             f"({near['pool'] or 'pump'})")
                else:
                    line += "\n    ⚠️ price spike: no stored trade within 5 s, so a curve read or DexScreener mark priced it"
            out.append(line)
        if warning:
            out.append(warning[1])
        return out

    async def _insider_warning(self, pos) -> tuple[float, str] | None:
        """When the insiders' net sales since this position's buy first reached INSIDER_EXIT_SUPPLY_PCT (the
        insider watch's warning, or its sale with INSIDER_EXIT=true), at what price against the entry."""
        rows = await self.db.fetchall("SELECT ts, side, price, cum_supply_pct FROM insider_trades WHERE position_id=? "
                                      "ORDER BY ts, id", [pos["id"]])
        first = next((r for r in rows if r["side"] == "sell"
                      and float(r["cum_supply_pct"] or 0) >= self.s.INSIDER_EXIT_SUPPLY_PCT), None)
        if first is None:
            return None
        entry = float(pos["entry_price"] or 0)
        when = datetime.fromtimestamp(float(first["ts"] or 0), timezone.utc).strftime("%H:%M:%S")
        x = f" (x{float(first['price']) / entry:,.4g} entry)" if entry > 0 and first["price"] else ""
        most = max(float(r["cum_supply_pct"] or 0) for r in rows)
        sells = sum(1 for r in rows if r["side"] == "sell")
        return float(first["ts"] or 0), (
            f"  {when}Z insider warning: insiders' net sales since the buy reached {float(first['cum_supply_pct']):.1f}% "
            f"of the supply{x}; at most {most:.1f}% while watched, {sells} insider sells")

    # --- polling -----------------------------------------------------------------------
    def _authorized(self, chat: str, cmd: str, who: str) -> bool:
        if chat == str(self.s.TELEGRAM_CHAT_ID).strip():
            return True
        if chat not in self._unknown_chats:
            self._unknown_chats.add(chat)
            log.warning("telegram: ignoring /%s from chat %s (%s); TELEGRAM_CHAT_ID is %s",
                        cmd, chat, who, self.s.TELEGRAM_CHAT_ID)
        return False

    async def handle_update(self, u: dict) -> tuple[str, dict | None] | None:
        """Reply for one update, or None when it is not a command for us."""
        cb = u.get("callback_query")
        if cb:
            msg = cb.get("message") or {}
            chat = str((msg.get("chat") or {}).get("id", ""))
            data = str(cb.get("data") or "").strip().lower()
            await self.tg.answer_callback(cb.get("id"))
            if not data or not self._authorized(chat, data, (cb.get("from") or {}).get("username") or "?"):
                return None
            head, _, rest = data.partition(" ")
            cmd = (head, rest.strip())
        else:
            msg = u.get("message") or {}
            chat = str((msg.get("chat") or {}).get("id", ""))
            cmd = parse_command(msg.get("text"))
            if cmd is None:
                return None
            if not self._authorized(chat, cmd[0], (msg.get("from") or {}).get("username")
                                    or (msg.get("chat") or {}).get("title") or "?"):
                return None
            if (msg.get("date") or 0) < self.started_at - STALE_COMMAND_S:
                log.info("telegram: skipping /%s sent before the bot started", cmd[0])
                return None
        try:
            return await self.answer(*cmd)
        except Exception:                         # a failing answer must not kill the loop
            log.exception("telegram /%s failed", cmd[0])
            return f"/{cmd[0]} failed; the log has the traceback", None

    async def _load_offset(self) -> None:
        """Start after the last update this bot has seen, even across a restart: Telegram only
        confirms an update on the next getUpdates, which a /restart it caused can pre-empt."""
        try:
            raw = await self.db.kv_get("telegram_offset")
            self.offset = int(raw) if raw else self.offset
        except Exception:
            log.exception("telegram offset could not be read")

    async def _save_offset(self) -> None:
        try:
            await self.db.kv_set("telegram_offset", str(self.offset))
        except Exception:
            log.exception("telegram offset could not be saved")

    async def poll_once(self) -> int:
        """One getUpdates round: answer every command, advance the offset. Returns replies sent."""
        sent = 0
        for u in await self.tg.get_updates(self.offset):
            self.offset = max(self.offset or 0, int(u.get("update_id", 0)) + 1)
            await self._save_offset()             # before acting: an update that restarts the bot must not replay
            reply = await self.handle_update(u)
            if reply:
                text, markup = reply
                if markup:
                    await self.tg.send(text, reply_markup=markup)
                else:
                    await self.tg.send_long(text)
                sent += 1
        return sent

    async def run(self, stop) -> None:
        await self._load_offset()
        await self.tg.set_commands(COMMANDS)
        log.info("telegram commands on for chat %s (/help lists them)", self.s.TELEGRAM_CHAT_ID)
        results_task = asyncio.create_task(self._results_loop(stop), name="telegram-results")
        attempt = 0
        try:
            while not stop.is_set():
                try:
                    t0 = now_s()
                    await self.poll_once()
                    attempt = 0
                    if now_s() - t0 < 1.0:            # Telegram answered at once: do not hammer it
                        await _sleep(stop, 1.0)
                except TelegramConflict:
                    if attempt == 0:
                        log.warning("telegram: another process is reading this bot's messages (HTTP 409); "
                                    "commands pause until it stops (a second bot, or preflight listing chat ids)")
                    await _sleep(stop, 5 + backoff_delay(attempt, 5.0, 60.0))
                    attempt += 1
                except (httpx.HTTPError, ValueError) as e:
                    log.warning("telegram getUpdates failed: %s", type(e).__name__)
                    await _sleep(stop, 1 + backoff_delay(attempt, 2.0, 60.0))
                    attempt += 1
        finally:
            results_task.cancel()
            await asyncio.gather(results_task, return_exceptions=True)

    async def _results_loop(self, stop) -> None:
        """Finished server actions arrive as files (the update that restarted the bot included)."""
        while not stop.is_set():
            try:
                await self.deliver_results()
            except Exception:                     # a bad result file must not stop the loop
                log.exception("delivering ops results failed")
            await _sleep(stop, RESULTS_POLL_S)


async def _sleep(stop, s: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=s)
    except asyncio.TimeoutError:
        pass
