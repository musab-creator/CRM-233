"""Consensus gate: BUY only if all three agents vote BUY and mean confidence >= threshold,
and no veto agent (forensics, social) blocks it afterwards.

Nothing bypasses this gate: the engine only creates a real position from a GateResult with
decision == "BUY". Veto agents can turn a BUY into a PASS, never the reverse.
"""
from __future__ import annotations

from dataclasses import dataclass

from .agents.base import Vote
from .config import Settings

REQUIRED_AGENTS = ("scout", "hunter", "analyst")
VETO_AGENTS = ("forensics", "social")


@dataclass(frozen=True)
class GateResult:
    decision: str        # BUY | PASS
    mean_confidence: float
    reason: str
    size_usd: float | None


def gate(votes: list[Vote], s: Settings) -> GateResult:
    by_agent = {v.agent: v for v in votes}
    missing = [a for a in REQUIRED_AGENTS if a not in by_agent]
    if missing or len(votes) != len(REQUIRED_AGENTS):
        return GateResult("PASS", 0.0, f"need exactly one vote from each agent; missing {missing}", None)
    mean = sum(v.confidence for v in votes) / len(votes)
    errored = [v.agent for v in votes if v.error]
    if errored:
        return GateResult("PASS", mean, f"agent error: {', '.join(errored)}", None)
    passes = [f"{v.agent}(guard: {v.guard})" if v.guard else v.agent for v in votes if v.vote != "BUY"]
    if passes:
        return GateResult("PASS", mean, f"PASS from {', '.join(passes)}", None)
    if mean < s.CONSENSUS_MIN_MEAN_CONFIDENCE:
        return GateResult("PASS", mean, f"mean confidence {mean:.3f} < {s.CONSENSUS_MIN_MEAN_CONFIDENCE}", None)
    return GateResult("BUY", mean, "unanimous BUY", position_size(by_agent["analyst"].size_usd, mean, s))


def veto_reason(v: Vote, s: Settings) -> str | None:
    """Why this veto vote blocks the trade, or None if it does not. A veto needs: a known veto
    agent, no error, a PASS at VETO_MIN_CONFIDENCE or more, at least one successful tool call,
    and evidence grounded in its tool results (a veto citing nothing is ignored)."""
    if v.agent not in VETO_AGENTS or v.error or v.vote != "PASS" or v.confidence < s.VETO_MIN_CONFIDENCE:
        return None
    if v.tool_calls_ok < 1 or (v.grounding or 0.0) < s.AGENT_MIN_GROUNDING:
        return None
    return f"veto from {v.agent}: {(v.reasons or ['no reason given'])[0][:160]}"


def apply_vetoes(result: GateResult, vetoes: list[Vote], s: Settings) -> GateResult:
    """A BUY survives only if no veto agent blocks it. PASS results are returned unchanged."""
    if result.decision != "BUY":
        return result
    reasons = [r for r in (veto_reason(v, s) for v in vetoes) if r]
    if not reasons:
        return result
    return GateResult("PASS", result.mean_confidence, "; ".join(reasons), None)


def position_size(proposed: float | None, mean_conf: float, s: Settings) -> float:
    """Analyst's proposal clamped to [min, max]; else scale linearly with mean confidence."""
    lo, hi = s.POSITION_MIN_USD, s.POSITION_MAX_USD
    if proposed is None:
        span = max(1e-9, 1 - s.CONSENSUS_MIN_MEAN_CONFIDENCE)
        proposed = lo + (hi - lo) * (mean_conf - s.CONSENSUS_MIN_MEAN_CONFIDENCE) / span
    return round(max(lo, min(hi, proposed)), 2)
