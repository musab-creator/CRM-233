"""Live-mode startup checks. Any failure refuses to start.

Live requires ALL of:
  MODE=live
  LIVE_CONFIRM=I_ACCEPT_LOSSES
  WALLET_PRIVATE_KEY that parses (base58 secret key or JSON byte array)
  HELIUS_API_KEY (transactions are sent through Helius RPC)
  ANTHROPIC_API_KEY (the agents still gate every trade)
  wallet balance <= LIVE_MAX_WALLET_SOL (default 0.5, at most LIVE_WALLET_CEILING_SOL) at startup, read from chain
"""
from __future__ import annotations

import json
from math import isfinite
from typing import Awaitable, Callable

from solders.keypair import Keypair

from ..config import LIVE_WALLET_CEILING_SOL, Settings

CONFIRM_PHRASE = "I_ACCEPT_LOSSES"


class LiveRefused(Exception):
    pass


def parse_keypair(secret: str) -> Keypair:
    secret = secret.strip()
    if not secret:
        raise ValueError("empty")
    if secret.startswith("["):
        return Keypair.from_bytes(bytes(json.loads(secret)))
    return Keypair.from_base58_string(secret)


def static_checks(s: Settings) -> Keypair | None:
    """Returns None in paper mode, the wallet keypair in live mode, or raises LiveRefused."""
    mode = s.MODE.strip().lower()
    if mode not in ("paper", "live"):
        raise LiveRefused(f"MODE must be 'paper' or 'live', got {s.MODE!r}")
    if mode == "paper":
        return None
    problems = []
    if not isfinite(s.LIVE_MAX_WALLET_SOL) or not 0 < s.LIVE_MAX_WALLET_SOL <= LIVE_WALLET_CEILING_SOL:
        problems.append(f"LIVE_MAX_WALLET_SOL must be finite, positive, and no more than {LIVE_WALLET_CEILING_SOL:g} SOL")
    if s.LIVE_CONFIRM != CONFIRM_PHRASE:
        problems.append(f"LIVE_CONFIRM must equal {CONFIRM_PHRASE}")
    kp = None
    if not s.WALLET_PRIVATE_KEY:
        problems.append("WALLET_PRIVATE_KEY is not set")
    else:
        try:
            kp = parse_keypair(s.WALLET_PRIVATE_KEY)
        except Exception:
            problems.append("WALLET_PRIVATE_KEY does not parse (base58 secret key or JSON byte array)")
    if not s.HELIUS_API_KEY:
        problems.append("HELIUS_API_KEY is not set")
    if not s.ANTHROPIC_API_KEY:
        problems.append("ANTHROPIC_API_KEY is not set")
    if problems:
        raise LiveRefused("refusing to start live mode: " + "; ".join(problems))
    return kp


async def check_live_startup(s: Settings, balance_sol: Callable[[str], Awaitable[float]]) -> Keypair | None:
    kp = static_checks(s)
    if kp is None:
        return None
    pubkey = str(kp.pubkey())
    try:
        bal = await balance_sol(pubkey)
    except Exception as e:
        raise LiveRefused(f"refusing to start live mode: could not read wallet balance ({type(e).__name__})") from None
    if not isinstance(bal, (int, float)) or not isfinite(bal) or bal < 0:
        raise LiveRefused("refusing to start live mode: wallet balance must be finite and nonnegative")
    if bal > s.LIVE_MAX_WALLET_SOL:
        raise LiveRefused(f"refusing to start live mode: wallet {pubkey} holds {bal:.4f} SOL > "
                          f"{s.LIVE_MAX_WALLET_SOL} SOL limit")
    return kp
