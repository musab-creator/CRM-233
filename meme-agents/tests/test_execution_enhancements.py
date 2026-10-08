"""Crash recovery and safety regressions; all live HTTP/RPC calls are local fakes."""
import asyncio
import json
from dataclasses import asdict
from types import SimpleNamespace

import pytest
from solders.hash import Hash
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction

from bot.db import Database
from bot.live.executor import LiveExecutionError, LiveExecutionUnknown, LiveExecutor
from bot.live.guard import LiveRefused, check_live_startup
from bot.paper import Fill, PaperExecutor, entry_fill, exit_fill, mark_to_market
from bot.positions import PositionManager
from bot.risk import RiskManager
from tests.test_live_executor import FakeHttp, FakeRpc, unsigned_tx
from tests.test_live_guard import bal, live
from tests.test_live_safety import FakeChain, _executor


class FixedPrice:
    def get(self):
        return 100.0


async def manager(s):
    db = await Database(s.DB_PATH).open()
    await db.kv_set("bankroll_sol", "0.5")
    return db, PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice())


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_nonfinite_values_never_enter_fill_accounting(s, bad):
    with pytest.raises(ValueError, match="finite"):
        entry_fill(bad, 1e-7, s)
    with pytest.raises(ValueError, match="finite"):
        entry_fill(0.1, bad, s)
    with pytest.raises(ValueError, match="finite"):
        exit_fill(bad, 1e-7, s)
    with pytest.raises(ValueError, match="finite"):
        mark_to_market(100, bad, s)
    with pytest.raises(LiveRefused, match="finite"):
        asyncio.run(check_live_startup(live(s), bal(bad)))


def test_entry_fill_and_inventory_roll_back_together(s, monkeypatch):
    async def go():
        db, pm = await manager(s)
        try:
            p = await pm.create("M", 1, "real", "C", 5, 10_000)
            before = asdict(p)
            insert = db.insert
            async def failing_insert(table, row):
                if table == "fills":
                    raise OSError("disk full")
                return await insert(table, row)
            monkeypatch.setattr(db, "insert", failing_insert)
            with pytest.raises(OSError, match="disk full"):
                await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
            assert asdict(p) == before
            assert (await db.fetchone("SELECT status,cost_sol FROM positions WHERE id=?", [p.id])) == {
                "status": "pending", "cost_sol": 0.0}
            assert await db.fetchall("SELECT * FROM fills") == []
            monkeypatch.setattr(db, "insert", insert)
            await pm.on_tick("M", 1e-7, p.decided_at + 2, {})
            assert p.status == "open" and len(await db.fetchall("SELECT * FROM fills")) == 1
        finally:
            await db.close()
    asyncio.run(go())


def test_exit_fill_and_cash_roll_back_together(s, monkeypatch):
    async def go():
        db, pm = await manager(s)
        try:
            p = await pm.create("M", 1, "real", "C", 5, 10_000)
            await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
            tokens, cash = p.tokens_remaining, await pm.cash_sol()
            insert = db.insert
            async def failing_insert(table, row):
                if table == "fills":
                    raise OSError("disk full")
                return await insert(table, row)
            monkeypatch.setattr(db, "insert", failing_insert)
            with pytest.raises(OSError):
                await pm.on_tick("M", 0.5e-7, p.decided_at + 2, {})
            row = await db.fetchone("SELECT status,tokens_remaining,proceeds_sol FROM positions WHERE id=?", [p.id])
            assert row == {"status": "open", "tokens_remaining": tokens, "proceeds_sol": 0.0}
            assert p.tokens_remaining == tokens and p.proceeds_sol == 0
            assert await pm.cash_sol() == cash
            assert len(await db.fetchall("SELECT * FROM fills")) == 1
            monkeypatch.setattr(db, "insert", insert)
            await pm.on_tick("M", 0.5e-7, p.decided_at + 3, {})
            assert p.status == "closed" and len(await db.fetchall("SELECT * FROM fills")) == 2
        finally:
            await db.close()
    asyncio.run(go())


def test_cash_is_conserved_through_partial_exit_and_restart(s):
    async def go():
        db, pm = await manager(s)
        try:
            p = await pm.create("M", 1, "real", "C", 5, 10_000)
            await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
            assert await pm.cash_sol() == pytest.approx(0.5 - p.cost_sol)
            await pm.on_tick("M", 1.6e-7, p.decided_at + 2, {})
            expected = 0.5 - p.cost_sol + p.proceeds_sol
            assert await pm.cash_sol() == pytest.approx(expected)
            restarted = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice())
            await restarted.load()
            assert await restarted.cash_sol() == pytest.approx(expected)
            await restarted.on_tick("M", 1e-7, p.decided_at + 3, {})
            closed = await db.fetchone("SELECT pnl_sol FROM positions WHERE id=?", [p.id])
            assert await restarted.cash_sol() == pytest.approx(0.5 + closed["pnl_sol"])
        finally:
            await db.close()
    asyncio.run(go())


def test_paper_never_resumes_or_counts_live_positions(s):
    async def go():
        db, pm = await manager(s)
        try:
            p = await pm.create("M", 1, "real", "C", 5, 10_000)
            await db.update("positions", "id", p.id, {"mode": "live"})
            await db.insert("positions", {"kind": "real", "mode": "live", "status": "closed", "pnl_sol": 99})
            restarted = PositionManager(s, db, RiskManager(s, 0), PaperExecutor(s), FixedPrice())
            await restarted.load()
            assert restarted.active() == []
            assert await restarted.cash_sol() == pytest.approx(0.5)
        finally:
            await db.close()
    asyncio.run(go())


def test_invalid_or_old_ticks_cannot_corrupt_a_position(s):
    async def go():
        db, pm = await manager(s)
        try:
            p = await pm.create("M", 1, "real", "C", 5, 10_000)
            await pm.on_tick("M", float("nan"), p.decided_at + 1, {})
            assert p.status == "pending"
            await pm.on_tick("M", 1e-7, p.decided_at + 2, {})
            await pm.on_tick("M", 0.1e-7, p.decided_at + 1, {})
            await pm._on_price(p, float("nan"), p.decided_at + 3)  # REST fallback shares validation
            assert p.status == "open" and p.last_price == 1e-7
        finally:
            await db.close()
    asyncio.run(go())


def test_remote_transaction_payer_and_explicit_spending_are_checked(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        kp = Keypair()
        http = FakeHttp(unsigned_tx(Keypair()))
        ex = LiveExecutor(s, db, http, kp, lambda m: False)
        try:
            with pytest.raises(LiveExecutionError, match="payer"):
                await ex.build_pumpportal("buy", "M", 0.05, True)
            ix = transfer(TransferParams(from_pubkey=kp.pubkey(), to_pubkey=Keypair().pubkey(),
                                         lamports=500_000_000))
            msg = MessageV0.try_compile(kp.pubkey(), [ix], [], Hash.default())
            http.body = bytes(VersionedTransaction.populate(msg, [kp.sign_message(b"unsigned")]))
            with pytest.raises(LiveExecutionError, match="spending limit"):
                await ex.build_pumpportal("buy", "M", 0.05, True)
            foreign = Keypair()
            ix = transfer(TransferParams(from_pubkey=foreign.pubkey(), to_pubkey=kp.pubkey(), lamports=1))
            msg = MessageV0.try_compile(kp.pubkey(), [ix], [], Hash.default())
            http.body = bytes(VersionedTransaction(msg, [kp, foreign]))
            with pytest.raises(LiveExecutionError, match="required signer"):
                await ex.build_pumpportal("buy", "M", 0.05, True)
        finally:
            await ex.close()
            await db.close()
    asyncio.run(go())


def test_live_build_uses_each_sides_configured_slippage(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        kp = Keypair()
        http = FakeHttp(unsigned_tx(kp))
        ex = LiveExecutor(s, db, http, kp, lambda m: False)
        try:
            await ex.build_pumpportal("buy", "M", 0.05, True)
            await ex.build_pumpportal("sell", "M", 100, False)
            assert [body["slippage"] for _, body in http.posts] == [3.0, 5.0]
        finally:
            await ex.close()
            await db.close()
    asyncio.run(go())


def test_failed_simulation_never_returns_a_fill(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        kp = Keypair()
        ex = LiveExecutor(s, db, FakeHttp(unsigned_tx(kp)), kp, lambda m: False)
        await ex.rpc.close()
        class FailedSimulation(FakeRpc):
            async def simulate_transaction(self, tx, sig_verify=False):
                return SimpleNamespace(value=SimpleNamespace(err="InstructionError", logs=[]))
        ex.rpc = FailedSimulation()
        try:
            with pytest.raises(LiveExecutionError, match="simulation failed"):
                await ex.buy("M", 0.05, 1e-7)
            row = await db.fetchone("SELECT sent,ok FROM live_tx")
            assert row == {"sent": 0, "ok": 0}
        finally:
            await db.close()
    asyncio.run(go())


def test_stop_after_build_prevents_dry_run_entry(s, tmp_path):
    async def go():
        db = await Database(s.DB_PATH).open()
        kp = Keypair()
        class StopDuringBuild(FakeHttp):
            async def post(self, *args, **kwargs):
                (tmp_path / "STOP").touch()
                return await super().post(*args, **kwargs)
        ex = LiveExecutor(s, db, StopDuringBuild(unsigned_tx(kp)), kp, lambda m: False)
        await ex.rpc.close()
        ex.rpc = FakeRpc()
        try:
            with pytest.raises(LiveExecutionError, match="STOP"):
                await ex.buy("M", 0.05, 1e-7)
            assert ex.rpc.simulated == []
        finally:
            await db.close()
    asyncio.run(go())


def test_uncertain_send_reconciles_original_signature_after_restart(s):
    async def go():
        chain = FakeChain()
        db, http, ex = await _executor(s, chain)
        try:
            def landed(c):
                c.sol -= 0.0712
                c.tok["MintAddr"] = 480_000.0
            ex.rpc.effect = landed
            send = ex.rpc.send_raw_transaction
            async def response_lost(raw, opts=None):
                await send(raw, opts)
                raise TimeoutError("response lost after landing")
            ex.rpc.send_raw_transaction = response_lost
            with pytest.raises(LiveExecutionUnknown, match="quarantined"):
                await ex.buy("MintAddr", 0.07, 1e-7)
            assert ex.rpc.sent == 1 and len(http.posts) == 1
            # Other wallet activity after this signature must not alter its fill.
            chain.sol += 1.0
            restarted = LiveExecutor(s, db, http, ex._kp, lambda m: False, chain)
            try:
                f = await restarted.buy("MintAddr", 0.07, 1e-7)
                assert f.sol == pytest.approx(0.0712) and f.tokens == 480_000.0
                assert ex.rpc.sent == 1 and len(http.posts) == 1
                async with db.transaction():
                    await restarted.acknowledge_fill("MintAddr", "buy", f.tx_sig)
                assert await restarted.pending_intent("MintAddr", "buy") is None
            finally:
                await restarted.close()
        finally:
            await db.close()
    asyncio.run(go())


def test_pending_live_intent_survives_restart_and_stop(s, tmp_path):
    async def go():
        chain = FakeChain()
        db, http, ex = await _executor(s, chain)
        try:
            await db.kv_set("bankroll_sol", "0.5")
            pm = PositionManager(s, db, RiskManager(s, 0), ex, FixedPrice())
            p = await pm.create("MintAddr", 1, "real", "C", 5, 10_000)
            # Crash immediately after durable intent preparation, before an outcome was recorded.
            intent = {"signature": "unknown-signature", "mint": p.mint, "side": "buy",
                      "price": 1e-7, "amount": p.sol_in, "route": "pumpportal"}
            await db.kv_set(ex._intent_key(p.mint, "buy"), json.dumps(intent))
            chain.status = "pending"
            restarted = PositionManager(s, db, RiskManager(s, 0), ex, FixedPrice())
            await restarted.load()
            q = restarted.positions[p.id]
            assert p.id in restarted._entry_uncertain and restarted.risk.paused_reason
            (tmp_path / "STOP").touch()
            await restarted.queue_exit(q, "kill_switch")
            assert q.status == "pending" and q.id in restarted.positions
            assert http.posts == [] and ex.rpc.sent == 0
        finally:
            await db.close()
    asyncio.run(go())


def test_partial_receipt_cannot_close_inventory_after_exit_intent_changes(s):
    async def go():
        db, pm = await manager(s)
        try:
            p = await pm.create("M", 1, "real", "C", 5, 10_000)
            await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
            remaining = p.tokens_remaining / 2
            p.pending_exit, p.pending_exit_fraction, p.pending_exit_at = "kill_switch", 1, p.decided_at + 2
            f = Fill("sell", 1.6e-7, 1.6e-7, remaining, 0.04, 0, "confirmed-partial", remaining)
            await pm._apply_exit(p, f, 1.0, 1.6e-7, p.decided_at + 3, "kill_switch")
            assert p.status == "open" and p.tokens_remaining == remaining
            assert p.pending_exit == "kill_switch" and p.pending_exit_fraction == 1
        finally:
            await db.close()
    asyncio.run(go())


def test_excessive_compute_fee_is_refused_before_signing(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        kp = Keypair()
        instructions = [set_compute_unit_limit(1_000_000), set_compute_unit_price(1_000_000_000)]
        msg = MessageV0.try_compile(kp.pubkey(), instructions, [], Hash.default())
        raw = bytes(VersionedTransaction.populate(msg, [kp.sign_message(b"unsigned")]))
        ex = LiveExecutor(s, db, FakeHttp(raw), kp, lambda m: False)
        try:
            with pytest.raises(LiveExecutionError, match="spending limit"):
                await ex.build_pumpportal("buy", "M", 0.05, True)
        finally:
            await ex.close()
            await db.close()
    asyncio.run(go())


@pytest.mark.parametrize("kind", ["overspend", "failure", "missing_account"])
def test_live_prebroadcast_simulation_blocks_unsafe_sends(s, kind):
    async def go():
        chain = FakeChain()
        db, http, ex = await _executor(s, chain)
        original_rpc = chain.rpc
        async def simulation(method, params):
            if method == "simulateTransaction":
                if kind == "failure":
                    return {"value": {"err": "InstructionError", "accounts": []}}
                if kind == "missing_account":
                    return {"value": {"err": None, "accounts": []}}
                return {"value": {"err": None, "accounts": [{"lamports": 0}]}}
            return await original_rpc(method, params)
        chain.rpc = simulation
        try:
            with pytest.raises(LiveExecutionError, match="simulation refused"):
                await ex.buy("MintAddr", 0.07, 1e-7)
            assert ex.rpc.sent == 0 and await ex.pending_intent("MintAddr", "buy") is None
        finally:
            await db.close()
    asyncio.run(go())


def test_stop_after_intent_persistence_still_prevents_broadcast(s, tmp_path, monkeypatch):
    async def go():
        chain = FakeChain()
        db, http, ex = await _executor(s, chain)
        original_set = db.kv_set
        async def persist_then_stop(key, value):
            await original_set(key, value)
            if key.startswith("live_intent:"):
                (tmp_path / "STOP").touch()
        monkeypatch.setattr(db, "kv_set", persist_then_stop)
        try:
            with pytest.raises(LiveExecutionError, match="before broadcast"):
                await ex.buy("MintAddr", 0.07, 1e-7)
            assert ex.rpc.sent == 0 and await ex.pending_intent("MintAddr", "buy") is None
        finally:
            await db.close()
    asyncio.run(go())


def test_tracked_partial_sell_is_reconciled_once_without_reselling(s):
    async def go():
        chain = FakeChain()
        chain.tok["MintAddr"] = 480_000.0
        db, http, ex = await _executor(s, chain)
        try:
            def landed(c):
                c.tok["MintAddr"] = 240_000.0
                c.sol += 0.04
            ex.rpc.effect = landed
            send = ex.rpc.send_raw_transaction
            async def response_lost(raw, opts=None):
                await send(raw, opts)
                raise TimeoutError("response lost")
            ex.rpc.send_raw_transaction = response_lost
            with pytest.raises(LiveExecutionUnknown):
                await ex.sell("MintAddr", 240_000.0, 1e-7, 0.5)
            fill = await ex.sell("MintAddr", 480_000.0, 1e-7, 1.0)
            assert ex.rpc.sent == 1 and len(http.posts) == 1
            assert fill.tokens == 240_000.0 and fill.remaining_tokens == 240_000.0
            assert fill.sol == pytest.approx(0.04)
        finally:
            await db.close()
    asyncio.run(go())


def test_live_intent_is_only_acknowledged_with_durable_fill(s, monkeypatch):
    async def go():
        chain = FakeChain()
        db, http, ex = await _executor(s, chain)
        try:
            await db.kv_set("bankroll_sol", "0.5")
            pm = PositionManager(s, db, RiskManager(s, 0), ex, FixedPrice())
            p = await pm.create("MintAddr", 1, "real", "C", 5, 10_000)
            def landed(c):
                c.sol -= 0.051
                c.tok["MintAddr"] = 400_000.0
            ex.rpc.effect = landed
            f = await ex.buy(p.mint, p.sol_in, 1e-7)
            original_insert = db.insert
            async def failing_fill(table, row):
                if table == "fills":
                    raise OSError("disk full")
                return await original_insert(table, row)
            monkeypatch.setattr(db, "insert", failing_fill)
            with pytest.raises(OSError):
                await pm._apply_entry(p, f, 1e-7, p.decided_at + 1)
            assert await ex.pending_intent(p.mint, "buy") is not None
            assert p.status == "pending"
            monkeypatch.setattr(db, "insert", original_insert)
            replay = await ex.buy(p.mint, p.sol_in, 1e-7)
            await pm._apply_entry(p, replay, 1e-7, p.decided_at + 2)
            assert await ex.pending_intent(p.mint, "buy") is None
            assert ex.rpc.sent == 1 and p.status == "open"
        finally:
            await db.close()
    asyncio.run(go())


def test_live_cash_uses_actual_wallet_after_fees_and_reserves_pending_entries(s):
    async def go():
        chain = FakeChain(sol=0.08)
        db, http, ex = await _executor(s, chain)
        try:
            await db.kv_set("bankroll_sol", "0.5")  # old paper bankroll cannot fund live orders
            pm = PositionManager(s, db, RiskManager(s, 0), ex, FixedPrice())
            assert await pm.cash_sol() == pytest.approx(0.08)
            p = await pm.create("MintAddr", 1, "real", "C", 5, 10_000)
            assert p is not None
            assert await pm.cash_sol() == pytest.approx(0.025)
            assert await pm.create("OtherMint", 2, "real", "OtherCreator", 5, 10_000) is None
            chain.sol -= 0.005  # a charged failed send must reduce spendable cash
            assert await pm.cash_sol() == pytest.approx(0.020)
        finally:
            await db.close()
    asyncio.run(go())


def test_direct_live_guard_cannot_raise_the_wallet_ceiling(s):
    with pytest.raises(LiveRefused, match="no more than 1"):
        asyncio.run(check_live_startup(live(s, LIVE_MAX_WALLET_SOL=2.0), bal(1.5)))
    # the operator's 1 SOL cap (8 Oct) is accepted and enforced
    asyncio.run(check_live_startup(live(s, LIVE_MAX_WALLET_SOL=1.0), bal(0.9)))
    with pytest.raises(LiveRefused):
        asyncio.run(check_live_startup(live(s, LIVE_MAX_WALLET_SOL=1.0), bal(1.1)))


def test_landed_buy_journal_reconciles_before_restart_stop_can_cancel(s, tmp_path):
    async def go():
        chain = FakeChain()
        db, http, ex = await _executor(s, chain)
        try:
            await db.kv_set("bankroll_sol", "0.5")
            pm = PositionManager(s, db, RiskManager(s, 0), ex, FixedPrice())
            p = await pm.create("MintAddr", 1, "real", "C", 5, 10_000)
            def landed(c):
                c.sol -= 0.051
                c.tok[p.mint] = 400_000.0
            ex.rpc.effect = landed
            # Crash after send, before PositionManager applies its receipt or uncertainty marker.
            receipt = await ex.buy(p.mint, p.sol_in, 1e-7)
            saved = await db.fetchone("SELECT status,exit_reason FROM positions WHERE id=?", [p.id])
            assert saved == {"status": "pending", "exit_reason": None}
            (tmp_path / "STOP").touch()
            restarted = PositionManager(s, db, RiskManager(s, 0), ex, FixedPrice())
            await restarted.load()
            await restarted.periodic()
            await restarted.drain(2)
            q = restarted.positions[p.id]
            assert q.status == "open" and q.tokens_remaining == 400_000.0
            assert q.pending_exit == "kill_switch" and q.pending_exit_fraction == 1.0
            assert ex.rpc.sent == 1 and len(http.posts) == 1
            fills = await db.fetchall("SELECT side,tx_sig FROM fills")
            assert fills == [{"side": "buy", "tx_sig": receipt.tx_sig}]
            assert await ex.pending_intent(p.mint, "buy") is None
        finally:
            await db.close()
    asyncio.run(go())


def test_simulated_spend_allows_fees_and_token_account_rent_but_not_more(s):
    """The first live buy was refused: a real pump.fun buy pays rent for the wallet's new token
    account and the percentage fees on top of the SOL amount, which the old limit did not allow."""
    from bot.live.executor import spend_limit
    assert spend_limit("buy", 0.025, s) == pytest.approx(0.025 * 1.015 + 0.005 + 0.0025)
    assert spend_limit("sell", 0.025, s) == pytest.approx(0.005 + 0.0025)

    async def go(debit_sol: float):
        chain = FakeChain()
        db, http, ex = await _executor(s, chain)
        before = await chain.balance_sol(ex.pubkey)
        original_rpc = chain.rpc

        async def simulation(method, params):
            if method == "simulateTransaction":
                return {"value": {"err": None, "accounts": [{"lamports": int((before - debit_sol) * 1e9)}]}}
            return await original_rpc(method, params)

        chain.rpc = simulation
        try:
            await ex._check_simulated_spend(await ex.build_pumpportal("buy", "MintAddr", 0.07, True), "buy", 0.07)
        finally:
            await db.close()

    asyncio.run(go(0.07 * 1.015 + 0.004 + 0.000005 + 0.00203928))   # amount, fees, priority, base fee, rent
    with pytest.raises(LiveExecutionError, match="spending limit"):
        asyncio.run(go(0.07 + 0.013))                                  # a quarter more than fees and rent explain
