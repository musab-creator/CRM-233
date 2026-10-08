"""A failed live check locks entries and keeps the bot (and the phone commands) alive."""
import asyncio

from solders.keypair import Keypair

from bot.sim import build_sim_engine
from tests.test_engine_e2e import _settings


def _live(tmp_path, **extra):
    base = dict(MODE="live", LIVE_CONFIRM="I_ACCEPT_LOSSES", WALLET_PRIVATE_KEY=str(Keypair()),
                HELIUS_API_KEY="h", ANTHROPIC_API_KEY="a", LIVE_MAX_WALLET_SOL="0.5")
    base.update(extra)
    return _settings(tmp_path, **base)


def test_a_wallet_over_the_cap_locks_entries_but_keeps_exits_and_the_bot(tmp_path):
    eng = build_sim_engine(_live(tmp_path), seed=3, launch_every_s=1.5)

    async def rich(pubkey):
        return 2.0
    eng.helius.balance_sol = rich
    asyncio.run(eng.run(3))                       # used to raise LiveRefused and end the process
    assert "holds 2.0000 SOL > 0.5 SOL limit" in eng.live_lock
    assert eng.risk.paused_reason.startswith("live lock: refusing to start live mode: wallet ")
    assert eng.risk.paused_reason.endswith("fix the cause, then /restart")
    assert eng.executor.mode == "live"            # the key is sound: exits of open positions can still run


def test_a_broken_key_locks_entries_without_a_live_executor(tmp_path):
    eng = build_sim_engine(_live(tmp_path, WALLET_PRIVATE_KEY="not-a-key"), seed=3, launch_every_s=1.5)
    asyncio.run(eng.run(3))
    assert "WALLET_PRIVATE_KEY does not parse" in eng.live_lock
    assert eng.risk.paused_reason.startswith("live lock:") and eng.executor.mode == "paper"
