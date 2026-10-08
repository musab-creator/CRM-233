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
import math
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import anthropic

from ..budget import Budget, BudgetExceeded, llm_cost_usd
from ..config import Settings
from .grounding import Corpus

log = logging.getLogger("bot.agents")

ToolFn = Callable[[dict], Awaitable[Any]]

MAX_TOOL_RESULT_CHARS = 6000
INPUT_FRAMING_ALLOWANCE = 2048  # reserve for provider-added message/tool framing
BYTES_PER_TOKEN = 2.0  # base58 addresses and JSON punctuation tokenize at ~2-3 bytes per token; text at ~4


def _api_json(value: Any) -> Any:
    """Serialize SDK content blocks as API JSON instead of Python repr strings."""
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True)
    if hasattr(value, "__dict__"):
        return vars(value)
    raise TypeError(f"unsupported LLM request value: {type(value).__name__}")


def request_input_bytes(system, tools, messages) -> int:
    payload = json.dumps([system, tools, messages], default=_api_json, ensure_ascii=False,
                         allow_nan=False, separators=(",", ":"))
    return len(payload.encode("utf-8"))


def worst_case_call_usd(s: Settings, system, tools, messages, *, price_in: float | None = None,
                        price_out: float | None = None, max_tokens: int | None = None) -> float:
    """Conservative allowance for one request: UTF-8 bytes / BYTES_PER_TOKEN plus provider
    framing, all billed as a cache write (1.25x input), plus the full max_tokens of output.

    Measured in bytes, not characters, so Unicode and base58 addresses are not undercounted.
    One token per byte would be a strict upper bound but reserves 3-4x the real cost and
    starves the paced daily budget; the hold is settled to the returned usage right after
    the call anyway. Oversized requests fail before any billed API call.
    """
    input_bytes = request_input_bytes(system, tools, messages)
    if input_bytes > s.LLM_MAX_INPUT_BYTES:
        raise ValueError(f"LLM input exceeds {s.LLM_MAX_INPUT_BYTES} UTF-8 bytes")
    in_tokens = input_bytes / BYTES_PER_TOKEN + INPUT_FRAMING_ALLOWANCE
    pin = s.LLM_PRICE_IN_PER_MTOK if price_in is None else price_in
    pout = s.LLM_PRICE_OUT_PER_MTOK if price_out is None else price_out
    out_tokens = s.LLM_MAX_TOKENS if max_tokens is None else max_tokens
    if any(isinstance(p, bool) or not math.isfinite(p) or p < 0 for p in (pin, pout)):
        raise ValueError("LLM prices must be finite and nonnegative")
    return (in_tokens * pin * 1.25 + out_tokens * pout) / 1_000_000


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
    raw_vote: str | None = None      # what the agent submitted, before the grounding guard
    grounding: float | None = None   # share of evidence items found in data the agent saw
    tool_calls_ok: int = 0
    guard: str | None = None         # why a BUY was downgraded to PASS

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


NEUTRAL_MAX_CONFIDENCE = 0.6          # a BUY at or below this, from a neutral-mode Scout or Hunter, ...
NEUTRAL_AGENTS = ("scout", "hunter")  # ... claims nothing positive: "I looked and found nothing against it"
NEUTRAL_CLAIM_CONFIDENCE = 0.7        # from here up a neutral-mode BUY claims attention or a catalyst: grounded or PASS


def apply_grounding_guard(vote: Vote, context: Corpus, tools: Corpus, tool_calls_ok: int,
                          min_ratio: float, neutral_max_conf: float | None = None) -> Vote:
    """A BUY must rest on data the agent actually looked at; otherwise it becomes PASS.

    Evidence may cite the candidate context or tool results, but at least one item must come
    from a tool result: the context alone is what every agent already gets for free.

    `neutral_max_conf` (GATE_NEUTRAL_VOTES, Scout and Hunter only): a BUY at or below it is the
    neutral "nothing found against the token" vote. It still needs a successful tool call, so the
    agent did look, but its evidence is the absence of findings ("x_search results 0"), which the
    grounding share cannot credit: on the first live evening every such vote was flipped to PASS at
    grounding 0.17-0.30 while the Analyst voted BUY at 0.76-0.82. The guard exists to stop
    fabricated positive claims; a neutral vote makes none.

    Between the neutral vote and NEUTRAL_CLAIM_CONFIDENCE a neutral-mode BUY (Scout at 0.62: "one
    link-only post, not bot-like") claims a little more than nothing, on counts of 0 or 1 that the
    matcher ignores on purpose. Flipping it to PASS turned a mildly positive look into a veto
    (DESK95, 8 Oct); the unverified part is the extra confidence, so that is what goes: the vote
    becomes the neutral BUY. From NEUTRAL_CLAIM_CONFIDENCE up it claims attention or a catalyst and
    is guarded in full."""
    vote.raw_vote = vote.vote
    vote.tool_calls_ok = tool_calls_ok
    grounded = [e for e in vote.evidence if context.grounded(e) or tools.grounded(e)]
    vote.grounding = round(len(grounded) / len(vote.evidence), 3) if vote.evidence else 0.0
    if vote.vote == "BUY":
        why = None
        if tool_calls_ok < 1:
            vote.vote, vote.guard = "PASS", "BUY without any successful tool call"
        elif neutral_max_conf is not None and vote.confidence <= neutral_max_conf:
            pass  # neutral BUY: looked, found nothing against it; the Analyst must carry the gate
        elif vote.grounding < min_ratio:
            why = f"evidence grounding {vote.grounding:.2f} < {min_ratio}"
        elif not any(tools.grounded(e) for e in vote.evidence):
            why = "evidence cites nothing from tool results"
        if why and neutral_max_conf is not None and vote.confidence < NEUTRAL_CLAIM_CONFIDENCE:
            vote.guard = f"BUY {vote.confidence:.2f} held to the neutral {neutral_max_conf:g}: {why}"
            vote.confidence = neutral_max_conf
        elif why:
            vote.vote, vote.guard = "PASS", "BUY " + why
    return vote


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


async def _run_tool(fn: ToolFn | None, name: str, args: dict) -> tuple[str, bool, bool]:
    """(result text, hard error, soft error). A soft error is a result that came back but
    reports a problem (e.g. {"error": "X API disabled"}): it is shown to the model as data, but
    it does not count as a successful lookup for the grounding guard."""
    if fn is None:
        return f"unknown tool {name}", True, True
    try:
        res = await asyncio.wait_for(fn(args), timeout=45)
        soft = isinstance(res, dict) and bool(res.get("error"))
        text = json.dumps(res, default=str, ensure_ascii=False)
        if len(text) > MAX_TOOL_RESULT_CHARS:
            text = text[:MAX_TOOL_RESULT_CHARS] + "...[truncated]"
        return text, False, soft
    except asyncio.TimeoutError:
        return f"{name} timed out", True, True
    except Exception as e:
        return f"{name} failed: {type(e).__name__}: {e}"[:500], True, True


async def run_agent(client: anthropic.AsyncAnthropic, s: Settings, spec: AgentSpec, context: str,
                    budget: Budget, subject_ids: set[str] | None = None) -> Vote:
    vt = vote_tool(spec.with_size)
    ctx_corpus, tool_corpus = Corpus(subject_ids), Corpus(subject_ids)
    ctx_corpus.add(context)
    tool_calls_ok = 0
    tools = [*spec.tools, vt]
    system = [{"type": "text", "text": spec.system, "cache_control": {"type": "ephemeral"}}]
    messages: list[dict] = [{"role": "user", "content": context}]
    total_cost = 0.0
    turns = 0
    force_vote = False   # set after a prose-only reply: the next turn may only call submit_vote
    try:
        for turn in range(s.LLM_MAX_TURNS):
            last = turn == s.LLM_MAX_TURNS - 1
            if last and turn > 0:
                _append_user_text(messages, "Final turn: call submit_vote now with what you have.")
            # The final turn, and any turn after a reply without a tool call, forces submit_vote:
            # a text answer there would waste the whole evaluation on "no vote after max turns".
            tool_choice = ({"type": "tool", "name": "submit_vote"} if (last or force_vote)
                           else {"type": "auto"})
            reserve = worst_case_call_usd(s, system, tools, messages)
            try:
                reservation = await budget.reserve(reserve)
            except BudgetExceeded as e:
                return Vote(spec.name, cost_usd=total_cost, turns=turns, error=f"llm budget: {e}")
            # A timeout/connection error may occur after a billed request. Until usage is
            # known, charge the full reservation instead of silently refunding the call.
            cost = reserve
            usage_known = False
            try:
                resp = await client.messages.create(
                    model=s.LLM_MODEL, max_tokens=s.LLM_MAX_TOKENS, system=system,
                    tools=tools, tool_choice=tool_choice,
                    messages=messages, cache_control={"type": "ephemeral"},
                    timeout=s.LLM_TIMEOUT_S,
                )
                u = resp.usage
                cost = llm_cost_usd(u.input_tokens or 0, u.output_tokens or 0,
                                    getattr(u, "cache_creation_input_tokens", 0) or 0,
                                    getattr(u, "cache_read_input_tokens", 0) or 0,
                                    s.LLM_PRICE_IN_PER_MTOK, s.LLM_PRICE_OUT_PER_MTOK)
                usage_known = True
            finally:
                detail = f"{spec.name} turn {turn}" + ("; estimated: usage unknown" if not usage_known else "")
                await asyncio.shield(budget.settle(reservation, cost, detail))
                total_cost += cost
                turns += 1
            if resp.stop_reason == "refusal":
                return Vote(spec.name, cost_usd=total_cost, turns=turns, error="model refusal")
            if resp.stop_reason == "max_tokens":
                # a cut-off turn can carry a truncated (but schema-valid looking) submit_vote:
                # drop the whole turn and ask again, briefly
                _append_user_text(messages, "Your last reply was cut off by the length limit. Be brief: "
                                            "either one tool call or submit_vote with short items.")
                continue
            messages.append({"role": "assistant", "content": resp.content})
            uses = [b for b in resp.content if b.type == "tool_use"]
            terminal = [b for b in uses if b.name == "submit_vote"]
            if terminal and (len(terminal) != 1 or len(uses) != 1):
                raise ValueError("submit_vote must be exactly one terminal tool call")
            for b in uses:
                if b.name == "submit_vote":
                    vote = validate_vote(spec.name, b.input, spec.with_size)
                    vote.cost_usd, vote.turns = total_cost, turns
                    neutral = NEUTRAL_MAX_CONFIDENCE if (s.GATE_NEUTRAL_VOTES and spec.name in NEUTRAL_AGENTS) else None
                    return apply_grounding_guard(vote, ctx_corpus, tool_corpus, tool_calls_ok,
                                                 s.AGENT_MIN_GROUNDING, neutral_max_conf=neutral)
            if not uses:
                messages.append({"role": "user", "content": "Call submit_vote to give your decision."})
                force_vote = True
                continue
            results = await asyncio.gather(*[_run_tool(spec.impl.get(b.name), b.name, dict(b.input or {}))
                                             for b in uses])
            for text, err, soft in results:
                if not err:
                    tool_corpus.add(text)
                    tool_calls_ok += 0 if soft else 1
            messages.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": b.id, "content": text, **({"is_error": True} if err else {})}
                for b, (text, err, _soft) in zip(uses, results)
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
