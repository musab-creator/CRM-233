"""Portfolio limits and the STOP kill switch."""
from __future__ import annotations

from datetime import datetime, timezone

from .config import Settings


def kill_switch_active(s: Settings) -> bool:
    return s.path(s.STOP_FILE).exists()


def utc_midnight(ts: float) -> float:
    d = datetime.fromtimestamp(ts, timezone.utc)
    return d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


class RiskManager:
    """Max open positions, one position per creator wallet, daily loss cap (pauses until restart)."""

    def __init__(self, settings: Settings, started_at: float):
        self.s = settings
        self.started_at = started_at
        self.paused_reason: str | None = None

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
