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


def _num(d: dict | None, key: str) -> float | None:
    v = (d or {}).get(key)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _holding_count(value) -> int:
    """`snipers_still_holding` is "k/n" (k of the top-3 launch-minute buyers still hold 10%+)."""
    try:
        return int(str(value).split("/", 1)[0])
    except (TypeError, ValueError):
        return 0


def hard_red_flags(ctx: dict) -> list[str]:
    """The triage prompt's hard red flags, recomputed from the deterministic fields the model saw.

    Lenient on purpose: this is a floor under the model's PASS, not a second opinion. A skip that
    cites a flag the data does not contain is a misreading (seen live: "effective holders 12.5
    falls below the threshold of 10"), and a skip on a weak signal alone (dev selling, early-buyer
    retention) is the rule the prompt demotes. The two judgment flags (a copycat name, "live far
    below the scan") are not recomputed, so they cannot carry a skip on their own: the committee
    then decides, which is what the prompt says doubt should do. A missing or null field is never
    a flag."""
    flow = ctx.get("flow") or {}
    rug = ctx.get("rugcheck") or {}
    live = ctx.get("live") or {}
    pf = ctx.get("prefilter") or {}
    change = (ctx.get("pair") or {}).get("price_change") or {}
    flags: list[str] = []
    for r in rug.get("risks") or []:
        if "rugged" in str(r.get("name", "")).lower():
            flags.append(f"rugcheck: {r.get('name')}")
            break
    # The prompt's sniper rule: the top three launch-minute buyers' SOL against the token's whole net
    # inflow (chain mode), or `sniper_top3_share` (streamed mode: their share of all buying since
    # launch). The launch minute's own total is NOT the denominator: three of the first handful of
    # buyers always hold most of that minute (review of aaf789b: 0.5-0.7 on ordinary launches), so
    # `sniper_top3_share_of_launch_minute` and `launch_minute_buy_sol` are deliberately not used.
    share = _num(flow, "sniper_top3_share")
    top3 = _num(flow, "sniper_top3_sol")
    inflow = _num(flow, "net_inflow_sol") or _num(live, "net_inflow_sol") or _num(pf, "net_inflow_sol")
    sol_share = top3 / inflow if top3 is not None and inflow else None
    concentrated = (share is not None and share > 0.3) or (sol_share is not None and sol_share >= 1 / 3)
    if concentrated and _holding_count(flow.get("snipers_still_holding")) >= 1:
        flags.append(f"snipers: top3 share {share if share is not None else round(sol_share, 3)} of net inflow, "
                     f"still holding {flow.get('snipers_still_holding')}")
    same_slot = _num(flow, "same_slot_as_launch_buyers")
    bundle = max((v for v in (_num(flow, "bundle_like_buy_share"), _num(flow, "bundle_like_share_of_launch_minute"))
                  if v is not None), default=None)
    cluster = _num(flow, "max_same_size_cluster_wallets")
    if (same_slot is not None and same_slot >= 3) or (bundle is not None and bundle > 0.2) \
            or (cluster is not None and cluster >= 5):
        flags.append(f"bundling: same_slot {same_slot}, bundle_like {bundle}, cluster {cluster}")
    for key in ("effective_buyers", "effective_holders"):
        v = _num(flow, key)
        if v is not None and v < 10:
            flags.append(f"concentration: {key} {v} < 10")
            break
    now5, prev5 = _num(flow, "net_flow_sol_5m"), _num(flow, "net_flow_sol_prev_5m")
    drawdown = _num(flow, "drawdown_from_peak_pct")
    if (now5 is not None and prev5 is not None and now5 < 0 < prev5) or (drawdown is not None and drawdown > 40):
        flags.append(f"momentum: net_flow_5m {now5} after {prev5}, drawdown {drawdown}%")
    # DexScreener's own price change: the chain-read drawdown needs the bot's price history, which a
    # candidate a few minutes old barely has (Pao, 8 Oct: -67% on every timeframe, no drawdown field,
    # so a right PASS ran the committee anyway)
    worst = min((v for v in (_num(change, "m5"), _num(change, "h1")) if v is not None), default=None)
    if worst is not None and worst <= -50:
        flags.append(f"collapse: DexScreener price change m5 {change.get('m5')}%, h1 {change.get('h1')}%")
    for key in ("unique_buyers", "net_inflow_sol"):
        before, after = _num(pf, key), _num(live, key)
        if before and after is not None and after < 0.7 * before:
            flags.append(f"shrinking since the scan: {key} {before} -> {after}")
            break
    return flags


def verify_triage(vote: Vote, ctx: dict) -> Vote:
    """A triage PASS that would skip the committee must be backed by a recomputed hard red flag;
    otherwise it is downgraded to BUY (the committee decides) with the reason kept in `guard`."""
    if vote.error is not None or vote.vote != "PASS":
        return vote
    flags = hard_red_flags(ctx)
    vote.raw_vote = "PASS"
    if flags:
        computed = [f"computed: {f}" for f in flags][:5]
        vote.evidence = list(vote.evidence)[:15 - len(computed)] + computed  # the computed flags always survive the cap
        return vote
    vote.vote, vote.guard = "BUY", "PASS without a computed hard red flag: the committee decides"
    return vote


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
        for attempt in range(2):  # one retry if the reply is cut off by max_tokens
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
                    tool_choice={"type": "tool", "name": "submit_vote"},   # never a prose reply
                    messages=messages, cache_control={"type": "ephemeral"},
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
