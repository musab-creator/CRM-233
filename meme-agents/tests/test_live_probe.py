"""check_transaction (the live executor's pre-signing checks) on realistic transactions, and the
preflight probe that runs a genuine PumpPortal transaction through them."""
import asyncio
from types import SimpleNamespace

import pytest
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction

from bot.live.executor import LiveExecutionError, check_transaction
from bot.preflight import probe_trade_local


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
