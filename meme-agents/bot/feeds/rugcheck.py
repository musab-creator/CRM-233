"""Rugcheck REST: /tokens/{mint}/report/summary and /tokens/{mint}/report.

Normalised output keeps only what the pipeline uses. Holder concentration excludes the
pump.fun bonding curve and any AMM pool / LP vault listed under `markets`, because those
accounts hold most of the supply by design.
"""
from __future__ import annotations

import time

import httpx

from ..util import RateLimiter
from .http import request_json


def has_danger(risks: list[dict]) -> list[str]:
    return [r.get("name", "?") for r in risks or [] if (r.get("level") or "").lower() == "danger"]


def pool_accounts(report: dict, bonding_curve_key: str | None = None) -> set[str]:
    out: set[str] = set()
    if bonding_curve_key:
        out.add(bonding_curve_key)
    for m in report.get("markets") or []:
        for k in ("pubkey", "liquidityA", "liquidityB", "liquidityAAccount", "liquidityBAccount"):
            v = m.get(k)
            if isinstance(v, str):
                out.add(v)
            elif isinstance(v, dict):
                for kk in ("pubkey", "owner", "address"):
                    if isinstance(v.get(kk), str):
                        out.add(v[kk])
    return out


def top10_pct(holders: list[dict], exclude: set[str]) -> float:
    """Sum of the 10 largest holder percentages, skipping pool/curve accounts."""
    kept = [h for h in holders or []
            if h.get("address") not in exclude and h.get("owner") not in exclude]
    kept.sort(key=lambda h: h.get("pct") or 0, reverse=True)
    return float(sum((h.get("pct") or 0) for h in kept[:10]))


def normalise(summary: dict | None, report: dict | None, bonding_curve_key: str | None = None) -> dict:
    summary = summary or {}
    report = report or {}
    risks = report.get("risks") or summary.get("risks") or []
    token = report.get("token") or {}
    holders = report.get("topHolders") or []
    exclude = pool_accounts(report, bonding_curve_key)
    return {
        "score": summary.get("score", report.get("score")),
        "score_normalised": summary.get("score_normalised", report.get("score_normalised")),
        "risks": [{"name": r.get("name"), "level": r.get("level"), "value": r.get("value")} for r in risks],
        "danger": has_danger(risks),
        "lp_locked_pct": summary.get("lpLockedPct", report.get("lpLockedPct")),
        "mint_authority": token.get("mintAuthority", report.get("mintAuthority")),
        "freeze_authority": token.get("freezeAuthority", report.get("freezeAuthority")),
        "top10_pct": top10_pct(holders, exclude),
        "insider_holders": sum(1 for h in holders if h.get("insider")),
        "top_holders": [{"address": h.get("address"), "owner": h.get("owner"), "pct": h.get("pct"),
                         "insider": h.get("insider")} for h in holders[:12]],
        "graph_insiders": report.get("graphInsidersDetected"),
        "creator": report.get("creator"),
        "creator_balance": report.get("creatorBalance"),
        "total_market_liquidity": report.get("totalMarketLiquidity"),
        "has_report": bool(report),
    }


class Rugcheck:
    def __init__(self, client: httpx.AsyncClient, base: str, rps: float):
        self.c = client
        self.base = base.rstrip("/")
        self.lim = RateLimiter(rps, burst=2)
        self._cache: dict[str, tuple[float, dict]] = {}

    async def summary(self, mint: str) -> dict:
        return await request_json(self.c, "GET", f"{self.base}/tokens/{mint}/report/summary", limiter=self.lim) or {}

    async def report(self, mint: str) -> dict:
        return await request_json(self.c, "GET", f"{self.base}/tokens/{mint}/report", limiter=self.lim) or {}

    async def check(self, mint: str, bonding_curve_key: str | None = None, max_age_s: float = 300) -> dict:
        hit = self._cache.get(mint)
        if hit and time.time() - hit[0] < max_age_s:
            return hit[1]
        summary = await self.summary(mint)
        report = await self.report(mint)
        out = normalise(summary, report, bonding_curve_key)
        self._cache[mint] = (time.time(), out)
        return out
