"""Wallet forensics: pure functions over Helius enhanced transactions.

The forensics agent's tools call these on the creator, the top holders and the launch-minute
snipers. Everything here is deterministic and testable; the agent reads the numbers.
"""
from __future__ import annotations

from collections import defaultdict

WSOL = "So11111111111111111111111111111111111111112"


def wallet_profile(address: str, txs: list[dict], now: float, limit: int = 20) -> dict:
    """What a wallet's recent transactions say about it: age of the oldest one seen, who funded
    it with SOL, how many distinct tokens and pump.fun transactions it touched."""
    stamps = [t["timestamp"] for t in txs if t.get("timestamp")]
    oldest = min(stamps) if stamps else None
    funders: dict[str, float] = defaultdict(float)
    first_funder = None
    first_fund_ts = None
    sol_out: dict[str, float] = defaultdict(float)
    mints: set[str] = set()
    types: dict[str, int] = defaultdict(int)
    pump = 0
    for t in txs:
        types[t.get("type") or "?"] += 1
        if (t.get("source") or "").upper() == "PUMP_FUN":
            pump += 1
        for x in t.get("token_transfers") or []:
            if x.get("mint") and x["mint"] != WSOL:
                mints.add(x["mint"])
        for x in t.get("native_transfers") or []:
            if x.get("to") == address and x.get("from") and x["from"] != address and (x.get("sol") or 0) > 0:
                funders[x["from"]] += x["sol"]
                ts = t.get("timestamp") or 0
                if first_fund_ts is None or ts < first_fund_ts:
                    first_fund_ts, first_funder = ts, x["from"]
            elif x.get("from") == address and x.get("to") and x["to"] != address and (x.get("sol") or 0) > 0:
                sol_out[x["to"]] += x["sol"]
    top_funders = sorted(funders.items(), key=lambda kv: kv[1], reverse=True)[:3]
    return {
        "wallet": address,
        "tx_seen": len(txs),
        "history_truncated": len(txs) >= limit,          # older activity exists beyond what was fetched
        "oldest_seen_days": round((now - oldest) / 86400, 2) if oldest else None,
        "first_funder": first_funder,
        "funders": [{"from": a, "sol": round(v, 4)} for a, v in top_funders],
        "sol_out_to": [{"to": a, "sol": round(v, 4)} for a, v in
                       sorted(sol_out.items(), key=lambda kv: kv[1], reverse=True)[:3]],
        "distinct_tokens_touched": len(mints),
        "pump_fun_txs": pump,
        "types": dict(types),
    }


def funding_graph(profiles: list[dict], creator: str | None) -> dict:
    """Links between wallets: shared funders, wallets funded by the creator, fresh wallets."""
    by_funder: dict[str, list[str]] = defaultdict(list)
    creator_funded = []
    fresh = []
    for p in profiles:
        for f in p.get("funders") or []:
            by_funder[f["from"]].append(p["wallet"])
            if creator and f["from"] == creator:
                creator_funded.append(p["wallet"])
        if (p.get("oldest_seen_days") is not None and p["oldest_seen_days"] < 1 and not p.get("history_truncated")):
            fresh.append(p["wallet"])
    shared = {f: sorted(set(ws)) for f, ws in by_funder.items() if len(set(ws)) >= 2 and f != creator}
    largest = max((len(ws) for ws in shared.values()), default=0)
    return {
        "wallets": len(profiles),
        "shared_funders": [{"funder": f, "wallets": ws} for f, ws in
                           sorted(shared.items(), key=lambda kv: len(kv[1]), reverse=True)[:5]],
        "largest_shared_funder_cluster": largest,
        "creator_funded_wallets": sorted(set(creator_funded)),
        "fresh_wallets": fresh,
        "fresh_share": round(len(fresh) / len(profiles), 2) if profiles else None,
    }
