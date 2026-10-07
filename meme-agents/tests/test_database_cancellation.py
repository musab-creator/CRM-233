"""SQLite boundaries remain truthful when the worker finishes after cancellation."""
import asyncio
from types import SimpleNamespace

import pytest
from aiosqlite.context import contextmanager as sqlite_cursor

from bot.db import Database
from bot.paper import PaperExecutor
from bot.positions import PositionManager
from bot.risk import RiskManager


def test_cancelled_begin_finishes_and_rolls_back_before_releasing_lock(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        original = db.conn.execute
        began, release = asyncio.Event(), asyncio.Event()
        yielded = []

        async def delayed_begin(sql, *args, **kwargs):
            cursor = await original(sql, *args, **kwargs)
            began.set()
            await release.wait()
            return cursor

        def execute(sql, *args, **kwargs):
            return delayed_begin(sql, *args, **kwargs) if sql == "BEGIN IMMEDIATE" else original(sql, *args, **kwargs)

        db.conn.execute = execute

        async def work():
            async with db.transaction():
                yielded.append(True)

        task = asyncio.create_task(work())
        await began.wait()
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()  # cancellation waits for the SQL boundary's result
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        db.conn.execute = original
        assert not yielded and not db.conn.in_transaction and db._transaction_owner is None
        await db.kv_set("after", "works")
        assert await db.kv_get("after") == "works"
        await db.close()
    asyncio.run(go())


@pytest.mark.parametrize("method", ["transaction", "execute", "executemany"])
def test_cancelled_commit_returns_truthful_result_then_cancels_next_await(s, method):
    async def go():
        db = await Database(s.DB_PATH).open()
        original = db.conn.commit
        committed, release = asyncio.Event(), asyncio.Event()
        synchronous_updates = []

        async def delayed_commit():
            await original()
            committed.set()
            await release.wait()

        db.conn.commit = delayed_commit

        async def work():
            if method == "transaction":
                async with db.transaction():
                    await db.kv_set("durable", "yes")
            elif method == "execute":
                await db.execute("INSERT INTO kv(k,v) VALUES(?,?)", ["durable", "yes"])
            else:
                await db.executemany("INSERT INTO kv(k,v) VALUES(?,?)", [("durable", "yes")])
            synchronous_updates.append("committed")
            await asyncio.Event().wait()  # deferred cancellation must still arrive

        task = asyncio.create_task(work())
        await committed.wait()
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        db.conn.commit = original
        assert synchronous_updates == ["committed"]
        assert await db.kv_get("durable") == "yes"
        assert not db.conn.in_transaction and db._transaction_owner is None
        await db.close()
    asyncio.run(go())


def test_cancelled_fill_commit_keeps_memory_and_durable_inventory_consistent(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        executor = PaperExecutor(s)
        manager = PositionManager(s, db, RiskManager(s, 0, db=db), executor,
                                  SimpleNamespace(get=lambda: 100.0))
        position = await manager.create("mint", 1, "shadow", "creator", 5.0, 8000.0)
        fill = await executor.buy("mint", position.sol_in, 1e-6)
        original = db.conn.commit
        committed, release = asyncio.Event(), asyncio.Event()
        after_fill = []

        async def delayed_commit():
            await original()
            committed.set()
            await release.wait()

        db.conn.commit = delayed_commit

        async def work():
            await manager._apply_entry(position, fill, 1e-6, 1000.0)
            after_fill.append(position.status)
            await asyncio.Event().wait()

        task = asyncio.create_task(work())
        await committed.wait()
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        db.conn.commit = original
        row = await db.fetchone("SELECT status,tokens_remaining,cost_sol FROM positions WHERE id=?", [position.id])
        assert position.status == row["status"] == "open" and after_fill == ["open"]
        assert position.tokens_remaining == row["tokens_remaining"] == fill.tokens
        assert position.cost_sol == row["cost_sol"] == fill.sol
        assert (await db.fetchone("SELECT COUNT(*) n FROM fills"))["n"] == 1
        await db.close()
    asyncio.run(go())


def test_second_cancellation_does_not_interrupt_rollback(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        original = db.conn.rollback
        entered, rolling_back, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def delayed_rollback():
            await original()
            rolling_back.set()
            await release.wait()

        db.conn.rollback = delayed_rollback

        async def work():
            async with db.transaction():
                await db.kv_set("partial", "no")
                entered.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(work())
        await entered.wait()
        task.cancel()
        await rolling_back.wait()
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        db.conn.rollback = original
        assert await db.kv_get("partial") is None
        assert not db.conn.in_transaction and db._transaction_owner is None
        await db.close()
    asyncio.run(go())


def test_cancelled_nested_savepoint_rolls_back_nested_work_only(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        original = db.conn.execute
        savepoint_started, release = asyncio.Event(), asyncio.Event()

        async def delayed_savepoint(sql, *args, **kwargs):
            cursor = await original(sql, *args, **kwargs)
            savepoint_started.set()
            await release.wait()
            return cursor

        def execute(sql, *args, **kwargs):
            return delayed_savepoint(sql, *args, **kwargs) if sql.startswith("SAVEPOINT ") else original(sql, *args, **kwargs)

        db.conn.execute = execute

        async def work():
            async with db.transaction():
                await db.kv_set("outer", "yes")
                with pytest.raises(asyncio.CancelledError):
                    async with db.transaction():
                        await db.kv_set("inner", "no")
                await db.kv_set("after_nested", "yes")

        task = asyncio.create_task(work())
        await savepoint_started.wait()
        task.cancel()
        release.set()
        await asyncio.wait_for(task, 2)
        db.conn.execute = original
        assert await db.kv_get("outer") == "yes"
        assert await db.kv_get("after_nested") == "yes"
        assert await db.kv_get("inner") is None
        assert not db.conn.in_transaction
        await db.close()
    asyncio.run(go())


@pytest.mark.parametrize("method", ["execute", "executemany"])
def test_cancelled_standalone_sql_rolls_back_worker_write(s, method):
    async def go():
        db = await Database(s.DB_PATH).open()
        original = getattr(db.conn, method)
        sql_finished = asyncio.Event()

        @sqlite_cursor
        async def delayed_sql(sql, params):
            cursor = await original(sql, params)
            sql_finished.set()
            await asyncio.Event().wait()
            return cursor

        setattr(db.conn, method, delayed_sql)
        if method == "execute":
            operation = db.execute("INSERT INTO kv(k,v) VALUES(?,?)", ["partial", "no"])
        else:
            operation = db.executemany("INSERT INTO kv(k,v) VALUES(?,?)", [("partial", "no")])
        # BEGIN itself uses execute, so target only the INSERT while preserving boundary calls.
        if method == "execute":
            def dispatch(sql, *args):
                return delayed_sql(sql, *args) if sql.startswith("INSERT ") else original(sql, *args)
            db.conn.execute = dispatch
        task = asyncio.create_task(operation)
        await sql_finished.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        setattr(db.conn, method, original)
        assert await db.kv_get("partial") is None
        assert not db.conn.in_transaction and db._transaction_owner is None
        await db.kv_set("after", "yes")
        assert await db.kv_get("after") == "yes"
        await db.close()
    asyncio.run(go())


def test_cancelled_nested_body_rolls_back_nested_writes(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        inside = asyncio.Event()

        async def work():
            async with db.transaction():
                await db.kv_set("outer", "yes")
                with pytest.raises(asyncio.CancelledError):
                    async with db.transaction():
                        await db.kv_set("inner", "no")
                        inside.set()
                        await asyncio.Event().wait()
                await db.kv_set("after_nested", "yes")

        task = asyncio.create_task(work())
        await inside.wait()
        task.cancel()
        await asyncio.wait_for(task, 2)
        assert await db.kv_get("outer") == "yes"
        assert await db.kv_get("after_nested") == "yes"
        assert await db.kv_get("inner") is None
        assert not db.conn.in_transaction
        await db.close()
    asyncio.run(go())
