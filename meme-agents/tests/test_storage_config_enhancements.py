import asyncio
from types import SimpleNamespace

import pytest

from bot.config import ConfigError, load_settings
from bot.db import Database
from bot.engine import Engine
from bot.ingest import MintState
from bot.risk import RiskManager


def test_transaction_rolls_back_without_swallowing_another_tasks_write(s):
    async def run():
        db = await Database(s.DB_PATH).open()
        entered, release = asyncio.Event(), asyncio.Event()

        async def failing():
            with pytest.raises(RuntimeError, match="disk fault"):
                async with db.transaction():
                    await db.kv_set("partial", "unsafe")
                    entered.set()
                    await release.wait()
                    raise RuntimeError("disk fault")

        task = asyncio.create_task(failing())
        await entered.wait()
        unrelated = asyncio.create_task(db.kv_set("other", "durable"))
        await asyncio.sleep(0)
        assert not unrelated.done()
        release.set()
        await asyncio.gather(task, unrelated)
        assert await db.kv_get("partial") is None
        assert await db.kv_get("other") == "durable"
        await db.close()
    asyncio.run(run())


def test_nested_transaction_failure_preserves_outer_work(s):
    async def run():
        db = await Database(s.DB_PATH).open()
        async with db.transaction():
            await db.kv_set("outer", "yes")
            with pytest.raises(ValueError):
                async with db.transaction():
                    await db.kv_set("inner", "no")
                    raise ValueError("fault")
        assert await db.kv_get("outer") == "yes"
        assert await db.kv_get("inner") is None
        await db.close()
    asyncio.run(run())


def test_cancelled_transaction_leaves_no_partial_commit(s):
    async def run():
        db = await Database(s.DB_PATH).open()
        entered = asyncio.Event()

        async def writer():
            async with db.transaction():
                await db.kv_set("cancelled", "no")
                entered.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(writer())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert await db.kv_get("cancelled") is None
        await db.kv_set("after", "works")
        await db.close()
    asyncio.run(run())


def test_backfill_and_stream_share_trade_identity_but_not_wallets(s):
    async def run():
        db = await Database(s.DB_PATH).open()
        row = ("sig", "mint", "alice", "buy", 1, 100, .01, 31, 1000, 100, "pump", 1)
        bob = (*row[:2], "bob", *row[3:])
        unsigned = (None, *row[1:])
        await db.insert_trades([row, row, bob, unsigned, unsigned])
        await db.insert_trades([row])
        assert (await db.fetchone("SELECT COUNT(*) n FROM trades"))["n"] == 4
        await db.close()
    asyncio.run(run())


def test_retention_keeps_active_work_but_expires_completed_candidates(s):
    async def run():
        db = await Database(s.DB_PATH).open()
        for mint in ("done", "evaluating", "holding"):
            await db.insert_trades([(mint, mint, "a", "buy", 1, 1, 1, 1, 1, 1, "pump", 1)])
        await db.insert("candidates", {"mint": "done", "status": "evaluated"})
        await db.insert("candidates", {"mint": "evaluating", "status": "pending"})
        await db.insert("positions", {"mint": "holding", "status": "open"})
        await db.prune_trades(100)
        assert {r["mint"] for r in await db.fetchall("SELECT mint FROM trades")} == {"evaluating", "holding"}
        await db.close()
    asyncio.run(run())


@pytest.mark.parametrize("setting", [
    "MODE=typo", "LLM_DAILY_BUDGET_USD=nan", "BANKROLL_USD=inf", "NETWORK_FEE_SOL=-1",
    "MAX_OPEN_POSITIONS=3.5", "HELIUS_RPC_RPS=0", "LLM_MAX_INPUT_BYTES=0",
    "LIVE_MAX_WALLET_SOL=0.6", "CONSENSUS_MIN_MEAN_CONFIDENCE=1.1",
    "POSITION_MIN_USD=11\nPOSITION_MAX_USD=10", "PF_MIN_AGE_MIN=100\nPF_MAX_AGE_MIN=90",
])
def test_unsafe_settings_refuse_before_startup(tmp_path, setting):
    env = tmp_path / ".env"
    env.write_text(setting)
    with pytest.raises(ConfigError):
        load_settings(env)


def test_secrets_are_loaded_from_file_not_process_environment(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text('HELIUS_API_KEY="file-value" # comment\n')
    monkeypatch.setenv("HELIUS_API_KEY", "process-value")
    st = load_settings(env)
    assert st.HELIUS_API_KEY == "file-value"
    env.write_text("")
    assert load_settings(env).HELIUS_API_KEY == ""


def test_invalid_env_encoding_has_actionable_safe_error(tmp_path):
    env = tmp_path / ".env"
    env.write_bytes(b"HELIUS_API_KEY=\xff")
    with pytest.raises(ConfigError, match="UTF-8"):
        load_settings(env)


@pytest.mark.parametrize("name", ["LIVE_DRY_RUN", "PUMPPORTAL_TRADE_STREAM", "TELEGRAM_DIGEST"])
def test_invalid_settings_do_not_echo_a_misplaced_credential(tmp_path, name):
    env = tmp_path / ".env"
    env.write_text(f"{name}=misplaced-test-credential")
    with pytest.raises(ConfigError) as raised:
        load_settings(env)
    assert "misplaced-test-credential" not in str(raised.value)


def test_crash_restart_retains_loss_pause_until_clean_operator_stop(s):
    async def run():
        db = await Database(s.DB_PATH).open()
        original = RiskManager(s, 10000, db=db)
        await original.startup()
        original.register_realized(-25)
        await original.persist()
        restarted = RiskManager(s, 11000, db=db)
        await restarted.startup()
        assert restarted.paused_reason.startswith("daily loss cap hit:")
        assert restarted.started_at == 10000
        await restarted.shutdown(clean_stop=True)
        intentional = RiskManager(s, 12000, db=db)
        await intentional.startup()
        assert intentional.paused_reason is None
        assert intentional.started_at == 12000
        await db.close()
    asyncio.run(run())


@pytest.mark.parametrize("previous_status", ["pending", "evaluated"])
def test_evaluation_failure_releases_candidate_without_replaying_decision(s, previous_status):
    async def run():
        eng = Engine(s)
        await eng.db.open()
        eng.positions = SimpleNamespace(positions={})
        eng.ingest.mints["mint"] = MintState(mint="mint")
        eng.ingest.pinned.add("mint")
        cid = await eng.db.insert("candidates", {"mint": "mint", "status": previous_status})

        async def fail(candidate):
            eng.stop.set()
            raise RuntimeError("injected evaluation failure")

        eng.evaluate = fail
        eng.queue.put_nowait(cid)
        await eng.evaluator()
        row = await eng.db.fetchone("SELECT status FROM candidates WHERE id=?", [cid])
        assert row["status"] == ("failed" if previous_status == "pending" else "evaluated")
        assert "mint" not in eng.ingest.pinned
        await eng.queue.join()
        await eng.db.close()
        await eng.http.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("stream", ["positions", "all"])
def test_stream_subscriptions_restore_existing_positions_and_tracking(s, stream):
    async def run():
        s.PUMPPORTAL_TRADE_STREAM = stream
        eng = Engine(s)
        tokens, accounts = set(), set()

        async def subscribe_tokens(values):
            tokens.update(values)

        async def subscribe_accounts(values):
            accounts.update(values)

        eng.feed = SimpleNamespace(subscribe_tokens=subscribe_tokens, subscribe_accounts=subscribe_accounts)
        eng.positions = SimpleNamespace(active=lambda kind: [SimpleNamespace(creator="creator")])
        eng.ingest.pinned.add("holding")
        eng.ingest.mints["tracking"] = MintState(mint="tracking")
        await eng._restore_stream_subscriptions()
        assert tokens == ({"holding", "tracking"} if stream == "all" else {"holding"})
        assert accounts == {"creator"}
        await eng.http.aclose()
    asyncio.run(run())


def test_daily_stream_budget_reset_restores_existing_subscriptions(s, monkeypatch):
    async def run():
        s.PUMPPORTAL_TRADE_STREAM = "positions"
        eng = Engine(s)
        await eng.db.open()
        tokens, accounts = set(), set()

        async def subscribe_tokens(values):
            tokens.update(values)

        async def subscribe_accounts(values):
            accounts.update(values)

        eng.feed = SimpleNamespace(subscribe_tokens=subscribe_tokens, subscribe_accounts=subscribe_accounts)
        eng.positions = SimpleNamespace(active=lambda kind: [SimpleNamespace(creator="creator")])
        eng.ingest.pinned.add("holding")
        eng._stream_blocked_day = "previous-day"
        monkeypatch.setattr("bot.engine.utc_day", lambda: "new-day")
        await eng._check_stream_budget()
        assert eng._stream_blocked_day is None
        assert tokens == {"holding"} and accounts == {"creator"}
        await eng.db.close()
        await eng.http.aclose()
    asyncio.run(run())
