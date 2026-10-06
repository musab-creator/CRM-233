"""Offline simulation: synthetic pump.fun launches on a real constant-product bonding curve,
plus fake DexScreener/Rugcheck/Helius/X/news/Claude. Exercises the full pipeline (ingest ->
pre-filter -> three agents with tool calls -> gate -> paper fills -> exits -> report) with
no network and no API keys. Writes to data/sim.db and reports/sim/ so real data is untouched.

    python -m bot simulate --minutes 60
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import random
import string
import time
from dataclasses import dataclass, field
from types import SimpleNamespace

from .feeds.rugcheck import normalise

SIM_OVERRIDES = {
    "MODE": "paper", "DB_PATH": "data/sim.db", "REPORTS_DIR": "reports/sim", "STOP_FILE": "STOP_SIM",
    "LOG_FILE": "logs/sim.log",
    "PF_MIN_AGE_MIN": "1", "PF_MAX_AGE_MIN": "30", "PF_MIN_UNIQUE_BUYERS": "15", "PF_MIN_NET_INFLOW_SOL": "3",
    "PF_MIN_LIQUIDITY_USD": "3000", "PF_SCAN_INTERVAL_S": "5", "TIME_STOP_HOURS": "0.25", "LIQ_POLL_S": "20",
    "RUGCHECK_POLL_S": "60", "TELEGRAM_BOT_TOKEN": "", "ANTHROPIC_API_KEY": "", "X_BEARER_TOKEN": "",
    "HELIUS_API_KEY": "", "LIVE_CONFIRM": "", "WALLET_PRIVATE_KEY": "",
}

SOL_USD = 150.0
K = 30.0 * 1_073_000_000.0  # pump.fun virtual reserves product (SOL * tokens)
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def addr(rng: random.Random, suffix: str = "") -> str:
    return "".join(rng.choice(B58) for _ in range(44 - len(suffix))) + suffix


@dataclass
class SimToken:
    mint: str
    name: str
    symbol: str
    creator: str
    curve: str
    fate: str           # pump | rug | rug_fast | dud
    born: float
    v_sol: float = 30.0
    v_tokens: float = 1_073_000_000.0
    holders: dict = field(default_factory=dict)
    dumped: bool = False

    def price(self) -> float:
        return self.v_sol / self.v_tokens


class SimFeed:
    """Same interface as PumpPortalFeed."""

    def __init__(self, on_message, seed: int = 7, launch_every_s: float = 20.0, speed: float = 1.0):
        self.on_message = on_message
        self.rng = random.Random(seed)
        self.launch_every_s = launch_every_s
        self.speed = speed
        self.tokens: dict[str, SimToken] = {}
        self.token_keys: set[str] = set()
        self.account_keys: set[str] = set()
        self.reconnects = 0
        self.wallets = [addr(self.rng) for _ in range(600)]

    async def subscribe_tokens(self, mints):
        self.token_keys.update(mints)

    async def unsubscribe_tokens(self, mints):
        self.token_keys.difference_update(mints)

    async def subscribe_accounts(self, w):
        self.account_keys.update(w)

    async def unsubscribe_accounts(self, w):
        self.account_keys.difference_update(w)

    def _launch(self) -> dict:
        r = self.rng
        sym = "".join(r.choice(string.ascii_uppercase) for _ in range(r.randint(3, 5)))
        fate = r.choices(["pump", "rug", "rug_fast", "dud"], weights=[0.3, 0.2, 0.15, 0.35])[0]
        t = SimToken(addr(r, "pump"), f"{sym.title()} Coin", sym, r.choice(self.wallets[:80]), addr(r), fate,
                     time.time())
        self.tokens[t.mint] = t
        initial = r.uniform(0.5, 2.0)
        out = self._buy(t, t.creator, initial)
        return {"signature": addr(r), "mint": t.mint, "traderPublicKey": t.creator, "txType": "create",
                "initialBuy": out, "solAmount": initial, "bondingCurveKey": t.curve,
                "vTokensInBondingCurve": t.v_tokens, "vSolInBondingCurve": t.v_sol,
                "marketCapSol": t.price() * 1e9, "name": t.name, "symbol": t.symbol, "uri": "", "pool": "pump"}

    def _buy(self, t: SimToken, who: str, sol: float) -> float:
        t.v_sol += sol
        new_tokens = K / t.v_sol
        out = t.v_tokens - new_tokens
        t.v_tokens = new_tokens
        t.holders[who] = t.holders.get(who, 0) + out
        return out

    def _sell(self, t: SimToken, who: str, frac: float) -> tuple[float, float]:
        tok = t.holders.get(who, 0) * frac
        if tok <= 0:
            return 0.0, 0.0
        t.v_tokens += tok
        new_sol = K / t.v_tokens
        sol = t.v_sol - new_sol
        t.v_sol = new_sol
        t.holders[who] -= tok
        return sol, tok

    def _trade(self, t: SimToken) -> dict | None:
        r = self.rng
        age = (time.time() - t.born) * self.speed / 60
        dump_at = {"rug": 7.0, "rug_fast": 2.0}.get(t.fate)
        if t.fate == "dud":
            p_buy = 0.5
        elif t.fate == "pump":
            p_buy = 0.8 if age < 6 else (0.6 if age < 12 else 0.35)
        elif t.fate == "rug_fast":
            p_buy = 0.85 if age < 1.5 else 0.2
        else:
            p_buy = 0.8 if age < 4 else 0.3
        if dump_at is not None and age > dump_at and not t.dumped:
            t.dumped = True
            sol, tok = self._sell(t, t.creator, 1.0)
            who, side = t.creator, "sell"
        elif r.random() < p_buy:
            who = r.choice(self.wallets)
            sol = r.uniform(0.05, 1.0)
            tok = self._buy(t, who, sol)
            side = "buy"
        else:
            sellers = [w for w, v in t.holders.items() if v > 0 and w != t.creator]
            if not sellers:
                return None
            who = r.choice(sellers)
            sol, tok = self._sell(t, who, r.uniform(0.3, 1.0))
            side = "sell"
        if tok <= 0:
            return None
        return {"signature": addr(r), "mint": t.mint, "traderPublicKey": who, "txType": side,
                "tokenAmount": tok, "solAmount": sol, "newTokenBalance": t.holders.get(who, 0),
                "bondingCurveKey": t.curve, "vTokensInBondingCurve": t.v_tokens, "vSolInBondingCurve": t.v_sol,
                "marketCapSol": t.price() * 1e9, "pool": "pump"}

    async def run(self, stop: asyncio.Event) -> None:
        next_launch = 0.0
        while not stop.is_set():
            now = time.time()
            if now >= next_launch:
                next_launch = now + self.rng.expovariate(1 / self.launch_every_s)
                await self.on_message(self._launch())
            for t in list(self.tokens.values()):
                age_min = (now - t.born) * self.speed / 60
                if age_min > 40:
                    self.tokens.pop(t.mint)
                    continue
                rate = {"pump": 1.2, "rug": 1.0, "rug_fast": 1.1, "dud": 0.15}[t.fate] * (1.0 if age_min < 15 else 0.4)
                if self.rng.random() < rate * 0.25 and t.mint in self.token_keys:
                    msg = self._trade(t)
                    if msg:
                        await self.on_message(msg)
            await asyncio.sleep(0.25)


class FakeDex:
    def __init__(self, feed: SimFeed):
        self.feed = feed

    def _pair(self, mint: str) -> dict | None:
        t = self.feed.tokens.get(mint)
        if not t:
            return None
        liq = t.v_sol * 2 * SOL_USD - 30 * SOL_USD
        return {"chainId": "solana", "dexId": "pumpfun", "pairAddress": t.curve, "url": f"sim://{mint}",
                "baseToken": {"address": mint, "name": t.name, "symbol": t.symbol},
                "priceNative": str(t.price()), "priceUsd": str(t.price() * SOL_USD),
                "liquidity": {"usd": max(0.0, liq)}, "fdv": t.price() * 1e9 * SOL_USD,
                "marketCap": t.price() * 1e9 * SOL_USD, "txns": {"m5": {"buys": 20, "sells": 8}},
                "volume": {"m5": 1000.0}, "info": {"socials": [{"type": "twitter", "url": f"https://x.com/{t.symbol}"}]}}

    async def tokens(self, mints):
        return {m: self._pair(m) for m in mints}

    async def pair(self, mint):
        return self._pair(mint)

    async def search(self, q):
        return []

    async def boosts(self):
        return []

    async def sol_usd(self):
        return SOL_USD


class FakeRug:
    def __init__(self, feed: SimFeed):
        self.feed = feed

    async def report(self, mint):
        return {}

    async def check(self, mint, bonding_curve_key=None, max_age_s=300):
        t = self.feed.tokens.get(mint)
        h = int(hashlib.sha1(mint.encode()).hexdigest(), 16)
        danger = [{"name": "Creator sold all tokens", "level": "danger", "value": ""}] if t and t.dumped else []
        report = {"token": {"mintAuthority": None, "freezeAuthority": None},
                  "risks": danger + ([{"name": "Low Liquidity", "level": "warn"}] if h % 3 == 0 else []),
                  "topHolders": [{"address": f"H{i}", "owner": f"O{i}", "pct": 1 + (h >> i) % 3, "insider": False}
                                 for i in range(12)],
                  "markets": [], "score": 500, "score_normalised": 10}
        return normalise({"score_normalised": 10, "lpLockedPct": 0}, report, bonding_curve_key)


class FakeHelius:
    async def balance_sol(self, pubkey):
        return 0.1

    async def holders(self, mint, exclude=None):
        return {"supply": 1e9, "holders": [], "top10_pct_ex_pools": 22.0, "top1_pct_ex_pools": 4.0}

    async def address_transactions(self, address, limit=20):
        return []


class FakeX:
    async def search(self, query, max_results=10, since_ts=None):
        return {"posts": [{"post_id": str(1843327776011239424 + i), "author": f"a{i}",
                           "text": f"{query} looks fun {i}", "created_at": "2026-01-01T00:00:00Z", "metrics": {}}
                          for i in range(5)]}

    async def timeline(self, handle, window_min, refresh_min, max_results=5):
        return {"posts": []}


class FakeNews:
    async def recent(self, window_min):
        return [{"source": "rss:sim", "title": "Markets steady", "url": None, "published_ts": time.time() - 600}]

    async def items(self):
        return await self.recent(60)


def _tool_fact(messages: list[dict]) -> str | None:
    """A citable fact (id or number) from the latest successful tool result, as a real agent
    is instructed to quote; None if the tools returned nothing citable."""
    from .agents.grounding import _salient
    last = messages[-1]
    if last["role"] != "user" or isinstance(last["content"], str):
        return None
    for block in last["content"]:
        if isinstance(block, dict) and block.get("type") == "tool_result" and not block.get("is_error"):
            ids, nums = _salient(block["content"])
            if ids:
                return f"id {sorted(ids)[0]}"
            if nums:
                return f"value {nums[0]}"
    return None


class FakeLLM:
    """Stands in for anthropic.AsyncAnthropic: one tool call, then submit_vote citing a fact
    from that call's result (or nothing citable, which the grounding guard then rejects)."""

    def __init__(self):
        self.messages = self
        self.calls = 0

    async def create(self, *, model, max_tokens, system, tools, messages, **kw):
        self.calls += 1
        await asyncio.sleep(0.05)
        first = messages[0]["content"]
        data = json.loads(first.split("\n", 1)[1])
        mint = data["mint"]
        role = system[0]["text"].split("Your role: ")[1].split(" ")[0].lower()
        usage = SimpleNamespace(input_tokens=1500, output_tokens=150, cache_creation_input_tokens=0,
                                cache_read_input_tokens=0)
        tool_names = [t["name"] for t in tools if t["name"] != "submit_vote"]
        if len(messages) == 1:
            name = tool_names[0]
            args = {"query": f"${data.get('symbol')} -is:retweet"} if name == "x_search" else \
                   {"handle": "elonmusk"} if name == "x_user_timeline" else {"mint": mint}
            block = SimpleNamespace(type="tool_use", id=f"tu_{self.calls}", name=name, input=args)
            return SimpleNamespace(content=[block], stop_reason="tool_use", usage=usage)
        h = int(hashlib.sha1((mint + role).encode()).hexdigest(), 16)
        buy = h % 100 < 70
        pf = data.get("prefilter") or {}
        evidence = [f"unique_buyers {pf.get('unique_buyers')}", f"net_inflow_sol {pf.get('net_inflow_sol')}"]
        fact = _tool_fact(messages)
        if fact:
            evidence.append(fact)
        vote = {"vote": "BUY" if buy else "PASS", "confidence": round(0.55 + (h % 40) / 100, 2),
                "reasons": [f"sim {role} reasoning"], "evidence": evidence}
        if any(t["name"] == "submit_vote" and "size_usd" in t["input_schema"]["properties"] for t in tools):
            vote["size_usd"] = 5 + (h % 6)
        block = SimpleNamespace(type="tool_use", id=f"tu_{self.calls}", name="submit_vote", input=vote)
        return SimpleNamespace(content=[block], stop_reason="tool_use", usage=usage)


def build_sim_engine(settings, seed: int = 7, launch_every_s: float = 20.0):
    from .engine import Engine
    eng = Engine(settings, llm=FakeLLM())
    feed = SimFeed(eng.ingest.handle, seed=seed, launch_every_s=launch_every_s)
    eng.feed = feed
    eng.dex = FakeDex(feed)
    eng.rug = FakeRug(feed)
    eng.helius = FakeHelius()
    eng.x = FakeX()
    eng.news = FakeNews()
    from .feeds.prices import SolPrice
    eng.sol_price = SolPrice(eng.dex.sol_usd, 60)
    return eng
