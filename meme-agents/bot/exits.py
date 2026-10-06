"""Exit rules. Pure functions, no I/O, no LLM.

Triggers compare the raw observed trade price with the raw entry fill price (see PLAN.md,
assumption 3). Order of precedence: emergency > time stop > stop loss > take profit > trailing.
"""
from __future__ import annotations

from dataclasses import dataclass

from .config import Settings


@dataclass
class ExitSignal:
    reason: str
    fraction: float  # of the *remaining* tokens to sell


@dataclass
class ExitState:
    entry_price: float
    peak_price: float
    tp_done: bool
    opened_at: float
    entry_liq_usd: float | None = None


def check_exit(p: ExitState, price: float | None, now: float, s: Settings,
               liq_usd: float | None = None, rug_danger: bool = False) -> ExitSignal | None:
    if rug_danger:
        return ExitSignal("emergency_rugcheck_danger", 1.0)
    if liq_usd is not None and p.entry_liq_usd and p.entry_liq_usd > 0:
        if liq_usd <= p.entry_liq_usd * (1 - s.EMERGENCY_LIQ_DROP_PCT / 100):
            return ExitSignal("emergency_liquidity_drop", 1.0)
    if now - p.opened_at >= s.TIME_STOP_HOURS * 3600:
        return ExitSignal("time_stop", 1.0)
    if price is None or price <= 0:
        return None
    if price <= p.entry_price * (1 - s.STOP_LOSS_PCT / 100):
        return ExitSignal("stop_loss", 1.0)
    if not p.tp_done:
        if price >= p.entry_price * (1 + s.TAKE_PROFIT_PCT / 100):
            return ExitSignal("take_profit", s.TAKE_PROFIT_SELL_FRACTION)
        return None
    if price <= p.peak_price * (1 - s.TRAILING_STOP_PCT / 100):
        return ExitSignal("trailing_stop", 1.0)
    return None
