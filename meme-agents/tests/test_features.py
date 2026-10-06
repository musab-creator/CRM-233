import pytest

from bot.features import flow_features

T0 = 1_800_000_000.0
DEV = "DEV"


def tr(ts, side, who, sol, price=1e-7):
    return {"ts": T0 + ts, "side": side, "trader": who, "sol": sol, "tokens": sol / price, "price_sol": price}


def organic():
    t = [tr(0, "buy", DEV, 1.0)]
    for i in range(30):  # 30 buyers, varied sizes, spread over 10 minutes
        t.append(tr(20 + i * 20, "buy", f"w{i}", 0.1 + 0.037 * i, price=1e-7 * (1 + i / 30)))
    t.append(tr(500, "sell", "w3", 0.05, price=1.9e-7))
    return t


def engineered():
    t = [tr(0, "buy", DEV, 2.0)]
    snipes = [5.0, 4.6, 5.3]
    t += [tr(2, "buy", f"sniper{i}", snipes[i]) for i in range(3)]        # 14.9 SOL in the first seconds
    t += [tr(30 + i * 0.5, "buy", f"bundle{i}", 0.777) for i in range(5)]  # same size, 2.5 s apart
    t += [tr(100 + i * 10, "buy", f"late{i}", 0.2 + 0.03 * i) for i in range(4)]
    t += [tr(200, "sell", f"sniper{i}", 6.0) for i in range(3)]            # snipers dump everything
    t += [tr(210, "sell", DEV, 1.9)]
    t = sorted(t, key=lambda x: x["ts"])
    # the sells must carry the token amounts bought, at a higher price
    for x in t:
        if x["side"] == "sell" and x["trader"].startswith("sniper"):
            x["tokens"] = snipes[int(x["trader"][-1])] / 1e-7
        if x["side"] == "sell" and x["trader"] == DEV:
            x["tokens"] = 2.0 / 1e-7
    return t


def test_empty():
    assert flow_features([], DEV, T0) == {"trades": 0}


def test_organic_launch_looks_organic():
    f = flow_features(organic(), DEV, T0 + 620)
    assert f["distinct_buyers_ex_dev"] == 30
    assert f["sniper_top3_share"] < 0.05
    assert f["bundle_like_buy_share"] == 0
    assert f["early_buyer_retention"] == 1.0  # w3 sold only a sliver
    assert f["dev_sold_pct_of_bought"] == 0
    assert f["dev_holding_pct_supply"] == pytest.approx(1.0 / 1e-7 / 1e9 * 100, rel=1e-3)
    assert f["effective_buyers"] > 20
    assert f["price_change_since_launch_pct"] > 0


def test_engineered_launch_is_flagged():
    f = flow_features(engineered(), DEV, T0 + 300)
    total_ex_dev = 14.9 + 5 * 0.777 + (0.2 + 0.23 + 0.26 + 0.29)
    assert f["sniper_top3_share"] == pytest.approx(14.9 / total_ex_dev, abs=1e-4)
    assert f["snipers_still_holding"] == "0/3"
    assert f["bundle_like_buy_share"] == pytest.approx(5 / 12, abs=1e-4)
    assert f["max_same_size_cluster_wallets"] == 5
    assert f["dev_sold_pct_of_bought"] == 100.0
    assert f["dev_holding_pct_supply"] == 0
    assert f["early_buyers_exited"] == "3/12"
    assert f["top5_buyer_share"] > 0.8
    # window is (now-300, now]: the dev's buy at exactly t=0 falls outside it
    assert f["net_flow_sol_5m"] == pytest.approx(total_ex_dev - 18.0 - 1.9, abs=1e-3)


def test_bundle_needs_three_wallets_close_in_time():
    t = [tr(0, "buy", "a", 0.5), tr(1, "buy", "b", 0.5), tr(60, "buy", "c", 0.5), tr(61, "buy", "a", 0.5)]
    assert flow_features(t, DEV, T0 + 100)["bundle_like_buy_share"] == 0
    t.append(tr(1.5, "buy", "d", 0.5))
    t.sort(key=lambda x: x["ts"])
    f = flow_features(t, DEV, T0 + 100)
    assert f["bundle_like_buy_share"] == pytest.approx(3 / 5) and f["max_same_size_cluster_wallets"] == 3


def test_momentum_windows():
    t = [tr(0, "buy", "a", 1.0), tr(400, "buy", "b", 2.0), tr(700, "sell", "a", 0.5), tr(750, "buy", "c", 3.0)]
    f = flow_features(t, DEV, T0 + 800)
    assert f["buy_sol_5m"] == 3.0 and f["sell_sol_5m"] == 0.5 and f["net_flow_sol_prev_5m"] == 2.0
    assert f["buy_sell_ratio_5m"] == 6.0 and f["traders_5m"] == 2
