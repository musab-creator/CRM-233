"""A confirmed buy's receipt is judged against the same spend allowance the transaction was
simulated against: amount, percentage fees, network fee and token-account rent. The first live
buy (8 Oct) paid all of those, passed simulation, confirmed on chain, and was then refused by a
receipt check that still allowed only amount + network fee, leaving tokens in the wallet with the
position stuck pending."""
import asyncio
import json

import pytest
from solders.keypair import Keypair

from bot.db import Database
from bot.live.executor import LiveExecutionUnknown, LiveExecutor, spend_limit
from tests.test_commands import _settings
from tests.test_live_executor import FakeHttp as TxHttp
from tests.test_live_executor import FakeRpc, unsigned_tx

MINT = "MintAddr"


def _receipt(pubkey, debit_sol: float):
    pre = 1_000_000_000
    return {"transaction": {"message": {"accountKeys": [{"pubkey": pubkey}]}},
            "meta": {"err": None, "fee": 5000, "preBalances": [pre], "postBalances": [pre - round(debit_sol * 1e9)],
                     "preTokenBalances": [],
                     "postTokenBalances": [{"mint": MINT, "owner": pubkey,
                                            "uiTokenAmount": {"amount": "1000000000", "decimals": 6}}]}}


def _reconcile(tmp_path, debit_sol: float):
    s = _settings(tmp_path, MODE="live", LIVE_DRY_RUN="true")
    kp = Keypair()
    pubkey = str(kp.pubkey())

    class FakeChain:
        async def signature_status(self, sig):
            return "ok"

        async def rpc(self, method, params):
            assert method == "getTransaction" and params[0] == "sig-real"
            return _receipt(pubkey, debit_sol)

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            ex = LiveExecutor(s, db, TxHttp(unsigned_tx(kp)), kp, is_graduated=lambda m: False, chain=FakeChain())
            await ex.rpc.close()
            ex.rpc = FakeRpc()
            intent = {"signature": "sig-real", "side": "buy", "mint": MINT, "amount": 0.05, "price": 1e-7,
                      "route": "pumpportal"}
            await db.kv_set(ex._intent_key(MINT, "buy"), json.dumps(intent))
            fill = await ex.buy(MINT, 0.05, 1e-7)
            return fill, await db.kv_get(ex._intent_key(MINT, "buy"))
        finally:
            await db.close()
    return s, (lambda: asyncio.run(go()))


def test_receipt_within_the_simulated_allowance_reconciles(tmp_path):
    s = _settings(tmp_path, MODE="live", LIVE_DRY_RUN="true")
    allowed = spend_limit("buy", 0.05, s)
    assert allowed > 0.05 + s.NETWORK_FEE_SOL                     # fees and rent are part of the allowance
    # the first live buy: amount, 1.5% fees, rent for the new token account, the network fee
    debit = 0.05 * 1.015 + s.LIVE_ACCOUNT_RENT_SOL + 0.000005
    assert debit <= allowed
    _, run = _reconcile(tmp_path, debit)
    fill, intent_left = run()
    assert fill.side == "buy" and fill.tx_sig == "sig-real" and abs(fill.sol - debit) < 1e-9
    assert fill.tokens == pytest.approx(1000.0) and fill.fee_sol == pytest.approx(debit - 0.05)


def test_receipt_beyond_the_allowance_stays_quarantined(tmp_path):
    s = _settings(tmp_path, MODE="live", LIVE_DRY_RUN="true")
    _, run = _reconcile(tmp_path, spend_limit("buy", 0.05, s) + 0.001)
    with pytest.raises(LiveExecutionUnknown, match="confirmed spend exceeds the authorized SOL limit"):
        run()
