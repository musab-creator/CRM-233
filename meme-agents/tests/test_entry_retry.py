"""A live buy refused before broadcast is retried on later ticks, then dropped with a reason."""
import asyncio

import pytest

from bot.db import Database
from bot.live.executor import LiveExecutionError
from bot.paper import PaperExecutor, entry_fill
from bot.positions import PositionManager
from bot.risk import RiskManager
from tests.test_paper import FixedPrice


class RefusingLive(PaperExecutor):
    mode = "live"

    def __init__(self, s, refuse: int, message="buy pre-broadcast simulation refused (ValueError: simulation failed: "
                                                "{'InstructionError': [3, {'Custom': 6002}]})"):
        super().__init__(s)
        self.refuse, self.message, self.buys = refuse, message, 0

    async def buy(self, mint, sol_in, price):
        self.buys += 1
        if self.buys <= self.refuse:
            raise LiveExecutionError(self.message)
        return entry_fill(sol_in, price, self.s)


async def _manager(s, ex, sent):
    db = await Database(s.DB_PATH).open()
    await db.kv_set("bankroll_sol", "0.5")

    async def notify(text):
        sent.append(text)
    return db, PositionManager(s, db, RiskManager(s, 0), ex, FixedPrice(), notifier=notify)


def test_a_refused_live_buy_is_retried_on_the_next_tick(s):
    sent: list[str] = []

    async def go():
        ex = RefusingLive(s, refuse=2)
        db, pm = await _manager(s, ex, sent)
        p = await pm.create("M", 1, "real", "C", 10.0, None)
        for i in range(1, 4):
            await pm.on_tick("M", 1e-7, p.decided_at + i, {})
            await pm.drain(2)
        assert ex.buys == 3 and p.status == "open" and p.entry_price == 1e-7
        await db.close()
    asyncio.run(go())
    assert [t[:40] for t in sent] == ["ENTRY RETRY #1 M: attempt 1 of 3 refused", "ENTRY RETRY #1 M: attempt 2 of 3 refused",
                                      "🟢 ENTRY M [live] $10.00 = 0.1000 SOL @ 1"]
    assert "Custom': 6002" in sent[0]


def test_three_refusals_cancel_the_entry_with_the_last_error(s):
    sent: list[str] = []

    async def go():
        ex = RefusingLive(s, refuse=5)
        db, pm = await _manager(s, ex, sent)
        p = await pm.create("M", 1, "real", "C", 10.0, None)
        for i in range(1, 6):
            await pm.on_tick("M", 1e-7, p.decided_at + i, {})
            await pm.drain(2)
        assert ex.buys == 3 and p.status == "cancelled" and p.id not in pm.positions
        assert p.exit_reason.startswith("entry_error after 3 attempts: buy pre-broadcast simulation refused")
        await db.close()
    asyncio.run(go())
    assert len(sent) == 3 and sent[2].startswith("⚪ NO ENTRY") and "after 3 attempts" in sent[2]


def test_a_stop_file_refusal_is_not_retried(s):
    sent: list[str] = []

    async def go():
        ex = RefusingLive(s, refuse=5, message="STOP file appeared before broadcast; entry refused")
        db, pm = await _manager(s, ex, sent)
        p = await pm.create("M", 1, "real", "C", 10.0, None)
        await pm.on_tick("M", 1e-7, p.decided_at + 1, {})
        await pm.drain(2)
        assert ex.buys == 1 and p.status == "cancelled" and "STOP file" in p.exit_reason
        await db.close()
    asyncio.run(go())
    assert len(sent) == 1 and sent[0].startswith("⚪ NO ENTRY")


def test_simulation_refusal_names_the_programs_error(s):
    from tests.test_execution_enhancements import FakeChain, _executor

    async def go(value):
        chain = FakeChain()
        db, http, ex = await _executor(s, chain)
        original_rpc = chain.rpc

        async def simulation(method, params):
            if method == "simulateTransaction":
                return {"value": value}
            return await original_rpc(method, params)

        chain.rpc = simulation
        try:
            await ex._check_simulated_spend(await ex.build_pumpportal("buy", "MintAddr", 0.07, True), "buy", 0.07)
        finally:
            await db.close()

    with pytest.raises(LiveExecutionError, match=r"simulation failed: \{'InstructionError': \[3, \{'Custom': 6002\}\]\} "
                                                 r"\(Program log: AnchorError .* TooMuchSolRequired"):
        asyncio.run(go({"err": {"InstructionError": [3, {"Custom": 6002}]},
                        "logs": ["Program 6EF8 invoke [1]", "Program log: Instruction: Buy",
                                 "Program log: AnchorError thrown. Error Code: TooMuchSolRequired",
                                 "Program 6EF8 failed: custom program error: 0x1772"]}))
    with pytest.raises(LiveExecutionError, match="simulation returned no result"):
        asyncio.run(go(None))
