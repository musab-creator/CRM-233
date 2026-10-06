"""SOL/USD reference price, refreshed from DexScreener's wrapped-SOL pairs.

One wrong reading matters: the price sizes positions, converts the bankroll and feeds the
curve-depth liquidity rule and the emergency exit. Live data has shown a single $166 tick
between readings of $121, so a reading far from the last accepted one is held back until it
repeats: a real crash or spike shows up again on the next readings, a glitch does not.
"""
from __future__ import annotations

import asyncio
import logging

log = logging.getLogger("bot.prices")

MAX_JUMP = 0.20     # a reading this far from the last accepted one ...
CONFIRM_READS = 3   # ... is accepted only after this many such readings in a row


class SolPrice:
    def __init__(self, fetch, refresh_s: float = 60.0, max_jump: float = MAX_JUMP,
                 confirm_reads: int = CONFIRM_READS):
        self._fetch = fetch
        self.refresh_s = refresh_s
        self.max_jump, self.confirm_reads = max_jump, confirm_reads
        self.value: float | None = None
        self.outliers: list[float] = []  # consecutive readings held back so far

    def get(self) -> float | None:
        return self.value

    def accept(self, v: float) -> bool:
        """Apply one reading. False means it was held back as an outlier."""
        v = float(v)
        if self.value is None or abs(v / self.value - 1) <= self.max_jump:
            self.value, self.outliers = v, []
            return True
        self.outliers.append(v)
        if len(self.outliers) >= self.confirm_reads:  # it keeps coming back: the market really moved
            log.warning("SOL/USD moved from %.2f to %.2f over %d readings: accepted", self.value, v, len(self.outliers))
            self.value, self.outliers = v, []
            return True
        log.warning("SOL/USD reading %.2f is %+.0f%% from %.2f: ignored until it repeats (%d/%d)",
                    v, (v / self.value - 1) * 100, self.value, len(self.outliers), self.confirm_reads)
        return False

    async def refresh(self) -> float | None:
        try:
            v = await self._fetch()
            if v and v > 0:
                self.accept(v)
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
