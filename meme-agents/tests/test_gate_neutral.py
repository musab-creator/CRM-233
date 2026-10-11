"""GATE_NEUTRAL_VOTES prompts, and forced submit_vote / submit_regime tool choice: the model can
no longer answer in prose and burn the evaluation (the live cause of 90 triage errors in a day)."""
import asyncio
from types import SimpleNamespace


from bot.agents.base import NEUTRAL_MAX_CONFIDENCE, AgentSpec, Vote, apply_grounding_guard, run_agent
from bot.agents.grounding import Corpus
from bot.agents.prompts import NEUTRAL_PROMPTS, ROLE_PROMPTS, TRIAGE, role_prompt
from bot.agents.triage import run_triage
from bot.budget import Budget
from bot.config import Settings, load_settings
from bot.db import Database
from bot.regime import run_regime


def test_role_prompt_variants():
    for name in ("scout", "hunter", "analyst"):
        strict, neutral = role_prompt(name, False), role_prompt(name, True)
        assert strict == ROLE_PROMPTS[name] and neutral == NEUTRAL_PROMPTS[name] and strict != neutral
        assert f"Your role: {name.title()}" in strict and f"Your role: {name.title()}" in neutral
        assert "submit_vote" in neutral and "untrusted data" in neutral
    # strict: no catalyst / no attention means PASS; neutral: it is a low-confidence BUY
    assert "No catalyst found still means PASS" in role_prompt("hunter")
    assert "No catalyst found still means PASS" not in role_prompt("hunter", True)
    assert "neutral" in role_prompt("hunter", True) and "BUY at 0.6" in role_prompt("scout", True)
    assert "0.75 or more" in role_prompt("analyst", True) and "exactly 0.6" in role_prompt("hunter", True)
    assert "Most candidates should be PASS" in role_prompt("scout") and "Most candidates" not in role_prompt("scout", True)
    # the veto and triage prompts are unchanged by the flag
    for name in ("triage", "forensics", "social"):
        assert role_prompt(name, True) == ROLE_PROMPTS[name]


def test_setting_defaults_on_and_parses(tmp_path):
    assert Settings().GATE_NEUTRAL_VOTES is True
    env = tmp_path / ".env"
    env.write_text("GATE_NEUTRAL_VOTES=false\n")
    assert load_settings(env, overrides={"LOG_FILE": ""}).GATE_NEUTRAL_VOTES is False


def test_specs_follow_the_flag(s):
    from bot.agents.tools import ToolContext, analyst_spec, hunter_spec, scout_spec
    def ctx(flag):
        s.GATE_NEUTRAL_VOTES = flag
        return ToolContext(s, None, None, None, None, None, None, {"mint": "m"})
    assert scout_spec(ctx(True)).system == NEUTRAL_PROMPTS["scout"]
    assert scout_spec(ctx(False)).system == ROLE_PROMPTS["scout"]
    assert hunter_spec(ctx(True)).system == NEUTRAL_PROMPTS["hunter"]
    assert analyst_spec(ctx(False)).system == ROLE_PROMPTS["analyst"]


class RecordingClient:
    """Returns canned responses and records every create() call's keyword arguments."""

    def __init__(self, responses):
        self.messages = self
        self.responses = list(responses)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.responses.pop(0)


def _usage():
    return SimpleNamespace(input_tokens=10, output_tokens=10, cache_creation_input_tokens=0, cache_read_input_tokens=0)


def _tool(name="submit_vote", vote="PASS"):
    data = {"vote": vote, "confidence": 0.8, "reasons": ["r"], "evidence": []}
    if name == "submit_regime":
        data = {"mode": "normal", "size_multiplier": 1, "reasons": []}
    return SimpleNamespace(content=[SimpleNamespace(type="tool_use", id="t1", name=name, input=data)],
                           stop_reason="tool_use", usage=_usage())


def _prose():
    return SimpleNamespace(content=[SimpleNamespace(type="text", text="Let me think...")],
                           stop_reason="end_turn", usage=_usage())


def test_triage_and_regime_force_their_tool(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            c = RecordingClient([_tool()])
            v = await run_triage(c, s, "ctx", Budget(db, "llm", 5, "day"))
            assert v.vote == "PASS" and v.error is None
            assert c.calls[0]["tool_choice"] == {"type": "tool", "name": "submit_vote"}
            c = RecordingClient([_tool("submit_regime")])
            r = await run_regime(c, s, {"sol_change_1h_pct": 0}, Budget(db, "llm", 5, "day"), 1)
            assert r.mode == "normal" and r.error is None
            assert c.calls[0]["tool_choice"] == {"type": "tool", "name": "submit_regime"}
        finally:
            await db.close()
    asyncio.run(go())


def test_agent_forces_vote_after_prose_and_on_final_turn(s):
    s.LLM_MAX_TURNS = 3
    spec = AgentSpec("scout", "Your role: Scout", [], {})

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            # prose on turn 0 -> turn 1 forces submit_vote
            c = RecordingClient([_prose(), _tool(vote="PASS")])
            v = await run_agent(c, s, spec, "ctx", Budget(db, "llm", 5, "day"))
            assert v.vote == "PASS" and v.error is None and v.turns == 2
            assert c.calls[0]["tool_choice"] == {"type": "auto"}
            assert c.calls[1]["tool_choice"] == {"type": "tool", "name": "submit_vote"}
            # the final turn is always forced, even without an earlier prose reply
            s.LLM_MAX_TURNS = 1
            c = RecordingClient([_tool(vote="PASS")])
            v = await run_agent(c, s, spec, "ctx", Budget(db, "llm", 5, "day"))
            assert v.vote == "PASS" and c.calls[0]["tool_choice"] == {"type": "tool", "name": "submit_vote"}
        finally:
            await db.close()
    asyncio.run(go())


def test_triage_no_longer_skips_on_the_creator_selling_alone():
    from bot.agents.prompts import ANALYST, HUNTER, SCOUT, TRIAGE

    hard = TRIAGE.split("Hard red flags", 1)[1].split("Weak signals", 1)[0]
    weak = TRIAGE.split("Weak signals", 1)[1].split("Rules:", 1)[0]
    assert "dev_sold_pct_of_bought" not in hard                                  # 9 Oct: not a flag, not even in combination
    assert "neither makes nor strengthens a red flag" in weak
    assert "`early_buyer_retention` below 0.4" not in hard                        # demoted ...
    assert "`early_buyer_retention` below 0.4 by itself" in weak                 # ... to a weak signal
    assert "the creator selling, even all of the launch buy" in weak
    assert "`net_flow_sol_5m` is negative (net outflow) after a positive" in hard
    assert "returned about the same on average as the rest" in ANALYST           # on-chain glossary
    assert "cashing out" not in SCOUT and "cashing out" not in HUNTER and "cashing out" not in ANALYST


def test_the_analyst_weighs_the_flow_fields_by_the_recorded_outcomes():
    """11 Oct signal check (1,857 coins): retention above its median wins a little more often (25% against
    21%) with no edge in the return; four or more same-slot buyers (-29% against -22%) and a drawdown past
    13% (-27% against -22%) are the two clearest marks; the launch-minute sniper share runs the other way."""
    for prompt in (ROLE_PROMPTS["analyst"], NEUTRAL_PROMPTS["analyst"]):
        assert "(1,733 tokens) those above the median were winners 25% of the time against 21%" in prompt
        assert "909 tokens" not in prompt and "better than any other flow field" not in prompt   # stale figures
        assert "Low retention alone is not a red flag." in prompt
        assert "a large inflow is not positive evidence by itself" in prompt
        assert "below 0.4 means most early buyers already exited" not in prompt
        assert "tokens with 4 or more same-slot buyers returned -29% against -22%" in prompt
        assert "`same_slot_as_launch_buyers` of 4 or more (3, the median token, is routine)" in prompt
        assert "more than about 13% under their peak" in prompt and "one of the two clearest signals" in prompt
        assert "`sniper_top3_share_of_launch_minute`) is not a warning by itself" in prompt
        assert "same-size clusters of 5 or more showed no edge either way" in prompt
    assert "(-25% against -25%, 22% winners against 26%)" in TRIAGE and "-33% against -34%" not in TRIAGE
    neutral = NEUTRAL_PROMPTS["analyst"].split("Your vote carries the decision", 1)[1]
    assert "launch buyers still holding" in neutral and "creator still in" not in neutral
    assert "0.75 or more" in neutral                                                  # the gate is unchanged


def _corpora():
    ctx, tools = Corpus(), Corpus()
    ctx.add("candidate XP age 15.4m buyers 157 inflow 809.7 SOL")
    tools.add("x_search: 0 results\nprofile: 0 boosts")
    return ctx, tools


def test_neutral_buy_is_exempt_from_the_grounding_share_but_not_from_looking():
    ctx, tools = _corpora()
    ungrounded = ["no spam or bot patterns found", "no posts from the launcher's accounts"]
    neutral = apply_grounding_guard(Vote("scout", "BUY", 0.6, ["nothing notable"], ungrounded), ctx, tools, 1,
                                    0.5, neutral_max_conf=NEUTRAL_MAX_CONFIDENCE)
    assert neutral.vote == "BUY" and neutral.guard is None and neutral.grounding == 0.0
    # the same vote without a single successful tool call is still downgraded: the agent did not look
    blind = apply_grounding_guard(Vote("scout", "BUY", 0.6, [], ungrounded), ctx, tools, 0, 0.5,
                                  neutral_max_conf=NEUTRAL_MAX_CONFIDENCE)
    assert blind.vote == "PASS" and "without any successful tool call" in blind.guard
    # a confident BUY (above the neutral band) is guarded exactly as before
    confident = apply_grounding_guard(Vote("scout", "BUY", 0.8, [], ungrounded), ctx, tools, 1, 0.5,
                                      neutral_max_conf=NEUTRAL_MAX_CONFIDENCE)
    assert confident.vote == "PASS" and "grounding 0.00 < 0.5" in confident.guard
    # a slightly-more-than-neutral BUY on ungrounded evidence (DESK95: "one link-only post") keeps its vote
    # and loses the unverified extra confidence; at the claim threshold it is guarded in full
    mild = apply_grounding_guard(Vote("scout", "BUY", 0.62, ["1 post, link-only"], ungrounded), ctx, tools, 1, 0.5,
                                 neutral_max_conf=NEUTRAL_MAX_CONFIDENCE)
    assert mild.vote == "BUY" and mild.confidence == 0.6 and mild.guard.startswith("BUY 0.62 held to the neutral 0.6")
    claim = apply_grounding_guard(Vote("scout", "BUY", 0.7, ["1 post, link-only"], ungrounded), ctx, tools, 1, 0.5,
                                  neutral_max_conf=NEUTRAL_MAX_CONFIDENCE)
    assert claim.vote == "PASS" and claim.guard == "BUY evidence grounding 0.00 < 0.5"
    # evidence grounded in a tool result keeps the 0.62 as it is
    tools.add("x_search: 1 result; author followers 2345")
    kept = apply_grounding_guard(Vote("scout", "BUY", 0.62, ["one real author"], ["author followers 2345"]), ctx,
                                 tools, 1, 0.5, neutral_max_conf=NEUTRAL_MAX_CONFIDENCE)
    assert kept.vote == "BUY" and kept.confidence == 0.62 and kept.guard is None
    # strict mode (no neutral band) guards the 0.6 vote too
    strict = apply_grounding_guard(Vote("scout", "BUY", 0.6, [], ungrounded), ctx, tools, 1, 0.5)
    assert strict.vote == "PASS" and strict.raw_vote == "BUY"
    # a PASS is never touched
    assert apply_grounding_guard(Vote("hunter", "PASS", 0.7, [], []), ctx, tools, 0, 0.5,
                                 neutral_max_conf=NEUTRAL_MAX_CONFIDENCE).vote == "PASS"


def test_two_neutral_votes_and_an_analyst_at_075_reach_the_gate_floor():
    assert round((0.6 + 0.6 + 0.75) / 3, 4) >= 0.65          # the lowest passing combination
    assert round((0.6 + 0.6 + 0.74) / 3, 4) < 0.65
    assert round((0.55 + 0.53 + 0.82) / 3, 4) < 0.65         # FORM8 at 21:46Z would still have failed the mean


def test_the_analyst_proposes_sizes_inside_the_configured_range(s):
    """9 Oct: positions were set to $10-$20 but the Analyst was told $5-$10, so every buy was clamped
    to $10. Its prompt and its vote tool now state POSITION_MIN_USD..POSITION_MAX_USD."""
    from bot.agents.base import vote_tool
    from bot.agents.tools import ToolContext, analyst_spec, forensics_spec, scout_spec
    s.POSITION_MIN_USD, s.POSITION_MAX_USD = 10.0, 20.0
    ctx = ToolContext(s, None, None, None, None, None, None, {"mint": "m"})
    spec = analyst_spec(ctx)
    assert spec.size == (10.0, 20.0) and spec.with_size
    assert "`size_usd` between 10 and 20: 10 by default, 20 only" in spec.system
    assert "($10-$20 positions" in spec.system and "$5-$10" not in spec.system
    assert "($10-$20 positions" in scout_spec(ctx).system
    assert "($10-$20 positions" in forensics_spec(ctx).system
    tool = vote_tool(True, spec.size)
    assert tool["input_schema"]["properties"]["size_usd"]["description"].endswith("10 to 20")
    # the defaults keep the text as it was (and the cached prefix with it)
    assert role_prompt("analyst", True) == NEUTRAL_PROMPTS["analyst"]
    assert role_prompt("analyst", False, (5.0, 10.0)) == ROLE_PROMPTS["analyst"]


def test_the_prompts_state_the_exit_rules_the_bot_runs(s):
    """The agents were told '-40% stop' whatever STOP_LOSS_PCT was; they now read the bot's own stop,
    take-profit and time stop, so they weigh the risk the bot takes."""
    from bot.agents.tools import ToolContext, analyst_spec, forensics_spec, scout_spec
    s.STOP_LOSS_PCT, s.TAKE_PROFIT_PCT, s.TIME_STOP_HOURS = 25.0, 80.0, 4.0
    ctx = ToolContext(s, None, None, None, None, None, None, {"mint": "m"})
    for spec in (analyst_spec(ctx), scout_spec(ctx)):
        assert "4-hour max hold, -25% stop, +80% take-profit" in spec.system and "-30% stop" not in spec.system
    assert "($5-$10 positions, 4-hour max hold)" in forensics_spec(ctx).system
    for prompt in (*ROLE_PROMPTS.values(), *NEUTRAL_PROMPTS.values()):
        assert "-40% stop" not in prompt                            # the defaults read the current rules
    assert "6-hour max hold, -30% stop, +60% take-profit" in ROLE_PROMPTS["analyst"]
