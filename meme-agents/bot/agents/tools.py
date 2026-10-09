"""Tool definitions and implementations for the three agents and the two veto agents."""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from ..config import Settings
from ..db import Database
from ..feeds.dexscreener import summarize_pair
from ..feeds.rugcheck import pool_accounts
from .base import AgentSpec
from .forensics import funding_graph, wallet_profile
from .prompts import role_prompt
from .social import author_stats


def _tool(name: str, desc: str, props: dict | None = None, required: list[str] | None = None) -> dict:
    return {"name": name, "description": desc,
            "input_schema": {"type": "object", "properties": props or {}, "required": required or []}}


MINT_ARG = {"mint": {"type": "string", "description": "Token mint address"}}



def _sizes(s: Settings) -> tuple[float, float]:
    """The position sizes the bot may take (POSITION_MIN_USD..POSITION_MAX_USD), which the prompts state."""
    return (s.POSITION_MIN_USD, s.POSITION_MAX_USD)

@dataclass
class ToolContext:
    s: Settings
    db: Database
    dex: Any
    rug: Any
    helius: Any
    x: Any
    news: Any
    candidate: dict  # mint, creator, bonding_curve_key, ...
    flow: Any = None  # async (mint) -> flow features (Engine.compute_flow)


async def _x_search(ctx: ToolContext, a: dict) -> dict:
    q = str(a.get("query", "")).strip()[:400]
    if not q:
        return {"error": "empty query"}
    # only posts since an hour before launch: older ones are about another token with this ticker
    res = await ctx.x.search(q, ctx.s.X_SEARCH_MAX_RESULTS, since_ts=ctx.candidate.get("since_ts"))
    posts = res.get("posts") or []
    authors = {p.get("author") for p in posts}
    texts = [(p.get("text") or "").strip().lower() for p in posts]
    dup = 1 - len(set(texts)) / len(texts) if texts else 0
    return {"query": q, "error": res.get("error"), "post_count": len(posts),
            "distinct_authors": len(authors), "duplicate_text_ratio": round(dup, 2),
            "posts": [{"id": p["post_id"], "author_id": p.get("author"), "created_at": p.get("created_at"),
                       "text": (p.get("text") or "")[:280], "metrics": p.get("metrics")} for p in posts[:25]]}


X_SEARCH_TOOL = _tool("x_search", "Search recent X posts (last 7 days). Costs money; use at most twice. "
                      "Query syntax is X API v2, e.g. '$WIF OR \"dogwifhat\" -is:retweet'.",
                      {"query": {"type": "string"}}, ["query"])


# --- Scout ----------------------------------------------------------------------------
def scout_spec(ctx: ToolContext) -> AgentSpec:
    async def x_search(a: dict):
        return await _x_search(ctx, a)

    async def dexscreener_profile(a: dict):
        mint = a.get("mint") or ctx.candidate["mint"]
        p = await ctx.dex.pair(mint)
        if not p:
            return {"mint": mint, "pair": None}
        sp = summarize_pair(p)
        base = p.get("baseToken") or {}
        return {"mint": mint, "name": base.get("name"), "symbol": base.get("symbol"),
                "websites": sp["websites"], "socials": sp["socials"], "boosts_active": sp["boosts_active"],
                "image": (p.get("info") or {}).get("imageUrl"), "url": sp["url"]}

    async def dexscreener_boosts(a: dict):
        rows = await ctx.dex.boosts()
        mint = ctx.candidate["mint"]
        return {"this_token_boosted": any(r.get("tokenAddress") == mint for r in rows),
                "this_token_boosts": [r for r in rows if r.get("tokenAddress") == mint],
                "latest_solana_boosts": [{"token": r.get("tokenAddress"), "amount": r.get("amount"),
                                          "total": r.get("totalAmount"), "desc": (r.get("description") or "")[:120]}
                                         for r in rows[:15]]}

    tools = [
        X_SEARCH_TOOL,
        _tool("dexscreener_profile", "Project links and socials listed on DexScreener for a mint.", MINT_ARG),
        _tool("dexscreener_boosts", "Latest paid DexScreener boosts on Solana, and whether this token is boosted."),
    ]
    return AgentSpec("scout", role_prompt("scout", ctx.s.GATE_NEUTRAL_VOTES, _sizes(ctx.s)), tools,
                     {"x_search": x_search, "dexscreener_profile": dexscreener_profile,
                      "dexscreener_boosts": dexscreener_boosts})


# --- Hunter ---------------------------------------------------------------------------
def hunter_spec(ctx: ToolContext) -> AgentSpec:
    watch = [h.lower() for h in ctx.s.WATCHLIST_HANDLES]

    async def x_user_timeline(a: dict):
        handle = str(a.get("handle", "")).lstrip("@").strip()
        if handle.lower() not in watch:
            return {"error": f"{handle} is not on the watchlist", "watchlist": ctx.s.WATCHLIST_HANDLES}
        res = await ctx.x.timeline(handle, ctx.s.CATALYST_WINDOW_MIN, ctx.s.X_TIMELINE_REFRESH_MIN,
                                   ctx.s.X_TIMELINE_MAX_RESULTS)
        posts = [{"id": p["post_id"], "created_at": p.get("created_at"), "text": (p.get("text") or "")[:400]}
                 for p in res.get("posts") or []]
        out: dict = {"handle": handle, "window_min": ctx.s.CATALYST_WINDOW_MIN, "posts": posts,
                     "error": res.get("error")}
        if handle.lower() == "realdonaldtrump" and ctx.s.TRUTH_SOCIAL_RSS_URL:
            items = [i for i in await ctx.news.recent(ctx.s.CATALYST_WINDOW_MIN) if i["source"] == "truthsocial"]
            out["truth_social"] = [_news_row(i) for i in items[:20]]
        return out

    async def news_feed(a: dict):
        items = await ctx.news.recent(ctx.s.CATALYST_WINDOW_MIN)
        return {"window_min": ctx.s.CATALYST_WINDOW_MIN, "count": len(items),
                "items": [_news_row(i) for i in items[:40]]}

    tools = [
        _tool("x_user_timeline", f"Recent posts (last {int(ctx.s.CATALYST_WINDOW_MIN)} min) by a watchlist "
              f"account. Watchlist: {', '.join(ctx.s.WATCHLIST_HANDLES)}. For realDonaldTrump this also "
              "includes Truth Social posts when a mirror feed is configured.",
              {"handle": {"type": "string"}}, ["handle"]),
        _tool("news_feed", f"Crypto and general news headlines from the last {int(ctx.s.CATALYST_WINDOW_MIN)} min."),
    ]
    return AgentSpec("hunter", role_prompt("hunter", ctx.s.GATE_NEUTRAL_VOTES, _sizes(ctx.s)), tools,
                     {"x_user_timeline": x_user_timeline, "news_feed": news_feed})


def _news_row(i: dict) -> dict:
    ts = i.get("published_ts")
    return {"source": i.get("source"), "title": i.get("title"),
            "minutes_ago": round((time.time() - ts) / 60, 1) if ts else None, "url": i.get("url")}


# --- Analyst --------------------------------------------------------------------------
def analyst_spec(ctx: ToolContext) -> AgentSpec:
    cand = ctx.candidate

    async def rugcheck(a: dict):
        mint = a.get("mint") or cand["mint"]
        return await ctx.rug.check(mint, cand.get("bonding_curve_key") if mint == cand["mint"] else None)

    async def holders(a: dict):
        mint = a.get("mint") or cand["mint"]
        exclude: set[str] = set()
        if mint == cand["mint"] and cand.get("bonding_curve_key"):
            exclude.add(cand["bonding_curve_key"])
        try:
            report = await ctx.rug.report(mint)
            exclude |= pool_accounts(report, None)
        except Exception:
            pass
        out = await ctx.helius.holders(mint, exclude)
        creator = cand.get("creator") if mint == cand["mint"] else None
        if creator:
            out["creator"] = creator
            out["creator_in_top_holders"] = [h for h in out["holders"] if h["owner"] == creator]
            out["creator_recent_activity"] = await ctx.helius.address_transactions(creator, 15)
        return out

    async def dexscreener_pair(a: dict):
        mint = a.get("mint") or cand["mint"]
        return summarize_pair(await ctx.dex.pair(mint)) or {"mint": mint, "pair": None}

    async def recent_trades(a: dict):
        mint = a.get("mint") or cand["mint"]
        limit = int(a.get("limit") or 80)
        rows = await ctx.db.recent_trades(mint, max(10, min(200, limit)))
        m = await ctx.db.fetchone("SELECT * FROM mints WHERE mint=?", [mint]) or {}
        creator = m.get("creator")
        buys = [r for r in rows if r["side"] == "buy"]
        sells = [r for r in rows if r["side"] == "sell"]
        sizes = [round(r["sol"], 3) for r in buys]
        repeated = max((sizes.count(x) for x in set(sizes)), default=0)
        flow = await ctx.flow(mint) if ctx.flow and mint == cand["mint"] else {"error": "flow features are computed for the candidate only"}
        return {
            "mint": mint, "creator": creator,
            "flow_features": flow,
            "totals": {k: m.get(k) for k in ("trade_count", "unique_buyers", "net_inflow_sol", "real_sol",
                                             "wallets_ex_dev", "holders_now", "progress", "graduated", "pool",
                                             "market_cap_sol")},
            "window": {"trades": len(rows), "buys": len(buys), "sells": len(sells),
                       "buy_sol": round(sum(r["sol"] for r in buys), 3),
                       "sell_sol": round(sum(r["sol"] for r in sells), 3),
                       "distinct_traders": len({r["trader"] for r in rows}),
                       "most_repeated_buy_size_count": repeated},
            "trades": [{"age_s": round(time.time() - r["ts"]), "side": r["side"], "sol": round(r["sol"], 4),
                        "trader": r["trader"], "is_creator": r["trader"] == creator, "pool": r["pool"]}
                       for r in rows[:60]],
        }

    tools = [
        _tool("rugcheck", "Rugcheck risk report: score, named risks, authorities, LP lock, top holders, insiders.",
              MINT_ARG),
        _tool("holders", "Top-20 holders via Helius RPC with % of supply (pool/curve accounts flagged), plus "
              "the creator's holdings and recent wallet activity.", MINT_ARG),
        _tool("dexscreener_pair", "Best DexScreener pair: price, liquidity, FDV, volume and buys/sells per "
              "5m/1h/6h/24h.", MINT_ARG),
        _tool("recent_trades", "Trades the bot knows for the mint (the launch minute, rebuilt from chain; every "
              "trade if the paid PumpPortal stream is on), per-mint totals, creator flags and freshly computed "
              "flow_features (snipers, bundles, early-buyer retention, dev selling, holder concentration, "
              "5-minute momentum).",
              {**MINT_ARG, "limit": {"type": "integer", "description": "10-200, default 80"}}),
    ]
    return AgentSpec("analyst", role_prompt("analyst", ctx.s.GATE_NEUTRAL_VOTES, _sizes(ctx.s)), tools,
                     {"rugcheck": rugcheck, "holders": holders, "dexscreener_pair": dexscreener_pair,
                      "recent_trades": recent_trades}, with_size=True, size=_sizes(ctx.s))


def build_specs(ctx: ToolContext) -> list[AgentSpec]:
    return [scout_spec(ctx), hunter_spec(ctx), analyst_spec(ctx)]


# --- Veto agents: run only after a unanimous BUY ----------------------------------------
def forensics_spec(ctx: ToolContext) -> AgentSpec:
    cand = ctx.candidate
    limit = 20

    async def profile(wallet: str) -> dict:
        return wallet_profile(wallet, await ctx.helius.address_transactions(wallet, limit), time.time(), limit)

    async def creator_history(a: dict):
        creator = cand.get("creator")
        if not creator:
            return {"error": "creator wallet unknown"}
        prof = await profile(creator)
        prof["note"] = "oldest_seen_days is a lower bound on the wallet's age when history_truncated is true"
        return prof

    async def top_holder_wallets() -> list[str]:
        exclude: set[str] = set()
        if cand.get("bonding_curve_key"):
            exclude.add(cand["bonding_curve_key"])
        try:
            exclude |= pool_accounts(await ctx.rug.report(cand["mint"]), None)
        except Exception:
            pass
        out = await ctx.helius.holders(cand["mint"], exclude)
        wallets = [h["owner"] for h in out.get("holders") or [] if h.get("owner") and not h.get("is_pool_or_curve")
                   and h["owner"] != cand.get("creator")]
        return wallets[:ctx.s.FORENSICS_HOLDER_WALLETS]

    async def holder_funding(a: dict):
        wallets = await top_holder_wallets()
        if not wallets:
            return {"error": "no holder wallets resolved"}
        profiles = [await profile(w) for w in wallets]
        return {"mint": cand["mint"], "graph": funding_graph(profiles, cand.get("creator")), "wallets": profiles}

    async def sniper_wallets(a: dict):
        flow = await ctx.flow(cand["mint"]) if ctx.flow else {}
        snipers = [w for w in (flow or {}).get("sniper_wallets") or [] if w and w != cand.get("creator")][:3]
        if not snipers:
            return {"error": "no launch-minute sniper wallets known", "flow_keys": sorted((flow or {}).keys())[:12]}
        profiles = [await profile(w) for w in snipers]
        return {"snipers_still_holding": (flow or {}).get("snipers_still_holding"),
                "graph": funding_graph(profiles, cand.get("creator")), "wallets": profiles}

    tools = [
        _tool("creator_history", "The creator wallet's recent transactions (Helius): age, funders, distinct "
              "tokens touched, pump.fun transaction count, SOL sent out and to whom."),
        _tool("holder_funding", f"The top {ctx.s.FORENSICS_HOLDER_WALLETS} holder wallets (pool and curve excluded): "
              "who funded each, shared funders, creator-funded wallets, fresh wallets."),
        _tool("sniper_wallets", "The launch-minute top-3 sniper wallets: their history and funding links."),
    ]
    return AgentSpec("forensics", role_prompt("forensics", size=_sizes(ctx.s)), tools,
                     {"creator_history": creator_history, "holder_funding": holder_funding,
                      "sniper_wallets": sniper_wallets})


def social_spec(ctx: ToolContext) -> AgentSpec:
    seen_posts: list[dict] = []

    async def x_search(a: dict):
        res = await _x_search(ctx, a)
        seen_posts.extend(res.get("posts") or [])
        return res

    async def x_authors(a: dict):
        ids = [str(i) for i in (a.get("author_ids") or []) if str(i).strip()]
        if not ids:
            ids = list(dict.fromkeys(str(p.get("author_id")) for p in seen_posts if p.get("author_id")))
        ids = ids[:ctx.s.SOCIAL_MAX_AUTHORS]
        if not ids:
            return {"error": "no author ids: run x_search first"}
        res = await ctx.x.users(ids)
        out = author_stats(res.get("users") or [], seen_posts, time.time())
        if res.get("error"):
            out["error"] = res["error"]
        return out

    tools = [
        X_SEARCH_TOOL,
        _tool("x_authors", f"Profiles of up to {ctx.s.SOCIAL_MAX_AUTHORS} post authors (account age, followers, "
              "following, posts, verified) and aggregate bot-likeness stats. Defaults to the authors of your "
              "x_search results.",
              {"author_ids": {"type": "array", "items": {"type": "string"}}}),
    ]
    return AgentSpec("social", role_prompt("social", size=_sizes(ctx.s)), tools,
                     {"x_search": x_search, "x_authors": x_authors})


def build_veto_specs(ctx: ToolContext) -> list[AgentSpec]:
    return [forensics_spec(ctx), social_spec(ctx)]
