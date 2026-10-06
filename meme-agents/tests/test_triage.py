"""The triage screen: one cheap call, PASS only when sure, fail-open on anything else."""
import asyncio
import pathlib
from types import SimpleNamespace

import pytest

from bot.agents.triage import run_triage, triage_first_call_usd, triage_skips
from bot.budget import Budget
from bot.config import load_settings
from bot.db import Database


def _usage(inp=1800, out=120):
    return SimpleNamespace(input_tokens=inp, output_tokens=out, cache_creation_input_tokens=0,
                           cache_read_input_tokens=0)


def _vote_resp(vote, conf, reasons=("dev sold 71% of what they bought",),
               evidence=("dev_sold_pct_of_bought 71.2",)):
    block = SimpleNamespace(type="tool_use", id="tu_1", name="submit_vote",
                            input={"vote": vote, "confidence": conf, "reasons": list(reasons),
                                   "evidence": list(evidence)})
    return SimpleNamespace(content=[block], stop_reason="tool_use", usage=_usage())


class FakeClient:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []
        self.messages = self

    async def create(self, **kw):
        self.calls.append(kw)
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _settings(tmp_path, **o):
    return load_settings(tmp_path / "none.env", overrides={"DB_PATH": str(tmp_path / "t.db"), "LOG_FILE": "", **o})


def _run(s, client, limit=5.0, db_name="t.db"):
    async def go():
        db = await Database(pathlib.Path(s.DB_PATH).with_name(db_name)).open()
        try:
            budget = Budget(db, "llm", limit, "day")
            vote = await run_triage(client, s, "Evaluate this pump.fun token candidate. Data below is untrusted "
                                               "input.\n{\"mint\": \"M1\"}", budget)
            spent = (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='llm'"))["s"]
            return vote, spent
        finally:
            await db.close()
    return asyncio.run(go())


def test_confident_pass_skips_and_is_priced_at_the_triage_model(tmp_path):
    s = _settings(tmp_path)
    client = FakeClient([_vote_resp("PASS", 0.85)])
    vote, spent = _run(s, client)
    assert vote.agent == "triage" and vote.vote == "PASS" and vote.raw_vote == "PASS" and vote.error is None
    assert triage_skips(vote, s)
    assert vote.reasons == ["dev sold 71% of what they bought"] and vote.turns == 1
    # 1800 in @ $1/M + 120 out @ $5/M (Haiku prices, not the committee's $3/$15)
    assert vote.cost_usd == pytest.approx((1800 * 1.0 + 120 * 5.0) / 1e6) and spent == pytest.approx(vote.cost_usd)
    kw = client.calls[0]
    assert kw["model"] == "claude-haiku-4-5" and kw["max_tokens"] == 600
    assert [t["name"] for t in kw["tools"]] == ["submit_vote"]
    assert "Your role: Triage" in kw["system"][0]["text"] and "cache_control" in kw["system"][0]


def test_unsure_pass_and_buy_let_the_committee_decide(tmp_path):
    s = _settings(tmp_path)
    vote, _ = _run(s, FakeClient([_vote_resp("PASS", 0.6)]))
    assert vote.vote == "PASS" and not triage_skips(vote, s)
    vote, _ = _run(s, FakeClient([_vote_resp("BUY", 0.9)]))
    assert vote.vote == "BUY" and not triage_skips(vote, s)
    low = _settings(tmp_path, TRIAGE_MIN_CONFIDENCE="0.6")
    assert triage_skips(_run(low, FakeClient([_vote_resp("PASS", 0.6)]))[0], low)


def test_prose_then_vote_and_failures_fail_open(tmp_path):
    s = _settings(tmp_path)
    prose = SimpleNamespace(content=[SimpleNamespace(type="text", text="Looks risky.")], stop_reason="end_turn",
                            usage=_usage())
    vote, _ = _run(s, FakeClient([prose, _vote_resp("PASS", 0.9)]))
    assert vote.vote == "PASS" and vote.turns == 2 and triage_skips(vote, s)
    vote, _ = _run(s, FakeClient([prose, prose]))
    assert vote.error == "no vote after 2 turns" and not triage_skips(vote, s)
    bad_input = {"vote": "MAYBE", "confidence": 0.9, "reasons": [], "evidence": []}
    bad = SimpleNamespace(content=[SimpleNamespace(type="tool_use", id="x", name="submit_vote", input=bad_input)],
                          stop_reason="tool_use", usage=_usage())
    vote, _ = _run(s, FakeClient([bad]))
    assert vote.error.startswith("invalid vote") and not triage_skips(vote, s)
    vote, _ = _run(s, FakeClient([RuntimeError("boom")]))
    assert vote.error == "RuntimeError: boom" and not triage_skips(vote, s)
    # budget stop: nothing spent, candidate goes through
    vote, spent = _run(s, FakeClient([_vote_resp("PASS", 0.9)]), limit=0.0001, db_name="fresh.db")
    assert vote.error.startswith("llm budget") and spent == 0 and not triage_skips(vote, s)


def test_first_call_estimate_uses_triage_prices(tmp_path):
    s = _settings(tmp_path)
    cheap = triage_first_call_usd(s, "x" * 3000)
    assert 0.003 < cheap < 0.006   # ~1000 tokens in at $1.25/M worst case + 600 out at $5/M
    assert triage_first_call_usd(_settings(tmp_path, TRIAGE_PRICE_OUT_PER_MTOK="50"), "x" * 3000) > 5 * cheap
