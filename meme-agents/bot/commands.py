"""Telegram commands: ask the bot for its status, the hour's digest or the report from the
chat, and flip the STOP kill switch, without logging in to the server.

Only messages from TELEGRAM_CHAT_ID are answered; anything else is logged and ignored. The
loop long-polls `getUpdates`, so it needs no open port.
"""
from __future__ import annotations

import asyncio
import logging

import httpx

from .config import Settings
from .db import Database
from .digest import hour_start, hourly_digest
from .report import build_report, render_text
from .risk import kill_switch_active
from .status import build_status, health
from .telegram import Telegram, TelegramConflict
from .util import backoff_delay, now_s

log = logging.getLogger("bot.commands")

COMMANDS: list[tuple[str, str]] = [
    ("status", "what the bot is doing right now"),
    ("digest", "this hour so far: trades, open positions, spend"),
    ("report", "the full report, all time and today"),
    ("stop", "kill switch: no new entries, close every position"),
    ("resume", "remove the kill switch"),
    ("help", "this list"),
]
STALE_COMMAND_S = 120   # commands sent while the bot was down are not answered on restart


def parse_command(text: str | None) -> tuple[str, str] | None:
    """('status', 'rest of the line') for '/status@my_bot rest', None for anything else."""
    if not text or not text.startswith("/"):
        return None
    head, _, rest = text[1:].partition(" ")
    name = head.split("@", 1)[0].strip().lower()
    return (name, rest.strip()) if name else None


class TelegramCommands:
    def __init__(self, tg: Telegram, db: Database, s: Settings):
        self.tg, self.db, self.s = tg, db, s
        self.offset: int | None = None
        self.started_at = now_s()
        self._unknown_chats: set[str] = set()

    # --- answers ---------------------------------------------------------------------
    async def answer(self, name: str, arg: str) -> str:
        if name in ("start", "help"):
            return "meme-agents commands:\n" + "\n".join(f"/{c}  {d}" for c, d in COMMANDS)
        if name == "status":
            state, line = await health(self.db, self.s)
            return f"{state}: {line}\n\n" + await build_status(self.db, self.s)
        if name == "digest":
            now = now_s()
            text, _ = await hourly_digest(self.db, self.s, hour_start(now), now)
            return text
        if name == "report":
            return render_text(await build_report(self.db, self.s))
        if name == "stop":
            path = self.s.path(self.s.STOP_FILE)
            if kill_switch_active(self.s):
                return f"kill switch already on ({path}): no new entries, positions closing"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("stopped from Telegram\n")
            log.warning("kill switch set from Telegram: %s", path)
            return f"kill switch ON ({path}): no new entries, every position is being closed. /resume turns it off"
        if name == "resume":
            path = self.s.path(self.s.STOP_FILE)
            if not kill_switch_active(self.s):
                return "kill switch is not on; entries are allowed"
            path.unlink()
            log.warning("kill switch removed from Telegram: %s", path)
            return "kill switch OFF: new entries allowed again"
        return f"unknown command /{name}. /help lists them"

    # --- polling -----------------------------------------------------------------------
    async def handle_update(self, u: dict) -> str | None:
        """Reply text for one update, or None when it is not a command for us."""
        msg = u.get("message") or {}
        chat = str((msg.get("chat") or {}).get("id", ""))
        cmd = parse_command(msg.get("text"))
        if cmd is None:
            return None
        if chat != str(self.s.TELEGRAM_CHAT_ID).strip():
            if chat not in self._unknown_chats:
                self._unknown_chats.add(chat)
                who = (msg.get("from") or {}).get("username") or (msg.get("chat") or {}).get("title") or "?"
                log.warning("telegram: ignoring /%s from chat %s (%s); TELEGRAM_CHAT_ID is %s",
                            cmd[0], chat, who, self.s.TELEGRAM_CHAT_ID)
            return None
        if (msg.get("date") or 0) < self.started_at - STALE_COMMAND_S:
            log.info("telegram: skipping /%s sent before the bot started", cmd[0])
            return None
        try:
            return await self.answer(*cmd)
        except Exception:                         # a failing answer must not kill the loop
            log.exception("telegram /%s failed", cmd[0])
            return f"/{cmd[0]} failed; the log has the traceback"

    async def poll_once(self) -> int:
        """One getUpdates round: answer every command, advance the offset. Returns replies sent."""
        sent = 0
        for u in await self.tg.get_updates(self.offset):
            self.offset = max(self.offset or 0, int(u.get("update_id", 0)) + 1)
            reply = await self.handle_update(u)
            if reply:
                await self.tg.send_long(reply)
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
