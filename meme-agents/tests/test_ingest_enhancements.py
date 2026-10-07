"""Signed-event replay protection and durable ingestion under SQLite failures/concurrency."""
import asyncio
import time

import pytest

from bot.db import Database
from bot.feeds.pumpchain import HeliusChain
from bot.ingest import Ingestor


def _create(signature="launch"):
    return {"txType": "create", "mint": "Mint", "pool": "pump", "bondingCurveKey": "Curve",
            "traderPublicKey": "Dev", "signature": signature, "solAmount": 1, "initialBuy": 10}


def _buy(signature="buy", trader="Buyer", mint="Mint", side="buy"):
    return {"txType": side, "mint": mint, "traderPublicKey": trader, "signature": signature,
            "solAmount": 2, "tokenAmount": 20}


def test_signed_replays_do_not_mutate_aggregates_dispatch_ticks_or_duplicate_rows(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            ing = Ingestor(s, db)
            ticks = []

            async def tick(*args):
                ticks.append(args)

            ing.tick_handlers.append(tick)
            await ing.handle(_create(), 100)
            await ing.handle(_create(), 200)
            # The same launch transaction may be repeated as its dev's initial buy.
            await ing.handle(_buy("launch", "Dev"), 201)
            await asyncio.gather(ing.handle(_buy(), 202), ing.handle(_buy(), 203))
            st = ing.mints["Mint"]
            assert (st.trade_count, st.buy_count, st.buy_sol, st.created_at) == (2, 2, 3, 100)
            assert st.buyers == {"Buyer"} and len(ticks) == 1
            await ing.flush()
            await ing.handle(_buy(), 204)
            assert st.trade_count == 2 and len(ticks) == 1
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 2
            assert not ing._pending_trade_keys
        finally:
            await db.close()
    asyncio.run(go())


def test_replays_remain_idempotent_after_restart(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            first = Ingestor(s, db)
            now = time.time()
            await first.handle(_create(), now)
            await first.handle(_buy(), now + 1)
            await first.flush()
            resumed = Ingestor(s, db)
            await resumed.restore()
            await resumed.handle(_create(), now + 2)
            await resumed.handle(_buy(), now + 3)
            await resumed.flush()
            assert resumed.mints["Mint"].trade_count == 2
            assert resumed.mints["Mint"].buy_sol == 3
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 2
        finally:
            await db.close()
    asyncio.run(go())


def test_tick_callback_can_ingest_another_event_without_deadlocking(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            ing = Ingestor(s, db)
            await ing.handle(_create(), 100)
            ticks = []

            async def tick(mint, price, ts, msg):
                ticks.append(msg["signature"])
                if msg["signature"] == "outer":
                    await ing.handle(_buy("inner"), 102)

            ing.tick_handlers.append(tick)
            await asyncio.wait_for(ing.handle(_buy("outer"), 101), 2)
            assert ticks == ["outer", "inner"]
            assert ing.mints["Mint"].trade_count == 3
        finally:
            await db.close()
    asyncio.run(go())


def test_failed_prebuffer_mutation_releases_signature_claim_for_retry(s, monkeypatch):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            ing = Ingestor(s, db)
            await ing.handle(_create(), 100)
            original = ing._apply

            def fail(*args):
                raise RuntimeError("injected pre-buffer failure")

            monkeypatch.setattr(ing, "_apply", fail)
            with pytest.raises(RuntimeError, match="injected pre-buffer failure"):
                await ing.handle(_buy(), 101)
            assert ("buy", "Mint", "Buyer", "buy") not in ing._pending_trade_keys
            monkeypatch.setattr(ing, "_apply", original)
            await ing.handle(_buy(), 102)
            assert ing.mints["Mint"].trade_count == 2
            await ing.flush()
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 2
        finally:
            await db.close()
    asyncio.run(go())


def test_dedup_keeps_unsigned_events_and_distinct_wallets_sides_and_mints(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            ing = Ingestor(s, db)
            await ing.handle(_create(), 100)
            for msg in (_buy(None), _buy(None), _buy(""), _buy(""),
                        _buy("bundle", "A"), _buy("bundle", "B"),
                        _buy("bundle", "A", side="sell"), _buy("bundle", "A", mint="Other")):
                await ing.handle(msg, 101)
            await ing.handle(_buy("bundle", "A", mint="Other"), 102)
            await ing.flush()
            assert ing.mints["Mint"].trade_count == 8
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 9
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades WHERE mint='Other'"))["n"] == 1
        finally:
            await db.close()
    asyncio.run(go())


@pytest.mark.parametrize("failed_write", ["insert_trades", "upsert_mints"])
def test_failed_flush_rolls_back_both_tables_and_keeps_retry_batch(s, monkeypatch, failed_write):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            ing = Ingestor(s, db)
            await ing.handle(_create(), 100)
            await ing.handle(_buy(), 101)
            original = getattr(db, failed_write)

            async def fail(rows):
                await original(rows)
                raise RuntimeError("injected write failure")

            monkeypatch.setattr(db, failed_write, fail)
            with pytest.raises(RuntimeError, match="injected write failure"):
                await ing.flush()
            assert len(ing._trade_buf) == 2 and ing._dirty == {"Mint"}
            assert len(ing._pending_trade_keys) == 2
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 0
            assert (await db.fetchone("SELECT COUNT(*) n FROM mints"))["n"] == 0
            # A replay arriving while the original batch awaits retry still cannot count twice.
            await ing.handle(_buy(), 102)
            monkeypatch.setattr(db, failed_write, original)
            await ing.flush()
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 2
            assert not ing._trade_buf and not ing._dirty and not ing._pending_trade_keys
        finally:
            await db.close()
    asyncio.run(go())


def test_flush_keeps_new_appends_and_same_mint_updates_during_database_io(s, monkeypatch):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            ing = Ingestor(s, db)
            await ing.handle(_create(), 100)
            entered, release = asyncio.Event(), asyncio.Event()
            original = db.insert_trades

            async def block(rows):
                entered.set()
                await release.wait()
                await original(rows)

            monkeypatch.setattr(db, "insert_trades", block)
            task = asyncio.create_task(ing.flush())
            await asyncio.wait_for(entered.wait(), 2)
            # Unsigned data can arrive without waiting on the DB replay lookup.
            await ing.handle(_buy(None), 101)
            ing.apply_holders("Mint", {"wallets_ex_dev": 50, "holders_ex_dev": 45}, 102)
            release.set()
            await asyncio.wait_for(task, 2)
            assert len(ing._trade_buf) == 1 and ing._dirty == {"Mint"}
            row = await db.fetchone("SELECT * FROM mints WHERE mint='Mint'")
            assert row["trade_count"] == 1 and row["wallets_ex_dev"] is None
            monkeypatch.setattr(db, "insert_trades", original)
            await ing.flush()
            row = await db.fetchone("SELECT * FROM mints WHERE mint='Mint'")
            assert row["trade_count"] == 2 and row["wallets_ex_dev"] == 50
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 2
            assert not ing._trade_buf and not ing._dirty
        finally:
            await db.close()
    asyncio.run(go())


def test_concurrent_flushes_are_serialized_and_do_not_insert_the_same_batch_twice(s, monkeypatch):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            ing = Ingestor(s, db)
            await ing.handle(_create(), 100)
            entered, release = asyncio.Event(), asyncio.Event()
            original = db.insert_trades
            calls = 0

            async def block_first(rows):
                nonlocal calls
                calls += 1
                if calls == 1:
                    entered.set()
                    await release.wait()
                await original(rows)

            monkeypatch.setattr(db, "insert_trades", block_first)
            first = asyncio.create_task(ing.flush())
            await asyncio.wait_for(entered.wait(), 2)
            second = asyncio.create_task(ing.flush())
            await ing.handle(_buy(None), 101)
            release.set()
            await asyncio.wait_for(asyncio.gather(first, second), 2)
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 2
            assert not ing._trade_buf and not ing._dirty
        finally:
            await db.close()
    asyncio.run(go())


def test_cancelled_flush_retains_uncommitted_events_and_can_retry(s, monkeypatch):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            ing = Ingestor(s, db)
            await ing.handle(_create(), 100)
            entered = asyncio.Event()
            original = db.upsert_mints

            async def block(rows):
                entered.set()
                await asyncio.Event().wait()

            monkeypatch.setattr(db, "upsert_mints", block)
            task = asyncio.create_task(ing.flush())
            await asyncio.wait_for(entered.wait(), 2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert len(ing._trade_buf) == 1 and ing._dirty == {"Mint"}
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 0
            monkeypatch.setattr(db, "upsert_mints", original)
            await ing.flush()
            assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 1
        finally:
            await db.close()
    asyncio.run(go())


@pytest.mark.parametrize("error", [asyncio.TimeoutError(), RuntimeError("rate limit exceeded")])
def test_transient_holder_errors_do_not_disable_zero_balance_capability(error):
    class Rpc:
        async def das(self, method, params):
            raise error

    async def go():
        chain = HeliusChain(Rpc())
        with pytest.raises(type(error)):
            await chain._token_accounts_page("Mint", 1)
        assert chain._das_options
    asyncio.run(go())


def test_explicit_unsupported_holder_option_uses_compatibility_fallback():
    class Rpc:
        def __init__(self):
            self.params = []

        async def das(self, method, params):
            self.params.append(params)
            if "options" in params:
                raise RuntimeError("unsupported option showZeroBalance")
            return {"token_accounts": [{"owner": "Buyer", "amount": 1}]}

    async def go():
        rpc = Rpc()
        chain = HeliusChain(rpc)
        assert await chain._token_accounts_page("Mint", 1) == [{"owner": "Buyer", "amount": 1}]
        assert not chain._das_options and len(rpc.params) == 2
        assert "options" not in rpc.params[-1]
    asyncio.run(go())
