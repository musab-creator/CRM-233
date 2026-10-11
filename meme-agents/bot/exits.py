"""Exit rules. Pure functions, no I/O, no LLM.

Triggers compare the raw observed trade price with the raw entry fill price (see PLAN.md,
assumption 3). Order of precedence: emergency > time stop > stop loss > take profit > trailing.

The trailing stop runs after the take-profit, and before it once the price has been TRAILING_ARM_PCT
above the entry (0 turns that off). 11 Oct: 69% of 1,836 shadows left by the stop loss or the
liquidity rule, at a median -41%, and the losing shadows had often been well up first; a coin that
ran +30% and gives it back now sells about TRAILING_STOP_PCT under its peak, not at the stop loss.
The seven coins that doubled since the dips were recorded never dipped below -20% first.

A position created with a runner policy (RUNNER_* settings) keeps part of a winner: after its
take-profit, the core's trailing or time stop sells all but RUNNER_FRACTION of the original
tokens, provided the sales so far plus that one cover the entry cost. The runner left over has
no trailing or time stop, and no stop loss unless RUNNER_STOP_LOSS is on (its cost is already
covered); it exits on an emergency, its price target or its hold limit.
"""
from __future__ import annotations

from dataclasses import dataclass

from .config import Settings
from .paper import mark_to_market

# Full exits of a runner policy: each one replaces a pending core sale that would keep a runner.
RUNNER_FULL_EXITS = ("stop_loss", "runner_target", "runner_time_stop", "runner_unfunded")


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
    runner_fraction: float = 0.0          # 0: this position has no runner policy
    runner_target_multiple: float = 300.0
    runner_max_hold_hours: float = 168.0
    runner_active: bool = False           # the core is sold; what is left is the runner
    tokens_initial: float = 0.0
    tokens_remaining: float = 0.0
    cost_sol: float = 0.0
    proceeds_sol: float = 0.0
    last_price: float | None = None


def _core_or_full(p: ExitState, price: float | None, s: Settings, reason: str) -> ExitSignal:
    """The core's trailing or time stop. With a runner policy and the take-profit done, sell all but
    the runner when the sales so far plus this one (valued at the mark, after costs) cover the entry
    cost; otherwise everything. The live receipt is checked again before the runner is kept."""
    mark = price or p.last_price
    keep = p.tokens_initial * p.runner_fraction
    if p.runner_fraction > 0 and p.tp_done and mark and mark > 0 and p.tokens_remaining > keep > 0:
        sell = p.tokens_remaining - keep
        if p.proceeds_sol + mark_to_market(sell, mark, s) >= p.cost_sol:
            return ExitSignal("core_" + reason, sell / p.tokens_remaining)
    return ExitSignal(reason, 1.0)


def check_exit(p: ExitState, price: float | None, now: float, s: Settings,
               liq_usd: float | None = None, rug_danger: bool = False) -> ExitSignal | None:
    if rug_danger:
        return ExitSignal("emergency_rugcheck_danger", 1.0)
    if liq_usd is not None and p.entry_liq_usd and p.entry_liq_usd > 0:
        if liq_usd <= p.entry_liq_usd * (1 - s.EMERGENCY_LIQ_DROP_PCT / 100):
            return ExitSignal("emergency_liquidity_drop", 1.0)
    if p.runner_active:
        if s.RUNNER_STOP_LOSS and price is not None and 0 < price <= p.entry_price * (1 - s.STOP_LOSS_PCT / 100):
            return ExitSignal("stop_loss", 1.0)
        if now - p.opened_at >= p.runner_max_hold_hours * 3600:
            return ExitSignal("runner_time_stop", 1.0)
        if price is not None and price >= p.entry_price * p.runner_target_multiple:
            return ExitSignal("runner_target", 1.0)
        return None
    if now - p.opened_at >= s.TIME_STOP_HOURS * 3600:
        return _core_or_full(p, price, s, "time_stop")
    if price is None or price <= 0:
        return None
    if price <= p.entry_price * (1 - s.STOP_LOSS_PCT / 100):
        return ExitSignal("stop_loss", 1.0)
    if not p.tp_done:
        if price >= p.entry_price * (1 + s.TAKE_PROFIT_PCT / 100):
            return ExitSignal("take_profit", s.TAKE_PROFIT_SELL_FRACTION)
        if (s.TRAILING_ARM_PCT > 0 and p.peak_price >= p.entry_price * (1 + s.TRAILING_ARM_PCT / 100)
                and price <= p.peak_price * (1 - s.TRAILING_STOP_PCT / 100)):
            return ExitSignal("early_trailing_stop", 1.0)   # armed: the coin ran, then fell back from its peak
        return None
    if p.runner_fraction > 0 and price >= p.entry_price * p.runner_target_multiple:
        return ExitSignal("runner_target", 1.0)       # everything left reached the runner's target
    if price <= p.peak_price * (1 - s.TRAILING_STOP_PCT / 100):
        return _core_or_full(p, price, s, "trailing_stop")
    return None
