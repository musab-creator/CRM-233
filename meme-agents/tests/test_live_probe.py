"""check_transaction (the live executor's pre-signing checks) on realistic transactions, and the
preflight probe that runs a genuine PumpPortal transaction through them."""
import asyncio
import json
from types import SimpleNamespace

import pytest
import websockets
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction

from bot.live.executor import LiveExecutionError, check_transaction
from bot import preflight
from bot.preflight import (Check, capture_stream, key_shape, merge_retry, probe_trade_local, render,
                           run_checks, run_checks_with_retry, summarize_stream)


def _tx(kp: Keypair, lamports: int, extra=()):
    ixs = [set_compute_unit_limit(200_000), set_compute_unit_price(50_000),
           transfer(TransferParams(from_pubkey=kp.pubkey(), to_pubkey=Keypair().pubkey(), lamports=lamports)), *extra]
    msg = MessageV0.try_compile(kp.pubkey(), ixs, [], Hash.default())
    return VersionedTransaction.populate(msg, [kp.sign_message(b"unsigned")])


def test_check_transaction_reports_what_it_found():
    kp = Keypair()
    info = check_transaction(_tx(kp, 5_000_000).message, kp.pubkey(), 0.01 + 0.001)
    assert info["instructions"] == 3 and info["explicit_debit_sol"] == 0.005
    assert info["priority_fee_sol"] == pytest.approx(200_000 * 50_000 / 1e6 / 1e9)
    assert info["compute_limit"] == 200_000 and len(info["programs"]) == 2
    with pytest.raises(LiveExecutionError, match="spending limit"):
        check_transaction(_tx(kp, 20_000_000).message, kp.pubkey(), 0.01 + 0.001)
    with pytest.raises(LiveExecutionError, match="payer"):
        check_transaction(_tx(kp, 1).message, Keypair().pubkey(), 1.0)


class FakeHttp:
    def __init__(self, body: bytes, status=200):
        self.body, self.status, self.posts = body, status, []

    async def post(self, url, data=None, timeout=None):
        self.posts.append(data)
        return SimpleNamespace(status_code=self.status, content=self.body, text="")


class FakeHelius:
    def __init__(self, value):
        self.value, self.calls = value, []

    async def rpc(self, method, params):
        self.calls.append((method, params))
        return {"context": {}, "value": self.value}


def test_probe_runs_the_real_transaction_through_signing_checks_and_simulation(s):
    kp = Keypair()
    http = FakeHttp(bytes(_tx(kp, 5_000_000)))
    helius = FakeHelius({"err": {"InsufficientFundsForFee": None}, "accounts": [None]})
    out = asyncio.run(probe_trade_local(s, http, "MINT", kp=kp, helius=helius))
    assert out["builds"] is True and out["signing_checks"] == "pass" and out["explicit_debit_sol"] == 0.005
    assert http.posts[0]["publicKey"] == str(kp.pubkey()) and isinstance(http.posts[0]["slippage"], int)
    assert out["simulate"]["rpc_ok"] is True and "InsufficientFundsForFee" in str(out["simulate"]["err"])
    assert helius.calls[0][0] == "simulateTransaction" and helius.calls[0][1][1]["sigVerify"] is True
    # a transaction built for someone else is reported, not signed
    out = asyncio.run(probe_trade_local(s, FakeHttp(bytes(_tx(Keypair(), 1))), "MINT", kp=kp))
    assert out["builds"] is True and out["signing_checks"].startswith("FAIL: remote transaction has an unexpected fee payer")
    # a non-200 answer is reported as not building
    out = asyncio.run(probe_trade_local(s, FakeHttp(b"nope", status=400), "MINT", kp=kp))
    assert out["builds"] is False and out["http"] == 400


def test_key_shape_describes_a_key_without_revealing_it():
    key = "sk-ant-api03-" + "x" * 95
    shape = key_shape(key)
    assert "an Anthropic API key" in shape and "108 chars" in shape and "xxxxx" not in shape
    assert "Admin API key" in key_shape("sk-ant-admin01-abc")
    assert "login token" in key_shape("sk-ant-oat01-abc")
    assert "not an Anthropic API key" in key_shape("sk-proj-abc")
    assert "quote characters" in key_shape('"sk-ant-api03-abc"')
    assert "line break" in key_shape("sk-ant-api03-abc\ndef")


class FakeWS:
    """Scripted websocket: each item is a message dict, an exception to raise, or nothing (block)."""

    def __init__(self, script):
        self.script, self.sent = list(script), []

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def recv(self):
        if not self.script:
            await asyncio.sleep(3600)
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return json.dumps(item)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _create(mint):
    return {"txType": "create", "mint": mint, "pool": "pump", "bondingCurveKey": "C"}


def test_capture_stream_reconnects_and_resubscribes_after_a_drop(monkeypatch):
    conns = [FakeWS([_create("A"), websockets.ConnectionClosedError(None, None)]), FakeWS([_create("B")])]
    opened = []

    def connect(url, **kw):
        opened.append(url)
        return conns[len(opened) - 1]

    monkeypatch.setattr("bot.preflight.websockets.connect", connect)
    cap = asyncio.run(capture_stream("wss://pumpportal.test", seconds=2.0))
    assert [c["mint"] for c in cap["creates"]] == ["A", "B"] and len(opened) == 2
    assert cap["reconnects"] == 1 and len(cap["drops"]) == 1 and "ConnectionClosedError" in cap["drops"][0]
    assert {"method": "subscribeTokenTrade", "keys": ["A"]} in conns[1].sent  # kept watching A's trades
    st = summarize_stream(cap)
    assert st["launches"] == 2 and st["reconnects"] == 1 and st["drops"] == cap["drops"]


def test_capture_stream_gives_up_after_max_reconnects_instead_of_raising(monkeypatch):
    def connect(url, **kw):
        raise OSError("connection refused")

    monkeypatch.setattr("bot.preflight.websockets.connect", connect)
    cap = asyncio.run(capture_stream("wss://pumpportal.test", seconds=30, max_reconnects=2))
    assert cap["creates"] == [] and cap["reconnects"] == 2 and len(cap["drops"]) == 3
    assert summarize_stream(cap)["launches"] == 0


def test_render_prints_the_stream_line_with_and_without_drops():
    checks = [Check("anthropic", "fail", "401; stored key shape: sk-ant-api... (an Anthropic API key), 108 chars", True)]
    quiet = summarize_stream({"creates": [_create("A")], "trades": {}, "seconds": 150})
    text = render(checks, {"stream": quiet, "assumptions": {"pumpportal_stream_stayed_up": True}})
    assert "FAIL  anthropic" in text and "(required)" in text
    assert "1 launches (0.4/min), 0 migrations, 0 trades for 0 subscribed launches, 0 reconnects" in text
    assert "after drops" not in text and "pumpportal_stream_stayed_up: True" in text
    dropped = summarize_stream({"creates": [], "trades": {}, "seconds": 150, "reconnects": 2,
                                "drops": ["40s: ConnectionClosedError: no close frame received or sent"]})
    text = render([], {"stream": dropped, "assumptions": {}})
    assert "2 reconnects after drops ['40s: ConnectionClosedError" in text


def test_run_checks_only_runs_the_named_checks_and_merge_retry_keeps_both_messages():
    s = SimpleNamespace(DEXSCREENER_URL="", DEX_TOKENS_RPS=1, DEX_BOOSTS_RPS=1, RUGCHECK_URL="", RUGCHECK_RPS=1,
                        is_live=False, PUMPPORTAL_TRADE_STREAM="off", X_BEARER_TOKEN="", PUMPPORTAL_API_KEY="")
    rows = asyncio.run(run_checks(s, http=None, only={"x api", "pumpportal trade stream"}))  # no network calls
    assert [c.name for c in rows] == ["x api", "pumpportal trade stream"]
    assert rows[0].status == "warn" and rows[1].status == "skip"
    first = [Check("rugcheck", "fail", "HTTP 400", True), Check("anthropic", "fail", "401", True),
             Check("helius", "pass", "ok", True)]
    merged = merge_retry(first, [Check("rugcheck", "pass", "BONK report", True)])
    assert merged[0].status == "pass" and "passed on retry" in merged[0].detail
    assert merged[1] == first[1] and merged[2] == first[2]
    twice = merge_retry(first, [Check("rugcheck", "fail", "HTTP 400 again", True)])
    assert twice[0].status == "fail" and "HTTP 400 | retry: HTTP 400 again" in twice[0].detail


def test_required_failures_are_retried_once_except_the_anthropic_key(monkeypatch):
    calls = []

    async def fake_run_checks(s, http, need_llm=True, only=None):
        calls.append(only)
        if only is None:
            return [Check("dexscreener: SOL/USD", "fail", "no wSOL pair price", True),
                    Check("rugcheck", "fail", "HTTP 400", True),
                    Check("anthropic", "fail", "401", True),
                    Check("news feeds", "fail", "0 headlines", False)]
        return [Check(name, "pass", "ok", True) for name in sorted(only)]

    monkeypatch.setattr(preflight, "run_checks", fake_run_checks)
    rows = asyncio.run(run_checks_with_retry(None, None, pause=0))
    assert calls == [None, {"dexscreener: SOL/USD", "rugcheck"}]  # anthropic and optional rows are not retried
    by = {c.name: c for c in rows}
    assert by["dexscreener: SOL/USD"].status == "pass" and by["rugcheck"].status == "pass"
    assert by["anthropic"].status == "fail" and by["news feeds"].status == "fail"
