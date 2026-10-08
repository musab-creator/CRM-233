"""DexScreener REST.

/latest/dex/tokens/{a,b,...}  up to 30 addresses per call, 300 req/min
/latest/dex/search?q=          300 req/min
/token-boosts/latest/v1        60 req/min
"""
from __future__ import annotations

import statistics
import time

import httpx

from ..util import RateLimiter
from .http import request_json

WSOL = "So11111111111111111111111111111111111111112"
STABLES = {"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",   # USDC
           "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}   # USDT
SOL_PAIR_MIN_LIQUIDITY_USD = 500_000


def sol_usd_from_pairs(pairs: list[dict]) -> float | None:
    """SOL/USD as the median over deep SOL/stablecoin pairs, so one pair reporting a wrong
    price cannot move it. Falls back to the deepest wrapped-SOL pair of any kind."""
    prices = sorted(_num(p.get("priceUsd")) for p in pairs or []
                    if p.get("chainId") == "solana" and (p.get("baseToken") or {}).get("address") == WSOL
                    and (p.get("quoteToken") or {}).get("address") in STABLES
                    and ((p.get("liquidity") or {}).get("usd") or 0) >= SOL_PAIR_MIN_LIQUIDITY_USD
                    and _num(p.get("priceUsd")))
    if len(prices) >= 2:
        return statistics.median(prices)
    p = best_pair(pairs, WSOL)
    return _num(p.get("priceUsd")) if p else None


def best_pair(pairs: list[dict], mint: str) -> dict | None:
    """Highest-liquidity Solana pair where `mint` is the base token."""
    cands = [p for p in pairs or [] if p.get("chainId") == "solana"
             and (p.get("baseToken") or {}).get("address") == mint]
    if not cands:
        return None
    return max(cands, key=lambda p: ((p.get("liquidity") or {}).get("usd") or 0))


def sol_price_native(p: dict | None) -> float | None:
    """`priceNative` as SOL per token, or None when the pair is not quoted in wrapped SOL.
    DexScreener's native price is in the pair's quote token: a USDC- or USDT-quoted pair reports
    a price about SOL/USD times too high, which once booked a +39,000% paper exit."""
    if not p or (p.get("quoteToken") or {}).get("address") != WSOL:
        return None
    v = _num(p.get("priceNative"))
    return v if v and v > 0 else None


def summarize_pair(p: dict | None) -> dict | None:
    if not p:
        return None
    tx = p.get("txns") or {}
    info = p.get("info") or {}
    return {
        "dex": p.get("dexId"),
        "pair": p.get("pairAddress"),
        "url": p.get("url"),
        "price_usd": _num(p.get("priceUsd")),
        "price_native": _num(p.get("priceNative")),
        "liquidity_usd": (p.get("liquidity") or {}).get("usd"),
        "fdv": p.get("fdv"),
        "market_cap": p.get("marketCap"),
        "volume": p.get("volume"),
        "price_change": p.get("priceChange"),
        "txns": {k: tx.get(k) for k in ("m5", "h1", "h6", "h24") if k in tx},
        "pair_created_at": p.get("pairCreatedAt"),
        "websites": [w.get("url") for w in info.get("websites") or []],
        "socials": [{"type": s.get("type") or s.get("platform"), "url": s.get("url") or s.get("handle")}
                    for s in info.get("socials") or []],
        "boosts_active": (p.get("boosts") or {}).get("active"),
    }


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class DexScreener:
    def __init__(self, client: httpx.AsyncClient, base: str, tokens_rps: float, boosts_rps: float):
        self.c = client
        self.base = base.rstrip("/")
        self.lim = RateLimiter(tokens_rps, burst=5)
        self.boost_lim = RateLimiter(boosts_rps, burst=2)
        self._boost_cache: tuple[float, list] = (0.0, [])

    async def tokens(self, mints: list[str]) -> dict[str, dict | None]:
        """mint -> raw best pair (or None). Batches of 30."""
        out: dict[str, dict | None] = {}
        for i in range(0, len(mints), 30):
            chunk = mints[i:i + 30]
            data = await request_json(self.c, "GET", f"{self.base}/latest/dex/tokens/{','.join(chunk)}",
                                      limiter=self.lim)
            pairs = (data or {}).get("pairs") or []
            for m in chunk:
                out[m] = best_pair(pairs, m)
        return out

    async def pair(self, mint: str) -> dict | None:
        return (await self.tokens([mint])).get(mint)

    async def search(self, q: str) -> list[dict]:
        data = await request_json(self.c, "GET", f"{self.base}/latest/dex/search", params={"q": q},
                                  limiter=self.lim)
        return (data or {}).get("pairs") or []

    async def boosts(self) -> list[dict]:
        ts, cached = self._boost_cache
        if time.time() - ts < 60:
            return cached
        data = await request_json(self.c, "GET", f"{self.base}/token-boosts/latest/v1", limiter=self.boost_lim)
        rows = [b for b in (data or []) if b.get("chainId") == "solana"]
        self._boost_cache = (time.time(), rows)
        return rows

    async def token_pairs(self, mint: str) -> list[dict]:
        """Every pair DexScreener lists for one token, raw."""
        data = await request_json(self.c, "GET", f"{self.base}/latest/dex/tokens/{mint}", limiter=self.lim)
        return (data or {}).get("pairs") or []

    async def sol_usd(self) -> float | None:
        return sol_usd_from_pairs(await self.token_pairs(WSOL))
