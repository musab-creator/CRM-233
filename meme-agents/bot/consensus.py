"""Consensus gate: BUY only if all three agents vote BUY and mean confidence >= threshold.

Nothing bypasses this gate: the engine only creates a real position from a GateResult with
decision == "BUY".
"""
from __future__ import annotations

from dataclasses import dataclass

from .agents.base import Vote
from .config import Settings

REQUIRED_AGENTS = ("scout", "hunter", "analyst")


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


def position_size(proposed: float | None, mean_conf: float, s: Settings) -> float:
    """Analyst's proposal clamped to [min, max]; else scale linearly with mean confidence."""
    lo, hi = s.POSITION_MIN_USD, s.POSITION_MAX_USD
    if proposed is None:
        span = max(1e-9, 1 - s.CONSENSUS_MIN_MEAN_CONFIDENCE)
        proposed = lo + (hi - lo) * (mean_conf - s.CONSENSUS_MIN_MEAN_CONFIDENCE) / span
    return round(max(lo, min(hi, proposed)), 2)
