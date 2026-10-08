"""Wires feeds -> ingest -> pre-filter -> agents -> consensus -> executor -> exits.

Data: PumpPortal's free stream announces launches and graduations. Per-token state (net
inflow, price, buyers) is read from the chain through Helius (`chain`). PumpPortal's paid
per-token trade stream is optional and budgeted (PUMPPORTAL_TRADE_STREAM).
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

import anthropic
import httpx

from .agents.base import Vote, run_agent, vote_tool, worst_case_call_usd
from .agents.tools import ToolContext, build_specs, build_veto_specs
from .agents.triage import run_triage, triage_first_call_usd, triage_skips, verify_triage
from .budget import Budget, utc_day, utc_month
from .commands import TelegramCommands
from .ops import consume_keep_pause
from .config import Settings, validate_settings
from .consensus import VETO_AGENTS, apply_vetoes, gate
from .db import Database
from .digest import hour_start, hourly_digest
from .feeds.dexscreener import DexScreener, summarize_pair
from .feeds.helius import Helius, RpcError
from .feeds.http import HttpError
from .feeds.news import NewsFeed
from .feeds.prices import SolPrice, chained, coingecko_sol_usd
from .feeds.pumpchain import HeliusChain
from .feeds.pumpportal import PumpPortalFeed
from .feeds.rugcheck import Rugcheck
from .feeds.xapi import XClient
from .features import chain_features, flow_features
from .ingest import Ingestor, MintState
from .live.guard import check_live_startup
from .paper import PaperExecutor
from .positions import PositionManager
from .prefilter import curve_liquidity_usd, full_check, stage1
from .regime import Regime, apply_regime_size, market_snapshot, run_regime
from .report import write_daily
from .risk import RiskManager, kill_switch_active
from .telegram import Telegram
from .util import InstanceLock, backoff_delay, now_s, sd_notify

log = logging.getLogger("bot.engine")

STAGE2_RECHECK_S = 300
CANDIDATE_MAX_WAIT_S = 600
EXTERNAL_ERRORS = (HttpError, RpcError, httpx.HTTPError, asyncio.TimeoutError)


class StartupError(Exception):
    pass


def _vote_label(v) -> str:
    """How a vote reads in the chat: the committee's BUY/PASS, a veto agent's veto / no veto."""
    if v.agent in VETO_AGENTS:
        return "VETO" if v.vote == "PASS" else "no veto"
    return v.vote


def credit_pace(total: int, monthly: int, ts: float) -> tuple[bool, bool]:
    """(over pace, exhausted) for this month's Helius credits. Over pace: more than 10% ahead of
    a straight line through the month, the first day counting as a full day. Exhausted: the
    monthly budget is spent."""
    allowed = monthly * max(month_fraction(ts), 1 / 30)
    return total > 1.1 * allowed, total >= monthly


def month_fraction(ts: float) -> float:
    """Share of the current UTC month that has elapsed."""
    d = datetime.fromtimestamp(ts, timezone.utc)
    start = d.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    nxt = (start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1))
    return (d - start).total_seconds() / (nxt - start).total_seconds()


class Engine:
    def __init__(self, s: Settings, *, http: httpx.AsyncClient | None = None, feed=None, dex=None, rug=None,
                 helius=None, x=None, news=None, llm=None, chain=None):
        validate_settings(s)
        self.s = s
        self.started_at = now_s()
        self.db = Database(s.path(s.DB_PATH))
        self.lock = InstanceLock(str(s.path(s.DB_PATH)) + ".lock")
        self.http = http or httpx.AsyncClient(timeout=20, headers={"User-Agent": "meme-agents/0.1"})
        self.llm_budget = Budget(self.db, "llm", s.LLM_DAILY_BUDGET_USD, "day",
                                 burst_h=s.LLM_BUDGET_BURST_HOURS if s.LLM_BUDGET_PACING else None)
        self.x_budget = Budget(self.db, "x", s.X_MONTHLY_BUDGET_USD, "month")
        self.ingest = Ingestor(s, self.db)
        self.feed = feed or PumpPortalFeed(s.pumpportal_ws(), self.ingest.handle, s.WS_MAX_BACKOFF_S,
                                                s.WS_STALL_S)
        self.dex = dex or DexScreener(self.http, s.DEXSCREENER_URL, s.DEX_TOKENS_RPS, s.DEX_BOOSTS_RPS)
        self.rug = rug or Rugcheck(self.http, s.RUGCHECK_URL, s.RUGCHECK_RPS)
        self.helius = helius or Helius(self.http, s.helius_rpc(), s.HELIUS_API_URL, s.HELIUS_API_KEY,
                                       s.HELIUS_RPC_RPS, s.HELIUS_ENHANCED_RPS)
        self.chain = chain or HeliusChain(self.helius)
        self.x = x or XClient(self.http, s.X_API_URL, s.X_BEARER_TOKEN, self.db, self.x_budget,
                              s.X_POST_READ_USD, s.X_USER_READ_USD)
        self.news = news or NewsFeed(self.http, s.CRYPTOPANIC_URL, s.CRYPTOPANIC_TOKEN, s.NEWS_RSS_URLS,
                                     s.TRUTH_SOCIAL_RSS_URL, s.NEWS_REFRESH_MIN)
        self.llm = llm if llm is not None else (
            anthropic.AsyncAnthropic(api_key=s.ANTHROPIC_API_KEY, max_retries=2) if s.ANTHROPIC_API_KEY else None)
        self.tg = Telegram(self.http, s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID)
        sources = [self.dex.sol_usd]
        if s.SOL_USD_FALLBACK_URL:
            sources.append(lambda: coingecko_sol_usd(self.http, s.SOL_USD_FALLBACK_URL))
        self.sol_price = SolPrice(chained(*sources), 60)
        self.risk = RiskManager(s, self.started_at, db=self.db)
        self.executor = PaperExecutor(s)
        self.positions: PositionManager | None = None
        self.queue: asyncio.Queue[int] = asyncio.Queue()
        self._stage2_at: dict[str, float] = {}
        self._early: dict[str, dict] = {}       # launch-minute trades per candidate, fetched once
        self.cycles = 0
        self.triage_skips = 0                   # candidates the triage screen kept from the agents
        self.crashes: dict[str, int] = {}       # background loops that raised (each is restarted)
        self.stream_mode = s.PUMPPORTAL_TRADE_STREAM
        self._stream_blocked_day: str | None = None
        self._stream_saved = 0
        self._credits_saved = 0
        self._credits_over_pace = False   # ahead of the month's Helius budget: slower, cheaper reads
        self._credits_exhausted = False   # the month's Helius budget is spent: no chain reads
        self._digest_hour: float | None = None  # start of the hour the next Telegram digest covers
        self.regime = Regime()                   # market regime: sizes entries down or pauses them
        self._regime_at: float | None = None
        self.stop = asyncio.Event()

    # --- setup ---------------------------------------------------------------------
    async def setup(self) -> None:
        if not self.lock.acquire():
            raise StartupError(f"another bot process is already using {self.s.path(self.s.DB_PATH)}; "
                               "stop it first (systemctl stop meme-agents, or Ctrl-C the other terminal)")
        await self.db.open()
        await self.risk.startup()
        kp = await check_live_startup(self.s, self.helius.balance_sol)  # raises LiveRefused
        if kp is not None:
            from .live.executor import LiveExecutor
            self.executor = LiveExecutor(self.s, self.db, self.http, kp, self._is_graduated, chain=self.helius)
            log.warning("LIVE MODE wallet %s, dry_run=%s", self.executor.pubkey, self.executor.dry_run)
        self.positions = PositionManager(
            self.s, self.db, self.risk, self.executor, self.sol_price, dex=self.dex, rugcheck=self.rug,
            notifier=self.tg.send if self.tg.enabled else None, pin=self._pin, watch_account=self._watch_account,
            curve_liquidity=self._curve_liquidity)
        self.ingest.subscribe = self.feed.subscribe_tokens
        self.ingest.unsubscribe = self.feed.unsubscribe_tokens
        self.ingest.tick_handlers.append(self.positions.on_tick)
        if self.stream_mode != "off" and not self.s.PUMPPORTAL_API_KEY and isinstance(self.feed, PumpPortalFeed):
            log.warning("PUMPPORTAL_TRADE_STREAM=%s needs PUMPPORTAL_API_KEY: since May 2026 PumpPortal streams "
                        "per-token trades only to funded API keys. Continuing with the stream off.", self.stream_mode)
            self.stream_mode = "off"
        if self.stream_mode != "all" and not self.chain.enabled:
            raise StartupError("HELIUS_API_KEY is required: net inflow, buyers and prices are read from the chain "
                               "through Helius (the free plan is enough). See KEYS.md.")
        await self._check_stream_budget()
        self.ingest.stream_new_tokens = self.stream_mode == "all" and self._stream_ok()
        await self.ingest.restore()
        sol = await self.sol_price.refresh()
        for attempt in range(4):
            if sol:
                break
            await asyncio.sleep(2 ** attempt)
            sol = await self.sol_price.refresh()
        if not await self.db.kv_get("bankroll_sol"):
            if not sol:
                raise StartupError("cannot fetch SOL/USD from DexScreener to convert the starting bankroll; "
                                   "check network access to api.dexscreener.com")
            await self.db.kv_set("bankroll_sol", str(self.s.BANKROLL_USD / sol))
            await self.db.kv_set("bankroll_sol_usd", str(sol))
            log.info("bankroll initialised: $%.2f = %.4f SOL @ $%.2f", self.s.BANKROLL_USD,
                     self.s.BANKROLL_USD / sol, sol)
        await self.positions.load()
        self.risk.register_realized(await self.positions.realized_since(self.risk.loss_window_start(now_s())))
        await self.risk.persist()
        await self._restore_stream_subscriptions()
        # candidates that were queued but never evaluated before a restart
        for c in await self.db.fetchall("SELECT id FROM candidates WHERE status='pending'"):
            self.queue.put_nowait(c["id"])
        if not self.llm:
            log.warning("ANTHROPIC_API_KEY not set: every agent vote will be PASS (error recorded)")
        self._credits_saved = getattr(self.helius, "credits", 0)
        log.info("data: launches from PumpPortal, per-token state from %s, paid trade stream %s",
                 "the chain via Helius" if self.chain.enabled else "the trade stream", self.stream_mode)
        await self.db.event("startup", {"mode": self.s.MODE, "model": self.s.LLM_MODEL,
                                        "trade_stream": self.stream_mode}, now_s())

    def _curve_liquidity(self, mint: str) -> float | None:
        """A bonding-curve token's depth from the last curve read (None once graduated)."""
        st = self.ingest.mints.get(mint)
        return curve_liquidity_usd(st, self.sol_price.get()) if st and st.curve_at else None

    def _is_graduated(self, mint: str) -> bool:
        st = self.ingest.mints.get(mint)
        return bool(st and st.graduated)

    def _pin(self, mint: str, on: bool) -> None:
        """Candidates, positions and shadows: read their curves often; stream their trades if paid for."""
        if on:
            self.ingest.pinned.add(mint)
            if mint not in self.ingest.mints:
                self.ingest.mints[mint] = MintState(mint=mint, first_trade_at=now_s(), status="evaluated")
            if self._stream_ok():
                asyncio.get_running_loop().create_task(self.feed.subscribe_tokens([mint]))
        else:
            self.ingest.pinned.discard(mint)

    async def _watch_account(self, wallet: str, on: bool) -> None:
        if on and self._stream_ok():
            await self.feed.subscribe_accounts([wallet])
        elif not on:
            await self.feed.unsubscribe_accounts([wallet])

    # --- paid trade stream budget -------------------------------------------------------
    def _stream_ok(self) -> bool:
        return self.stream_mode != "off" and self._stream_blocked_day is None

    async def _restore_stream_subscriptions(self) -> None:
        """Restore existing subscriptions after restart or a daily budget reset."""
        if not self._stream_ok():
            return
        mints = set(self.ingest.pinned)
        if self.stream_mode == "all":
            mints.update(st.mint for st in self.ingest.mints.values() if st.status == "tracking")
        if mints:
            await self.feed.subscribe_tokens(sorted(mints))
        if self.positions:
            wallets = {p.creator for p in self.positions.active(None) if p.creator}
            if wallets:
                await self.feed.subscribe_accounts(sorted(wallets))

    async def _check_stream_budget(self) -> None:
        """Count streamed trades per UTC day (persisted) and cut the stream at the budget."""
        if self.stream_mode == "off":
            return
        day = utc_day()
        n = self.ingest.stats["stream_trades"]
        delta, self._stream_saved = n - self._stream_saved, n
        key = f"pumpportal_trades:{day}"
        total = int(await self.db.kv_get(key) or 0) + delta
        if delta:
            await self.db.kv_set(key, str(total))
        spent = total * self.s.PUMPPORTAL_SOL_PER_TRADE
        # compare whole trades: 50 x 0.000001 is 4.9999999999999996e-05 in floating point
        limit = (int(self.s.PUMPPORTAL_DAILY_BUDGET_SOL / self.s.PUMPPORTAL_SOL_PER_TRADE + 1e-6)
                 if self.s.PUMPPORTAL_SOL_PER_TRADE > 0 else None)
        if limit is not None and total >= limit and self._stream_blocked_day != day:
            self._stream_blocked_day = day
            log.warning("PumpPortal trade stream budget reached: %d trades = %.4f SOL today; streaming stops "
                        "until UTC midnight, the chain reads carry on", total, spent)
            self.ingest.stream_new_tokens = False
            for st in self.ingest.mints.values():
                st.streamed = False
            await self.feed.unsubscribe_tokens(sorted(self.feed.token_keys))
            await self.feed.unsubscribe_accounts(sorted(self.feed.account_keys))
        elif self._stream_blocked_day and self._stream_blocked_day != day:
            self._stream_blocked_day = None  # a new UTC day
            self.ingest.stream_new_tokens = self.stream_mode == "all"
            await self._restore_stream_subscriptions()
            log.info("PumpPortal trade stream budget reset for %s", day)

    async def stream_guard(self) -> None:
        while not self.stop.is_set():
            await self._sleep(5)
            await self._check_stream_budget()

    # --- bonding-curve reads ------------------------------------------------------------
    def _poll_interval(self, st: MintState) -> float:
        """Seconds until a tracked launch's curve is read again: the closer to the pre-filter's
        inflow bar, the sooner. Most launches stay below 0.5 SOL and are read every 4 minutes."""
        rs = st.real_sol or 0.0
        k = self.s.CURVE_POLL_SCALE
        if rs >= 0.5 * self.s.PF_MIN_NET_INFLOW_SOL:
            return 20.0 * k
        if rs >= 2.0:
            return 45.0 * k
        if rs >= 0.5:
            return 120.0 * k
        return 240.0 * k

    async def poll_curves_once(self) -> int:
        """One getMultipleAccounts call (1 credit): pinned mints first, then the most overdue launches."""
        now = now_s()
        pinned = self.ingest.pinned
        live = [st for st in self.ingest.mints.values()
                if st.bonding_curve_key and not st.graduated and not st.streamed]
        hot = [st for st in live if st.mint in pinned and now - st.curve_at >= self.s.CURVE_HOT_POLL_S]
        due = sorted((st for st in live if st.mint not in pinned and st.status == "tracking"
                      and st.next_poll_at <= now), key=lambda st: st.next_poll_at)
        batch = (hot + due)[:100]
        if not batch:
            return 0
        curves = await self.chain.curves([st.bonding_curve_key for st in batch])
        now = now_s()
        for st in batch:
            c = curves.get(st.bonding_curve_key)
            if c is None:  # not on chain yet, or not a bonding curve: look again later
                st.next_poll_at = now + 300
                continue
            await self.ingest.apply_curve(st.mint, c, now)
            st.next_poll_at = now + self._poll_interval(st)
        return len(batch)

    def _curve_tick_s(self) -> float:
        base = 60.0 / max(0.1, self.s.CURVE_POLL_CALLS_PER_MIN)
        return base * (2.0 if self._credits_over_pace else 1.0)

    async def curve_poller(self) -> None:
        if not self.chain.enabled:  # every launch is streamed instead (PUMPPORTAL_TRADE_STREAM=all)
            await self.stop.wait()
            return
        while not self.stop.is_set():
            if self._credits_exhausted:  # the month's Helius budget is spent; the heartbeat resets this next month
                await self._sleep(300)
                continue
            try:
                await self.poll_curves_once()
            except EXTERNAL_ERRORS as e:
                log.warning("curve read failed: %s", e)
            await self._sleep(self._curve_tick_s())

    async def _record_credits(self) -> int:
        """Persist this month's Helius credits and keep the chain reads inside the monthly budget.

        Ahead of pace: curve reads run at half speed, holder counts refresh half as often and the
        launch-minute backfill reads half as many transactions. Budget spent: chain reads stop
        until next month and `status` reports PAUSED, instead of hammering a rate-limited key."""
        used = getattr(self.helius, "credits", 0)
        delta, self._credits_saved = used - self._credits_saved, used
        key = f"helius_credits:{utc_month()}"
        total = int(await self.db.kv_get(key) or 0) + delta
        if delta:
            await self.db.kv_set(key, str(total))
        over, exhausted = credit_pace(total, self.s.HELIUS_MONTHLY_CREDITS, now_s())
        if exhausted != self._credits_exhausted:
            log.warning("Helius credits %d this month vs HELIUS_MONTHLY_CREDITS=%d: chain reads %s", total,
                        self.s.HELIUS_MONTHLY_CREDITS, "stopped until next month" if exhausted else "resumed")
        elif over != self._credits_over_pace:
            log.warning("Helius credits %d this month vs %d on pace: chain reads %s", total,
                        int(self.s.HELIUS_MONTHLY_CREDITS * max(month_fraction(now_s()), 1 / 30)),
                        "slowed to half speed" if over else "back to full speed")
        self._credits_over_pace, self._credits_exhausted = over, exhausted
        return total

    async def refresh_holders(self, st: MintState) -> None:
        try:
            snap = await self.chain.holders(st.mint, st.bonding_curve_key, st.creator)
        except EXTERNAL_ERRORS as e:
            log.warning("holders %s failed: %s", st.mint, e)
            st.holders_at = now_s()  # try again after the refresh interval, not every scan
            return
        self.ingest.apply_holders(st.mint, snap, now_s())

    def _needs_holders(self, st: MintState, now: float) -> bool:
        """Buyers are the only stage-1 rule still failing and the holder count is stale."""
        s = self.s
        refresh_s = s.HOLDERS_REFRESH_S * (2 if self._credits_over_pace else 1)
        return (self.chain.enabled and not self._credits_exhausted and not st.streamed
                and st.bonding_curve_key != ""
                and s.PF_MIN_AGE_MIN <= st.age_min(now) <= s.PF_MAX_AGE_MIN
                and st.net_inflow_sol >= s.PF_MIN_NET_INFLOW_SOL
                and st.unique_buyers < s.PF_MIN_UNIQUE_BUYERS
                and now - (st.holders_at or 0) >= refresh_s)

    async def compute_flow(self, mint: str) -> dict:
        """Flow features for a mint: from the full stream if it was streamed since launch, else
        from the chain (launch-minute trades fetched once, fresh holders, curve reads)."""
        now = now_s()
        st = self.ingest.mints.get(mint)
        m = await self.db.fetchone("SELECT creator, bonding_curve_key, first_trade_at FROM mints WHERE mint=?",
                                   [mint]) or {}
        creator = (st.creator if st else "") or m.get("creator")
        if st and st.streamed:
            return flow_features(await self.db.all_trades(mint), creator, now)
        curve = (st.bonding_curve_key if st else "") or m.get("bonding_curve_key")
        if not curve or not self.chain.enabled:
            return {"source": "chain", "error": "no bonding-curve key or no Helius key: flow unavailable"}
        if self._credits_exhausted:
            return {"source": "chain", "error": "Helius monthly credit budget spent: flow unavailable until next month"}
        err = None
        early = self._early.get(mint)
        if early is None:
            try:
                max_tx = self.s.BACKFILL_MAX_TX // (2 if self._credits_over_pace else 1)
                early = await self.chain.early_trades(mint, curve, self.s.BACKFILL_WINDOW_S, max_tx)
                self._early[mint] = early
                while len(self._early) > 500:
                    self._early.pop(next(iter(self._early)))
                await self.db.insert_trades([(t["signature"], mint, t["trader"], t["side"], t["sol"], t["tokens"],
                                              t["price_sol"], None, None, None, "pump", t["ts"])
                                             for t in early["trades"] if t["ts"]])
            except EXTERNAL_ERRORS as e:
                early, err = {"trades": [], "reached_launch": False}, f"launch-minute trades: {e}"
        holders = None
        try:
            holders = await self.chain.holders(mint, curve, creator)
            if st:
                self.ingest.apply_holders(mint, holders, now)
        except EXTERNAL_ERRORS as e:
            err = (err + "; " if err else "") + f"holders: {e}"
        out = chain_features(early["trades"], early["reached_launch"], holders, creator,
                             list(st.snapshots) if st else [], st.net_inflow_sol if st else None, now,
                             (st.first_trade_at if st else None) or m.get("first_trade_at"),
                             supply=st.supply if st else None)
        if err:
            out["error"] = str(err)[:300]
        return out

    # --- pre-filter scanner ------------------------------------------------------------
    async def scan_once(self) -> int:
        now = now_s()
        found = 0
        for m in [m for m, t in self._stage2_at.items() if now - t > 2 * 3600]:
            del self._stage2_at[m]
        checks = 0
        for st in list(self.ingest.mints.values()):
            if st.status != "tracking":
                continue
            if not st.streamed and not st.curve_at:
                continue  # until its curve is read, the inflow is only the dev's own launch buy
            if checks < self.s.HOLDER_CHECKS_PER_SCAN and self._needs_holders(st, now):
                checks += 1
                await self.refresh_holders(st)
            if not stage1(st, now, self.s).passed:
                continue
            if now - self._stage2_at.get(st.mint, 0) < STAGE2_RECHECK_S:
                continue
            self._stage2_at[st.mint] = now
            res = await full_check(st, now, self.s, self.rug, self.dex, self.sol_price.get())
            await self.db.insert("prefilter_results", {"mint": st.mint, "ts": now, "passed": int(res.passed),
                                                       "reason": res.reason, "metrics": res.metrics})
            if not res.passed:
                log.debug("prefilter reject %s (%s): %s", st.symbol, st.mint, res.reason)
                continue
            st.status = "candidate"
            context = {"mint": st.mint, "name": st.name, "symbol": st.symbol, "uri": st.uri,
                       "creator": st.creator, "bonding_curve_key": st.bonding_curve_key,
                       "mayhem_mode": st.mayhem, "prefilter": res.metrics, "rugcheck": res.rug,
                       "pair": summarize_pair(res.pair)}
            cid = await self.db.insert("candidates", {"mint": st.mint, "ts": now, "metrics": context,
                                                      "status": "pending"})
            self._pin(st.mint, True)
            await self.db.upsert_mints([st.row()])
            self.queue.put_nowait(cid)
            found += 1
            log.info("CANDIDATE #%d %s (%s) age %.1fm buyers %d inflow %.1f SOL liq $%s top10 %s%%",
                     cid, st.symbol, st.mint, res.metrics["age_min"], res.metrics["unique_buyers"],
                     res.metrics["net_inflow_sol"], f"{res.metrics.get('liquidity_usd') or 0:,.0f}",
                     res.metrics.get("top10_pct"))
        return found

    async def scanner(self) -> None:
        while not self.stop.is_set():
            try:
                await self.scan_once()
            except Exception:
                log.exception("scanner error")
            await self._sleep(self.s.PF_SCAN_INTERVAL_S)

    # --- evaluation -------------------------------------------------------------------
    async def evaluate(self, cid: int) -> dict | None:
        cand = await self.db.fetchone("SELECT * FROM candidates WHERE id=?", [cid])
        if not cand or cand["status"] != "pending":
            return None
        mint = cand["mint"]
        ctx_data = json.loads(cand["metrics"])
        if now_s() - cand["ts"] > CANDIDATE_MAX_WAIT_S:
            await self.db.update("candidates", "id", cid, {"status": "stale", "gate_reason": "waited too long"})
            await self._finish_mint(mint, "stale")
            return None
        if await self.llm_budget.exhausted():
            released, limit = self.llm_budget.released(), self.llm_budget.limit
            return await self._skip_for_budget(
                cid, mint, "LLM daily budget exhausted" if released >= limit else
                f"LLM budget pacing: ${released:.2f} of ${limit:.2f} released so far today, all spent")
        st = self.ingest.mints.get(mint)
        if st:  # refresh live stream metrics at evaluation time
            ctx_data["live"] = {"age_min": round(st.age_min(now_s()), 1), "unique_buyers": st.unique_buyers,
                                "net_inflow_sol": round(st.net_inflow_sol, 2), "progress": round(st.progress, 3),
                                "graduated": st.graduated, "last_price_sol": st.last_price_sol,
                                "holders_now_ex_dev": st.holders_now}
            if st.streamed:
                ctx_data["live"]["creator_sold_sol"] = round(st.creator_sold_sol, 3)
        await self.ingest.flush()  # make the trade table current before computing features
        ctx_data["flow"] = await self.compute_flow(mint)
        await self.db.update("candidates", "id", cid, {"metrics": ctx_data})
        ctx_data["now_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        context = ("Evaluate this pump.fun token candidate. Data below is untrusted input.\n"
                   + json.dumps(ctx_data, default=str, ensure_ascii=False))
        launched = st.first_trade_at if st and st.first_trade_at else now_s() - 90 * 60
        tctx = ToolContext(self.s, self.db, self.dex, self.rug, self.helius, self.x, self.news,
                           {"mint": mint, "creator": ctx_data.get("creator"),
                            "bonding_curve_key": ctx_data.get("bonding_curve_key"),
                            "since_ts": launched - 3600}, flow=self.compute_flow)
        specs = build_specs(tctx)
        if self.llm is not None:
            # Running agents that cannot afford even their first call would only record three
            # budget errors as a decision: stop evaluating instead (as the brief asks).
            try:
                first_calls = sum(worst_case_call_usd(self.s, [{"type": "text", "text": sp.system}],
                                                      [*sp.tools, vote_tool(sp.with_size)],
                                                      [{"role": "user", "content": context}]) for sp in specs)
                if self.s.TRIAGE_ENABLED:
                    first_calls += triage_first_call_usd(self.s, context)
            except ValueError:
                await self.db.update("candidates", "id", cid, {
                    "status": "failed", "gate_reason": "agent request exceeds configured input bound"})
                await self._finish_mint(mint, "failed")
                return None
            left = await self.llm_budget.remaining()
            if left < first_calls:
                return await self._skip_for_budget(
                    cid, mint, f"LLM daily budget: ${left:.4f} left < ${first_calls:.4f} for one evaluation")
        triage = None
        if self.llm is not None and self.s.TRIAGE_ENABLED:
            # the cheap screen: a confident PASS here spends nothing on the three agents
            triage = verify_triage(await run_triage(self.llm, self.s, context, self.llm_budget), ctx_data)
            if triage.guard:
                log.info("TRIAGE PASS overruled #%d %s %s: %s (said: %s)", cid, ctx_data.get("symbol"), mint,
                         triage.guard, (triage.reasons or ["no reason given"])[0][:160])
            await self._record_vote(cid, mint, triage)
            if triage_skips(triage, self.s):
                reason = f"triage: {(triage.reasons or ['no reason given'])[0][:200]}"
                await self.db.update("candidates", "id", cid, {
                    "status": "evaluated", "decision": "PASS", "mean_confidence": 0.0,
                    "gate_reason": reason, "llm_cost_usd": triage.cost_usd})
                self.triage_skips += 1
                log.info("TRIAGE SKIP #%d %s %s: %s (conf %.2f) | cost $%.4f", cid, ctx_data.get("symbol"), mint,
                         reason, triage.confidence, triage.cost_usd)
                liq = (ctx_data.get("prefilter") or {}).get("liquidity_usd")
                await self.positions.create(mint, cid, "shadow", ctx_data.get("creator") or "",
                                            self.s.POSITION_MIN_USD, liq)
                await self._finish_mint(mint, "evaluated")
                return {"candidate_id": cid, "decision": "PASS", "votes": [triage.as_json()]}
        if self.llm is None:
            votes = [Vote(sp.name, error="ANTHROPIC_API_KEY not set") for sp in specs]
        else:
            votes = list(await asyncio.gather(*[run_agent(self.llm, self.s, sp, context, self.llm_budget,
                                                          subject_ids={mint}) for sp in specs]))
        for v in votes:
            await self._record_vote(cid, mint, v)
        result = gate(votes, self.s)
        vetoes: list[Vote] = []
        if result.decision == "BUY" and self.s.VETO_ENABLED and self.llm is not None:
            # the second stage: wallet forensics and the social graph, only on the rare BUY
            vetoes = list(await asyncio.gather(*[run_agent(self.llm, self.s, sp, context, self.llm_budget,
                                                           subject_ids={mint}) for sp in build_veto_specs(tctx)]))
            for v in vetoes:
                await self._record_vote(cid, mint, v)
            before = result
            result = apply_vetoes(result, vetoes, self.s)
            if result.decision != before.decision:
                log.info("VETO #%d %s %s: %s", cid, ctx_data.get("symbol"), mint, result.reason)
        spent = sum(v.cost_usd for v in [*votes, *vetoes]) + (triage.cost_usd if triage else 0.0)
        await self.db.update("candidates", "id", cid, {
            "status": "evaluated", "decision": result.decision, "mean_confidence": result.mean_confidence,
            "gate_reason": result.reason, "llm_cost_usd": spent})
        self.cycles += 1
        log.info("DECISION #%d %s %s: %s (mean conf %.2f, %s) votes: %s | cost $%.3f", cid,
                 ctx_data.get("symbol"), mint, result.decision, result.mean_confidence, result.reason,
                 ", ".join(f"{v.agent}={v.vote}/{v.confidence:.2f}{'!' if v.error else ''}"
                           for v in [*votes, *vetoes]), spent)
        liq = (ctx_data.get("prefilter") or {}).get("liquidity_usd")
        await self.positions.create(mint, cid, "shadow", ctx_data.get("creator") or "", self.s.POSITION_MIN_USD, liq)
        if result.decision == "BUY":
            if kill_switch_active(self.s):
                log.warning("gate said BUY for %s but STOP file is present; no entry", mint)
            elif self.regime.mode == "off":
                log.warning("gate said BUY for %s but the market regime is off (%s); no entry", mint,
                            "; ".join(self.regime.reasons)[:200])
                await self.db.event("regime_off", {"mint": mint, "candidate_id": cid, "reasons": self.regime.reasons},
                                    now_s())
            else:
                size = apply_regime_size(result.size_usd, self.regime, self.s)
                pos = await self.positions.create(mint, cid, "real", ctx_data.get("creator") or "", size, liq)
                if pos and self.tg.enabled:
                    scaled = (f" (regime {self.regime.mode} x{self.regime.multiplier:g}, from ${result.size_usd:.2f})"
                              if size != result.size_usd else "")
                    await self.tg.send(
                        f"GATE BUY {ctx_data.get('symbol')} {mint}\nmean conf {result.mean_confidence:.2f}, "
                        f"size ${size:.2f}{scaled}\n" + "\n".join(
                            f"{v.agent}: {_vote_label(v)} {v.confidence:.2f} - {(v.reasons or ['-'])[0][:160]}"
                            for v in [*votes, *vetoes]))
        await self._finish_mint(mint, "evaluated")
        return {"candidate_id": cid, "decision": result.decision, "votes": [v.as_json() for v in [*votes, *vetoes]]}

    async def _record_vote(self, cid: int, mint: str, v: Vote) -> None:
        await self.db.insert("votes", {"candidate_id": cid, "mint": mint, "agent": v.agent, "vote": v.vote,
                                       "confidence": v.confidence, "reasons": v.reasons,
                                       "evidence": v.evidence, "size_usd": v.size_usd, "cost_usd": v.cost_usd,
                                       "turns": v.turns, "error": v.error, "ts": now_s(), "raw_vote": v.raw_vote,
                                       "grounding": v.grounding, "tool_calls_ok": v.tool_calls_ok,
                                       "guard": v.guard})

    async def _skip_for_budget(self, cid: int, mint: str, reason: str) -> None:
        log.info("skipping candidate #%d: %s", cid, reason)
        await self.db.update("candidates", "id", cid, {"status": "skipped_budget", "gate_reason": reason})
        await self._finish_mint(mint, "skipped_budget")
        return None

    async def _finish_mint(self, mint: str, status: str) -> None:
        st = self.ingest.mints.get(mint)
        if st:
            st.status = status
            await self.db.upsert_mints([st.row()])
        if not any(p.mint == mint and p.active for p in self.positions.positions.values()):
            self.ingest.pinned.discard(mint)

    async def evaluator(self) -> None:
        while not self.stop.is_set():
            try:
                cid = await asyncio.wait_for(self.queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            try:
                await self.evaluate(cid)
            except Exception:
                log.exception("evaluation of candidate %s failed", cid)
                # Never replay a late failure: a durable decision or live order may already exist.
                cand = await self.db.fetchone("SELECT mint,status FROM candidates WHERE id=?", [cid])
                if cand:
                    if cand["status"] == "pending":
                        await self.db.update("candidates", "id", cid, {
                            "status": "failed", "gate_reason": "evaluation failed; no automatic replay"})
                    await self._finish_mint(cand["mint"], "failed" if cand["status"] == "pending" else cand["status"])
            finally:
                self.queue.task_done()

    # --- misc loops -------------------------------------------------------------------
    async def heartbeat(self) -> None:
        day = utc_day()
        while not self.stop.is_set():
            try:
                day = await self._beat(day)
            except Exception:
                log.exception("heartbeat failed")
            await self._sleep(60)

    async def _beat(self, day: str) -> str:
        """One heartbeat: log line, `status` record, daily report at UTC midnight."""
        sd_notify("WATCHDOG=1")  # systemd restarts the bot if these stop (WatchdogSec in the unit)
        st = self.ingest.stats
        credits = await self._record_credits()
        log.info("heartbeat: tracked %d mints, %d launches, %d curve reads, %d streamed trades, ws reconnects %d, "
                 "queue %d, cycles %d, open %d, LLM left $%.2f, X left $%.2f, Helius credits %d this month, SOL $%s%s",
                 len(self.ingest.mints), st["creates"], st["curve_reads"], st["stream_trades"],
                 getattr(self.feed, "reconnects", 0), self.queue.qsize(), self.cycles,
                 len(self.positions.active("real")), await self.llm_budget.remaining(),
                 await self.x_budget.remaining(), credits,
                 f"{self.sol_price.get():.2f}" if self.sol_price.get() else "?",
                 f" | PAUSED: {self.risk.paused_reason}" if self.risk.paused_reason else "")
        await self.db.kv_set("heartbeat", json.dumps({
            "ts": now_s(), "started_at": self.started_at, "mode": self.s.MODE, "tracked": len(self.ingest.mints),
            "simulated": bool(getattr(self, "simulated", False)),
            "launches": st["creates"], "trades": st["trades"], "curve_reads": st["curve_reads"],
            "stream_trades": st["stream_trades"], "trade_stream": self.stream_mode,
            "stream_blocked": self._stream_blocked_day is not None, "helius_credits_month": credits,
            "helius_over_pace": self._credits_over_pace, "helius_exhausted": self._credits_exhausted,
            "reconnects": getattr(self.feed, "reconnects", 0), "stalls": getattr(self.feed, "stalls", 0),
            "last_msg_at": getattr(self.feed, "last_msg_at", None), "queue": self.queue.qsize(),
            "cycles": self.cycles, "triage_skips": self.triage_skips, "crashes": sum(self.crashes.values()),
            "paused": self.risk.paused_reason, "regime": self.regime.mode, "regime_multiplier": self.regime.multiplier,
            "regime_reasons": self.regime.reasons[:3], "regime_source": self.regime.source}))
        await self._refresh_regime()
        await self._hourly_digest()
        if utc_day() != day:
            text, path = await write_daily(self.db, self.s, day)
            log.info("wrote %s", path)
            await self.tg.send(f"Daily summary {day}\n" + text[:3500])
            day = utc_day()
        return day

    async def _refresh_regime(self) -> None:
        """Every REGIME_REFRESH_MIN: rebuild the market snapshot and ask the regime agent (or the
        rule, without a model). A change of mode is logged, recorded and sent to Telegram."""
        if not self.s.REGIME_ENABLED:
            return
        now = now_s()
        if self._regime_at is not None and now - self._regime_at < self.s.REGIME_REFRESH_MIN * 60:
            return
        self._regime_at = now
        try:
            snap = await market_snapshot(self.db, self.ingest.stats, self.sol_price, now,
                                         len(self.positions.active("real")) if self.positions else 0,
                                         self.risk.paused_reason)
            new = await run_regime(self.llm, self.s, snap, self.llm_budget, now)
        except Exception:
            log.exception("regime assessment failed; keeping %s", self.regime.mode)
            return
        old = self.regime
        self.regime = new
        changed = (old.mode, old.multiplier) != (new.mode, new.multiplier)
        keep = ("sol_usd", "sol_change_1h_pct", "launches_1h", "candidates_1h", "shadow_6h")
        await self.db.event("regime", {**new.as_dict(), "changed": changed,
                                       "snapshot": {k: snap.get(k) for k in keep}}, now)
        if new.error:
            log.warning("regime agent error (%s); using the rule: %s x%g", new.error, new.mode, new.multiplier)
        if changed:
            log.warning("REGIME %s -> %s x%g (%s): %s", old.mode, new.mode, new.multiplier, new.source,
                        "; ".join(new.reasons)[:300])
            if self.tg.enabled and (old.at is not None or new.mode != "normal"):
                what = {"normal": "normal: full-size entries", "cautious": f"cautious: entries x{new.multiplier:g}",
                        "off": "off: no new entries until the next check"}[new.mode]
                await self.tg.send(f"REGIME {what}\n" + "\n".join(f"- {r}" for r in new.reasons[:3]))

    async def _hourly_digest(self) -> None:
        """At the top of each UTC hour, send the previous hour's trades to Telegram
        (TELEGRAM_DIGEST: all = every hour, wins = only hours with a winning trade, off)."""
        now_hour = hour_start(now_s())
        if self._digest_hour is None:
            self._digest_hour = now_hour
            return
        if now_hour <= self._digest_hour:
            return
        since, self._digest_hour = self._digest_hour, now_hour
        if not self.tg.enabled or self.s.TELEGRAM_DIGEST == "off":
            return
        text, wins = await hourly_digest(self.db, self.s, since, now_hour)
        if self.s.TELEGRAM_DIGEST == "all" or wins:
            await self.tg.send(text)

    async def _supervise(self, name: str, factory) -> None:
        """Run a background loop and restart it if it ever raises or returns early.

        Each loop handles its own expected failures (network errors, bad data). Reaching this
        handler means a bug, so it is logged with its traceback and counted in `crashes`, which
        `status` shows and `acceptance` fails on, instead of the loop dying silently."""
        attempt = 0
        while not self.stop.is_set():
            try:
                await factory()
                if self.stop.is_set():
                    return
                log.error("background loop %s returned while the bot is running; restarting it", name)
            except Exception:
                log.exception("background loop %s crashed; restarting it", name)
            self.crashes[name] = self.crashes.get(name, 0) + 1
            await self._sleep(backoff_delay(attempt, 1.0, 30.0))
            attempt += 1

    async def _sleep(self, s: float) -> None:
        try:
            await asyncio.wait_for(self.stop.wait(), timeout=s)
        except asyncio.TimeoutError:
            pass

    async def run(self, duration_s: float | None = None) -> None:
        try:
            await self.setup()
        except BaseException:
            await self.db.close()
            await self.http.aclose()
            self.lock.release()
            raise
        loops = {
            "feed": lambda: self.feed.run(self.stop),
            "flusher": lambda: self.ingest.run_flusher(self.stop),
            "solprice": lambda: self.sol_price.run(self.stop),
            "positions": lambda: self.positions.run(self.stop),
            "curves": self.curve_poller,
            "stream_guard": self.stream_guard,
            "scanner": self.scanner,
            "heartbeat": self.heartbeat,
            **{f"evaluator{i}": self.evaluator for i in range(self.s.LLM_CONCURRENCY)},
        }
        if self.tg.enabled and self.s.TELEGRAM_COMMANDS:
            loops["telegram"] = lambda: TelegramCommands(self.tg, self.db, self.s, engine=self).run(self.stop)
        tasks = [asyncio.create_task(self._supervise(name, fn), name=name) for name, fn in loops.items()]
        log.info("bot running in %s mode (model %s)", self.s.MODE, self.s.LLM_MODEL)
        sd_notify("READY=1")
        clean_stop = False
        try:
            if duration_s:
                await self._sleep(duration_s)
                self.stop.set()
            else:
                await self.stop.wait()
            clean_stop = True
        finally:
            self.stop.set()
            await asyncio.gather(*tasks, return_exceptions=True)
            if clean_stop and consume_keep_pause(self.s):
                # a restart queued from Telegram while the daily-loss pause is on: the pause survives it
                log.warning("restart from Telegram keeps the daily-loss pause and its loss window")
                clean_stop = False
            await self.shutdown(clean_stop=clean_stop)

    async def shutdown(self, *, clean_stop: bool = True) -> None:
        sd_notify("STOPPING=1")
        if self.positions:
            await self.positions.drain()
        await self.risk.shutdown(clean_stop=clean_stop)
        try:
            await self._record_credits()  # metered usage survives restarts
            await self._check_stream_budget()
            raw = await self.db.kv_get("heartbeat")  # tell `status` this was a clean stop
            hb = json.loads(raw) if raw else {}
            hb.update(stopped_at=now_s(), cycles=self.cycles)
            await self.db.kv_set("heartbeat", json.dumps(hb))
        except Exception:
            log.exception("could not record usage counters")
        try:
            await self.ingest.flush()
            text, path = await write_daily(self.db, self.s)
            log.info("report written to %s", path)
        except Exception:
            log.exception("final report failed")
        if hasattr(self.executor, "close"):
            await self.executor.close()
        await self.db.close()
        await self.http.aclose()
        self.lock.release()
