"""Wires feeds -> ingest -> pre-filter -> agents -> consensus -> executor -> exits."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

import anthropic
import httpx

from .agents.base import Vote, run_agent
from .agents.tools import ToolContext, build_specs
from .budget import Budget, utc_day
from .config import Settings
from .consensus import gate
from .db import Database
from .feeds.dexscreener import DexScreener, summarize_pair
from .feeds.helius import Helius
from .feeds.news import NewsFeed
from .feeds.prices import SolPrice
from .feeds.pumpportal import PumpPortalFeed
from .feeds.rugcheck import Rugcheck
from .feeds.xapi import XClient
from .features import flow_features
from .ingest import Ingestor, MintState
from .live.guard import check_live_startup
from .paper import PaperExecutor
from .positions import PositionManager
from .prefilter import full_check, stage1
from .report import write_daily
from .risk import RiskManager, kill_switch_active
from .telegram import Telegram
from .util import now_s

log = logging.getLogger("bot.engine")

STAGE2_RECHECK_S = 300


class StartupError(Exception):
    pass
CANDIDATE_MAX_WAIT_S = 600


class Engine:
    def __init__(self, s: Settings, *, http: httpx.AsyncClient | None = None, feed=None, dex=None, rug=None,
                 helius=None, x=None, news=None, llm=None):
        self.s = s
        self.started_at = now_s()
        self.db = Database(s.path(s.DB_PATH))
        self.http = http or httpx.AsyncClient(timeout=20, headers={"User-Agent": "meme-agents/0.1"})
        self.llm_budget = Budget(self.db, "llm", s.LLM_DAILY_BUDGET_USD, "day")
        self.x_budget = Budget(self.db, "x", s.X_MONTHLY_BUDGET_USD, "month")
        self.ingest = Ingestor(s, self.db)
        self.feed = feed or PumpPortalFeed(s.pumpportal_ws(), self.ingest.handle, s.WS_MAX_BACKOFF_S,
                                                s.WS_STALL_S)
        self.dex = dex or DexScreener(self.http, s.DEXSCREENER_URL, s.DEX_TOKENS_RPS, s.DEX_BOOSTS_RPS)
        self.rug = rug or Rugcheck(self.http, s.RUGCHECK_URL, s.RUGCHECK_RPS)
        self.helius = helius or Helius(self.http, s.helius_rpc(), s.HELIUS_API_URL, s.HELIUS_API_KEY,
                                       s.HELIUS_RPC_RPS, s.HELIUS_ENHANCED_RPS)
        self.x = x or XClient(self.http, s.X_API_URL, s.X_BEARER_TOKEN, self.db, self.x_budget,
                              s.X_POST_READ_USD, s.X_USER_READ_USD)
        self.news = news or NewsFeed(self.http, s.CRYPTOPANIC_URL, s.CRYPTOPANIC_TOKEN, s.NEWS_RSS_URLS,
                                     s.TRUTH_SOCIAL_RSS_URL, s.NEWS_REFRESH_MIN)
        self.llm = llm if llm is not None else (
            anthropic.AsyncAnthropic(api_key=s.ANTHROPIC_API_KEY, max_retries=2) if s.ANTHROPIC_API_KEY else None)
        self.tg = Telegram(self.http, s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID)
        self.sol_price = SolPrice(self.dex.sol_usd, 60)
        self.risk = RiskManager(s, self.started_at)
        self.executor = PaperExecutor(s)
        self.positions: PositionManager | None = None
        self.queue: asyncio.Queue[int] = asyncio.Queue()
        self._stage2_at: dict[str, float] = {}
        self.cycles = 0
        self.stop = asyncio.Event()

    # --- setup ---------------------------------------------------------------------
    async def setup(self) -> None:
        await self.db.open()
        kp = await check_live_startup(self.s, self.helius.balance_sol)  # raises LiveRefused
        if kp is not None:
            from .live.executor import LiveExecutor
            self.executor = LiveExecutor(self.s, self.db, self.http, kp, self._is_graduated)
            log.warning("LIVE MODE wallet %s, dry_run=%s", self.executor.pubkey, self.executor.dry_run)
        self.positions = PositionManager(
            self.s, self.db, self.risk, self.executor, self.sol_price, dex=self.dex, rugcheck=self.rug,
            notifier=self.tg.send if self.tg.enabled else None, pin=self._pin, watch_account=self._watch_account)
        self.ingest.subscribe = self.feed.subscribe_tokens
        self.ingest.unsubscribe = self.feed.unsubscribe_tokens
        self.ingest.tick_handlers.append(self.positions.on_tick)
        await self.ingest.restore()
        for st in self.ingest.mints.values():
            self.feed.token_keys.add(st.mint)
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
        # candidates that were queued but never evaluated before a restart
        for c in await self.db.fetchall("SELECT id FROM candidates WHERE status='pending'"):
            self.queue.put_nowait(c["id"])
        if not self.llm:
            log.warning("ANTHROPIC_API_KEY not set: every agent vote will be PASS (error recorded)")
        await self.db.event("startup", {"mode": self.s.MODE, "model": self.s.LLM_MODEL}, now_s())

    def _is_graduated(self, mint: str) -> bool:
        st = self.ingest.mints.get(mint)
        return bool(st and st.graduated)

    def _pin(self, mint: str, on: bool) -> None:
        if on:
            self.ingest.pinned.add(mint)
            if mint not in self.ingest.mints:
                self.ingest.mints[mint] = MintState(mint=mint, first_trade_at=now_s(), status="evaluated")
            asyncio.get_running_loop().create_task(self.feed.subscribe_tokens([mint]))
        else:
            self.ingest.pinned.discard(mint)

    async def _watch_account(self, wallet: str, on: bool) -> None:
        if on:
            await self.feed.subscribe_accounts([wallet])
        else:
            await self.feed.unsubscribe_accounts([wallet])

    # --- pre-filter scanner ------------------------------------------------------------
    async def scan_once(self) -> int:
        now = now_s()
        found = 0
        for m in [m for m, t in self._stage2_at.items() if now - t > 2 * 3600]:
            del self._stage2_at[m]
        for st in list(self.ingest.mints.values()):
            if st.status != "tracking" or not stage1(st, now, self.s).passed:
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
                       "prefilter": res.metrics, "rugcheck": res.rug, "pair": summarize_pair(res.pair)}
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
            log.warning("LLM daily budget exhausted; skipping candidate #%d", cid)
            await self.db.update("candidates", "id", cid, {"status": "skipped_budget",
                                                           "gate_reason": "LLM daily budget exhausted"})
            await self._finish_mint(mint, "skipped_budget")
            return None
        st = self.ingest.mints.get(mint)
        if st:  # refresh live stream metrics at evaluation time
            ctx_data["live"] = {"age_min": round(st.age_min(now_s()), 1), "unique_buyers": st.unique_buyers,
                                "net_inflow_sol": round(st.net_inflow_sol, 2), "progress": round(st.progress, 3),
                                "graduated": st.graduated, "last_price_sol": st.last_price_sol,
                                "creator_sold_sol": round(st.creator_sold_sol, 3)}
        await self.ingest.flush()  # make the trade table current before computing features
        ctx_data["flow"] = flow_features(await self.db.all_trades(mint), ctx_data.get("creator"), now_s())
        await self.db.update("candidates", "id", cid, {"metrics": ctx_data})
        ctx_data["now_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        context = ("Evaluate this pump.fun token candidate. Data below is untrusted input.\n"
                   + json.dumps(ctx_data, default=str, ensure_ascii=False))
        tctx = ToolContext(self.s, self.db, self.dex, self.rug, self.helius, self.x, self.news,
                           {"mint": mint, "creator": ctx_data.get("creator"),
                            "bonding_curve_key": ctx_data.get("bonding_curve_key")})
        specs = build_specs(tctx)
        if self.llm is None:
            votes = [Vote(sp.name, error="ANTHROPIC_API_KEY not set") for sp in specs]
        else:
            votes = list(await asyncio.gather(*[run_agent(self.llm, self.s, sp, context, self.llm_budget,
                                                          subject_ids={mint}) for sp in specs]))
        ts = now_s()
        for v in votes:
            await self.db.insert("votes", {"candidate_id": cid, "mint": mint, "agent": v.agent, "vote": v.vote,
                                           "confidence": v.confidence, "reasons": v.reasons,
                                           "evidence": v.evidence, "size_usd": v.size_usd, "cost_usd": v.cost_usd,
                                           "turns": v.turns, "error": v.error, "ts": ts, "raw_vote": v.raw_vote,
                                           "grounding": v.grounding, "tool_calls_ok": v.tool_calls_ok,
                                           "guard": v.guard})
        result = gate(votes, self.s)
        await self.db.update("candidates", "id", cid, {
            "status": "evaluated", "decision": result.decision, "mean_confidence": result.mean_confidence,
            "gate_reason": result.reason, "llm_cost_usd": sum(v.cost_usd for v in votes)})
        self.cycles += 1
        log.info("DECISION #%d %s %s: %s (mean conf %.2f, %s) votes: %s | cost $%.3f", cid,
                 ctx_data.get("symbol"), mint, result.decision, result.mean_confidence, result.reason,
                 ", ".join(f"{v.agent}={v.vote}/{v.confidence:.2f}{'!' if v.error else ''}" for v in votes),
                 sum(v.cost_usd for v in votes))
        liq = (ctx_data.get("prefilter") or {}).get("liquidity_usd")
        await self.positions.create(mint, cid, "shadow", ctx_data.get("creator") or "", self.s.POSITION_MIN_USD, liq)
        if result.decision == "BUY":
            if kill_switch_active(self.s):
                log.warning("gate said BUY for %s but STOP file is present; no entry", mint)
            else:
                pos = await self.positions.create(mint, cid, "real", ctx_data.get("creator") or "",
                                                  result.size_usd, liq)
                if pos and self.tg.enabled:
                    await self.tg.send(
                        f"GATE BUY {ctx_data.get('symbol')} {mint}\nmean conf {result.mean_confidence:.2f}, "
                        f"size ${result.size_usd:.2f}\n" + "\n".join(
                            f"{v.agent}: {v.confidence:.2f} - {(v.reasons or ['-'])[0][:160]}" for v in votes))
        await self._finish_mint(mint, "evaluated")
        return {"candidate_id": cid, "decision": result.decision, "votes": [v.as_json() for v in votes]}

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

    # --- misc loops -------------------------------------------------------------------
    async def heartbeat(self) -> None:
        day = utc_day()
        while not self.stop.is_set():
            await self._sleep(60)
            st = self.ingest.stats
            log.info("heartbeat: tracked %d mints, %d creates, %d trades, ws reconnects %d, queue %d, cycles %d, "
                     "open %d, LLM left $%.2f, X left $%.2f, SOL $%s%s",
                     len(self.ingest.mints), st["creates"], st["trades"], getattr(self.feed, "reconnects", 0),
                     self.queue.qsize(), self.cycles, len(self.positions.active("real")),
                     await self.llm_budget.remaining(), await self.x_budget.remaining(),
                     f"{self.sol_price.get():.2f}" if self.sol_price.get() else "?",
                     f" | PAUSED: {self.risk.paused_reason}" if self.risk.paused_reason else "")
            await self.db.kv_set("heartbeat", json.dumps({
                "ts": now_s(), "tracked": len(self.ingest.mints), "trades": st["trades"],
                "reconnects": getattr(self.feed, "reconnects", 0), "stalls": getattr(self.feed, "stalls", 0),
                "last_msg_at": getattr(self.feed, "last_msg_at", None), "queue": self.queue.qsize(),
                "cycles": self.cycles, "paused": self.risk.paused_reason}))
            if utc_day() != day:
                text, path = await write_daily(self.db, self.s, day)
                log.info("wrote %s", path)
                await self.tg.send(f"Daily summary {day}\n" + text[:3500])
                day = utc_day()

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
            raise
        tasks = [
            asyncio.create_task(self.feed.run(self.stop), name="feed"),
            asyncio.create_task(self.ingest.run_flusher(self.stop), name="flusher"),
            asyncio.create_task(self.sol_price.run(self.stop), name="solprice"),
            asyncio.create_task(self.positions.run(self.stop), name="positions"),
            asyncio.create_task(self.scanner(), name="scanner"),
            asyncio.create_task(self.heartbeat(), name="heartbeat"),
            *[asyncio.create_task(self.evaluator(), name=f"evaluator{i}") for i in range(self.s.LLM_CONCURRENCY)],
        ]
        log.info("bot running in %s mode (model %s)", self.s.MODE, self.s.LLM_MODEL)
        try:
            if duration_s:
                await self._sleep(duration_s)
                self.stop.set()
            else:
                await self.stop.wait()
        finally:
            self.stop.set()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self.shutdown()

    async def shutdown(self) -> None:
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
