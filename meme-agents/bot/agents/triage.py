"""Triage: a cheap first screen before the three agents.

One call to a small model with the same candidate context the agents get and no tools. Its
vote means "worth the committee's budget" (BUY) or "not worth evaluating" (PASS). The engine
skips the three agents only on a PASS at or above TRIAGE_MIN_CONFIDENCE; any error, budget stop
or malformed answer lets the candidate through, so a broken triage costs money, never coverage.
The vote is stored like the others (agent "triage"), so the report scores its skips against
the shadow book's outcomes.
"""
from __future__ import annotations

import asyncio
import logging

import anthropic

from ..budget import Budget, BudgetExceeded, llm_cost_usd
from ..config import Settings
from .base import Vote, validate_vote, vote_tool, worst_case_call_usd
from .prompts import ROLE_PROMPTS

log = logging.getLogger("bot.agents.triage")

AGENT = "triage"


def triage_skips(vote: Vote, s: Settings) -> bool:
    """Does this triage vote take the candidate away from the committee?"""
    return vote.error is None and vote.vote == "PASS" and vote.confidence >= s.TRIAGE_MIN_CONFIDENCE


def triage_first_call_usd(s: Settings, context: str) -> float:
    system = [{"type": "text", "text": ROLE_PROMPTS[AGENT], "cache_control": {"type": "ephemeral"}}]
    return worst_case_call_usd(s, system, [vote_tool(False)], [{"role": "user", "content": context}],
                               price_in=s.TRIAGE_PRICE_IN_PER_MTOK, price_out=s.TRIAGE_PRICE_OUT_PER_MTOK,
                               max_tokens=s.TRIAGE_MAX_TOKENS)


async def run_triage(client: anthropic.AsyncAnthropic, s: Settings, context: str, budget: Budget) -> Vote:
    vt = vote_tool(False)
    system = [{"type": "text", "text": ROLE_PROMPTS[AGENT], "cache_control": {"type": "ephemeral"}}]
    messages: list[dict] = [{"role": "user", "content": context}]
    total = 0.0
    turns = 0
    try:
        for attempt in range(2):  # one retry if the model answers in prose instead of calling the tool
            reserve = worst_case_call_usd(s, system, [vt], messages, price_in=s.TRIAGE_PRICE_IN_PER_MTOK,
                                          price_out=s.TRIAGE_PRICE_OUT_PER_MTOK, max_tokens=s.TRIAGE_MAX_TOKENS)
            try:
                reservation = await budget.reserve(reserve)
            except BudgetExceeded as e:
                return Vote(AGENT, cost_usd=total, turns=turns, error=f"llm budget: {e}")
            cost = reserve
            usage_known = False
            try:
                resp = await client.messages.create(
                    model=s.TRIAGE_MODEL, max_tokens=s.TRIAGE_MAX_TOKENS, system=system, tools=[vt],
                    tool_choice={"type": "auto"}, messages=messages, cache_control={"type": "ephemeral"},
                    timeout=s.LLM_TIMEOUT_S)
                u = resp.usage
                cost = llm_cost_usd(u.input_tokens or 0, u.output_tokens or 0,
                                    getattr(u, "cache_creation_input_tokens", 0) or 0,
                                    getattr(u, "cache_read_input_tokens", 0) or 0,
                                    s.TRIAGE_PRICE_IN_PER_MTOK, s.TRIAGE_PRICE_OUT_PER_MTOK)
                usage_known = True
            finally:
                detail = f"{AGENT} turn {attempt}" + ("; estimated: usage unknown" if not usage_known else "")
                await asyncio.shield(budget.settle(reservation, cost, detail))
                total += cost
                turns += 1
            if resp.stop_reason == "refusal":
                return Vote(AGENT, cost_usd=total, turns=turns, error="model refusal")
            if resp.stop_reason == "max_tokens":
                messages.append({"role": "user", "content": "Your reply was cut off. Call submit_vote briefly."})
                continue
            terminal = [b for b in resp.content if getattr(b, "type", None) == "tool_use"]
            if len(terminal) > 1:
                raise ValueError("submit_vote must be exactly one terminal tool call")
            for b in terminal:
                if getattr(b, "type", None) == "tool_use" and b.name == "submit_vote":
                    vote = validate_vote(AGENT, b.input, False)
                    vote.cost_usd, vote.turns, vote.raw_vote = total, turns, vote.vote
                    return vote
            messages.append({"role": "assistant", "content": resp.content})
            messages.append({"role": "user", "content": "Call submit_vote now with your decision."})
        return Vote(AGENT, cost_usd=total, turns=turns, error="no vote after 2 turns")
    except ValueError as e:
        return Vote(AGENT, cost_usd=total, turns=turns, error=f"invalid vote: {e}")
    except anthropic.RateLimitError as e:
        return Vote(AGENT, cost_usd=total, turns=turns, error=f"rate limited: {e}")
    except anthropic.APIStatusError as e:
        return Vote(AGENT, cost_usd=total, turns=turns, error=f"api {e.status_code}: {e}"[:300])
    except anthropic.APIConnectionError as e:
        return Vote(AGENT, cost_usd=total, turns=turns, error=f"connection: {e}"[:300])
    except Exception as e:  # never let triage crash the cycle
        log.exception("triage crashed")
        return Vote(AGENT, cost_usd=total, turns=turns, error=f"{type(e).__name__}: {e}"[:300])
