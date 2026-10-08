import pytest

from bot.agents.base import Vote, validate_vote
from bot.consensus import gate, position_size


def votes(*specs, size=None):
    names = ["scout", "hunter", "analyst"]
    out = [Vote(n, v, c) for n, (v, c) in zip(names, specs)]
    out[2].size_usd = size
    return out


def test_unanimous_buy_above_threshold(s):
    g = gate(votes(("BUY", 0.7), ("BUY", 0.7), ("BUY", 0.7), size=8), s)
    assert g.decision == "BUY" and g.size_usd == 8


def test_threshold_is_inclusive(s):
    g = gate(votes(("BUY", 0.65), ("BUY", 0.65), ("BUY", 0.65)), s)
    assert g.decision == "BUY"
    g = gate(votes(("BUY", 0.65), ("BUY", 0.65), ("BUY", 0.6499)), s)
    assert g.decision == "PASS" and "mean confidence" in g.reason


@pytest.mark.parametrize("i", [0, 1, 2])
def test_any_pass_blocks(s, i):
    specs = [("BUY", 1.0)] * 3
    specs[i] = ("PASS", 1.0)
    assert gate(votes(*specs), s).decision == "PASS"


def test_errored_vote_blocks_even_if_buy(s):
    v = votes(("BUY", 0.9), ("BUY", 0.9), ("BUY", 0.9))
    v[1].error = "timeout"
    assert gate(v, s).decision == "PASS"


def test_missing_or_duplicate_agents_block(s):
    v = votes(("BUY", 0.9), ("BUY", 0.9), ("BUY", 0.9))
    assert gate(v[:2], s).decision == "PASS"
    dup = [v[0], v[0], v[2]]
    assert gate(dup, s).decision == "PASS"
    assert gate(v + [Vote("scout", "BUY", 0.9)], s).decision == "PASS"


def test_size_is_clamped(s):
    assert position_size(50, 0.9, s) == 10
    assert position_size(1, 0.9, s) == 5
    assert position_size(None, 0.65, s) == 5
    assert position_size(None, 1.0, s) == 10


def test_vote_validation_is_strict():
    ok = validate_vote("scout", {"vote": "BUY", "confidence": 0.8, "reasons": ["a"], "evidence": []}, False)
    assert ok.vote == "BUY" and ok.confidence == 0.8
    for bad in [
        {"vote": "buy", "confidence": 0.8, "reasons": [], "evidence": []},
        {"vote": "BUY", "confidence": 1.2, "reasons": [], "evidence": []},
        {"vote": "BUY", "confidence": "0.8", "reasons": [], "evidence": []},
        {"vote": "BUY", "confidence": True, "reasons": [], "evidence": []},
        {"vote": "BUY", "confidence": 0.8, "reasons": "x", "evidence": []},
        {"vote": "BUY", "confidence": 0.8, "reasons": [], "evidence": [1]},
        "BUY",
    ]:
        with pytest.raises(ValueError):
            validate_vote("scout", bad, False)
