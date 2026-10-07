"""Budget boundaries: restarts, competing connections, rollovers and uncertain billing."""
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx2
import pytest
import anthropic

from bot.agents.base import AgentSpec, run_agent, worst_case_call_usd
from bot.agents.triage import run_triage
from bot.budget import Budget, BudgetExceeded, llm_cost_usd
from bot.db import Database
from bot.regime import run_regime


def _ts(text):
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp()


def test_crashed_reservation_survives_restart(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        token = await Budget(db, "llm", 1, "day").reserve(0.6)
        await db.close()  # no response/settlement: the remote service may still have billed
        db = await Database(s.DB_PATH).open()
        try:
            restarted = Budget(db, "llm", 1, "day")
            assert await restarted.remaining() == pytest.approx(0.4)
            with pytest.raises(BudgetExceeded):
                await restarted.reserve(0.5)
            await restarted.settle(token, 0.2, "reconciled usage")
            assert await restarted.remaining() == pytest.approx(0.8)
        finally:
            await db.close()
    asyncio.run(go())


def test_competing_database_connections_cannot_double_reserve(s):
    async def go():
        first = await Database(s.DB_PATH).open()
        second = await Database(s.DB_PATH).open()
        try:
            budgets = [Budget(first, "llm", 1, "day"), Budget(second, "llm", 1, "day")]
            results = await asyncio.gather(*(b.reserve(0.6) for b in budgets), return_exceptions=True)
            assert sum(isinstance(r, BudgetExceeded) for r in results) == 1
            assert await budgets[0].remaining() == pytest.approx(0.4)
            assert await budgets[1].remaining() == pytest.approx(0.4)
        finally:
            await first.close()
            await second.close()
    asyncio.run(go())


@pytest.mark.parametrize("period, before, after, old_key", [
    ("day", "2026-10-06T23:59:59", "2026-10-07T00:00:01", "2026-10-06"),
    ("month", "2026-10-31T23:59:59", "2026-11-01T00:00:01", "2026-10"),
])
def test_settlement_belongs_to_original_period(s, monkeypatch, period, before, after, old_key):
    clock = [_ts(before)]
    monkeypatch.setattr("bot.budget.now_s", lambda: clock[0])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            budget = Budget(db, "llm", 1, period)
            old = await budget.reserve(0.6)
            clock[0] = _ts(after)
            assert await budget.remaining() == pytest.approx(1)
            new = await budget.reserve(0.8)
            await budget.settle(old, 0.4)
            assert await budget.spent() == 0
            assert await budget.remaining() == pytest.approx(0.2)
            rows = await db.fetchall("SELECT day,month,usd FROM ledger")
            assert rows[0][period] == old_key and rows[0]["usd"] == pytest.approx(0.4)
            await budget.settle(new, 0.5)
            assert await budget.spent() == pytest.approx(0.5)
        finally:
            await db.close()
    asyncio.run(go())


def test_settlement_is_atomic_and_idempotent(s, monkeypatch):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            budget = Budget(db, "llm", 1, "day")
            token = await budget.reserve(0.6)
            real_update = db.update

            async def broken_update(*args, **kwargs):
                raise RuntimeError("disk write failed")

            monkeypatch.setattr(db, "update", broken_update)
            with pytest.raises(RuntimeError):
                await budget.settle(token, 0.2)
            assert await budget.spent() == 0  # ledger insertion rolled back with hold update
            assert await budget.remaining() == pytest.approx(0.4)
            monkeypatch.setattr(db, "update", real_update)
            await budget.settle(token, 0.2)
            await budget.settle(token, 0.2)
            assert await budget.spent() == pytest.approx(0.2)
            assert len(await db.fetchall("SELECT * FROM ledger")) == 1
            with pytest.raises(ValueError, match="already settled"):
                await budget.settle(token, 0.3)
        finally:
            await db.close()
    asyncio.run(go())


@pytest.mark.parametrize("amount", [-1, float("inf"), float("nan"), True])
def test_invalid_reservations_cannot_poison_budget(s, amount):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            budget = Budget(db, "llm", 1, "day")
            with pytest.raises(ValueError):
                await budget.reserve(amount)
            assert await budget.remaining() == 1
        finally:
            await db.close()
    asyncio.run(go())


class FailureClient:
    def __init__(self, error=None):
        self.messages = self
        self.error = error or TimeoutError("response lost after submission")
        self.calls = 0

    async def create(self, **kwargs):
        self.calls += 1
        raise self.error


@pytest.mark.parametrize("role", ["agent", "triage", "regime"])
def test_ambiguous_api_failure_charges_reserved_amount(s, role):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            budget = Budget(db, "llm", 5, "day")
            client = FailureClient()
            if role == "agent":
                result = await run_agent(client, s, AgentSpec("scout", "system", [], {}), "context", budget)
            elif role == "triage":
                result = await run_triage(client, s, "context", budget)
            else:
                result = await run_regime(client, s, {"sol_change_1h_pct": -5}, budget, 1)
            assert result.error and result.cost_usd > 0 and client.calls == 1
            row = await db.fetchone("SELECT usd,actual,status FROM budget_reservations")
            assert row["status"] == "settled" and row["actual"] == pytest.approx(row["usd"])
            assert await budget.spent() == pytest.approx(result.cost_usd)
            assert "estimated: usage unknown" in (await db.fetchone("SELECT detail FROM ledger"))["detail"]
        finally:
            await db.close()
    asyncio.run(go())


def test_cancelled_call_does_not_refund_possible_billing(s):
    class BlockingClient:
        def __init__(self):
            self.messages = self
            self.started = asyncio.Event()

        async def create(self, **kwargs):
            self.started.set()
            await asyncio.Event().wait()

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            client, budget = BlockingClient(), Budget(db, "llm", 5, "day")
            task = asyncio.create_task(run_agent(client, s, AgentSpec("scout", "sys", [], {}), "ctx", budget))
            await asyncio.wait_for(client.started.wait(), 2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert await budget.spent() > 0
            assert (await db.fetchone("SELECT status FROM budget_reservations"))["status"] == "settled"
        finally:
            await db.close()
    asyncio.run(go())


def test_sdk_retries_stay_on_and_a_failed_call_still_charges_its_hold(s):
    """Transient 429/529s are retried by the SDK (a vote lost to one is a candidate lost);
    a request that never returns usage is charged at its reservation, never refunded."""
    calls = []

    def handler(request):
        calls.append(request)
        return httpx2.Response(429, json={"type": "error", "error": {"type": "rate_limit_error", "message": "busy"}})

    async def go():
        db = await Database(s.DB_PATH).open()
        http = anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(handler))
        client = anthropic.AsyncAnthropic(api_key="unit-test-placeholder", max_retries=2, http_client=http)
        try:
            vote = await run_agent(client, s, AgentSpec("scout", "sys", [], {}), "ctx", Budget(db, "llm", 5, "day"))
            assert vote.error.startswith("rate limited") and len(calls) == 3   # 1 call + 2 SDK retries
            assert vote.cost_usd > 0
        finally:
            await client.close()
            await db.close()
    asyncio.run(go())


def test_unicode_and_sdk_history_have_conservative_input_allowance(s):
    from bot.agents.base import BYTES_PER_TOKEN, INPUT_FRAMING_ALLOWANCE
    messages = [{"role": "user", "content": "🚀" * 1000}]
    output_cost = s.LLM_MAX_TOKENS * s.LLM_PRICE_OUT_PER_MTOK / 1e6
    in_rate = s.LLM_PRICE_IN_PER_MTOK * 1.25 / 1e6

    def floor(input_bytes):   # bytes, not characters: every rocket is four UTF-8 bytes
        return output_cost + (input_bytes / BYTES_PER_TOKEN + INPUT_FRAMING_ALLOWANCE) * in_rate
    assert worst_case_call_usd(s, [], [], messages) >= floor(4000)
    assert worst_case_call_usd(s, [], [], messages) > output_cost + 1000 / 3 * in_rate   # the old chars/3 estimate
    block = anthropic.types.TextBlock(type="text", text="地址" * 2000)
    messages.append({"role": "assistant", "content": [block]})   # SDK objects count as API JSON, not repr()
    assert worst_case_call_usd(s, [], [], messages) >= floor(4000 + 12_000)


@pytest.mark.parametrize("role", ["agent", "triage", "regime"])
def test_oversized_inputs_make_no_billed_calls(s, role):
    s.LLM_MAX_INPUT_BYTES = 10

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            client, budget = FailureClient(), Budget(db, "llm", 5, "day")
            if role == "agent":
                result = await run_agent(client, s, AgentSpec("scout", "sys", [], {}), "context", budget)
            elif role == "triage":
                result = await run_triage(client, s, "context", budget)
            else:
                result = await run_regime(client, s, {}, budget, 1)
            assert result.error and "input exceeds" in result.error
            assert client.calls == 0 and await budget.spent() == 0
        finally:
            await db.close()
    asyncio.run(go())


@pytest.mark.parametrize("usage", [-1, 1.2, float("nan"), True])
def test_invalid_api_usage_is_not_a_budget_refund(usage):
    with pytest.raises(ValueError, match="usage"):
        llm_cost_usd(usage, 10, 0, 0, 3, 15)


class ResponseClient:
    def __init__(self, responses):
        self.messages = self
        self.responses = list(responses)

    async def create(self, **kwargs):
        return self.responses.pop(0)


def _response(name="submit_vote", vote="BUY", stop_reason="tool_use", duplicate=False):
    data = {"vote": vote, "confidence": 1, "reasons": [], "evidence": []}
    if name == "submit_regime":
        data = {"mode": "normal", "size_multiplier": 1, "reasons": []}
    block = SimpleNamespace(type="tool_use", id="v1", name=name, input=data)
    return SimpleNamespace(content=[block, block] if duplicate else [block], stop_reason=stop_reason,
                           usage=SimpleNamespace(input_tokens=10, output_tokens=10,
                                                 cache_creation_input_tokens=0, cache_read_input_tokens=0))


@pytest.mark.parametrize("role", ["agent", "triage", "regime"])
def test_duplicate_terminal_votes_fail_closed(s, role):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            name = "submit_regime" if role == "regime" else "submit_vote"
            client = ResponseClient([_response(name, duplicate=True)])
            budget = Budget(db, "llm", 5, "day")
            if role == "agent":
                result = await run_agent(client, s, AgentSpec("scout", "sys", [], {}), "ctx", budget)
            elif role == "triage":
                result = await run_triage(client, s, "ctx", budget)
            else:
                result = await run_regime(client, s, {"sol_change_1h_pct": -5}, budget, 1)
            assert result.error and "terminal tool call" in result.error
            assert await budget.spent() > 0
        finally:
            await db.close()
    asyncio.run(go())


def test_triage_discards_truncated_vote(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            client = ResponseClient([_response(stop_reason="max_tokens"), _response(vote="PASS")])
            result = await run_triage(client, s, "ctx", Budget(db, "llm", 5, "day"))
            assert result.vote == "PASS" and result.error is None and result.turns == 2
        finally:
            await db.close()
    asyncio.run(go())


def test_regime_discards_truncated_vote(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            client = ResponseClient([_response("submit_regime", stop_reason="max_tokens")])
            result = await run_regime(client, s, {"sol_change_1h_pct": -5}, Budget(db, "llm", 5, "day"), 1)
            assert result.mode == "cautious" and result.source == "rule" and result.error == "model max_tokens"
        finally:
            await db.close()
    asyncio.run(go())
