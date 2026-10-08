"""Position lifecycle: pending entry -> open -> (partial) exits -> closed.

* Entries fill at the first PumpPortal trade observed after the decision.
* Every trade tick marks open positions to market and runs the exit rules; exits triggered
  by a tick fill at that tick's price.
* Time stops, emergencies and the kill switch queue an exit that fills on the next tick, or
  at the last observed price after EXIT_FILL_TIMEOUT_S.
* `shadow` positions run the same engine for every evaluated candidate (no bankroll) so the
  report can score each agent's votes against an outcome.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass, fields
from math import isfinite
from typing import Awaitable, Callable

from .config import Settings
from .db import Database
from .exits import ExitState, check_exit
from .feeds.dexscreener import sol_price_native
from .live.executor import LiveExecutionUnknown
from .paper import Fill, PaperExecutor, mark_to_market
from .risk import RiskManager, kill_switch_active
from .util import now_s

log = logging.getLogger("bot.positions")

TICK_CONFIRM_S = 300.0   # a held mark is confirmed by a second one near it within this long


@dataclass
class Position:
    id: int | None
    mint: str
    candidate_id: int | None
    kind: str            # real | shadow
    mode: str            # paper | live
    creator: str
    status: str          # pending | open | closed | cancelled
    decided_at: float
    size_usd: float
    sol_in: float
    opened_at: float | None = None
    closed_at: float | None = None
    cost_sol: float = 0.0
    entry_price: float | None = None
    tokens_initial: float = 0.0
    tokens_remaining: float = 0.0
    peak_price: float | None = None
    last_price: float | None = None
    last_tick_at: float | None = None
    tp_done: int = 0
    entry_liq_usd: float | None = None
    last_liq_usd: float | None = None
    proceeds_sol: float = 0.0
    pnl_sol: float | None = None
    pnl_usd: float | None = None
    sol_usd_entry: float | None = None
    sol_usd_exit: float | None = None
    exit_reason: str | None = None
    pending_exit: str | None = None
    pending_exit_fraction: float | None = None
    pending_exit_at: float | None = None
    exit_attempts: int = 0
    next_exit_at: float | None = None   # backoff: no exit attempt before this time

    def row(self) -> dict:
        d = asdict(self)
        d.pop("id")
        return d

    @property
    def active(self) -> bool:
        return self.status in ("pending", "open")

    def unrealized_sol(self, s: Settings) -> float:
        if self.status != "open" or not self.last_price:
            return 0.0
        return self.proceeds_sol + mark_to_market(self.tokens_remaining, self.last_price, s) - self.cost_sol


def _num(v) -> float | None:
    try:
        number = float(v)
        return number if isfinite(number) else None
    except (TypeError, ValueError):
        return None


Notifier = Callable[[str], Awaitable[None]]


class PositionManager:
    def __init__(self, settings: Settings, db: Database, risk: RiskManager, executor, sol_price,
                 dex=None, rugcheck=None, notifier: Notifier | None = None,
                 pin: Callable[[str, bool], None] | None = None,
                 watch_account: Callable[[str, bool], Awaitable[None]] | None = None,
                 curve_liquidity: Callable[[str], float | None] | None = None):
        self.s = settings
        self.db = db
        self.risk = risk
        self.executor = executor
        self.shadow_exec = PaperExecutor(settings)
        self.sol_price = sol_price
        self.dex = dex
        self.rugcheck = rugcheck
        self.notify = notifier
        self.pin = pin or (lambda mint, on: None)
        self.watch_account = watch_account
        # DexScreener has no liquidity for bonding-curve pairs: the curve's own depth stands in,
        # the same measure the pre-filter recorded as entry liquidity
        self.curve_liquidity = curve_liquidity
        self.positions: dict[int, Position] = {}
        self.lock = asyncio.Lock()
        # live trades run off the tick path, one in flight per position
        self._inflight: set[int] = set()
        self._tasks: set[asyncio.Task] = set()
        self._entry_uncertain: set[int] = set()
        self._entry_told: dict[int, str] = {}      # the last ENTRY FAILED text sent per position: once, not every tick
        self._suspect: dict[int, tuple[float, float]] = {}   # position id -> (held mark, its ts)
        self._last_liq_poll = 0.0
        self._last_rug_poll = 0.0
        self._kill_handled = False

    # --- queries ---------------------------------------------------------------
    def active(self, kind: str | None = "real") -> list[Position]:
        return [p for p in self.positions.values() if p.active and (kind is None or p.kind == kind)]

    async def cash_sol(self) -> float:
        """Paper bankroll: starting SOL + realized PnL - capital tied up in active positions."""
        if self.executor.mode == "live" and not getattr(self.executor, "dry_run", True):
            balance = await self.executor.chain.balance_sol(self.executor.pubkey)
            if not isfinite(balance) or balance < 0:
                raise ValueError("live wallet balance must be finite and nonnegative")
            # Open inventory and failed transaction fees are already reflected in the wallet.
            reserved = sum(p.sol_in + self.s.NETWORK_FEE_SOL
                           for p in self.active("real") if p.status == "pending")
            return balance - reserved
        start = await self.db.kv_get("bankroll_sol")
        start_sol = float(start) if start else 0.0
        r = await self.db.fetchone(
            "SELECT COALESCE(SUM(pnl_sol),0) s FROM positions WHERE kind='real' AND mode=? AND status='closed'",
            [self.executor.mode])
        tied = sum(p.cost_sol or p.sol_in + self.s.NETWORK_FEE_SOL for p in self.active("real"))
        tied -= sum(p.proceeds_sol for p in self.active("real"))
        return start_sol + float(r["s"]) - tied

    async def _symbol(self, mint: str) -> str:
        row = await self.db.fetchone("SELECT symbol FROM mints WHERE mint=?", [mint])
        return (row["symbol"] if row and row["symbol"] else None) or mint[:6]

    async def realized_since(self, since: float) -> float:
        r = await self.db.fetchone(
            "SELECT COALESCE(SUM(pnl_usd),0) s FROM positions WHERE kind='real' AND mode=? AND status='closed' AND closed_at>=?",
            [self.executor.mode, since])
        return float(r["s"])

    # --- persistence -------------------------------------------------------------
    async def load(self) -> None:
        rows = await self.db.fetchall(
            "SELECT * FROM positions WHERE status IN ('pending','open') AND (kind='shadow' OR mode=?)",
            [self.executor.mode])
        names = {f.name for f in fields(Position)}
        for r in rows:
            p = Position(**{k: v for k, v in r.items() if k in names})
            self.positions[p.id] = p
            intent = None
            if p.status == "pending" and self._is_live(p) and hasattr(self.executor, "pending_intent"):
                intent = await self.executor.pending_intent(p.mint, "buy")
            if p.status == "pending" and (intent or (p.exit_reason or "").startswith("execution_uncertain:")):
                self._entry_uncertain.add(p.id)
                if intent:
                    p.last_price = intent["price"]
                self.risk.paused_reason = "unresolved live transaction; entries paused until restart after reconciliation"
            self.pin(p.mint, True)
            if self.watch_account and p.creator:
                await self.watch_account(p.creator, True)
        if rows:
            log.info("resumed %d active positions", len(rows))

    async def _save(self, p: Position) -> None:
        if p.id is None:
            p.id = await self.db.insert("positions", p.row())
            self.positions[p.id] = p
        else:
            await self.db.update("positions", "id", p.id, p.row())

    async def _record_fill(self, p: Position, f: Fill, reason: str, ts: float) -> None:
        await self.db.insert("fills", {"position_id": p.id, "ts": ts, "side": f.side, "reason": reason,
                                       "price": f.price, "tokens": f.tokens, "sol": f.sol,
                                       "fee_sol": f.fee_sol, "tx_sig": f.tx_sig})

    async def _persist_fill(self, p: Position, f: Fill, reason: str, ts: float, before: dict) -> None:
        """Commit the inventory and its cash movement together, or restore both in memory."""
        try:
            async with self.db.transaction():
                await self._save(p)
                await self._record_fill(p, f, reason, ts)
                if self._is_live(p) and f.tx_sig and hasattr(self.executor, "acknowledge_fill"):
                    await self.executor.acknowledge_fill(p.mint, f.side, f.tx_sig)
        except BaseException:
            for key, value in before.items():
                setattr(p, key, value)
            raise

    # --- entry ---------------------------------------------------------------------
    async def create(self, mint: str, candidate_id: int | None, kind: str, creator: str, size_usd: float,
                     liq_usd: float | None) -> Position | None:
        sol_usd = self.sol_price.get()
        if not sol_usd or not isfinite(sol_usd) or sol_usd <= 0:
            log.warning("no SOL/USD price yet; cannot size %s position for %s", kind, mint)
            return None
        if kind not in ("real", "shadow") or not isfinite(size_usd) or size_usd <= 0:
            raise ValueError("position kind and size must be valid")
        if kind == "real" and not self.s.POSITION_MIN_USD <= size_usd <= self.s.POSITION_MAX_USD:
            raise ValueError("real position size is outside configured limits")
        sol_in = size_usd / sol_usd
        async with self.lock:
            if kind == "real":
                ok, why = self.risk.can_open(creator, [asdict(p) for p in self.active("real")],
                                             await self.cash_sol(), sol_in + self.s.NETWORK_FEE_SOL)
                if not ok:
                    log.info("risk blocked entry %s: %s", mint, why)
                    await self.db.event("risk_block", {"mint": mint, "reason": why}, now_s())
                    return None
            p = Position(id=None, mint=mint, candidate_id=candidate_id, kind=kind,
                         mode=self.executor.mode if kind == "real" else "paper", creator=creator,
                         status="pending", decided_at=now_s(), size_usd=size_usd, sol_in=sol_in,
                         sol_usd_entry=sol_usd, entry_liq_usd=liq_usd, last_liq_usd=liq_usd)
            await self._save(p)
        self.pin(mint, True)
        if self.watch_account and creator:
            await self.watch_account(creator, True)
        log.info("%s entry queued #%d %s $%.2f (%.4f SOL)", kind, p.id, mint, size_usd, sol_in)
        return p

    def _is_live(self, p: Position) -> bool:
        return p.kind == "real" and getattr(self.executor, "mode", "paper") == "live"

    def _spawn(self, p: Position, coro) -> None:
        self._inflight.add(p.id)
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        def finished(done: asyncio.Task) -> None:
            self._tasks.discard(done)
            if not done.cancelled() and done.exception():
                log.error("position task #%s failed", p.id,
                          exc_info=(type(done.exception()), done.exception(), done.exception().__traceback__))
                self.risk.paused_reason = "live transaction persistence failed; reconcile before restarting"
        task.add_done_callback(finished)

    async def _cancel_entry(self, p: Position, reason: str, ts: float) -> None:
        p.status, p.exit_reason, p.closed_at = "cancelled", reason[:200], ts
        await self._save(p)
        await self._release(p)

    async def _fill_entry(self, p: Position, price: float, ts: float) -> None:
        """Caller holds the lock."""
        if p.id in self._inflight:
            return
        if p.kind == "real" and p.id not in self._entry_uncertain:
            # the world may have changed between the decision and this first trade
            if kill_switch_active(self.s):
                await self._cancel_entry(p, "kill switch before fill", ts)
                return
            if self.risk.paused_reason:
                await self._cancel_entry(p, f"paused before fill: {self.risk.paused_reason}", ts)
                return
        if self._is_live(p):
            self._spawn(p, self._live_entry(p, price))
            return
        ex = self.executor if p.kind == "real" else self.shadow_exec
        try:
            f = await ex.buy(p.mint, p.sol_in, price)
        except Exception as e:
            log.error("entry failed #%s %s: %s", p.id, p.mint, e)
            await self._cancel_entry(p, f"entry_error: {e}", ts)
            return
        await self._apply_entry(p, f, price, ts)

    async def _live_entry(self, p: Position, price: float) -> None:
        try:
            try:
                f = await self.executor.buy(p.mint, p.sol_in, price)
            except Exception as e:
                log.error("live entry failed #%s %s: %s", p.id, p.mint, e)
                async with self.lock:
                    if isinstance(e, LiveExecutionUnknown):
                        self._entry_uncertain.add(p.id)
                        p.exit_reason = f"execution_uncertain: {e}"[:200]
                        p.last_price = price
                        await self._save(p)
                        self.risk.paused_reason = "unresolved live transaction; entries paused until restart after reconciliation"
                    else:
                        self._entry_uncertain.discard(p.id)
                        await self._cancel_entry(p, f"entry_error: {e}", now_s())
                text = f"ENTRY FAILED #{p.id} {p.mint}: {str(e)[:200]}"
                if self.notify and self._entry_told.get(p.id) != text:
                    # an uncertain entry is retried every tick; the same failure is reported once
                    self._entry_told[p.id] = text
                    await self.notify(text)
                return
            async with self.lock:
                try:
                    await self._apply_entry(p, f, price, now_s())
                except BaseException:
                    if p.status == "pending":
                        self._entry_uncertain.add(p.id)
                        p.last_price = price
                    raise
                self._entry_uncertain.discard(p.id)
                self._entry_told.pop(p.id, None)
                if kill_switch_active(self.s):
                    await self.queue_exit(p, "kill_switch")
        finally:
            self._inflight.discard(p.id)

    async def _apply_entry(self, p: Position, f: Fill, price: float, ts: float) -> None:
        before = asdict(p)
        if p.status != "pending":
            log.error("fill for #%s arrived in state %s; recording it anyway", p.id, p.status)
            self.positions[p.id] = p
        p.status, p.opened_at = "open", ts
        p.entry_price = price
        p.peak_price = p.last_price = price
        p.last_tick_at = ts
        p.tokens_initial = p.tokens_remaining = f.tokens
        p.cost_sol = f.sol
        p.exit_reason = None
        await self._persist_fill(p, f, "entry", ts, before)
        if p.kind == "real":
            msg = (f"🟢 ENTRY {await self._symbol(p.mint)} [{p.mode}] ${p.size_usd:.2f} = {p.sol_in:.4f} SOL "
                   f"@ {price:.3e} SOL\ntokens {f.tokens:,.0f}\n{p.mint}" + (f"\ntx {f.tx_sig}" if f.tx_sig else ""))
            log.info(msg.replace("\n", " | "))
            if self.notify:
                await self.notify(msg)

    # --- exits ---------------------------------------------------------------------
    def _exit_allowed(self, p: Position, ts: float) -> bool:
        return p.id not in self._inflight and (p.next_exit_at is None or ts >= p.next_exit_at)

    async def _exit(self, p: Position, fraction: float, price: float, ts: float, reason: str) -> None:
        """Caller holds the lock."""
        tokens = p.tokens_remaining if fraction >= 0.999 else p.tokens_remaining * fraction
        if tokens <= 0 or not self._exit_allowed(p, ts):
            return
        if self._is_live(p):
            # record the intent first: if the process dies mid-trade the exit is retried on restart
            if p.pending_exit != reason:
                p.pending_exit, p.pending_exit_fraction, p.pending_exit_at = reason, fraction, ts
                await self._save(p)
            self._spawn(p, self._live_exit(p, fraction, tokens, price, reason))
            return
        ex = self.executor if p.kind == "real" else self.shadow_exec
        try:
            f = await ex.sell(p.mint, tokens, price, fraction)
        except Exception as e:
            await self._exit_failed(p, fraction, reason, e, ts)
            return
        await self._apply_exit(p, f, fraction, price, ts, reason)

    async def _live_exit(self, p: Position, fraction: float, tokens: float, price: float, reason: str) -> None:
        try:
            try:
                f = await self.executor.sell(p.mint, tokens, price, fraction)
            except Exception as e:
                async with self.lock:
                    await self._exit_failed(p, fraction, reason, e, now_s())
                return
            async with self.lock:
                await self._apply_exit(p, f, fraction, price, now_s(), reason)
        finally:
            self._inflight.discard(p.id)

    async def _exit_failed(self, p: Position, fraction: float, reason: str, err: Exception, ts: float) -> None:
        p.exit_attempts += 1
        delay = min(self.s.EXIT_RETRY_MAX_S, self.s.EXIT_RETRY_BASE_S * 2 ** (p.exit_attempts - 1))
        p.next_exit_at = ts + delay
        if not p.pending_exit or p.pending_exit == reason or (p.pending_exit_fraction or 1.0) <= fraction:
            p.pending_exit, p.pending_exit_fraction = reason, fraction
        p.pending_exit_at = p.pending_exit_at or ts
        await self._save(p)
        log.error("exit failed #%s %s (%s), attempt %d: %s; retrying in %.0fs",
                  p.id, p.mint, reason, p.exit_attempts, err, delay)
        if p.kind == "real" and p.exit_attempts == 3 and self.notify:
            await self.notify(f"EXIT FAILING #{p.id} {p.mint} ({reason}): {str(err)[:200]}\n"
                              f"still retrying every <= {self.s.EXIT_RETRY_MAX_S:.0f}s; check the wallet")

    async def _apply_exit(self, p: Position, f: Fill, fraction: float, price: float, ts: float,
                          reason: str) -> None:
        if p.status != "open":
            return
        before = asdict(p)
        full = fraction >= 0.999
        if f.remaining_tokens is not None:
            p.tokens_remaining = max(0.0, f.remaining_tokens)
            full = p.tokens_remaining <= 1e-9
        else:
            p.tokens_remaining = 0.0 if full else max(0.0, p.tokens_remaining - f.tokens)
        p.proceeds_sol += f.sol
        if reason == "take_profit":
            p.tp_done = 1
        # A full emergency exit may have replaced the in-flight take-profit intent.
        if p.pending_exit is None or (p.pending_exit == reason and
                (full or (p.pending_exit_fraction or 1.0) <= fraction) and
                (f.remaining_tokens is None or full or fraction < 0.999)):
            p.pending_exit = p.pending_exit_fraction = p.pending_exit_at = None
        p.exit_attempts, p.next_exit_at = 0, None
        closed = full or p.tokens_remaining <= p.tokens_initial * 1e-9
        if closed:
            p.tokens_remaining = 0.0
            p.status, p.closed_at, p.exit_reason = "closed", ts, reason
            p.sol_usd_exit = self.sol_price.get() or p.sol_usd_entry
            p.pnl_sol = p.proceeds_sol - p.cost_sol
            p.pnl_usd = p.pnl_sol * (p.sol_usd_exit or 0)
        await self._persist_fill(p, f, reason, ts, before)
        if p.kind == "real":
            sym = await self._symbol(p.mint)
            if closed:
                ret = (p.proceeds_sol / p.cost_sol - 1) * 100 if p.cost_sol else 0.0
                head = (f"{'✅ WIN' if (p.pnl_usd or 0) > 0 else '❌ LOSS'} {sym} [{p.mode}] "
                        f"{'+' if (p.pnl_usd or 0) >= 0 else '-'}${abs(p.pnl_usd or 0):.2f} ({ret:+.0f}%) · "
                        f"{reason.replace('_', ' ')}")
            else:
                head = f"EXIT {sym} [{p.mode}] {reason.replace('_', ' ')} (partial)"
            txt = (f"{head}\nsold {f.tokens:,.0f} @ {price:.3e} -> {f.sol:.4f} SOL"
                   + (f"\nclosed pnl {p.pnl_sol:+.4f} SOL (${p.pnl_usd:+.2f})" if closed else "")
                   + f"\n{p.mint}" + (f"\ntx {f.tx_sig}" if f.tx_sig else ""))
            log.info(txt.replace("\n", " | "))
            if self.notify:
                await self.notify(txt)
        if closed:
            await self._release(p)
            if p.kind == "real":
                self.risk.register_realized(await self.realized_since(self.risk.loss_window_start(ts)))
                await self.risk.persist()

    async def drain(self, timeout: float = 90.0) -> None:
        """Let in-flight live trades finish (on shutdown)."""
        if self._tasks:
            await asyncio.wait(set(self._tasks), timeout=timeout)

    async def _release(self, p: Position) -> None:
        still = [q for q in self.positions.values() if q.active and q.id != p.id]
        if not any(q.mint == p.mint for q in still):
            self.pin(p.mint, False)
        if self.watch_account and p.creator and not any(q.creator == p.creator for q in still):
            await self.watch_account(p.creator, False)
        self.positions.pop(p.id, None)
        self._suspect.pop(p.id, None)

    def _state(self, p: Position) -> ExitState:
        return ExitState(p.entry_price, p.peak_price or p.entry_price, bool(p.tp_done), p.opened_at,
                         p.entry_liq_usd)

    # --- event handlers ------------------------------------------------------------
    async def on_tick(self, mint: str, price: float, ts: float, msg: dict) -> None:
        if not isfinite(price) or price <= 0 or not isfinite(ts):
            log.warning("ignoring invalid position tick for %s", mint)
            return
        targets = [p for p in self.positions.values() if p.mint == mint and p.active]
        if not targets:
            return
        async with self.lock:
            for p in targets:
                if p.status == "pending":
                    if ts > p.decided_at:
                        await self._fill_entry(p, price, ts)
                    continue
                await self._on_price(p, price, ts, str(msg.get("txType") or "stream"),
                                     msg.get("signature") or msg.get("pool"))

    def _implausible(self, p: Position, price: float, ts: float, source: str, detail) -> bool:
        """A mark far from the last one is held until a second tick lands near it. One bad tick
        (a pair quoted in the wrong token, a decode slip) must not fill a take-profit or a stop;
        a real crash or run is confirmed by the next trade seconds later."""
        factor = self.s.TICK_SANITY_FACTOR
        ref = p.last_price or p.entry_price
        if factor <= 1 or not ref or ref <= 0:
            return False
        if ref / factor <= price <= ref * factor:
            self._suspect.pop(p.id, None)
            return False
        prev = self._suspect.get(p.id)
        if prev and 0 <= ts - prev[1] <= TICK_CONFIRM_S and prev[0] / 3 <= price <= prev[0] * 3:
            log.warning("#%d %s: %s mark %.3e (%.0fx the last mark %.3e) confirmed by a second tick",
                        p.id, p.mint, source, price, price / ref, ref)
            self._suspect.pop(p.id, None)
            return False
        self._suspect[p.id] = (price, ts)
        log.warning("#%d %s: holding %s mark %.3e, %.4gx the last mark %.3e, until a second tick confirms it%s",
                    p.id, p.mint, source, price, price / ref, ref, f" ({detail})" if detail else "")
        return True

    async def _on_price(self, p: Position, price: float, ts: float, source: str = "stream",
                        detail: str | None = None) -> None:
        """Mark to market and run the exit rules. Caller holds the lock."""
        if (p.status != "open" or not isfinite(price) or price <= 0 or not isfinite(ts)
                or (p.last_tick_at is not None and ts < p.last_tick_at)):
            return
        if self._implausible(p, price, ts, source, detail):
            return
        p.last_price, p.last_tick_at = price, ts
        p.peak_price = max(p.peak_price or price, price)
        if p.pending_exit:
            await self._exit(p, p.pending_exit_fraction or 1.0, price, ts, p.pending_exit)
            return
        sig = check_exit(self._state(p), price, ts, self.s)
        if sig:
            await self._exit(p, sig.fraction, price, ts, sig.reason)

    async def queue_exit(self, p: Position, reason: str, fraction: float = 1.0) -> None:
        if p.id in self._entry_uncertain:
            return  # keep the durable intent until its original signature has a known outcome
        if p.id in self._inflight and p.status == "pending":
            return  # a live buy is in flight: let it land, then the exit is queued on the open position
        if p.status == "pending":
            p.status, p.exit_reason, p.closed_at = "cancelled", reason, now_s()
            await self._save(p)
            await self._release(p)
            return
        urgent = reason == "kill_switch" or reason.startswith("emergency")
        if not p.pending_exit or (urgent and (p.pending_exit_fraction or 1.0) < fraction):
            p.pending_exit, p.pending_exit_fraction, p.pending_exit_at = reason, fraction, now_s()
            await self._save(p)
            log.info("exit queued #%d %s: %s", p.id, p.mint, reason)

    async def periodic(self) -> None:
        """Timeouts, time stops, kill switch, liquidity + rugcheck polling."""
        now = now_s()
        async with self.lock:
            if kill_switch_active(self.s):
                if not self._kill_handled:
                    log.warning("STOP file present: no new entries, closing all real positions")
                    if self.notify:
                        await self.notify("KILL SWITCH: STOP file found, closing all positions")
                    self._kill_handled = True
                for p in list(self.active("real")):
                    await self.queue_exit(p, "kill_switch")
            else:
                self._kill_handled = False
            for p in list(self.positions.values()):
                if p.id in self._entry_uncertain:
                    if p.id not in self._inflight and p.last_price:
                        self._spawn(p, self._live_entry(p, p.last_price))
                    continue
                if (p.status == "pending" and p.id not in self._inflight
                        and now - p.decided_at > self.s.ENTRY_FILL_TIMEOUT_S):
                    p.status, p.exit_reason, p.closed_at = "cancelled", "no trade after decision", now
                    await self._save(p)
                    await self._release(p)
                    continue
                if p.status != "open":
                    continue
                if not p.pending_exit:
                    sig = check_exit(self._state(p), None, now, self.s)
                    if sig:
                        await self.queue_exit(p, sig.reason, sig.fraction)
                # a queued exit fills on the next tick; if the stream is quiet, at the last price.
                # A failed exit retries here too, on its backoff schedule (see _exit_failed).
                retry_due = p.exit_attempts > 0 and now >= (p.next_exit_at or 0)
                waited = now - (p.pending_exit_at or now) > self.s.EXIT_FILL_TIMEOUT_S
                if p.pending_exit and p.last_price and (retry_due or waited):
                    await self._exit(p, p.pending_exit_fraction or 1.0, p.last_price, now, p.pending_exit)
        await self._poll_liquidity(now)
        await self._poll_rugcheck(now)
        # persist marks so a crash loses at most a few seconds of peak tracking
        for p in list(self.positions.values()):
            if p.status == "open" and p.id:
                await self.db.update("positions", "id", p.id,
                                     {"last_price": p.last_price, "peak_price": p.peak_price,
                                      "last_tick_at": p.last_tick_at, "last_liq_usd": p.last_liq_usd})

    async def _poll_liquidity(self, now: float) -> None:
        if not self.dex or now - self._last_liq_poll < self.s.LIQ_POLL_S:
            return
        self._last_liq_poll = now
        opened = [p for p in self.positions.values() if p.status == "open"]
        if not opened:
            return
        try:
            pairs = await self.dex.tokens(sorted({p.mint for p in opened}))
        except Exception as e:
            log.warning("liquidity poll failed: %s", e)
            return
        async with self.lock:
            for p in opened:
                pair = pairs.get(p.mint)
                liq = _num(((pair or {}).get("liquidity") or {}).get("usd"))
                if liq is None and self.curve_liquidity:
                    liq = _num(self.curve_liquidity(p.mint))
                if liq is None or liq < 0:
                    continue
                p.last_liq_usd = liq
                if p.entry_liq_usd is None:
                    p.entry_liq_usd = liq
                sig = check_exit(self._state(p), None, now, self.s, liq_usd=liq)
                if sig and sig.reason.startswith("emergency") and p.status == "open":
                    await self.queue_exit(p, sig.reason)
                    continue
                # Stream gone quiet (e.g. graduated to PumpSwap without a PumpPortal API key):
                # use DexScreener's price as the mark so stops still work.
                stale = now - (p.last_tick_at or 0) > self.s.LIQ_POLL_S
                native = sol_price_native(pair)
                if stale and native and p.status == "open":
                    await self._on_price(p, native, now, "dexscreener", (pair or {}).get("pairAddress"))

    async def _poll_rugcheck(self, now: float) -> None:
        if not self.rugcheck or now - self._last_rug_poll < self.s.RUGCHECK_POLL_S:
            return
        self._last_rug_poll = now
        for p in [p for p in self.positions.values() if p.status == "open"]:
            try:
                rep = await self.rugcheck.check(p.mint, max_age_s=self.s.RUGCHECK_POLL_S / 2)
            except Exception as e:
                log.warning("rugcheck poll %s failed: %s", p.mint, e)
                continue
            if rep.get("danger"):
                async with self.lock:
                    if p.status == "open":
                        await self.queue_exit(p, "emergency_rugcheck_danger")

    async def run(self, stop: asyncio.Event, interval: float = 2.0) -> None:
        while not stop.is_set():
            try:
                await self.periodic()
            except Exception:
                log.exception("position loop error")
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass
