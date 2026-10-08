"""The market regime agent: snapshot, deterministic rule, model call with fallback, sizing."""
import asyncio
from types import SimpleNamespace

import pytest

from bot.budget import Budget
from bot.config import load_settings
from bot.db import Database
from bot.feeds.prices import SolPrice
from bot.regime import Regime, apply_regime_size, market_snapshot, rule_regime, run_regime, validate_regime

NOW = 1_791_300_000.0


def test_sol_price_history_and_changes():
    sp = SolPrice(None)
    for i, v in enumerate((100.0, 102.0, 104.0, 96.0)):
        assert sp.accept(v, now=NOW - 3 * 3600 + i * 3600)
    assert sp.at(NOW - 3 * 3600) == 100.0 and sp.at(NOW - 2.5 * 3600) == 100.0 and sp.at(NOW - 4 * 3600) is None
    assert sp.change_pct(3600, NOW) == pytest.approx(-7.69, abs=0.01)
    assert sp.change_pct(3 * 3600, NOW) == -4.0 and sp.change_pct(10 * 3600, NOW) is None
    sp.accept(97.0, now=NOW + 25 * 3600)          # the 24h window drops the oldest readings
    assert sp.at(NOW) is None and len(sp.history) == 1


def _snap(**o):
    base = {"sol_change_1h_pct": 0.5, "shadow_6h": {"closed": 0, "wins": 0, "win_rate": None},
            "launches_1h": 400, "launches_prev_1h": 420}
    base.update(o)
    return base


def test_rule_regime_thresholds():
    assert rule_regime(_snap()).mode == "normal" and rule_regime(_snap()).multiplier == 1.0
    r = rule_regime(_snap(sol_change_1h_pct=-4.5))
    assert (r.mode, r.multiplier) == ("cautious", 0.5) and "SOL -4.5%" in r.reasons[0]
    r = rule_regime(_snap(sol_change_1h_pct=-8.2))
    assert (r.mode, r.multiplier) == ("off", 0.0)
    r = rule_regime(_snap(shadow_6h={"closed": 7, "wins": 1, "win_rate": 0.14}))
    assert (r.mode, r.multiplier) == ("cautious", 0.5)
    r = rule_regime(_snap(shadow_6h={"closed": 9, "wins": 0, "win_rate": 0.0}))
    assert r.mode == "off"
    assert rule_regime(_snap(shadow_6h={"closed": 3, "wins": 0, "win_rate": 0.0})).mode == "normal"  # small sample
    r = rule_regime(_snap(launches_1h=40, launches_prev_1h=300))
    assert (r.mode, r.multiplier) == ("cautious", 0.75) and "launches fell" in r.reasons[0]
    assert rule_regime(_snap(sol_change_1h_pct=None)).mode == "normal"


def test_validate_regime_clamps_and_rejects(tmp_path):
    s = load_settings(tmp_path / "none.env")
    assert validate_regime({"mode": "cautious", "size_multiplier": 0.1, "reasons": ["x"]}, s).multiplier == 0.25
    assert validate_regime({"mode": "cautious", "size_multiplier": 3, "reasons": []}, s).multiplier == 1.0
    assert validate_regime({"mode": "normal", "size_multiplier": 0.3, "reasons": []}, s).multiplier == 1.0
    assert validate_regime({"mode": "off", "size_multiplier": 0.9, "reasons": []}, s).multiplier == 0.0
    for bad in ({"mode": "panic", "size_multiplier": 1, "reasons": []},
                {"mode": "normal", "size_multiplier": "1", "reasons": []},
                {"mode": "normal", "size_multiplier": 1, "reasons": "no"}, "nope"):
        with pytest.raises(ValueError):
            validate_regime(bad, s)


class FakeClient:
    def __init__(self, resp):
        self.resp, self.messages, self.calls = resp, self, []

    async def create(self, **kw):
        self.calls.append(kw)
        if isinstance(self.resp, Exception):
            raise self.resp
        return self.resp


def _tool_resp(inp):
    usage = SimpleNamespace(input_tokens=1200, output_tokens=80, cache_creation_input_tokens=0,
                            cache_read_input_tokens=0)
    return SimpleNamespace(content=[SimpleNamespace(type="tool_use", id="t", name="submit_regime", input=inp)],
                           stop_reason="tool_use", usage=usage)


def test_run_regime_model_and_fallbacks(tmp_path):
    s = load_settings(tmp_path / "none.env", overrides={"DB_PATH": str(tmp_path / "r.db"), "LOG_FILE": ""})
    snap = _snap(sol_change_1h_pct=-5.0)

    async def go(client, limit=5.0):
        db = await Database(s.DB_PATH).open()
        try:
            r = await run_regime(client, s, snap, Budget(db, "llm", limit, "day"), NOW)
            spent = (await db.fetchone("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='llm'"))["s"]
            return r, spent
        finally:
            await db.close()

    good = FakeClient(_tool_resp({"mode": "cautious", "size_multiplier": 0.4, "reasons": ["SOL -5.0% in 1h"]}))
    r, spent = asyncio.run(go(good))
    assert (r.mode, r.multiplier, r.source, r.at) == ("cautious", 0.4, "model", NOW) and r.error is None
    assert spent == pytest.approx((1200 * 1.0 + 80 * 5.0) / 1e6) and good.calls[0]["model"] == "claude-haiku-4-5"
    assert "Your role: Regime" in good.calls[0]["system"][0]["text"]
    # an invalid answer, an exception or an empty budget fall back to the rule (cautious x0.5 here)
    r, _ = asyncio.run(go(FakeClient(_tool_resp({"mode": "calm", "size_multiplier": 1, "reasons": []}))))
    assert (r.mode, r.multiplier, r.source) == ("cautious", 0.5, "rule") and r.error.startswith("invalid regime")
    r, _ = asyncio.run(go(FakeClient(RuntimeError("down"))))
    assert r.source == "rule" and r.error == "RuntimeError: down"
    r, _ = asyncio.run(go(good, limit=0.0001))
    assert r.source == "rule" and r.error.startswith("llm budget")
    r, _ = asyncio.run(go(None))
    assert r.source == "rule" and r.error is None and r.at == NOW


def test_market_snapshot_reads_the_bots_own_tables(tmp_path):
    s = load_settings(tmp_path / "none.env", overrides={"DB_PATH": str(tmp_path / "m.db"), "LOG_FILE": ""})
    sp = SolPrice(None)
    sp.accept(120.0, now=NOW - 7000)
    sp.accept(114.0, now=NOW - 10)

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            for i in range(5):
                await db.insert("mints", {"mint": f"L{i}", "first_trade_at": NOW - 600 * i, "last_trade_at": NOW - 60,
                                          "graduated": int(i == 0)})
            await db.insert("mints", {"mint": "OLD", "first_trade_at": NOW - 5000, "last_trade_at": NOW - 4000})
            await db.insert("candidates", {"mint": "L1", "ts": NOW - 300, "status": "evaluated", "decision": "BUY"})
            await db.insert("candidates", {"mint": "L2", "ts": NOW - 200, "status": "evaluated", "decision": "PASS"})
            for i, (pnl, ret) in enumerate(((2.0, 0.4), (-3.0, -0.6), (-2.0, -0.4))):
                await db.insert("positions", {"kind": "shadow", "mode": "paper", "mint": f"L{i}", "status": "closed",
                                              "closed_at": NOW - 1000 - i, "cost_sol": 0.04,
                                              "proceeds_sol": 0.04 * (1 + ret), "pnl_usd": pnl})
            await db.insert("positions", {"kind": "real", "mode": "paper", "mint": "L1", "status": "closed",
                                          "closed_at": NOW - 100, "pnl_usd": 1.5, "cost_sol": 0.04,
                                          "proceeds_sol": 0.05})
            return await market_snapshot(db, {"creates": 50, "migrations": 2}, sp, NOW, 1, None)
        finally:
            await db.close()

    snap = asyncio.run(go())
    assert snap["sol_usd"] == 114.0 and snap["sol_change_1h_pct"] == -5.0
    assert snap["launches_1h"] == 5 and snap["launches_prev_1h"] == 1 and snap["graduations_1h"] == 1
    assert snap["candidates_1h"] == 2 and snap["gate_buys_1h"] == 1
    assert snap["shadow_6h"] == {"closed": 3, "wins": 1, "win_rate": 0.33, "avg_return": -0.2, "pnl_usd": -3.0}
    assert snap["real_today"]["closed"] == 1 and snap["open_positions"] == 1 and snap["session"]["launches"] == 50
    assert snap["rule_suggestion"]["mode"] == "cautious" and snap["rule_suggestion"]["multiplier"] == 0.5


def test_apply_regime_size(tmp_path):
    s = load_settings(tmp_path / "none.env")
    assert apply_regime_size(10.0, Regime("normal", 1.0), s) == 10.0
    assert apply_regime_size(10.0, Regime("cautious", 0.5), s) == 5.0
    assert apply_regime_size(6.0, Regime("cautious", 0.25), s) == 5.0     # never below POSITION_MIN_USD
