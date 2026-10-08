"""Portfolio limits and the STOP kill switch."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from .config import Settings


def kill_switch_active(s: Settings) -> bool:
    return s.path(s.STOP_FILE).exists()


def utc_midnight(ts: float) -> float:
    d = datetime.fromtimestamp(ts, timezone.utc)
    return d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


class RiskManager:
    """Max open positions, one position per creator wallet, daily loss cap (pauses until restart)."""

    def __init__(self, settings: Settings, started_at: float, db=None):
        self.s = settings
        self.started_at = started_at
        self.paused_reason: str | None = None
        self.db = db

    async def startup(self) -> None:
        """An automatic crash restart must not clear the operator's loss pause."""
        if self.db is None:
            return
        raw = await self.db.kv_get(f"risk_state:{self.s.MODE}")
        if raw:
            previous = json.loads(raw)
            if not previous.get("clean_stop", False):
                self.started_at = min(self.started_at, float(previous["started_at"]))
                reason = previous.get("paused_reason")
                if isinstance(reason, str) and reason.startswith("daily loss cap hit:"):
                    self.paused_reason = reason
        await self.persist()

    async def persist(self, *, clean_stop: bool = False) -> None:
        if self.db is not None:
            await self.db.kv_set(f"risk_state:{self.s.MODE}", json.dumps({
                "started_at": self.started_at, "paused_reason": self.paused_reason,
                "clean_stop": clean_stop,
            }))

    async def shutdown(self, *, clean_stop: bool) -> None:
        await self.persist(clean_stop=clean_stop)

    def loss_window_start(self, now: float) -> float:
        return max(utc_midnight(now), self.started_at)

    def daily_loss_cap_usd(self) -> float:
        return self.s.BANKROLL_USD * self.s.DAILY_LOSS_CAP_PCT / 100

    def register_realized(self, realized_today_usd: float) -> None:
        if realized_today_usd <= -self.daily_loss_cap_usd() and not self.paused_reason:
            self.paused_reason = (f"daily loss cap hit: {realized_today_usd:.2f} USD <= "
                                  f"-{self.daily_loss_cap_usd():.2f} USD; restart to resume")

    def can_open(self, creator: str, open_positions: list[dict], cash_sol: float, need_sol: float) -> tuple[bool, str]:
        if kill_switch_active(self.s):
            return False, "kill switch (STOP file) present"
        if self.paused_reason:
            return False, self.paused_reason
        active = [p for p in open_positions if p["status"] in ("pending", "open")]
        if len(active) >= self.s.MAX_OPEN_POSITIONS:
            return False, f"max open positions ({self.s.MAX_OPEN_POSITIONS})"
        if creator and sum(1 for p in active if p.get("creator") == creator) >= self.s.MAX_POSITIONS_PER_CREATOR:
            return False, "already holding a position from this creator wallet"
        if need_sol > cash_sol:
            return False, f"insufficient bankroll ({cash_sol:.4f} SOL < {need_sol:.4f} SOL)"
        return True, "ok"
