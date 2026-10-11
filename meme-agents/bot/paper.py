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
network_fee is what a live transaction pays: the priority fee sent with it (PRIORITY_FEE_SOL, or
URGENT_PRIORITY_FEE_SOL for an urgent sale) plus the 5,000-lamport signature fee.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import isfinite

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
    remaining_tokens: float | None = None  # confirmed live receipt holdings, never estimated


SIGNATURE_FEE_SOL = 0.000005      # Solana's base fee, 5,000 lamports per signature


def _fee_rate(s: Settings) -> float:
    return (s.PUMPFUN_FEE_PCT + s.PUMPPORTAL_FEE_PCT) / 100


def tx_fee_sol(s: Settings, urgent: bool = False) -> float:
    """Network cost of one transaction: its priority fee plus the signature fee."""
    return (s.URGENT_PRIORITY_FEE_SOL if urgent else s.PRIORITY_FEE_SOL) + SIGNATURE_FEE_SOL


def entry_fill(sol_in: float, price: float, s: Settings) -> Fill:
    if not isfinite(sol_in) or not isfinite(price) or sol_in <= 0 or price <= 0:
        raise ValueError("sol_in and price must be finite and positive")
    exec_price = price * (1 + s.ENTRY_SLIPPAGE_PCT / 100)
    fee = sol_in * _fee_rate(s)
    tokens = (sol_in - fee) / exec_price
    net = tx_fee_sol(s)
    return Fill("buy", price, exec_price, tokens, sol_in + net, fee + net)


def exit_fill(tokens: float, price: float, s: Settings, urgent: bool = False) -> Fill:
    if not isfinite(tokens) or not isfinite(price) or tokens <= 0 or price <= 0:
        raise ValueError("tokens and price must be finite and positive")
    exec_price = price * (1 - s.EXIT_SLIPPAGE_PCT / 100)
    gross = tokens * exec_price
    fee = gross * _fee_rate(s)
    net = tx_fee_sol(s, urgent)
    return Fill("sell", price, exec_price, tokens, gross - fee - net, fee + net)


def mark_to_market(tokens: float, price: float, s: Settings) -> float:
    """Net SOL the remaining tokens would fetch right now (liquidation value)."""
    if not isfinite(tokens) or not isfinite(price):
        raise ValueError("tokens and price must be finite")
    if tokens <= 0 or price <= 0:
        return 0.0
    return exit_fill(tokens, price, s).sol


def _finite(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and isfinite(v) else None


def open_result(p: dict, s: Settings) -> dict | None:
    """An open position row (a runner holding its last tokens for days) valued at its last mark: the
    sales so far plus what the tokens still held would fetch now, minus the cost; dollars at the buy's
    SOL price. None when it lacks a positive cost, holdings, price or SOL rate."""
    cost, rem, last = _finite(p.get("cost_sol")), _finite(p.get("tokens_remaining")), _finite(p.get("last_price"))
    rate = _finite(p.get("sol_usd_entry"))
    if not cost or cost <= 0 or rem is None or rem < 0 or not last or last <= 0 or not rate or rate <= 0:
        return None
    pnl = (_finite(p.get("proceeds_sol")) or 0.0) + mark_to_market(rem, last, s) - cost
    return {"pnl_sol": pnl, "pnl_usd": pnl * rate, "ret": pnl / cost}


class PaperExecutor:
    mode = "paper"

    def __init__(self, settings: Settings):
        self.s = settings

    async def buy(self, mint: str, sol_in: float, price: float) -> Fill:
        return entry_fill(sol_in, price, self.s)

    async def sell(self, mint: str, tokens: float, price: float, fraction: float = 1.0,
                   *, urgent: bool = False) -> Fill:
        return exit_fill(tokens, price, self.s, urgent)
