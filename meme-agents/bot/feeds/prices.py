"""SOL/USD reference price, refreshed from DexScreener's wrapped-SOL pairs, with CoinGecko as the
fallback when DexScreener answers with no pair at all (it did so for a GitHub runner's shared
address twice in a row on 2026-10-07).

One wrong reading matters: the price sizes positions, converts the bankroll and feeds the
curve-depth liquidity rule and the emergency exit. Live data has shown a single $166 tick
between readings of $121, so a reading far from the last accepted one is held back until it
repeats: a real crash or spike shows up again on the next readings, a glitch does not.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque

log = logging.getLogger("bot.prices")

HISTORY_S = 24 * 3600

MAX_JUMP = 0.20     # a reading this far from the last accepted one ...
CONFIRM_READS = 3   # ... is accepted only after this many such readings in a row


async def coingecko_sol_usd(http, url: str) -> float | None:
    """CoinGecko's free simple-price endpoint: {"solana": {"usd": 115.9}}."""
    from .http import request_json
    data = await request_json(http, "GET", url, retries=1, timeout=10)
    try:
        v = float(((data or {}).get("solana") or {}).get("usd") or 0)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def chained(*fetchers):
    """A price fetch that tries each source in turn: the first positive reading wins, a source
    that returns nothing or raises hands over to the next. Returns None only when all fail; the
    last error is re-raised only if no source answered at all."""
    async def fetch() -> float | None:
        error = None
        for i, f in enumerate(fetchers):
            try:
                v = await f()
            except Exception as e:  # noqa: BLE001 - any source failure means "try the next"
                error = e
                log.warning("SOL/USD source %d failed: %s", i, e)
                continue
            if v:
                if i:
                    log.info("SOL/USD %.2f from fallback source %d", v, i)
                return v
        if error is not None:
            raise error
        return None
    return fetch


class SolPrice:
    def __init__(self, fetch, refresh_s: float = 60.0, max_jump: float = MAX_JUMP,
                 confirm_reads: int = CONFIRM_READS):
        self._fetch = fetch
        self.refresh_s = refresh_s
        self.max_jump, self.confirm_reads = max_jump, confirm_reads
        self.value: float | None = None
        self.outliers: list[float] = []  # consecutive readings held back so far
        self.history: deque[tuple[float, float]] = deque()  # (ts, accepted value), last 24 h

    def get(self) -> float | None:
        return self.value

    def _set(self, v: float, now: float | None = None) -> None:
        now = time.time() if now is None else now
        self.value, self.outliers = v, []
        self.history.append((now, v))
        while self.history and self.history[0][0] < now - HISTORY_S:
            self.history.popleft()

    def at(self, ts: float) -> float | None:
        """The accepted price in force at `ts` (the last reading at or before it), or None."""
        best = None
        for t, v in self.history:
            if t <= ts:
                best = v
            else:
                break
        return best

    def change_pct(self, seconds_ago: float, now: float | None = None) -> float | None:
        now = time.time() if now is None else now
        then = self.at(now - seconds_ago)
        return round((self.value / then - 1) * 100, 2) if then and self.value else None

    def accept(self, v: float, now: float | None = None) -> bool:
        """Apply one reading. False means it was held back as an outlier."""
        v = float(v)
        if self.value is None or abs(v / self.value - 1) <= self.max_jump:
            self._set(v, now)
            return True
        self.outliers.append(v)
        if len(self.outliers) >= self.confirm_reads:  # it keeps coming back: the market really moved
            log.warning("SOL/USD moved from %.2f to %.2f over %d readings: accepted", self.value, v, len(self.outliers))
            self._set(v, now)
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
