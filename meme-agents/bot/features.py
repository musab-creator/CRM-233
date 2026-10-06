"""Deterministic flow features: the patterns that separate organic launches from engineered
ones on pump.fun. Snipers take the first minute, bundled same-size buys are spread across
fresh wallets, early buyers have already left, the dev sells, or buying sits in a few
wallets. The Analyst gets them as facts; the LLM decides how much they matter.

Two sources, the same ideas:
* `flow_features`: every trade since launch, from the paid PumpPortal stream (or the simulator).
* `chain_features` (default): the launch minute's trades rebuilt from chain, a holder snapshot
  (what every wallet holds now), and the bot's periodic bonding-curve reads.

Trades are dicts with ts, side ("buy"/"sell"), trader, sol, tokens, price_sol, sorted by ts
ascending. All shares are 0-1; *_pct values are 0-100.
"""
from __future__ import annotations

from collections import defaultdict

SUPPLY = 1_000_000_000.0  # pump.fun token supply, UI units
LAUNCH_PRICE_SOL = 30.0 / 1_073_000_000.0  # empty bonding curve: 30 virtual SOL / 1.073B virtual tokens


def _r(v, n=4):
    return None if v is None else round(v, n)


def _bundles(trades: list[dict], creator: str | None, gap_s: float) -> tuple[int, int, int]:
    """(buys, bundle-like buys, largest cluster): >=3 distinct wallets buying the same amount
    (to 0.001 SOL) within `gap_s` seconds of each other."""
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
            if item[0] - group[-1][0] <= gap_s:
                group.append(item)
                continue
            distinct = len({w for _, w in group})
            if distinct >= 3:
                bundled += len(group)
                max_cluster = max(max_cluster, distinct)
            group = [item]
    return n_buys, bundled, max_cluster


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

    n_buys, bundled, max_cluster = _bundles(trades, creator, bundle_gap_s)

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


def _at_or_before(snaps: list[tuple[float, float, float]], ts: float) -> tuple[float, float, float] | None:
    best = None
    for s in snaps:
        if s[0] <= ts:
            best = s
        else:
            break
    return best


def chain_features(early: list[dict], reached_launch: bool, holders: dict | None, creator: str | None,
                   snapshots: list[tuple[float, float, float]], net_inflow_sol: float | None, now: float,
                   launched_at: float | None, early_buyers_n: int = 20, bundle_gap_s: float = 3.0) -> dict:
    """Flow features without the paid trade stream.

    `early`: the launch minute's trades rebuilt from chain (`reached_launch` False if the token
    had too many transactions to page back to its launch). `holders`: a holder snapshot
    (`feeds.pumpchain.holder_snapshot`). `snapshots`: (ts, price, real_sol) from curve reads,
    oldest first. Values that need data the bot does not have are None, never guessed.
    """
    by_owner = (holders or {}).get("by_owner") or {}
    holders_complete = bool((holders or {}).get("complete"))

    def held(wallet: str) -> float | None:
        if wallet in by_owner:
            return by_owner[wallet]
        return 0.0 if holders_complete else None  # absent from a complete snapshot: sold out and closed

    out: dict = {"source": "chain",
                 "basis": "launch-minute trades rebuilt from chain, current holder balances, curve reads"}
    t0 = early[0]["ts"] if early else launched_at
    out["age_min"] = _r((now - t0) / 60, 1) if t0 else None
    out["net_inflow_sol"] = _r(net_inflow_sol, 3)
    out["launch_minute_trades"] = len(early)
    out["launch_minute_complete"] = reached_launch

    # launch minute: snipers, bundles, the dev's buy
    buys = [t for t in early if t["side"] == "buy" and t["trader"] != creator]
    spent: dict[str, float] = defaultdict(float)
    bought: dict[str, float] = defaultdict(float)
    first_buy: dict[str, float] = {}
    for t in buys:
        spent[t["trader"]] += t["sol"] or 0
        bought[t["trader"]] += t["tokens"] or 0
        first_buy.setdefault(t["trader"], t["ts"] or 0)
    early_sol = sum(spent.values())
    top3 = sorted(spent.items(), key=lambda kv: kv[1], reverse=True)[:3]
    out["launch_minute_buy_sol"] = _r(early_sol, 3)
    out["sniper_top3_sol"] = _r(sum(v for _, v in top3), 3)
    out["sniper_top3_share_of_launch_minute"] = _r(sum(v for _, v in top3) / early_sol) if early_sol else None
    still = [held(w) for w, _ in top3]
    out["snipers_still_holding"] = (f"{sum(1 for (w, _), h in zip(top3, still) if h is not None and bought[w] and h >= 0.1 * bought[w])}"
                                    f"/{len(top3)}") if top3 and None not in still else None
    create_slot = early[0].get("slot") if early else None
    out["same_slot_as_launch_buyers"] = len({t["trader"] for t in buys if create_slot is not None
                                             and t.get("slot") == create_slot})
    n_buys, bundled, max_cluster = _bundles(early, creator, bundle_gap_s)
    out["bundle_like_share_of_launch_minute"] = _r(bundled / n_buys) if n_buys else None
    out["max_same_size_cluster_wallets"] = max_cluster

    # early buyers today
    first_n = sorted(first_buy, key=first_buy.get)[:early_buyers_n]
    known = [(w, held(w)) for w in first_n if held(w) is not None]
    exited = sum(1 for w, h in known if bought[w] and h < 0.1 * bought[w])
    out["early_buyers_exited"] = f"{exited}/{len(known)}" if known else None
    out["early_buyer_retention"] = _r(1 - exited / len(known)) if known else None

    # dev
    dev_bought = sum(t["tokens"] or 0 for t in early if t["side"] == "buy" and t["trader"] == creator)
    dev_now = (holders or {}).get("creator_tokens")
    out["dev_bought_tokens_at_launch"] = _r(dev_bought, 0)
    out["dev_holding_pct_supply"] = _r(100 * dev_now / SUPPLY, 3) if dev_now is not None else None
    out["dev_sold_pct_of_bought"] = (_r(100 * max(0.0, 1 - dev_now / dev_bought), 2)
                                     if dev_now is not None and dev_bought else None)

    # who holds it now (the curve's own account is already excluded)
    amounts = sorted((a for o, a in by_owner.items() if o != creator and a > 0), reverse=True)
    total = sum(amounts)
    shares = [a / total for a in amounts] if total else []
    hhi = sum(x * x for x in shares)
    out["wallets_ex_dev"] = (holders or {}).get("wallets_ex_dev")
    out["holders_now_ex_dev"] = (holders or {}).get("holders_ex_dev")
    out["effective_holders"] = _r(1 / hhi, 1) if hhi else None
    out["holder_hhi"] = _r(hhi) if shares else None
    out["top5_holder_share"] = _r(sum(shares[:5])) if shares else None
    all_held = sorted((a for a in by_owner.values() if a > 0), reverse=True)
    out["top10_pct_supply_ex_curve"] = _r(100 * sum(all_held[:10]) / SUPPLY, 2) if all_held else None

    # momentum from the bot's own curve reads
    snaps = sorted(snapshots)
    cur = snaps[-1] if snaps else None
    ago5, ago10 = _at_or_before(snaps, now - 300), _at_or_before(snaps, now - 600)
    out["net_flow_sol_5m"] = _r(cur[2] - ago5[2], 3) if cur and ago5 else None
    out["net_flow_sol_prev_5m"] = _r(ago5[2] - ago10[2], 3) if ago5 and ago10 else None
    out["price_change_5m_pct"] = _r(100 * (cur[1] / ago5[1] - 1), 2) if cur and ago5 and ago5[1] else None
    out["price_change_since_launch_pct"] = _r(100 * (cur[1] / LAUNCH_PRICE_SOL - 1), 1) if cur else None
    peak = max((s[1] for s in snaps), default=None)
    out["drawdown_from_peak_pct"] = _r(100 * (1 - cur[1] / peak), 2) if cur and peak else None
    out["curve_reads"] = len(snaps)
    return out
