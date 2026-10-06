"""Optional Telegram alerts (entries, exits, daily summary). No-op without TELEGRAM_BOT_TOKEN."""
from __future__ import annotations

import logging

import httpx

log = logging.getLogger("bot.telegram")


class Telegram:
    def __init__(self, client: httpx.AsyncClient, token: str, chat_id: str):
        self.c = client
        self.token = token
        self.chat_id = chat_id

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.chat_id)

    async def send(self, text: str) -> None:
        if not self.enabled:
            return
        try:
            r = await self.c.post(f"https://api.telegram.org/bot{self.token}/sendMessage",
                                  json={"chat_id": self.chat_id, "text": text[:4000],
                                        "disable_web_page_preview": True}, timeout=10)
            if r.status_code != 200:
                log.warning("telegram send failed: HTTP %s", r.status_code)
        except httpx.HTTPError as e:
            log.warning("telegram send failed: %s", type(e).__name__)
