"""Deterministic pre-filter. No LLM.

Stage 1 (free, from the stream): age, unique buyers, net SOL inflow.
Stage 2 (one Rugcheck + one DexScreener call, only for stage-1 survivors):
  no danger-level risk, mint & freeze authority null, top-10 holders < 35% (ex pools),
  DexScreener pair exists with liquidity >= $8,000.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from .config import Settings
from .ingest import MintState

log = logging.getLogger("bot.prefilter")


@dataclass
class PrefilterResult:
    passed: bool
    reasons: list[str] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    rug: dict | None = None
    pair: dict | None = None

    @property
    def reason(self) -> str:
        return "; ".join(self.reasons) if self.reasons else "ok"


def stage1(st: MintState, now: float, s: Settings) -> PrefilterResult:
    age = st.age_min(now)
    m = {"age_min": round(age, 2), "unique_buyers": st.unique_buyers,
         "net_inflow_sol": round(st.net_inflow_sol, 3), "progress": round(st.progress, 4),
         "trade_count": st.trade_count, "graduated": st.graduated}
    r: list[str] = []
    if age < s.PF_MIN_AGE_MIN:
        r.append(f"too young ({age:.1f}m < {s.PF_MIN_AGE_MIN}m)")
    if age > s.PF_MAX_AGE_MIN:
        r.append(f"too old ({age:.1f}m > {s.PF_MAX_AGE_MIN}m)")
    if st.unique_buyers < s.PF_MIN_UNIQUE_BUYERS:
        r.append(f"buyers {st.unique_buyers} < {s.PF_MIN_UNIQUE_BUYERS}")
    if st.net_inflow_sol < s.PF_MIN_NET_INFLOW_SOL:
        r.append(f"net inflow {st.net_inflow_sol:.2f} < {s.PF_MIN_NET_INFLOW_SOL} SOL")
    return PrefilterResult(not r, r, m)


def curve_liquidity_usd(st: MintState, sol_usd: float | None) -> float | None:
    """AMM-equivalent depth of a bonding curve: 2 x real SOL reserve (virtual SOL minus the 30 SOL seed)."""
    if st.graduated or st.v_sol is None or not sol_usd:
        return None
    return max(0.0, st.v_sol - 30.0) * 2 * sol_usd


def stage2(rug: dict | None, pair: dict | None, s: Settings, curve_liq_usd: float | None = None) -> PrefilterResult:
    r: list[str] = []
    m: dict = {}
    if not rug or not rug.get("has_report"):
        r.append("rugcheck report unavailable")
    else:
        m.update({"rug_score": rug.get("score_normalised"), "rug_danger": rug.get("danger"),
                  "top10_pct": round(rug.get("top10_pct") or 0, 2),
                  "mint_authority": rug.get("mint_authority"), "freeze_authority": rug.get("freeze_authority"),
                  "lp_locked_pct": rug.get("lp_locked_pct")})
        if rug.get("danger"):
            r.append("rugcheck danger: " + ", ".join(rug["danger"]))
        if s.PF_REQUIRE_NULL_AUTHORITIES:
            if rug.get("mint_authority"):
                r.append("mint authority not null")
            if rug.get("freeze_authority"):
                r.append("freeze authority not null")
        if (rug.get("top10_pct") or 0) >= s.PF_MAX_TOP10_PCT:
            r.append(f"top10 {rug['top10_pct']:.1f}% >= {s.PF_MAX_TOP10_PCT}%")
    if not pair:
        r.append("no dexscreener pair")
    else:
        liq = (pair.get("liquidity") or {}).get("usd")
        source = "dexscreener"
        if liq is None and s.PF_CURVE_LIQUIDITY_FALLBACK and curve_liq_usd is not None:
            liq, source = curve_liq_usd, "curve_estimate"
        m.update({"liquidity_usd": liq, "liquidity_source": source, "dex": pair.get("dexId"),
                  "pair": pair.get("pairAddress"), "fdv": pair.get("fdv")})
        if liq is None:
            r.append("dexscreener pair reports no liquidity")
        elif liq < s.PF_MIN_LIQUIDITY_USD:
            r.append(f"liquidity ${liq:,.0f} < ${s.PF_MIN_LIQUIDITY_USD:,.0f}")
    return PrefilterResult(not r, r, m)


async def full_check(st: MintState, now: float, s: Settings, rugcheck, dex,
                     sol_usd: float | None = None) -> PrefilterResult:
    """Stage 1 then stage 2; stage-2 lookups run concurrently."""
    r1 = stage1(st, now, s)
    if not r1.passed:
        return r1

    async def _rug():
        try:
            return await rugcheck.check(st.mint, st.bonding_curve_key)
        except Exception as e:
            log.warning("rugcheck %s failed: %s", st.mint, e)
            return None

    async def _pair():
        try:
            return await dex.pair(st.mint)
        except Exception as e:
            log.warning("dexscreener %s failed: %s", st.mint, e)
            return None

    rug, pair = await asyncio.gather(_rug(), _pair())
    r2 = stage2(rug, pair, s, curve_liquidity_usd(st, sol_usd))
    metrics = {**r1.metrics, **r2.metrics}
    return PrefilterResult(r2.passed, r2.reasons, metrics, rug, pair)
