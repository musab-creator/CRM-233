"""Spend ledgers for the LLM (daily, UTC) and X API (monthly, UTC). Persisted in SQLite."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from .db import Database
from .util import now_s


def utc_day(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else now_s(), timezone.utc).strftime("%Y-%m-%d")


def utc_month(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else now_s(), timezone.utc).strftime("%Y-%m")


def llm_cost_usd(input_tokens: int, output_tokens: int, cache_write: int, cache_read: int,
                 price_in: float, price_out: float) -> float:
    """Anthropic pricing: cache writes bill at 1.25x input, cache reads at 0.1x input."""
    return (input_tokens * price_in + cache_write * price_in * 1.25 + cache_read * price_in * 0.1
            + output_tokens * price_out) / 1_000_000


def pace_released(limit: float, burst_h: float | None, ts: float | None = None) -> float:
    """How much of a daily limit is released so far. Without pacing (burst_h None), all of it.
    With pacing it grows linearly through the UTC day, starting at `burst_h` hours' worth and
    reaching the full limit at midnight, so a busy first hour cannot leave the rest of the day
    with no evaluations. The limit itself is never exceeded."""
    if burst_h is None:
        return limit
    dt = datetime.fromtimestamp(ts if ts is not None else now_s(), timezone.utc)
    hours = dt.hour + dt.minute / 60 + dt.second / 3600
    return limit * min(1.0, (hours + burst_h) / 24)


class BudgetExceeded(Exception):
    pass


class Budget:
    def __init__(self, db: Database, kind: str, limit_usd: float, period: str, burst_h: float | None = None):
        assert period in ("day", "month")
        self.db, self.kind, self.limit, self.period = db, kind, limit_usd, period
        self.burst_h = burst_h if period == "day" else None  # pacing applies to daily budgets only
        self._lock = asyncio.Lock()
        self._reserved = 0.0  # in-flight worst-case reservations

    def _key(self) -> tuple[str, str]:
        return ("day", utc_day()) if self.period == "day" else ("month", utc_month())

    def released(self) -> float:
        return pace_released(self.limit, self.burst_h)

    async def spent(self) -> float:
        col, val = self._key()
        r = await self.db.fetchone(f"SELECT COALESCE(SUM(usd),0) AS s FROM ledger WHERE kind=? AND {col}=?",
                                   [self.kind, val])
        return float(r["s"]) if r else 0.0

    async def remaining(self) -> float:
        return self.released() - await self.spent() - self._reserved

    async def exhausted(self) -> bool:
        return await self.remaining() <= 0

    async def reserve(self, usd: float) -> None:
        """Hold a worst-case amount before calling; raises if it does not fit."""
        async with self._lock:
            if await self.remaining() < usd:
                raise BudgetExceeded(f"{self.kind} budget: {usd:.4f} needed, {await self.remaining():.4f} left")
            self._reserved += usd

    async def settle(self, reserved: float, actual: float, detail: str = "") -> None:
        async with self._lock:
            self._reserved = max(0.0, self._reserved - reserved)
            if actual > 0:
                await self.record(actual, detail)

    async def record(self, usd: float, detail: str = "") -> None:
        ts = now_s()
        await self.db.insert("ledger", {"kind": self.kind, "ts": ts, "day": utc_day(ts),
                                        "month": utc_month(ts), "usd": usd, "detail": detail[:300]})
