"""Paper fill math. Prices are SOL per token.

Entry, for `sol_in` SOL at observed price P:
    exec_price = P * (1 + entry_slippage)
    fee_sol    = sol_in * (pump.fun fee + PumpPortal fee)
    tokens     = (sol_in - fee_sol) / exec_price
    cost_sol   = sol_in + network_fee
Exit, for `tokens` at observed price P:
    exec_price = P * (1 - exit_slippage)
    gross      = tokens * exec_price
    fee_sol    = gross * (pump.fun fee + PumpPortal fee)
    proceeds   = gross - fee_sol - network_fee
"""
from __future__ import annotations

from dataclasses import dataclass

from .config import Settings


@dataclass
class Fill:
    side: str
    price: float       # observed trade price
    exec_price: float  # after slippage
    tokens: float
    sol: float         # SOL spent (buy, incl. network fee) or received (sell, net)
    fee_sol: float     # protocol + PumpPortal + network
    tx_sig: str | None = None


def _fee_rate(s: Settings) -> float:
    return (s.PUMPFUN_FEE_PCT + s.PUMPPORTAL_FEE_PCT) / 100


def entry_fill(sol_in: float, price: float, s: Settings) -> Fill:
    if sol_in <= 0 or price <= 0:
        raise ValueError("sol_in and price must be positive")
    exec_price = price * (1 + s.ENTRY_SLIPPAGE_PCT / 100)
    fee = sol_in * _fee_rate(s)
    tokens = (sol_in - fee) / exec_price
    return Fill("buy", price, exec_price, tokens, sol_in + s.NETWORK_FEE_SOL, fee + s.NETWORK_FEE_SOL)


def exit_fill(tokens: float, price: float, s: Settings) -> Fill:
    if tokens <= 0 or price <= 0:
        raise ValueError("tokens and price must be positive")
    exec_price = price * (1 - s.EXIT_SLIPPAGE_PCT / 100)
    gross = tokens * exec_price
    fee = gross * _fee_rate(s)
    return Fill("sell", price, exec_price, tokens, gross - fee - s.NETWORK_FEE_SOL, fee + s.NETWORK_FEE_SOL)


def mark_to_market(tokens: float, price: float, s: Settings) -> float:
    """Net SOL the remaining tokens would fetch right now (liquidation value)."""
    if tokens <= 0 or price <= 0:
        return 0.0
    return exit_fill(tokens, price, s).sol


class PaperExecutor:
    mode = "paper"

    def __init__(self, settings: Settings):
        self.s = settings

    async def buy(self, mint: str, sol_in: float, price: float) -> Fill:
        return entry_fill(sol_in, price, self.s)

    async def sell(self, mint: str, tokens: float, price: float, fraction: float = 1.0) -> Fill:
        return exit_fill(tokens, price, self.s)
