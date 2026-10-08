"""Optional Telegram alerts and commands. No-op without TELEGRAM_BOT_TOKEN.

Sends entries, exits, the hourly digest and the daily summary; `get_updates` long-polls the
bot's incoming messages for `bot.commands`.
"""
from __future__ import annotations

import logging

import httpx

log = logging.getLogger("bot.telegram")

MAX_MESSAGE = 4000   # Telegram's limit is 4096 characters per message


class TelegramConflict(Exception):
    """Another process is reading this bot's updates (HTTP 409): a second bot, or `preflight`."""


def split_message(text: str, limit: int = MAX_MESSAGE) -> list[str]:
    """Split on line breaks into pieces Telegram accepts, so long reports arrive whole."""
    parts: list[str] = []
    cur = ""
    for line in text.split("\n"):
        while len(line) > limit:              # one enormous line: hard cut
            parts.append(line[:limit])
            line = line[limit:]
        if cur and len(cur) + 1 + len(line) > limit:
            parts.append(cur)
            cur = line
        else:
            cur = f"{cur}\n{line}" if cur else line
    if cur or not parts:
        parts.append(cur)
    return parts


class Telegram:
    def __init__(self, client: httpx.AsyncClient, token: str, chat_id: str):
        self.c = client
        self.token = token
        self.chat_id = chat_id

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.chat_id)

    def _url(self, method: str) -> str:
        return f"https://api.telegram.org/bot{self.token}/{method}"

    async def send(self, text: str, reply_markup: dict | None = None) -> bool:
        """True when Telegram accepted the message (False when disabled, refused or unreachable)."""
        if not self.enabled:
            return False
        body: dict = {"chat_id": self.chat_id, "text": text[:MAX_MESSAGE], "disable_web_page_preview": True}
        if reply_markup:
            body["reply_markup"] = reply_markup
        try:
            r = await self.c.post(self._url("sendMessage"), json=body, timeout=10)
            if r.status_code != 200:
                log.warning("telegram send failed: HTTP %s", r.status_code)
                return False
        except httpx.HTTPError as e:
            log.warning("telegram send failed: %s", type(e).__name__)
            return False
        return True

    async def send_long(self, text: str) -> bool:
        """A text longer than one message, in order. True when every part was accepted."""
        ok = True
        for part in split_message(text):
            ok = await self.send(part) and ok
        return ok

    async def get_updates(self, offset: int | None, timeout_s: int = 25) -> list[dict]:
        """Long-poll incoming messages. Raises TelegramConflict on HTTP 409, httpx.HTTPError
        on network trouble; other HTTP errors return an empty list after a log line."""
        params: dict = {"timeout": timeout_s, "allowed_updates": '["message","callback_query"]'}
        if offset is not None:
            params["offset"] = offset
        r = await self.c.get(self._url("getUpdates"), params=params, timeout=timeout_s + 10)
        if r.status_code == 409:
            raise TelegramConflict("another getUpdates poller is running")
        if r.status_code != 200:
            log.warning("telegram getUpdates HTTP %s", r.status_code)
            return []
        try:
            body = r.json() or {}
        except ValueError:
            return []
        return body.get("result") or [] if body.get("ok") else []

    async def answer_callback(self, callback_id: str | None, text: str = "") -> None:
        """Dismiss a button's loading state (answerCallbackQuery). Best effort."""
        if not callback_id:
            return
        try:
            await self.c.post(self._url("answerCallbackQuery"), json={"callback_query_id": callback_id, "text": text},
                              timeout=10)
        except httpx.HTTPError as e:
            log.warning("telegram answerCallbackQuery failed: %s", type(e).__name__)

    async def set_commands(self, commands: list[tuple[str, str]]) -> None:
        """The "/" menu in the chat (setMyCommands). Best effort."""
        try:
            await self.c.post(self._url("setMyCommands"),
                              json={"commands": [{"command": c, "description": d} for c, d in commands]}, timeout=10)
        except httpx.HTTPError as e:
            log.warning("telegram setMyCommands failed: %s", type(e).__name__)
