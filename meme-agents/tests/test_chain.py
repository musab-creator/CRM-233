"""On-chain data path: curve decoding, trades rebuilt from transactions, holder snapshots,
chain flow features, curve ticks, Helius batching/paging and the paid-stream budget."""
import asyncio
import base64

import pytest

from bot.config import ConfigError, load_settings
from bot.db import Database
from bot.features import chain_features
from bot.feeds.pumpchain import (CURVE_DISCRIMINATOR, Curve, HeliusChain, decode_curve, encode_curve,
                                 holder_snapshot, trades_from_tx)
from bot.ingest import Ingestor

MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJospump"
CURVE = "So11111111111111111111111111111111111111112"
DEV = "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
A, B = "Aaaa1111111111111111111111111111111111111111", "Bbbb2222222222222222222222222222222222222222"


def test_curve_round_trip_and_rejects_other_accounts():
    c = Curve(v_tokens=900_000_000.0, v_sol=35.766666, real_tokens=620_100_000.0, real_sol=5.766666,
              supply=1e9, complete=False, creator=DEV)
    d = decode_curve(encode_curve(c))
    assert d.real_sol == pytest.approx(5.766666) and d.v_tokens == pytest.approx(9e8) and d.creator == DEV
    assert d.price_sol == pytest.approx(35.766666 / 9e8) and not d.complete
    # 49-byte accounts from before the creator field still decode
    assert decode_curve(encode_curve(Curve(1e9, 30, 7e8, 0, 1e9, True))) == Curve(1e9, 30, 7e8, 0, 1e9, True)
    assert decode_curve(b"\x00" * 81) is None and decode_curve(None) is None
    assert decode_curve(CURVE_DISCRIMINATOR + b"\x00" * 10) is None


def _tx(keys, pre, post, pre_tok, post_tok, err=None, loaded=None, slot=7, ts=1_700_000_000):
    meta = {"err": err, "preBalances": pre, "postBalances": post,
            "preTokenBalances": pre_tok, "postTokenBalances": post_tok}
    if loaded:
        meta["loadedAddresses"] = loaded
    return {"slot": slot, "blockTime": ts, "meta": meta,
            "transaction": {"signatures": ["SIG1"], "message": {"accountKeys": keys}}}


def _bal(i, owner, raw, mint=MINT):
    return {"accountIndex": i, "mint": mint, "owner": owner, "uiTokenAmount": {"amount": str(raw), "decimals": 6}}


def test_trades_from_tx_buy_sell_and_non_trades():
    # A buys: 1.0 SOL into the curve, 30M tokens out of the curve's token account to A
    buy = _tx([A, CURVE, "ATA"], [5_000_000_000, 10_000_000_000, 0], [3_990_000_000, 11_000_000_000, 0],
              [_bal(2, CURVE, 800_000_000_000_000)],
              [_bal(2, CURVE, 770_000_000_000_000), _bal(3, A, 30_000_000_000_000)])
    (t,) = trades_from_tx(buy, MINT, CURVE)
    assert (t["side"], t["trader"], t["slot"], t["ts"]) == ("buy", A, 7, 1_700_000_000.0)
    assert t["sol"] == pytest.approx(1.0) and t["tokens"] == pytest.approx(30_000_000)
    assert t["price_sol"] == pytest.approx(1.0 / 30_000_000)
    # B sells half its bag: 0.4 SOL leaves the curve
    sell = _tx([B, CURVE], [1, 11_000_000_000], [1, 10_600_000_000],
               [_bal(3, B, 20_000_000_000_000)], [_bal(3, B, 10_000_000_000_000)])
    (s,) = trades_from_tx(sell, MINT, CURVE)
    assert s["side"] == "sell" and s["trader"] == B and s["sol"] == pytest.approx(0.4)
    # the curve sits behind an address lookup table (v0 transaction)
    v0 = _tx([A], [5, 10_000_000_000], [4, 10_500_000_000], [], [_bal(5, A, 1_000_000)],
             loaded={"writable": [CURVE], "readonly": []})
    assert trades_from_tx(v0, MINT, CURVE)[0]["sol"] == pytest.approx(0.5)
    assert trades_from_tx({**buy, "meta": {**buy["meta"], "err": {"Custom": 1}}}, MINT, CURVE) == []
    assert trades_from_tx(buy, MINT, "NotInTx") == []
    # a wallet-to-wallet transfer moves tokens but no curve SOL
    transfer = _tx([A, CURVE], [5, 7], [5, 7], [_bal(1, A, 10)], [_bal(1, A, 0), _bal(2, B, 10)])
    assert trades_from_tx(transfer, MINT, CURVE) == []
    # another mint's balances are ignored
    other = _tx([A, CURVE], [5, 7], [5, 1_000_000_007], [], [_bal(2, A, 10, mint="Other")])
    assert trades_from_tx(other, MINT, CURVE) == []


def test_holder_snapshot_excludes_curve_and_counts_emptied_accounts():
    rows = [{"owner": CURVE, "amount": 700_000_000_000_000}, {"owner": DEV, "amount": 10_000_000_000_000},
            {"owner": A, "amount": 5_000_000}, {"owner": A, "amount": 1_000_000}, {"owner": B, "amount": 0}]
    h = holder_snapshot(rows, CURVE, DEV)
    assert h["wallets_ex_dev"] == 2 and h["holders_ex_dev"] == 1
    assert h["creator_tokens"] == pytest.approx(10_000_000) and h["by_owner"][A] == pytest.approx(6.0)
    assert CURVE not in h["by_owner"]


def test_chain_features_never_guess_missing_data():
    early = [{"ts": 100, "slot": 5, "side": "buy", "trader": DEV, "sol": 1, "tokens": 3e7},
             {"ts": 100, "slot": 5, "side": "buy", "trader": A, "sol": 2, "tokens": 6e7}]
    f = chain_features(early, True, None, DEV, [], None, 400, 100)
    assert f["source"] == "chain" and f["same_slot_as_launch_buyers"] == 1
    for k in ("snipers_still_holding", "early_buyer_retention", "dev_sold_pct_of_bought", "effective_holders",
              "net_flow_sol_5m", "price_change_5m_pct", "drawdown_from_peak_pct"):
        assert f[k] is None, k
    assert chain_features(early + [{"ts": None, "slot": 9, "side": "buy", "trader": B, "sol": 1, "tokens": 1e6}],
                          True, None, DEV, [], None, 400, 100)["launch_minute_trades"] == 2
    # an incomplete holder snapshot cannot say a missing wallet sold out
    f = chain_features(early, True, {"by_owner": {}, "complete": False, "creator_tokens": 0.0}, DEV, [], 3, 400, 100)
    assert f["early_buyer_retention"] is None and f["dev_sold_pct_of_bought"] == 100.0
    # percentages use the token's own supply (Mayhem Mode tokens have 2B)
    h = {"by_owner": {DEV: 2e7}, "complete": True, "creator_tokens": 2e7}
    assert chain_features(early, True, h, DEV, [], 3, 400, 100)["dev_holding_pct_supply"] == 2.0
    assert chain_features(early, True, h, DEV, [], 3, 400, 100, supply=2e9)["dev_holding_pct_supply"] == 1.0


def test_apply_curve_ticks_only_when_the_curve_moved(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        ing = Ingestor(s, db)
        ticks = []

        async def h(mint, price, ts, msg):
            ticks.append((price, msg["txType"]))
        ing.tick_handlers.append(h)
        await ing.handle({"txType": "create", "mint": MINT, "traderPublicKey": DEV, "bondingCurveKey": CURVE,
                          "solAmount": 1.0, "initialBuy": 3.4e7, "vSolInBondingCurve": 31.0,
                          "vTokensInBondingCurve": 1.039e9}, ts=1000)
        st = ing.mints[MINT]
        assert st.net_inflow_sol == 1.0 and st.next_poll_at == 1000 + s.CURVE_FIRST_POLL_S
        c1 = Curve(1.0e9, 32.19, 7.2e8, 2.19, 1e9, False)
        assert await ing.apply_curve(MINT, c1, 1060) is False      # first read: no earlier state to compare
        assert await ing.apply_curve(MINT, c1, 1075) is False      # unchanged: no trade happened
        c2 = Curve(9.0e8, 35.77, 6.2e8, 5.77, 1e9, False)
        assert await ing.apply_curve(MINT, c2, 1090) is True
        assert ticks == [(pytest.approx(35.77 / 9e8), "curve")]
        assert st.net_inflow_sol == pytest.approx(5.77) and st.last_trade_at == 1090 and len(st.snapshots) == 3
        # graduation: the emptied curve must not erase the inflow the token reached
        await ing.apply_curve(MINT, Curve(0, 0, 0, 0, 1e9, True), 1200)
        assert st.graduated and st.net_inflow_sol == pytest.approx(5.77) and len(ticks) == 1
        ing.apply_holders(MINT, {"wallets_ex_dev": 52, "holders_ex_dev": 40}, 1210)
        assert st.unique_buyers == 52 and st.holders_now == 40
        await ing.handle({"txType": "migrate", "mint": MINT, "pool": "pump-amm"})
        assert st.pool == "pump-amm"
        # PumpPortal also announces other launchpads' tokens: they are not pump.fun curves
        await ing.handle({"txType": "create", "mint": "B" * 44, "pool": "bonk", "bondingCurveKey": "X"}, ts=1300)
        assert "B" * 44 not in ing.mints and ing.stats["other_launchpads"] == 1
        # ... and creates without a bonding curve (seen live) are not curve launches either
        await ing.handle({"txType": "create", "mint": "C" * 44, "pool": "pump"}, ts=1300)
        assert "C" * 44 not in ing.mints and ing.stats["other_launchpads"] == 2
        await ing.handle({"txType": "create", "mint": "D" * 44, "pool": "pump", "bondingCurveKey": "K",
                          "is_mayhem_mode": True, "solAmount": 0, "initialBuy": 0}, ts=1300)
        assert ing.mints["D" * 44].mayhem
        await ing.apply_curve("D" * 44, Curve(1.0e9, 32.19, 7.2e8, 2.19, 2e9, False), 1310)
        assert ing.mints["D" * 44].supply == 2e9 and ing.mints["D" * 44].row()["mayhem"] == 1
        await db.close()
    asyncio.run(go())


class FakeRpc:
    key = "k"

    def __init__(self, sig_pages=None, txs=None, das_rejects_options=False):
        self.calls = []
        self.sig_pages = list(sig_pages or [])
        self.txs = txs or {}
        self.das_rejects_options = das_rejects_options

    async def rpc(self, method, params):
        self.calls.append((method, params))
        if method == "getMultipleAccounts":
            data = base64.b64encode(encode_curve(Curve(1e9, 32.19, 7.2e8, 2.19, 1e9, False))).decode()
            return {"value": [{"data": [data, "base64"]} if k != "missing" else None for k in params[0]]}
        if method == "getSignaturesForAddress":
            return self.sig_pages.pop(0) if self.sig_pages else []
        if method == "getTransaction":
            return self.txs.get(params[0])
        raise AssertionError(method)

    async def das(self, method, params):
        self.calls.append((method, params))
        if self.das_rejects_options and "options" in params:
            raise RuntimeError("invalid params: options")
        return {"token_accounts": [{"owner": A, "amount": 5}, {"owner": CURVE, "amount": 9}]}


def test_helius_chain_batches_curves_by_100():
    rpc = FakeRpc()
    out = asyncio.run(HeliusChain(rpc).curves([f"k{i}" for i in range(150)] + ["missing"]))
    assert [len(p[0]) for m, p in rpc.calls] == [100, 51]
    assert out["k0"].real_sol == pytest.approx(2.19) and out["missing"] is None


def test_helius_chain_holders_falls_back_without_das_options():
    rpc = FakeRpc(das_rejects_options=True)
    chain = HeliusChain(rpc)
    h = asyncio.run(chain.holders(MINT, CURVE, DEV))
    assert h["wallets_ex_dev"] == 1 and h["complete"]
    assert "options" in rpc.calls[0][1] and "options" not in rpc.calls[1][1] and not chain._das_options


def test_helius_chain_early_trades_pages_to_launch_and_keeps_the_first_minute():
    newest = [{"signature": f"s{i}", "slot": 5000 - i, "blockTime": 5000 - i, "err": None} for i in range(1000)]
    oldest = [{"signature": "late", "slot": 900, "blockTime": 1061, "err": None},
              {"signature": "fail", "slot": 850, "blockTime": 1030, "err": {"x": 1}},
              {"signature": "first", "slot": 800, "blockTime": 1000, "err": None}]
    first = _tx([A, CURVE], [5, 0], [4, 1_000_000_000], [], [_bal(2, A, 3_000_000)], slot=800, ts=1000)
    rpc = FakeRpc(sig_pages=[newest, oldest], txs={"first": first})
    out = asyncio.run(HeliusChain(rpc).early_trades(MINT, CURVE, window_s=60))
    assert out["reached_launch"] and out["transactions"] == 1          # "late" is outside the minute
    assert [t["trader"] for t in out["trades"]] == [A]
    assert rpc.calls[1][1][1]["before"] == "s999"                        # paged back from the oldest seen
    # too many transactions to reach the launch: say so rather than call the wrong trades "first"
    rpc = FakeRpc(sig_pages=[newest] * 3)
    out = asyncio.run(HeliusChain(rpc).early_trades(MINT, CURVE, max_pages=2))
    assert not out["reached_launch"] and out["trades"] == []


def test_stream_mode_is_validated(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(tmp_path / "none.env", overrides={"PUMPPORTAL_TRADE_STREAM": "everything"})


def test_paid_stream_stops_at_its_daily_budget(tmp_path):
    from bot.sim import SIM_OVERRIDES, build_sim_engine
    s = load_settings(overrides=dict(SIM_OVERRIDES, DB_PATH=str(tmp_path / "b.db"), LOG_FILE="",
                                     PUMPPORTAL_TRADE_STREAM="all", PUMPPORTAL_DAILY_BUDGET_SOL="0.00005"))
    eng = build_sim_engine(s, seed=5, launch_every_s=1.0)

    async def go():
        await eng.db.open()
        try:
            await check()
        finally:
            await eng.db.close()
            await eng.http.aclose()

    async def check():
        eng.ingest.stream_new_tokens = True
        await eng.feed.subscribe_tokens([MINT])
        eng.ingest.stats["stream_trades"] = 49
        await eng._check_stream_budget()
        assert eng._stream_ok() and eng.feed.token_keys == {MINT}
        eng.ingest.stats["stream_trades"] = 50                            # 50 x 1e-6 SOL = the budget
        await eng._check_stream_budget()
        assert not eng._stream_ok() and not eng.feed.token_keys and not eng.ingest.stream_new_tokens
        eng._pin("Another", True)
        await asyncio.sleep(0)
        assert not eng.feed.token_keys                                     # nothing re-subscribes
    asyncio.run(go())
