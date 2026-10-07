"""Evidence grounding: does a vote's evidence cite facts the agent actually saw?

An evidence item is *grounded* when at least one salient token in it also appears in the
data the agent was given (the candidate context plus its successful tool results):

* a Solana address / mint / signature (base58, 32-88 chars) or an X post id (15-20 digits):
  exact match;
* a number (``41.2%``, ``$12.3k``, ``1,234``, ``0.45``): within 1% of a number in the data
  (k/m/b suffixes are tried both expanded and literal; a fraction matches its percentage).
  Small integers 0-10 are ignored because they match almost anything ("1h", "top 3").

The candidate's own mint address is ignored: citing the subject proves nothing.

Prose with no salient token ("strong narrative") is not grounded: the prompts ask for
evidence with numbers or ids copied from tool results.

This is a guard against fabricated evidence, not proof of correctness: a number can still
match by coincidence.
"""
from __future__ import annotations

import re

_ADDR = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,88}\b")
_POST_ID = re.compile(r"\b\d{15,20}\b")
_NUM = re.compile(r"(?<![\w.])[-+]?\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([kKmMbB])?(?!\w)")
_MULT = {"k": 1e3, "m": 1e6, "b": 1e9}


def _numbers(text: str) -> list[float]:
    """Every number in the text. A k/m/b suffix yields both readings ("5m" = 5 minutes or 5M)."""
    out = []
    for m in _NUM.finditer(text):
        whole, frac, suffix = m.group(1), m.group(2) or "", m.group(3)
        try:
            v = float(whole.replace(",", "") + frac)
        except ValueError:
            continue
        if m.group(0).lstrip().startswith("-"):
            v = -v
        out.append(v)
        if suffix:
            out.append(v * _MULT[suffix.lower()])
    return out


def _salient(text: str, ignore: set[str] = frozenset()) -> tuple[set[str], list[float]]:
    ids = (set(_ADDR.findall(text)) | set(_POST_ID.findall(text))) - set(ignore)
    nums = [n for n in _numbers(text) if not (n == int(n) and 0 <= n <= 10)]
    return ids, nums


class Corpus:
    """Everything the agent saw, indexed for grounding checks."""

    def __init__(self, ignore_ids: set[str] | None = None) -> None:
        self.text = ""
        self.nums: list[float] = []
        # the candidate's own mint is the subject, not evidence
        self.ignore_ids = set(ignore_ids or ())

    def add(self, text: str) -> None:
        self.text += "\n" + text
        self.nums.extend(_numbers(text))

    def has_number(self, v: float) -> bool:
        v = abs(v)  # prose drops signs: "down 35%" for -35.2
        for n in self.nums:
            n = abs(n)
            if n == v:
                return True
            if n != 0 and abs(n - v) <= 0.01 * abs(n):
                return True
            # the same quantity as a fraction on one side and a percentage on the other
            if n != 0 and abs(n * 100 - v) <= 0.01 * abs(n * 100):
                return True
            if v != 0 and abs(v * 100 - n) <= 0.01 * abs(v * 100):
                return True
        return False

    def grounded(self, item: str) -> bool:
        ids, nums = _salient(item, self.ignore_ids)
        if any(i in self.text for i in ids):
            return True
        return any(self.has_number(v) for v in nums)


def grounding_ratio(evidence: list[str], corpus: Corpus) -> float:
    if not evidence:
        return 0.0
    return sum(1 for e in evidence if corpus.grounded(e)) / len(evidence)
