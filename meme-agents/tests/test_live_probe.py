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
from bot.preflight import capture_stream, key_shape, probe_trade_local, summarize_stream


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
