"""Spend ledgers for the LLM (daily, UTC) and X API (monthly, UTC). Persisted in SQLite."""
from __future__ import annotations

import asyncio
import math
import uuid
from dataclasses import dataclass
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
    if any(isinstance(n, bool) or not isinstance(n, int) or n < 0
           for n in (input_tokens, output_tokens, cache_write, cache_read)):
        raise ValueError("LLM usage must contain nonnegative integer token counts")
    if any(isinstance(p, bool) or not isinstance(p, (int, float)) or not math.isfinite(p) or p < 0
           for p in (price_in, price_out)):
        raise ValueError("LLM prices must be finite, nonnegative numbers")
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


@dataclass(frozen=True)
class Reservation:
    """An identity and billing period for one durable, worst-case hold."""

    id: str
    kind: str
    usd: float
    day: str
    month: str


def _money(value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("budget amounts must be finite, nonnegative numbers")
    return float(value)


class Budget:
    def __init__(self, db: Database, kind: str, limit_usd: float, period: str, burst_h: float | None = None):
        assert period in ("day", "month")
        self.db, self.kind, self.limit, self.period = db, kind, _money(limit_usd), period
        self.burst_h = burst_h if period == "day" else None  # pacing applies to daily budgets only
        self._lock = asyncio.Lock()
        self._pending: dict[str, Reservation] = {}  # compatibility for old settle(amount, ...) callers
        self._schema_connection = None

    async def _ensure_schema(self) -> None:
        if self._schema_connection is self.db.conn and self.db.conn is not None:
            return
        await self.db.execute(
            "CREATE TABLE IF NOT EXISTS budget_reservations ("
            "id TEXT PRIMARY KEY, kind TEXT NOT NULL, ts REAL NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, "
            "usd REAL NOT NULL CHECK(usd >= 0), status TEXT NOT NULL DEFAULT 'held' "
            "CHECK(status IN ('held','settled')), actual REAL, detail TEXT)"
        )
        await self.db.execute(
            "CREATE INDEX IF NOT EXISTS ix_budget_reservations ON budget_reservations(kind,status,day,month)"
        )
        self._schema_connection = self.db.conn

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
        await self._ensure_schema()
        col, val = self._key()
        return await self._remaining_for(col, val, self.released())

    async def _remaining_for(self, col: str, val: str, released: float) -> float:
        # One read gives a consistent ledger + holds snapshot, including other instances.
        r = await self.db.fetchone(
            f"SELECT (SELECT COALESCE(SUM(usd),0) FROM ledger WHERE kind=? AND {col}=?) + "
            f"(SELECT COALESCE(SUM(usd),0) FROM budget_reservations WHERE kind=? AND {col}=? "
            "AND status='held') AS used", [self.kind, val, self.kind, val]
        )
        return released - float(r["used"])

    async def exhausted(self) -> bool:
        return await self.remaining() <= 0

    async def reserve(self, usd: float) -> Reservation:
        """Persist a worst-case hold before calling; SQLite enforces the cap across instances.

        A crash leaves the hold in place. It must not be automatically refunded: the remote
        service may have billed a request whose response the process never received.
        """
        usd = _money(usd)
        async with self._lock:
            await self._ensure_schema()
            ts = now_s()
            reservation = Reservation(uuid.uuid4().hex, self.kind, usd, utc_day(ts), utc_month(ts))
            col, val = ("day", reservation.day) if self.period == "day" else ("month", reservation.month)
            released = pace_released(self.limit, self.burst_h, ts)
            async with self.db.transaction():
                # The entire check is inside the INSERT, so two SQLite connections cannot
                # both reserve against the same old balance, even with deferred transactions.
                await self.db.execute(
                    "INSERT INTO budget_reservations(id,kind,ts,day,month,usd) SELECT ?,?,?,?,?,? WHERE "
                    f"? >= ? + (SELECT COALESCE(SUM(usd),0) FROM ledger WHERE kind=? AND {col}=?) + "
                    f"(SELECT COALESCE(SUM(usd),0) FROM budget_reservations WHERE kind=? AND {col}=? "
                    "AND status='held')",
                    [reservation.id, self.kind, ts, reservation.day, reservation.month, usd,
                     released, usd, self.kind, val, self.kind, val]
                )
                row = await self.db.fetchone("SELECT id FROM budget_reservations WHERE id=?", [reservation.id])
                if row is None:
                    left = await self._remaining_for(col, val, released)
                    raise BudgetExceeded(f"{self.kind} budget: {usd:.4f} needed, {left:.4f} left")
            self._pending[reservation.id] = reservation
            return reservation

    async def settle(self, reserved: Reservation | float, actual: float, detail: str = "") -> None:
        """Replace one hold with actual spend, atomically and in its original billing period.

        Returned Reservation objects should be used by new callers. Amount-only settlement
        remains available to old callers, but can settle only this instance's own holds.
        """
        actual = _money(actual)
        async with self._lock:
            await self._ensure_schema()
            if not isinstance(reserved, Reservation):
                amount = _money(reserved)
                reserved = next((r for r in self._pending.values() if r.usd == amount), None)
                if reserved is None:
                    raise ValueError("no matching reservation owned by this budget instance")
            if reserved.kind != self.kind:
                raise ValueError("reservation belongs to a different budget")
            async with self.db.transaction():
                row = await self.db.fetchone("SELECT * FROM budget_reservations WHERE id=? AND kind=?",
                                            [reserved.id, self.kind])
                if row is None:
                    raise ValueError("unknown budget reservation")
                if row["status"] == "settled":
                    if float(row["actual"]) != actual:
                        raise ValueError("reservation already settled to a different amount")
                    self._pending.pop(reserved.id, None)
                    return
                if actual > 0:
                    await self.db.insert("ledger", {"kind": self.kind, "ts": row["ts"], "day": row["day"],
                                                   "month": row["month"], "usd": actual, "detail": detail[:300]})
                await self.db.update("budget_reservations", "id", reserved.id,
                                     {"status": "settled", "actual": actual, "detail": detail[:300]})
            self._pending.pop(reserved.id, None)

    async def record(self, usd: float, detail: str = "") -> None:
        usd = _money(usd)
        ts = now_s()
        await self.db.insert("ledger", {"kind": self.kind, "ts": ts, "day": utc_day(ts),
                                        "month": utc_month(ts), "usd": usd, "detail": detail[:300]})
