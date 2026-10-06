"""SOL/USD reference price, refreshed from DexScreener's wrapped-SOL pairs."""
from __future__ import annotations

import asyncio
import logging

log = logging.getLogger("bot.prices")


class SolPrice:
    def __init__(self, fetch, refresh_s: float = 60.0):
        self._fetch = fetch
        self.refresh_s = refresh_s
        self.value: float | None = None

    def get(self) -> float | None:
        return self.value

    async def refresh(self) -> float | None:
        try:
            v = await self._fetch()
            if v and v > 0:
                self.value = float(v)
        except Exception as e:
            log.warning("SOL/USD refresh failed: %s", e)
        return self.value

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.refresh()
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.refresh_s)
            except asyncio.TimeoutError:
                pass
