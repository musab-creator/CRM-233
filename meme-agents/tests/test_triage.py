"""The triage screen: one cheap call, PASS only when sure, fail-open on anything else."""
import asyncio
import pathlib
from types import SimpleNamespace

import pytest

from bot.agents.base import Vote
from bot.agents.triage import hard_red_flags, run_triage, triage_first_call_usd, triage_skips, verify_triage
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
    # bytes / BYTES_PER_TOKEN + framing in at the 1.25x cache-write price, plus the full 600 out
    assert cheap > (3000 / 2 * 1.25 + 600 * 5.0) / 1e6
    dear = triage_first_call_usd(_settings(tmp_path, TRIAGE_PRICE_OUT_PER_MTOK="50"), "x" * 3000)
    assert dear - cheap == pytest.approx(600 * (50 - 5) / 1e6)


def _ctx(flow=None, rug=None, live=None, pf=None):
    return {"flow": flow or {}, "rugcheck": rug or {}, "live": live or {}, "prefilter": pf or {}}


def test_hard_red_flags_recompute_the_prompt_rules_from_the_data():
    # the live misreads of 7 Oct: no flag in the data, so no skip
    assert hard_red_flags(_ctx(flow={"effective_holders": 12.5, "effective_buyers": 40})) == []        # CATE
    assert hard_red_flags(_ctx(flow={"dev_sold_pct_of_bought": 100.0, "early_buyer_retention": 0.0})) == []  # NOBO
    assert hard_red_flags(_ctx(flow={"dev_sold_pct_of_bought": 94.6})) == []                          # Colony
    # the rules that do count
    assert "concentration" in hard_red_flags(_ctx(flow={"effective_holders": 9.9}))[0]
    assert "bundling" in hard_red_flags(_ctx(flow={"same_slot_as_launch_buyers": 6}))[0]              # FF
    assert "bundling" in hard_red_flags(_ctx(flow={"max_same_size_cluster_wallets": 5}))[0]
    assert "bundling" in hard_red_flags(_ctx(flow={"bundle_like_share_of_launch_minute": 0.21}))[0]
    assert hard_red_flags(_ctx(flow={"bundle_like_share_of_launch_minute": 0.1667, "same_slot_as_launch_buyers": 2})) == []
    still = {"sniper_top3_sol": 22.631, "net_inflow_sol": 40.0, "snipers_still_holding": "2/3"}       # CLOVER: 57%
    assert "snipers" in hard_red_flags(_ctx(flow=still))[0]
    gone = {"sniper_top3_sol": 49.175, "net_inflow_sol": 83.9, "snipers_still_holding": "0/3"}
    assert hard_red_flags(_ctx(flow=gone)) == []                                                      # exited: no flag
    # the launch minute's own share is not the test: three of six early buyers holding 68% of a 1.9 SOL
    # minute on a token that has since taken 20 SOL is an ordinary launch (review of aaf789b)
    ordinary = {"sniper_top3_sol": 1.3, "launch_minute_buy_sol": 1.9, "sniper_top3_share_of_launch_minute": 0.6842,
                "net_inflow_sol": 20.0, "snipers_still_holding": "1/3"}
    assert hard_red_flags(_ctx(flow=ordinary)) == []
    assert hard_red_flags(_ctx(flow={"sniper_top3_share_of_launch_minute": 0.9, "snipers_still_holding": "3/3"})) == []
    assert "snipers" in hard_red_flags(_ctx(flow={"sniper_top3_sol": 1.309, "snipers_still_holding": "1/3"},
                                            live={"net_inflow_sol": 3.0}))[0]                          # 44% of inflow
    assert "snipers" in hard_red_flags(_ctx(flow={"sniper_top3_share": 0.31, "snipers_still_holding": "1/3"}))[0]
    assert hard_red_flags(_ctx(flow={"sniper_top3_share": 0.30, "snipers_still_holding": "3/3"})) == []
    assert "rugcheck" in hard_red_flags(_ctx(rug={"risks": [{"name": "Creator history of rugged tokens",
                                                              "level": "danger"}]}))[0]
    assert hard_red_flags(_ctx(rug={"risks": [{"name": "Low Liquidity", "level": "warn"}]})) == []
    assert "momentum" in hard_red_flags(_ctx(flow={"net_flow_sol_5m": -3.0, "net_flow_sol_prev_5m": 12.0}))[0]
    assert "momentum" in hard_red_flags(_ctx(flow={"drawdown_from_peak_pct": 41.0}))[0]
    assert hard_red_flags(_ctx(flow={"net_flow_sol_5m": 2.0, "net_flow_sol_prev_5m": 12.0, "drawdown_from_peak_pct": 39})) == []
    assert "shrinking" in hard_red_flags(_ctx(pf={"unique_buyers": 100}, live={"unique_buyers": 60}))[0]
    assert hard_red_flags(_ctx(pf={"unique_buyers": 100}, live={"unique_buyers": 71})) == []
    # nulls are never flags
    assert hard_red_flags(_ctx(flow={"effective_holders": None, "same_slot_as_launch_buyers": None,
                                     "snipers_still_holding": None, "sniper_top3_share": None})) == []
    assert hard_red_flags({}) == []


def test_verify_triage_downgrades_an_unbacked_pass_and_keeps_a_backed_one(tmp_path):
    s = _settings(tmp_path)
    unbacked = verify_triage(Vote("triage", "PASS", 0.75, ["effective holders 12.5 below 10"], ["effective_holders 12.5"]),
                             _ctx(flow={"effective_holders": 12.5}))
    assert unbacked.vote == "BUY" and unbacked.raw_vote == "PASS" and "without a computed hard red flag" in unbacked.guard
    assert not triage_skips(unbacked, s)                      # the committee runs
    backed = verify_triage(Vote("triage", "PASS", 0.78, ["bundled launch"], ["same_slot_as_launch_buyers 6"]),
                           _ctx(flow={"same_slot_as_launch_buyers": 6}))
    assert backed.vote == "PASS" and backed.guard is None and triage_skips(backed, s)
    assert any(e.startswith("computed: bundling") for e in backed.evidence)
    full = verify_triage(Vote("triage", "PASS", 0.8, ["x"], [f"item {i}" for i in range(15)]),
                         _ctx(flow={"same_slot_as_launch_buyers": 6}))
    assert len(full.evidence) == 15 and full.evidence[-1].startswith("computed: bundling")   # cap keeps the flag
    # BUY votes and errors pass through untouched
    buy = verify_triage(Vote("triage", "BUY", 0.65), _ctx())
    assert buy.vote == "BUY" and buy.guard is None
    err = verify_triage(Vote("triage", error="llm budget: spent"), _ctx())
    assert err.vote == "PASS" and err.error and err.guard is None and not triage_skips(err, s)
