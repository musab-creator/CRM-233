"""Live-trading safety: wallet reconciliation, percentage sells, no double sells, exit backoff,
off-tick-path execution, and the kill switch at fill time."""
import asyncio
import time
from types import SimpleNamespace

import pytest
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction

from bot.db import Database
from bot.live.executor import LiveExecutionError, LiveExecutionUnknown, LiveExecutor
from bot.paper import Fill, PaperExecutor, entry_fill, exit_fill
from bot.positions import PositionManager
from bot.risk import RiskManager
from tests.test_live_executor import FakeHttp, unsigned_tx

MINT = "MintAddr"


class FakeChain:
    def __init__(self, sol=1.0):
        self.sol = sol
        self.tok: dict[str, float] = {}
        self.status = "ok"
        self.receipts = {}
        self.owner = None

    async def balance_sol(self, pubkey):
        return self.sol

    async def token_balance(self, owner, mint):
        t = self.tok.get(mint, 0.0)
        return int(t * 1e6), t

    async def signature_status(self, sig):
        return self.status

    async def rpc(self, method, params):
        if method == "simulateTransaction":
            return {"value": {"err": None, "accounts": [{"lamports": round(self.sol * 1e9)}]}}
        assert method == "getTransaction"
        return self.receipts.get(params[0])


class SendingRpc:
    """Applies `effect` to the fake chain when a transaction is sent."""

    def __init__(self, chain):
        self.chain = chain
        self.sent = 0
        self.effect = None

    async def send_raw_transaction(self, raw, opts=None):
        self.sent += 1
        sol_before, tokens_before = self.chain.sol, dict(self.chain.tok)
        if self.effect:
            self.effect(self.chain)
        signature = str(VersionedTransaction.from_bytes(raw).signatures[0])
        def balances(values):
            return [{"mint": mint, "owner": self.chain.owner,
                     "uiTokenAmount": {"amount": str(round(tokens * 1e6)), "decimals": 6}}
                    for mint, tokens in values.items()]
        self.chain.receipts[signature] = {
            "transaction": {"message": {"accountKeys": [{"pubkey": self.chain.owner}]}},
            "meta": {"err": None, "fee": 5000,
                     "preBalances": [round(sol_before * 1e9)],
                     "postBalances": [round(self.chain.sol * 1e9)],
                     "preTokenBalances": balances(tokens_before),
                     "postTokenBalances": balances(self.chain.tok)}}
        return SimpleNamespace(value=signature)

    async def simulate_transaction(self, *a, **k):
        raise AssertionError("sending simulation must use the shared Helius limiter/credit tracker")

    async def close(self):
        pass


async def _executor(s, chain):
    s.LIVE_DRY_RUN = False
    s.LIVE_CONFIRM_TIMEOUT_S = 0.2
    db = await Database(s.DB_PATH).open()
    kp = Keypair()
    http = FakeHttp(unsigned_tx(kp))
    ex = LiveExecutor(s, db, http, kp, is_graduated=lambda m: False, chain=chain)
    chain.owner = ex.pubkey
    await ex.rpc.close()
    ex.rpc = SendingRpc(chain)
    ex.poll_s = 0.01
    return db, http, ex


def test_send_buy_reconciles_against_the_wallet(s):
    async def go():
        chain = FakeChain(sol=1.0)
        db, http, ex = await _executor(s, chain)

        def landed(c):
            c.sol -= 0.0712
            c.tok[MINT] = 480_000.0
        ex.rpc.effect = landed
        f = await ex.buy(MINT, 0.07, 1e-7)
        assert f.tokens == 480_000.0 and f.sol == pytest.approx(0.0712) and f.tx_sig
        rows = await db.fetchall("SELECT sent, ok, signature FROM live_tx")
        assert rows and rows[0]["sent"] == 0 and rows[-1]["sent"] == 1 and rows[-1]["ok"] == 1
        await db.close()
    asyncio.run(go())


def test_full_exit_sells_100_percent_of_actual_holdings(s):
    async def go():
        chain = FakeChain(sol=0.9)
        chain.tok[MINT] = 470_000.0  # wallet holds less than the bot's 480k estimate
        db, http, ex = await _executor(s, chain)

        def landed(c):
            c.tok[MINT] = 0.0
            c.sol += 0.09
        ex.rpc.effect = landed
        f = await ex.sell(MINT, 480_000.0, 1e-7, fraction=1.0)
        assert http.posts[-1][1]["amount"] == "100%" and http.posts[-1][1]["denominatedInSol"] == "false"
        assert f.tokens == 470_000.0 and f.sol == pytest.approx(0.09)
        await db.close()
    asyncio.run(go())


def test_partial_exit_sells_a_percentage(s):
    async def go():
        chain = FakeChain()
        chain.tok[MINT] = 480_000.0
        db, http, ex = await _executor(s, chain)
        ex.rpc.effect = lambda c: c.tok.__setitem__(MINT, 240_000.0)
        f = await ex.sell(MINT, 240_000.0, 1e-7, fraction=0.5)
        assert http.posts[-1][1]["amount"] == "50%" and f.tokens == 240_000.0
        await db.close()
    asyncio.run(go())


def test_untracked_wallet_changes_never_fabricate_a_sell_fill(s):
    async def go():
        chain = FakeChain()
        chain.tok[MINT] = 0.0  # the earlier attempt landed after we gave up on it
        db, http, ex = await _executor(s, chain)
        with pytest.raises(LiveExecutionUnknown, match="without a tracked sell signature"):
            await ex.sell(MINT, 480_000.0, 1e-7, fraction=1.0)
        assert ex.rpc.sent == 0 and http.posts == []
        chain.tok[MINT] = 240_000.0  # half already sold by an earlier take-profit attempt
        with pytest.raises(LiveExecutionUnknown, match="without a tracked sell signature"):
            await ex.sell(MINT, 240_000.0, 1e-7, fraction=0.5)
        assert ex.rpc.sent == 0
        await db.close()
    asyncio.run(go())


def test_failed_or_unconfirmed_sends_raise(s):
    async def go():
        chain = FakeChain()
        db, http, ex = await _executor(s, chain)
        chain.status = "failed"
        with pytest.raises(LiveExecutionError, match="failed on chain"):
            await ex.buy(MINT, 0.07, 1e-7)
        chain.status = "pending"  # never confirmed and nothing arrived
        with pytest.raises(LiveExecutionError, match="not confirmed"):
            await ex.buy(MINT, 0.07, 1e-7)
        await db.close()
    asyncio.run(go())


class FixedPrice:
    def get(self):
        return 100.0


class FlakySeller(PaperExecutor):
    def __init__(self, s, fails):
        super().__init__(s)
        self.fails = fails
        self.calls = 0

    async def sell(self, mint, tokens, price, fraction=1.0, urgent=False):
        self.calls += 1
        self.urgent = getattr(self, "urgent", []) + [urgent]
        if self.calls <= self.fails:
            raise RuntimeError("rpc down")
        return exit_fill(tokens, price, self.s, urgent)


async def _manager(s, executor):
    db = await Database(s.DB_PATH).open()
    await db.kv_set("bankroll_sol", "0.5")
    return db, PositionManager(s, db, RiskManager(s, 0), executor, FixedPrice())


def test_failed_exit_backs_off_instead_of_retrying_every_tick(s):
    async def go():
        ex = FlakySeller(s, fails=2)
        db, pm = await _manager(s, ex)
        p = await pm.create("M", 1, "real", "C", 5.0, None)
        t0 = time.time()
        await pm.on_tick("M", 1e-7, t0, {})
        await pm.on_tick("M", 0.5e-7, t0 + 1, {})      # stop loss -> attempt 1 fails
        assert ex.calls == 1 and p.exit_attempts == 1 and p.next_exit_at == pytest.approx(t0 + 1 + 5)
        for i in range(50):                            # a burst of ticks inside the backoff window
            await pm.on_tick("M", 0.5e-7, t0 + 1.1 + i * 0.05, {})
        assert ex.calls == 1
        await pm.on_tick("M", 0.5e-7, t0 + 6.5, {})    # backoff elapsed -> attempt 2 fails, waits 10 s
        assert ex.calls == 2 and p.next_exit_at == pytest.approx(t0 + 6.5 + 10)
        await pm.on_tick("M", 0.5e-7, t0 + 17, {})     # attempt 3 succeeds
        assert ex.calls == 3 and p.status == "closed" and p.exit_reason == "stop_loss"
        await db.close()
    asyncio.run(go())


class SlowLive(PaperExecutor):
    mode = "live"

    def __init__(self, s):
        super().__init__(s)
        self.release = asyncio.Event()
        self.buys = 0

    async def buy(self, mint, sol_in, price):
        self.buys += 1
        await self.release.wait()
        return entry_fill(sol_in, price, self.s)


def test_live_trades_run_off_the_tick_path(s):
    async def go():
        ex = SlowLive(s)
        db, pm = await _manager(s, ex)
        p = await pm.create("M", 1, "real", "C", 5.0, None)
        start = time.monotonic()
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})   # must return while the buy is in flight
        await pm.on_tick("M", 1.1e-7, p.decided_at + 2, {})
        assert time.monotonic() - start < 0.5
        await asyncio.sleep(0.05)
        assert ex.buys == 1 and p.status == "pending"       # no duplicate buy
        await pm.queue_exit(p, "kill_switch")               # must not orphan the in-flight buy
        assert p.status == "pending" and p.id in pm.positions
        ex.release.set()
        await pm.drain(2)
        assert p.status == "open" and p.entry_price == 1e-7
        await db.close()
    asyncio.run(go())


def test_kill_switch_or_pause_cancels_a_pending_entry_at_fill_time(s, tmp_path):
    async def go():
        class CountingBuys(PaperExecutor):
            buys = 0

            async def buy(self, mint, sol_in, price):
                CountingBuys.buys += 1
                return await super().buy(mint, sol_in, price)
        db, pm = await _manager(s, CountingBuys(s))
        p = await pm.create("M", 1, "real", "C", 5.0, None)
        (tmp_path / "STOP").write_text("")
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        assert p.status == "cancelled" and "kill switch" in p.exit_reason and CountingBuys.buys == 0
        (tmp_path / "STOP").unlink()
        q = await pm.create("N", 2, "real", "C2", 5.0, None)
        pm.risk.paused_reason = "daily loss cap hit"
        await pm.on_tick("N", 1e-7, q.decided_at + 1, {})
        assert q.status == "cancelled" and "paused" in q.exit_reason and CountingBuys.buys == 0
        await db.close()
    asyncio.run(go())


def test_paper_fill_object_shape_unchanged():
    f = Fill("buy", 1.0, 1.03, 10.0, 1.005, 0.02)
    assert f.tx_sig is None
