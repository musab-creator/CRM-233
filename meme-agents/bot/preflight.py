"""`python -m bot preflight [--probe]`: is every dependency reachable, is every key valid?

Checks make only free calls (no X reads, no paid LLM tokens, a few Helius credits) and never
print a secret.

With --probe it also records what the live APIs return and tests this build's assumptions
against them:
  * PumpPortal create messages carry the fields ingest reads; whether trades arrive for
    subscribed launches without an API key (they should not, since May 2026);
  * DexScreener: how many launches minutes old already have a pair, and what it reports;
  * Rugcheck: report fields, risk levels, whether the curve sits in topHolders;
  * Helius (if HELIUS_API_KEY is set): curve accounts decode (virtual reserves keep the
    constant product), holder counts, and a rebuilt launch trade matches its create event;
  * PumpPortal trade-local builds a transaction for a throwaway wallet (built, never signed).
The report is written to reports/preflight-YYYYmmdd-HHMMSS.json.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

import httpx
import websockets

from .config import Settings
from .feeds.dexscreener import WSOL, DexScreener
from .feeds.helius import Helius
from .feeds.news import NewsFeed
from .feeds.pumpchain import INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKENS, HeliusChain
from .feeds.rugcheck import Rugcheck, normalise, pool_accounts, top10_pct
from .util import redact

log = logging.getLogger("bot.preflight")

BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"  # long-lived token: Rugcheck always has a report
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
K = INITIAL_VIRTUAL_SOL * INITIAL_VIRTUAL_TOKENS     # pump.fun constant product (SOL x tokens)
CREATE_FIELDS = ["mint", "traderPublicKey", "bondingCurveKey", "vTokensInBondingCurve", "vSolInBondingCurve",
                 "solAmount", "initialBuy", "name", "symbol", "signature"]


@dataclass
class Check:
    name: str
    status: str      # pass | fail | warn | skip
    detail: str
    required: bool


def _err(e: BaseException) -> str:
    return redact(f"{type(e).__name__}: {e}")[:300]


async def _check(name: str, required: bool, coro) -> Check:
    try:
        status, detail = await coro
        return Check(name, status, redact(str(detail))[:300], required)
    except Exception as e:  # every failure becomes a row, never a crash
        return Check(name, "fail", _err(e), required)


def _helius(s: Settings, http: httpx.AsyncClient) -> Helius:
    return Helius(http, s.helius_rpc(), s.HELIUS_API_URL, s.HELIUS_API_KEY, s.HELIUS_RPC_RPS, s.HELIUS_ENHANCED_RPS)


async def run_checks(s: Settings, http: httpx.AsyncClient, need_llm: bool = True) -> list[Check]:
    dex = DexScreener(http, s.DEXSCREENER_URL, s.DEX_TOKENS_RPS, s.DEX_BOOSTS_RPS)
    rug = Rugcheck(http, s.RUGCHECK_URL, s.RUGCHECK_RPS)
    need_helius = s.is_live or s.PUMPPORTAL_TRADE_STREAM != "all"

    async def sol_price():
        v = await dex.sol_usd()
        return ("pass", f"SOL/USD {v:.2f}") if v else ("fail", "no wSOL pair price")

    async def boosts():
        rows = await dex.boosts()
        return "pass", f"{len(rows)} Solana boosts"

    async def rugcheck():
        out = normalise(await rug.summary(BONK), await rug.report(BONK))
        ok = out["has_report"] and out["score_normalised"] is not None
        return ("pass" if ok else "fail"), f"BONK report: score_normalised={out['score_normalised']}, " \
                                            f"{len(out['top_holders'])} top holders"

    async def pumpportal():
        t0 = time.monotonic()
        async with websockets.connect(s.pumpportal_ws(), open_timeout=15) as ws:
            await ws.send(json.dumps({"method": "subscribeNewToken"}))
            while time.monotonic() - t0 < 45:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=45))
                if isinstance(msg, dict) and msg.get("txType") == "create":
                    return "pass", f"first launch after {time.monotonic() - t0:.1f}s ({msg.get('symbol')})"
        return "fail", "connected but no launch within 45s"

    async def news():
        n = len(await NewsFeed(http, s.CRYPTOPANIC_URL, s.CRYPTOPANIC_TOKEN, s.NEWS_RSS_URLS,
                               s.TRUTH_SOCIAL_RSS_URL, 0).items())
        return ("pass" if n else "warn"), f"{n} headlines" + ("" if s.CRYPTOPANIC_TOKEN else " (RSS only, no CryptoPanic token)")

    async def anthropic_key():
        if not s.ANTHROPIC_API_KEY:
            return ("fail" if need_llm else "skip"), "ANTHROPIC_API_KEY not set: every agent vote would be PASS"
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=s.ANTHROPIC_API_KEY, max_retries=1)
        m = await client.models.retrieve(s.LLM_MODEL)  # free: validates the key and the model id
        return "pass", f"key valid, model {m.id} available"

    async def helius():
        if not s.HELIUS_API_KEY:
            return ("fail" if need_helius else "warn"), \
                "HELIUS_API_KEY not set: net inflow, buyers and prices are read from the chain through Helius"
        h = _helius(s, http)
        health = await h.rpc("getHealth", [])
        slot = await h.rpc("getSlot", [])
        return "pass", f"getHealth={health}, slot {slot}"

    async def jupiter():
        if not s.JUPITER_API_KEY:
            return "skip", "JUPITER_API_KEY not set (only needed for graduated tokens in live mode)"
        r = await http.get(f"{s.JUPITER_URL}/order", params={"inputMint": WSOL, "outputMint": USDC,
                                                             "amount": "10000000"},
                           headers={"x-api-key": s.JUPITER_API_KEY}, timeout=15)
        return ("pass" if r.status_code == 200 else "fail"), f"order quote HTTP {r.status_code}"

    async def telegram():
        if not s.TELEGRAM_BOT_TOKEN:
            return "skip", "TELEGRAM_BOT_TOKEN not set (alerts off)"
        r = await http.get(f"https://api.telegram.org/bot{s.TELEGRAM_BOT_TOKEN}/getMe", timeout=10)
        ok = r.status_code == 200 and (r.json() or {}).get("ok")
        return ("pass" if ok and s.TELEGRAM_CHAT_ID else "warn"), \
            f"getMe HTTP {r.status_code}" + ("" if s.TELEGRAM_CHAT_ID else ", TELEGRAM_CHAT_ID not set")

    async def x_api():  # any X read is billed, so only report configuration
        if not s.X_BEARER_TOKEN:
            return "warn", "X_BEARER_TOKEN not set: Scout and Hunter run without X"
        return "pass", f"token set (not called: reads are billed), budget ${s.X_MONTHLY_BUDGET_USD:.0f}/month"

    async def trade_stream():
        if s.PUMPPORTAL_TRADE_STREAM == "off":
            return "skip", "PUMPPORTAL_TRADE_STREAM=off: no paid per-token trade stream (the default)"
        if not s.PUMPPORTAL_API_KEY:
            return "fail", (f"PUMPPORTAL_TRADE_STREAM={s.PUMPPORTAL_TRADE_STREAM} needs PUMPPORTAL_API_KEY with a "
                            "funded wallet (0.02 SOL minimum, 0.01 SOL per 10,000 trades)")
        return "pass", (f"key set; budget {s.PUMPPORTAL_DAILY_BUDGET_SOL} SOL/day "
                        f"(~{int(s.PUMPPORTAL_DAILY_BUDGET_SOL / s.PUMPPORTAL_SOL_PER_TRADE):,} trades)")

    return list(await asyncio.gather(
        _check("dexscreener: SOL/USD", True, sol_price()),
        _check("dexscreener: boosts", False, boosts()),
        _check("rugcheck", True, rugcheck()),
        _check("pumpportal websocket", True, pumpportal()),
        _check("helius", need_helius, helius()),
        _check("anthropic", need_llm, anthropic_key()),
        _check("news feeds", False, news()),
        _check("jupiter", False, jupiter()),
        _check("telegram", False, telegram()),
        _check("x api", False, x_api()),
        _check("pumpportal trade stream", s.PUMPPORTAL_TRADE_STREAM != "off", trade_stream()),
    ))


# --- live-data probe ---------------------------------------------------------------------------
async def capture_stream(url: str, seconds: float, trade_subs: int = 20) -> dict:
    """Record launches, migrations, any trades for the first `trade_subs` launches (subscribed
    the way the paid stream would be), and PumpPortal's non-trade notices."""
    creates: list[dict] = []
    migrations: list[dict] = []
    trades: dict[str, list[dict]] = {}
    notices: list = []
    other_tx: Counter = Counter()
    t_end = time.monotonic() + seconds
    async with websockets.connect(url, open_timeout=15, max_size=2 ** 22) as ws:
        await ws.send(json.dumps({"method": "subscribeNewToken"}))
        await ws.send(json.dumps({"method": "subscribeMigration"}))
        while (left := t_end - time.monotonic()) > 0:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=left)
            except asyncio.TimeoutError:
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                notices.append(str(raw)[:300])
                continue
            if not isinstance(msg, dict):
                continue
            tx = msg.get("txType")
            if tx == "create":
                msg["_seen"] = time.time()
                creates.append(msg)
                if len(creates) <= trade_subs:
                    await ws.send(json.dumps({"method": "subscribeTokenTrade", "keys": [msg["mint"]]}))
            elif tx in ("buy", "sell") and msg.get("mint"):
                trades.setdefault(msg["mint"], []).append(msg)
            elif tx == "migrate" or (tx is None and "pool" in msg and "mint" in msg):
                migrations.append(msg)
            elif tx:
                other_tx[tx] += 1
            elif len(notices) < 10:
                notices.append({k: (str(v)[:200]) for k, v in msg.items()})
    return {"creates": creates, "migrations": migrations, "trades": trades, "notices": notices,
            "other_tx": dict(other_tx), "seconds": seconds, "trade_subs": min(trade_subs, len(creates))}


def summarize_stream(cap: dict) -> dict:
    creates, trades = cap["creates"], cap["trades"]
    n = len(creates)
    create_keys = Counter(k for c in creates for k in c if not k.startswith("_"))
    products = sorted(float(c["vSolInBondingCurve"]) * float(c["vTokensInBondingCurve"]) / K for c in creates
                      if c.get("vSolInBondingCurve") and c.get("vTokensInBondingCurve"))
    n_trades = sum(len(v) for v in trades.values())
    return {
        "launches": n,
        "launches_per_min": round(n / (cap["seconds"] / 60), 1) if cap["seconds"] else None,
        "create_fields_missing": [k for k in CREATE_FIELDS if create_keys[k] < n] if n else CREATE_FIELDS,
        "create_fields_seen": sorted(create_keys),
        "create_pools": dict(Counter(c.get("pool") for c in creates)),
        "create_reserves_product_vs_k_median": round(products[len(products) // 2], 4) if products else None,
        "migrations": len(cap.get("migrations") or []),
        "sample_migration": (cap.get("migrations") or [None])[0],
        "launches_subscribed_for_trades": cap.get("trade_subs", 0),
        "trades_received": n_trades,
        "notices": cap.get("notices") or [],
        "other_tx_types": cap.get("other_tx") or {},
        "sample_create": {k: v for k, v in (creates[0] if creates else {}).items() if k != "uri"},
        "sample_trade": next((v[0] for v in trades.values() if v), None),
    }


def summarize_pairs(pairs: dict[str, dict | None]) -> dict:
    by_dex: dict[str, dict] = {}
    for p in pairs.values():
        key = (p or {}).get("dexId") or "no pair"
        d = by_dex.setdefault(key, {"pairs": 0, "liquidity_present": 0, "liquidity_usd_samples": [],
                                    "txns_m5_samples": []})
        d["pairs"] += 1
        if not p:
            continue
        liq = (p.get("liquidity") or {}).get("usd")
        if liq is not None:
            d["liquidity_present"] += 1
            if len(d["liquidity_usd_samples"]) < 5:
                d["liquidity_usd_samples"].append(round(liq))
        if len(d["txns_m5_samples"]) < 3:
            d["txns_m5_samples"].append((p.get("txns") or {}).get("m5"))
    return by_dex


def summarize_rugcheck(mint: str, report: dict, summary: dict, curve_key: str | None) -> dict:
    holders = report.get("topHolders") or []
    excl = pool_accounts(report, curve_key)
    return {
        "mint": mint,
        "report_keys": sorted(report)[:60],
        "summary_keys": sorted(summary),
        "risk_levels": dict(Counter((r.get("level") or "?") for r in report.get("risks") or [])),
        "risks": [{"name": r.get("name"), "level": r.get("level")} for r in (report.get("risks") or [])][:10],
        "mint_authority": (report.get("token") or {}).get("mintAuthority"),
        "freeze_authority": (report.get("token") or {}).get("freezeAuthority"),
        "market_types": [m.get("marketType") for m in report.get("markets") or []],
        "top_holders": len(holders),
        "holder_sample": [{k: h.get(k) for k in ("address", "owner", "pct", "insider")} for h in holders[:4]],
        "curve_in_top_holders": bool(curve_key) and any(curve_key in (h.get("address"), h.get("owner"))
                                                        for h in holders),
        "pool_accounts_found": len(excl),
        "top10_pct_raw": round(top10_pct(holders, set()), 2),
        "top10_pct_ex_pools": round(top10_pct(holders, excl), 2),
    }


async def probe_helius(s: Settings, http: httpx.AsyncClient, creates: list[dict]) -> dict:
    """Validate the on-chain reads against PumpPortal's create events for the same launches."""
    h = _helius(s, http)
    chain = HeliusChain(h)
    out: dict = {}
    keyed = [c for c in creates if c.get("bondingCurveKey")][:150]
    curves = await chain.curves([c["bondingCurveKey"] for c in keyed])
    decoded = [(c, curves.get(c["bondingCurveKey"])) for c in keyed]
    ok = [(c, cv) for c, cv in decoded if cv]
    ratios = sorted(cv.v_sol * cv.v_tokens / K for _, cv in ok if not cv.complete)
    out["curves_read"] = len(keyed)
    out["curves_decoded"] = len(ok)
    out["curves_complete"] = sum(1 for _, cv in ok if cv.complete)
    out["constant_product_ratio_min_max"] = [round(ratios[0], 4), round(ratios[-1], 4)] if ratios else None
    out["real_sol_samples"] = sorted((round(cv.real_sol, 3) for _, cv in ok), reverse=True)[:10]
    out["creator_field_matches_create"] = sum(1 for c, cv in ok if cv.creator == c.get("traderPublicKey"))
    hot = sorted(ok, key=lambda x: x[1].real_sol, reverse=True)[:3]
    out["holders"] = []
    for c, cv in hot:
        try:
            snap = await chain.holders(c["mint"], c["bondingCurveKey"], c.get("traderPublicKey"))
            out["holders"].append({"mint": c["mint"], "real_sol": round(cv.real_sol, 3),
                                   "wallets_ex_dev": snap["wallets_ex_dev"], "holders_ex_dev": snap["holders_ex_dev"],
                                   "creator_tokens": snap["creator_tokens"], "complete": snap["complete"]})
        except Exception as e:
            out["holders"].append({"mint": c["mint"], "error": _err(e)})
    out["das_show_zero_balance_supported"] = chain._das_options
    if hot:
        c, _ = hot[0]
        try:
            early = await chain.early_trades(c["mint"], c["bondingCurveKey"], s.BACKFILL_WINDOW_S, 20)
            first = early["trades"][0] if early["trades"] else None
            out["early_trades"] = {"mint": c["mint"], "reached_launch": early["reached_launch"],
                                   "transactions": early["transactions"], "trades": len(early["trades"]),
                                   "first": first}
            if first:
                out["launch_trade_matches_create"] = {
                    "trader_is_creator": first["trader"] == c.get("traderPublicKey"),
                    "sol_vs_create": round(first["sol"] / float(c["solAmount"]), 4) if c.get("solAmount") else None,
                    "tokens_vs_create": (round(first["tokens"] / float(c["initialBuy"]), 4)
                                         if c.get("initialBuy") else None)}
        except Exception as e:
            out["early_trades"] = {"error": _err(e)}
    out["credits_used"] = h.credits
    return out


async def probe_trade_local(s: Settings, http: httpx.AsyncClient, mint: str) -> dict:
    """Ask PumpPortal to build a small buy for a throwaway wallet. Never signed, never sent."""
    from solders.keypair import Keypair
    from solders.transaction import VersionedTransaction
    body = {"publicKey": str(Keypair().pubkey()), "action": "buy", "mint": mint, "amount": 0.01,
            "denominatedInSol": "true", "slippage": 10, "priorityFee": 0.0001, "pool": "auto"}
    r = await http.post(s.PUMPPORTAL_TRADE_URL, data=body, timeout=20)
    out: dict = {"http": r.status_code, "bytes": len(r.content)}
    if r.status_code == 200:
        try:
            tx = VersionedTransaction.from_bytes(r.content)
            out.update(builds=True, instructions=len(tx.message.instructions),
                       account_keys=len(tx.message.account_keys))
        except Exception as e:
            out.update(builds=False, error=_err(e))
    else:
        out.update(builds=False, body=redact(r.text[:300]))
    return out


async def probe(s: Settings, http: httpx.AsyncClient, seconds: float) -> dict:
    out: dict = {}
    cap = await capture_stream(s.pumpportal_ws(), seconds)
    out["stream"] = summarize_stream(cap)
    creates = cap["creates"]
    dex = DexScreener(http, s.DEXSCREENER_URL, s.DEX_TOKENS_RPS, s.DEX_BOOSTS_RPS)
    rug = Rugcheck(http, s.RUGCHECK_URL, s.RUGCHECK_RPS)
    # launches from this capture (1-3 minutes old) ...
    fresh = [c["mint"] for c in creates][:150]
    # ... plus older pump.fun tokens that are currently boosted (graduated or close to it)
    try:
        boosted = [b["tokenAddress"] for b in await dex.boosts() if str(b.get("tokenAddress", "")).endswith("pump")][:15]
    except Exception as e:
        boosted, out["boosts_error"] = [], _err(e)
    fresh_pairs: dict = {}
    try:
        fresh_pairs = await dex.tokens(fresh) if fresh else {}
        out["dexscreener_fresh_launches"] = summarize_pairs(fresh_pairs)
        out["dexscreener_boosted_pump_tokens"] = summarize_pairs(await dex.tokens(boosted) if boosted else {})
    except Exception as e:
        out["dexscreener_error"] = _err(e)
    # DexScreener's price vs the curve: vSol = sqrt(K x price) on an unfinished curve
    implied = []
    out["fresh_launches_without_pumpfun_pair"] = [
        {"mint": c["mint"], "pool": c.get("pool"), "dex": (fresh_pairs.get(c["mint"]) or {}).get("dexId"),
         "liquidity_usd": ((fresh_pairs.get(c["mint"]) or {}).get("liquidity") or {}).get("usd")}
        for c in creates if (fresh_pairs.get(c["mint"]) or {}).get("dexId") not in (None, "pumpfun")][:5]
    for c in creates:
        p = fresh_pairs.get(c["mint"])
        if (p or {}).get("dexId") != "pumpfun":  # the curve formula only holds on the bonding curve
            continue
        try:
            pn = float((p or {}).get("priceNative") or 0)
        except (TypeError, ValueError):
            pn = 0
        if pn > 0:
            implied.append(round(math.sqrt(K * pn) - INITIAL_VIRTUAL_SOL, 3))
    out["dexscreener_implied_net_inflow_sol_samples"] = sorted(implied, reverse=True)[:10]
    curve_of = {c["mint"]: c.get("bondingCurveKey") for c in creates}
    with_pair = [m for m in fresh if fresh_pairs.get(m)]
    rc = []
    for mint in (with_pair[:2] or fresh[:2]) + boosted[:2]:
        try:
            rc.append(summarize_rugcheck(mint, await rug.report(mint), await rug.summary(mint), curve_of.get(mint)))
        except Exception as e:
            rc.append({"mint": mint, "error": _err(e)})
    out["rugcheck"] = rc
    if s.HELIUS_API_KEY:
        try:
            out["helius"] = await probe_helius(s, http, creates)
        except Exception as e:
            out["helius"] = {"error": _err(e)}
    if creates:
        try:
            out["trade_local"] = await probe_trade_local(s, http, creates[-1]["mint"])
        except Exception as e:
            out["trade_local"] = {"error": _err(e)}
    # verdicts on the assumptions in PLAN.md
    st = out["stream"]
    hl = out.get("helius") or {}
    match = hl.get("launch_trade_matches_create") or {}
    fresh_summary = out.get("dexscreener_fresh_launches") or {}
    out["assumptions"] = {
        "pumpportal_create_fields_as_assumed": not st["create_fields_missing"],
        "create_reserves_on_pumpfun_curve (product/K ~ 1.0)": st["create_reserves_product_vs_k_median"],
        "pumpportal_trades_without_key": (f"{st['trades_received']} trades for {st['launches_subscribed_for_trades']} "
                                          "subscribed launches" + (" (paid stream needed, as expected)"
                                                                   if not st["trades_received"] else "")),
        "dexscreener_pairs_for_fresh_launches": (f"{len(fresh) - fresh_summary.get('no pair', {}).get('pairs', 0)}"
                                                 f"/{len(fresh)} have a pair"),
        "dexscreener_liquidity_on_bonding_curve_pairs": (
            f"{(fresh_summary.get('pumpfun') or {}).get('liquidity_present', 0)}/"
            f"{(fresh_summary.get('pumpfun') or {}).get('pairs', 0)} pumpfun pairs report liquidity.usd"),
        "rugcheck_curve_or_pool_in_top_holders": [r.get("curve_in_top_holders") or
                                                  r.get("top10_pct_raw", 0) > r.get("top10_pct_ex_pools", 0)
                                                  for r in rc if "error" not in r],
        "helius_curves_decode": (f"{hl.get('curves_decoded')}/{hl.get('curves_read')}, constant product "
                                 f"{hl.get('constant_product_ratio_min_max')}") if hl and "error" not in hl
        else ("not checked: HELIUS_API_KEY not set" if not s.HELIUS_API_KEY else hl.get("error")),
        "launch_trade_rebuilt_from_chain_matches_create": match or None,
        "trade_local_builds_unsigned_tx": (out.get("trade_local") or {}).get("builds"),
    }
    return out


def render(checks: list[Check], probe_out: dict | None) -> str:
    icon = {"pass": "PASS", "fail": "FAIL", "warn": "WARN", "skip": "skip"}
    lines = ["== preflight =="]
    for c in checks:
        lines.append(f"{icon[c.status]:4s}  {c.name:24s} {c.detail}{'   (required)' if c.required and c.status == 'fail' else ''}")
    if probe_out:
        st = probe_out["stream"]
        lines += ["", "== live probe ==",
                  f"stream: {st['launches']} launches ({st['launches_per_min']}/min), {st['migrations']} migrations, "
                  f"{st['trades_received']} trades for {st['launches_subscribed_for_trades']} subscribed launches",
                  f"missing create fields: {st['create_fields_missing'] or 'none'}; create pools: {st['create_pools']}",
                  f"create fields: {st['create_fields_seen']}",
                  f"sample migration: {json.dumps(st['sample_migration'], default=str)}",
                  f"notices: {sorted(set(json.dumps(n, default=str) for n in st['notices'])) or 'none'}"]
        for key in ("dexscreener_fresh_launches", "dexscreener_boosted_pump_tokens", "fresh_launches_without_pumpfun_pair",
                    "dexscreener_implied_net_inflow_sol_samples", "helius", "trade_local"):
            if key in probe_out:
                lines.append(f"{key}: " + json.dumps(probe_out[key], default=str))
        for r in probe_out.get("rugcheck", []):
            lines.append("rugcheck " + json.dumps({k: r.get(k) for k in (
                "mint", "error", "risk_levels", "risks", "market_types", "mint_authority", "freeze_authority",
                "curve_in_top_holders", "top10_pct_raw", "top10_pct_ex_pools")} if "error" not in r else r))
        lines += ["", "== assumptions =="] + [f"{k}: {v}" for k, v in probe_out["assumptions"].items()]
    return "\n".join(lines)


async def run_preflight(s: Settings, do_probe: bool = False, seconds: float = 150, need_llm: bool = True) -> int:
    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": "meme-agents/0.1"}) as http:
        checks = await run_checks(s, http, need_llm)
        probe_out = None
        if do_probe:
            try:
                probe_out = await probe(s, http, seconds)
            except Exception as e:
                probe_out = {"stream": summarize_stream({"creates": [], "trades": {}, "seconds": seconds}),
                             "assumptions": {"probe_failed": _err(e)}}
    text = render(checks, probe_out)
    print(text)
    out_dir = s.path(s.REPORTS_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = out_dir / f"preflight-{stamp}.json"
    path.write_text(redact(json.dumps({"checks": [asdict(c) for c in checks], "probe": probe_out}, indent=2,
                                      default=str)))
    path.with_suffix(".txt").write_text(redact(text) + "\n")
    print(f"\nwritten: {path} (and .txt)")
    failed = [c.name for c in checks if c.required and c.status == "fail"]
    if failed:
        print(f"required checks failed: {', '.join(failed)}")
        return 1
    return 0
