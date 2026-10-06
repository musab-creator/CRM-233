"""Telegram commands: the bot's control panel from the chat, without logging in to the server.

Read: /status, /digest, /report, /trades, /log, /settings. Act: /pause and /resume (entries
only), /stop (the STOP kill switch: no entries, close every position). /panel shows the same
as buttons; the destructive ones ask for a confirmation tap. Only messages from
TELEGRAM_CHAT_ID are answered; anything else is logged and ignored. The loop long-polls
`getUpdates`, so it needs no open port. Nothing here can change a setting, unlock live mode
or send a transaction: settings change in `.env` on the server, and the bot runs with its
code and `.env` read-only.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque

import httpx

from .config import Settings
from .db import Database
from .digest import fmt_hold, hour_start, hourly_digest, usd
from .report import build_report, render_text
from .risk import kill_switch_active
from .status import build_status, health
from .telegram import Telegram, TelegramConflict
from .util import backoff_delay, now_s

log = logging.getLogger("bot.commands")

COMMANDS: list[tuple[str, str]] = [
    ("panel", "buttons for everything below"),
    ("status", "what the bot is doing right now"),
    ("digest", "this hour so far: trades, open positions, spend"),
    ("report", "the full report, all time and today"),
    ("trades", "the last closed trades"),
    ("log", "the last lines of the bot's log"),
    ("settings", "the current settings (read-only)"),
    ("pause", "no new entries; open positions keep running"),
    ("resume", "allow entries again (clears pause and the kill switch)"),
    ("stop", "kill switch: no new entries, close every position"),
    ("help", "this list"),
]
PAUSE_REASON = "paused from Telegram (/resume to continue)"
STALE_COMMAND_S = 120   # commands sent while the bot was down are not answered on restart
CONFIRM = ("stop",)     # panel buttons that ask before acting
SHOWN_SETTINGS = (
    "MODE", "LLM_MODEL", "LLM_DAILY_BUDGET_USD", "LLM_BUDGET_PACING", "LLM_CONCURRENCY", "X_MONTHLY_BUDGET_USD",
    "BANKROLL_USD", "MAX_OPEN_POSITIONS", "POSITION_MIN_USD", "POSITION_MAX_USD", "DAILY_LOSS_CAP_PCT",
    "TRAILING_STOP_PCT", "TIME_STOP_HOURS", "PF_MIN_AGE_MIN", "PF_MAX_AGE_MIN", "PF_MIN_UNIQUE_BUYERS",
    "PF_MIN_NET_INFLOW_SOL", "PF_MAX_TOP10_PCT", "PF_MIN_LIQUIDITY_USD", "CONSENSUS_MIN_MEAN_CONFIDENCE",
    "TRIAGE_ENABLED", "TRIAGE_MIN_CONFIDENCE", "VETO_ENABLED", "VETO_MIN_CONFIDENCE", "REGIME_ENABLED",
    "REGIME_REFRESH_MIN", "TELEGRAM_DIGEST", "HELIUS_MONTHLY_CREDITS",
)
PANEL = [[("Status", "status"), ("Digest", "digest"), ("Report", "report")],
         [("Trades", "trades"), ("Log", "log"), ("Settings", "settings")],
         [("Pause", "pause"), ("Resume", "resume"), ("Stop", "confirm:stop")]]


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
                    keyboard([[("Yes, " + what, what), ("Cancel", "cancel")]]))
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
        if name == "trades":
            return await self._trades(10), None
        if name == "log":
            n = int(arg) if arg.isdigit() else 30
            lines = tail_lines(self.s.path(self.s.LOG_FILE), max(5, min(80, n))) if self.s.LOG_FILE else []
            return ("".join(lines).rstrip() or "no log file"), None
        if name == "settings":
            vals = [f"{k}={getattr(self.s, k)}" for k in SHOWN_SETTINGS if hasattr(self.s, k)]
            return "current settings (change them in .env on the server, then restart):\n" + "\n".join(vals), None
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
                return notes[0] + " (a loss-cap pause ends with a restart of the service)", None
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
        return f"unknown command /{name}. /help lists them", None

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
            cmd = (data, "")
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

    async def poll_once(self) -> int:
        """One getUpdates round: answer every command, advance the offset. Returns replies sent."""
        sent = 0
        for u in await self.tg.get_updates(self.offset):
            self.offset = max(self.offset or 0, int(u.get("update_id", 0)) + 1)
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
        await self.tg.set_commands(COMMANDS)
        log.info("telegram commands on for chat %s (/help lists them)", self.s.TELEGRAM_CHAT_ID)
        attempt = 0
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


async def _sleep(stop, s: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=s)
    except asyncio.TimeoutError:
        pass
