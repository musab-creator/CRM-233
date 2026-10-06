"""Deterministic flow features from the bot's own PumpPortal trade stream.

These quantify the patterns that separate organic launches from engineered ones on pump.fun:
snipers taking the first minute, bundled same-size buys across fresh wallets, early buyers who
have already exited, the dev selling, and buying concentrated in a few wallets. The Analyst
gets them as facts; the LLM decides how much they matter.

Input trades are dicts with ts, side ("buy"/"sell"), trader, sol, tokens, price_sol, sorted by
ts ascending. All shares are 0-1; *_pct values are 0-100.
"""
from __future__ import annotations

from collections import defaultdict

SUPPLY = 1_000_000_000.0  # pump.fun token supply, UI units


def _r(v, n=4):
    return None if v is None else round(v, n)


def flow_features(trades: list[dict], creator: str | None, now: float, early_window_s: float = 60.0,
                  early_buyers_n: int = 20, bundle_gap_s: float = 3.0) -> dict:
    if not trades:
        return {"trades": 0}
    t0 = trades[0]["ts"]
    wallets: dict[str, dict] = defaultdict(lambda: {"buy_sol": 0.0, "buy_tok": 0.0, "sell_sol": 0.0,
                                                    "sell_tok": 0.0, "first_buy": None})
    for t in trades:
        w = wallets[t["trader"] or "?"]
        if t["side"] == "buy":
            w["buy_sol"] += t["sol"] or 0
            w["buy_tok"] += t["tokens"] or 0
            if w["first_buy"] is None:
                w["first_buy"] = t["ts"]
        else:
            w["sell_sol"] += t["sol"] or 0
            w["sell_tok"] += t["tokens"] or 0

    buyers = {k: v for k, v in wallets.items() if v["buy_sol"] > 0 and k != creator}
    total_buy = sum(v["buy_sol"] for v in buyers.values())
    shares = sorted((v["buy_sol"] / total_buy for v in buyers.values()), reverse=True) if total_buy else []
    hhi = sum(x * x for x in shares)

    # snipers: who bought in the first `early_window_s` seconds, and how much of all buying that was
    early = defaultdict(float)
    for t in trades:
        if t["side"] == "buy" and t["trader"] != creator and t["ts"] - t0 <= early_window_s:
            early[t["trader"]] += t["sol"] or 0
    top3_early = sorted(early.items(), key=lambda kv: kv[1], reverse=True)[:3]
    sniper_share = sum(v for _, v in top3_early) / total_buy if total_buy else 0.0
    snipers_holding = sum(1 for w, _ in top3_early
                          if wallets[w]["buy_tok"] and wallets[w]["sell_tok"] < 0.9 * wallets[w]["buy_tok"])

    # early-buyer retention: of the first N distinct buyers, how many still hold >10% of what they bought
    first_n = sorted(buyers.items(), key=lambda kv: kv[1]["first_buy"])[:early_buyers_n]
    exited = sum(1 for _, v in first_n if v["buy_tok"] and v["sell_tok"] >= 0.9 * v["buy_tok"])

    # bundle-like: >=3 distinct wallets buying the same amount (to 0.001 SOL) within a few seconds
    by_amount: dict[float, list[tuple[float, str]]] = defaultdict(list)
    n_buys = 0
    for t in trades:
        if t["side"] == "buy" and t["trader"] != creator and t["sol"]:
            n_buys += 1
            by_amount[round(t["sol"], 3)].append((t["ts"], t["trader"]))
    bundled, max_cluster = 0, 0
    for seq in by_amount.values():
        group = [seq[0]]
        for item in seq[1:] + [(float("inf"), "")]:
            if item[0] - group[-1][0] <= bundle_gap_s:
                group.append(item)
                continue
            distinct = len({w for _, w in group})
            if distinct >= 3:
                bundled += len(group)
                max_cluster = max(max_cluster, distinct)
            group = [item]

    dev = wallets.get(creator) if creator else None
    dev_buy_tok = dev["buy_tok"] if dev else 0.0
    dev_sell_tok = dev["sell_tok"] if dev else 0.0

    def window(lo, hi):
        ws = [t for t in trades if lo < t["ts"] <= hi]
        b = sum(t["sol"] or 0 for t in ws if t["side"] == "buy")
        s = sum(t["sol"] or 0 for t in ws if t["side"] == "sell")
        return ws, b, s

    w5, b5, s5 = window(now - 300, now)
    _, bp, sp = window(now - 600, now - 300)
    prices = [(t["ts"], t["price_sol"]) for t in trades if t.get("price_sol")]
    last_price = prices[-1][1] if prices else None
    before = [p for ts, p in prices if ts <= now - 300]
    price_5m_ago = before[-1] if before else (prices[0][1] if prices else None)
    peak = max((p for _, p in prices), default=None)
    last_buy = max((t["ts"] for t in trades if t["side"] == "buy"), default=None)

    return {
        "trades": len(trades),
        "age_min": _r((now - t0) / 60, 1),
        "distinct_buyers_ex_dev": len(buyers),
        "effective_buyers": _r(1 / hhi, 1) if hhi else 0,
        "buyer_hhi": _r(hhi),
        "top5_buyer_share": _r(sum(shares[:5])),
        "sniper_top3_share": _r(sniper_share),
        "snipers_still_holding": f"{snipers_holding}/{len(top3_early)}",
        "early_buy_share_first_60s": _r(sum(early.values()) / total_buy if total_buy else 0.0),
        "early_buyers_exited": f"{exited}/{len(first_n)}",
        "early_buyer_retention": _r(1 - exited / len(first_n)) if first_n else None,
        "bundle_like_buy_share": _r(bundled / n_buys if n_buys else 0.0),
        "max_same_size_cluster_wallets": max_cluster,
        "dev_sold_pct_of_bought": _r(100 * dev_sell_tok / dev_buy_tok, 2) if dev_buy_tok else None,
        "dev_holding_pct_supply": _r(100 * max(0.0, dev_buy_tok - dev_sell_tok) / SUPPLY, 3),
        "dev_sold_sol": _r(dev["sell_sol"] if dev else 0.0, 3),
        "buy_sol_5m": _r(b5, 3),
        "sell_sol_5m": _r(s5, 3),
        "net_flow_sol_5m": _r(b5 - s5, 3),
        "net_flow_sol_prev_5m": _r(bp - sp, 3),
        "buy_sell_ratio_5m": _r(b5 / s5, 2) if s5 else None,
        "trades_per_min_5m": _r(len(w5) / 5, 1),
        "traders_5m": len({t["trader"] for t in w5}),
        "price_change_5m_pct": _r(100 * (last_price / price_5m_ago - 1), 2) if last_price and price_5m_ago else None,
        "price_change_since_launch_pct": _r(100 * (last_price / prices[0][1] - 1), 1) if prices else None,
        "drawdown_from_peak_pct": _r(100 * (1 - last_price / peak), 2) if last_price and peak else None,
        "seconds_since_last_buy": _r(now - last_buy, 0) if last_buy else None,
    }
