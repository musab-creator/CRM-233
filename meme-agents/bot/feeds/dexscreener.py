"""DexScreener REST.

/latest/dex/tokens/{a,b,...}  up to 30 addresses per call, 300 req/min
/latest/dex/search?q=          300 req/min
/token-boosts/latest/v1        60 req/min
"""
from __future__ import annotations

import time

import httpx

from ..util import RateLimiter
from .http import request_json

WSOL = "So11111111111111111111111111111111111111112"


def best_pair(pairs: list[dict], mint: str) -> dict | None:
    """Highest-liquidity Solana pair where `mint` is the base token."""
    cands = [p for p in pairs or [] if p.get("chainId") == "solana"
             and (p.get("baseToken") or {}).get("address") == mint]
    if not cands:
        return None
    return max(cands, key=lambda p: ((p.get("liquidity") or {}).get("usd") or 0))


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

    async def sol_usd(self) -> float | None:
        p = (await self.tokens([WSOL])).get(WSOL)
        return _num(p.get("priceUsd")) if p else None
