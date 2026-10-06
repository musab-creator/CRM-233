"""Agent loop: Claude Messages API + client tools + a strict `submit_vote` terminal tool.

Output contract per agent:
    {"vote": "BUY|PASS", "confidence": 0.0-1.0, "reasons": [...], "evidence": [...]}
(the Analyst also returns `size_usd`). Anything else, any error, timeout, or budget stop
becomes PASS with confidence 0 and the error recorded.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import anthropic

from ..budget import Budget, BudgetExceeded, llm_cost_usd
from ..config import Settings

log = logging.getLogger("bot.agents")

ToolFn = Callable[[dict], Awaitable[Any]]

# Worst-case reservation per API call; settled to the real cost from `usage`.
CALL_RESERVE_USD = 0.06
MAX_TOOL_RESULT_CHARS = 6000


@dataclass
class Vote:
    agent: str
    vote: str = "PASS"
    confidence: float = 0.0
    reasons: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    size_usd: float | None = None
    cost_usd: float = 0.0
    turns: int = 0
    error: str | None = None

    def as_json(self) -> dict:
        d = {"vote": self.vote, "confidence": self.confidence, "reasons": self.reasons, "evidence": self.evidence}
        if self.size_usd is not None:
            d["size_usd"] = self.size_usd
        return d


def vote_tool(with_size: bool) -> dict:
    props: dict[str, Any] = {
        "vote": {"type": "string", "enum": ["BUY", "PASS"]},
        "confidence": {"type": "number", "description": "0.0 to 1.0"},
        "reasons": {"type": "array", "items": {"type": "string"}},
        "evidence": {"type": "array", "items": {"type": "string"}},
    }
    req = ["vote", "confidence", "reasons", "evidence"]
    if with_size:
        props["size_usd"] = {"type": "number", "description": "Proposed position size in USD, 5 to 10"}
        req.append("size_usd")
    return {
        "name": "submit_vote",
        "description": "Submit your final vote. Call exactly once, after gathering evidence.",
        "strict": True,
        "input_schema": {"type": "object", "properties": props, "required": req, "additionalProperties": False},
    }


def validate_vote(agent: str, data: Any, with_size: bool) -> Vote:
    """Strictly validate the submitted JSON; raise ValueError if it breaks the contract."""
    if not isinstance(data, dict):
        raise ValueError("vote is not an object")
    v = data.get("vote")
    if v not in ("BUY", "PASS"):
        raise ValueError(f"vote must be BUY or PASS, got {v!r}")
    c = data.get("confidence")
    if isinstance(c, bool) or not isinstance(c, (int, float)) or not 0.0 <= float(c) <= 1.0:
        raise ValueError(f"confidence must be a number in [0,1], got {c!r}")
    reasons, evidence = data.get("reasons"), data.get("evidence")
    if not isinstance(reasons, list) or not all(isinstance(x, str) for x in reasons):
        raise ValueError("reasons must be a list of strings")
    if not isinstance(evidence, list) or not all(isinstance(x, str) for x in evidence):
        raise ValueError("evidence must be a list of strings")
    size = None
    if with_size:
        s = data.get("size_usd")
        if isinstance(s, (int, float)) and not isinstance(s, bool):
            size = float(s)
    return Vote(agent, v, float(c), [r[:400] for r in reasons][:10], [e[:400] for e in evidence][:15], size)


@dataclass
class AgentSpec:
    name: str
    system: str
    tools: list[dict]           # Anthropic tool definitions (without submit_vote)
    impl: dict[str, ToolFn]     # tool name -> async implementation
    with_size: bool = False


def _append_user_text(messages: list[dict], text: str) -> None:
    """Add text to the trailing user turn (tool results + text share one message)."""
    lastmsg = messages[-1]
    if lastmsg["role"] != "user":
        messages.append({"role": "user", "content": text})
    elif isinstance(lastmsg["content"], str):
        lastmsg["content"] += "\n\n" + text
    else:
        lastmsg["content"].append({"type": "text", "text": text})


async def _run_tool(fn: ToolFn | None, name: str, args: dict) -> tuple[str, bool]:
    if fn is None:
        return f"unknown tool {name}", True
    try:
        res = await asyncio.wait_for(fn(args), timeout=45)
        text = json.dumps(res, default=str, ensure_ascii=False)
        if len(text) > MAX_TOOL_RESULT_CHARS:
            text = text[:MAX_TOOL_RESULT_CHARS] + "...[truncated]"
        return text, False
    except asyncio.TimeoutError:
        return f"{name} timed out", True
    except Exception as e:
        return f"{name} failed: {type(e).__name__}: {e}"[:500], True


async def run_agent(client: anthropic.AsyncAnthropic, s: Settings, spec: AgentSpec, context: str,
                    budget: Budget) -> Vote:
    vt = vote_tool(spec.with_size)
    tools = [*spec.tools, vt]
    system = [{"type": "text", "text": spec.system, "cache_control": {"type": "ephemeral"}}]
    messages: list[dict] = [{"role": "user", "content": context}]
    total_cost = 0.0
    turns = 0
    try:
        for turn in range(s.LLM_MAX_TURNS):
            last = turn == s.LLM_MAX_TURNS - 1
            if last and turn > 0:
                _append_user_text(messages, "Final turn: call submit_vote now with what you have.")
            try:
                await budget.reserve(CALL_RESERVE_USD)
            except BudgetExceeded as e:
                return Vote(spec.name, cost_usd=total_cost, turns=turns, error=f"llm budget: {e}")
            cost = 0.0
            try:
                resp = await client.messages.create(
                    model=s.LLM_MODEL, max_tokens=s.LLM_MAX_TOKENS, system=system,
                    tools=tools, tool_choice={"type": "auto"},
                    messages=messages, cache_control={"type": "ephemeral"},
                    timeout=s.LLM_TIMEOUT_S,
                )
                u = resp.usage
                cost = llm_cost_usd(u.input_tokens or 0, u.output_tokens or 0,
                                    getattr(u, "cache_creation_input_tokens", 0) or 0,
                                    getattr(u, "cache_read_input_tokens", 0) or 0,
                                    s.LLM_PRICE_IN_PER_MTOK, s.LLM_PRICE_OUT_PER_MTOK)
            finally:
                await budget.settle(CALL_RESERVE_USD, cost, f"{spec.name} turn {turn}")
            total_cost += cost
            turns += 1
            if resp.stop_reason == "refusal":
                return Vote(spec.name, cost_usd=total_cost, turns=turns, error="model refusal")
            messages.append({"role": "assistant", "content": resp.content})
            uses = [b for b in resp.content if b.type == "tool_use"]
            for b in uses:
                if b.name == "submit_vote":
                    vote = validate_vote(spec.name, b.input, spec.with_size)
                    vote.cost_usd, vote.turns = total_cost, turns
                    return vote
            if not uses:
                messages.append({"role": "user", "content": "Call submit_vote to give your decision."})
                continue
            results = await asyncio.gather(*[_run_tool(spec.impl.get(b.name), b.name, dict(b.input or {}))
                                             for b in uses])
            messages.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": b.id, "content": text, **({"is_error": True} if err else {})}
                for b, (text, err) in zip(uses, results)
            ]})
        return Vote(spec.name, cost_usd=total_cost, turns=turns, error="no vote after max turns")
    except ValueError as e:
        return Vote(spec.name, cost_usd=total_cost, turns=turns, error=f"invalid vote: {e}")
    except anthropic.RateLimitError as e:
        return Vote(spec.name, cost_usd=total_cost, turns=turns, error=f"rate limited: {e}")
    except anthropic.APIStatusError as e:
        return Vote(spec.name, cost_usd=total_cost, turns=turns, error=f"api {e.status_code}: {e}"[:300])
    except anthropic.APIConnectionError as e:
        return Vote(spec.name, cost_usd=total_cost, turns=turns, error=f"connection: {e}"[:300])
    except Exception as e:  # never let one agent crash the cycle
        log.exception("agent %s crashed", spec.name)
        return Vote(spec.name, cost_usd=total_cost, turns=turns, error=f"{type(e).__name__}: {e}"[:300])
