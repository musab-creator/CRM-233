from bot.exits import ExitState, check_exit

T0 = 1_800_000_000.0
E = 1e-7


def st(tp=False, peak=E, liq=10_000.0):
    return ExitState(entry_price=E, peak_price=peak, tp_done=tp, opened_at=T0, entry_liq_usd=liq)


def test_hold_inside_band(s):
    assert check_exit(st(), E * 1.2, T0 + 60, s) is None
    assert check_exit(st(), E * 0.61, T0 + 60, s) is None


def test_stop_loss_at_minus_40(s):
    sig = check_exit(st(), E * 0.60, T0 + 60, s)
    assert sig.reason == "stop_loss" and sig.fraction == 1.0


def test_take_profit_sells_half_at_plus_60(s):
    assert check_exit(st(), E * 1.599, T0, s) is None
    sig = check_exit(st(), E * 1.60, T0, s)
    assert sig.reason == "take_profit" and sig.fraction == 0.5


def test_trailing_only_after_tp(s):
    # before TP a 30% pullback from a peak is not an exit
    assert check_exit(st(peak=E * 1.5), E * 1.04, T0, s) is None
    # after TP: 30% from peak
    assert check_exit(st(tp=True, peak=E * 2), E * 1.41, T0, s) is None
    sig = check_exit(st(tp=True, peak=E * 2), E * 1.40, T0, s)
    assert sig.reason == "trailing_stop" and sig.fraction == 1.0


def test_time_stop_6h(s):
    assert check_exit(st(), E, T0 + 6 * 3600 - 1, s) is None
    assert check_exit(st(), E, T0 + 6 * 3600, s).reason == "time_stop"
    assert check_exit(st(), None, T0 + 6 * 3600, s).reason == "time_stop"


def test_emergency_liquidity_drop_50(s):
    assert check_exit(st(), E, T0, s, liq_usd=5_001) is None
    assert check_exit(st(), E, T0, s, liq_usd=5_000).reason == "emergency_liquidity_drop"
    assert check_exit(st(liq=None), E, T0, s, liq_usd=1) is None


def test_emergency_rugcheck_danger_beats_everything(s):
    sig = check_exit(st(), E * 3, T0, s, rug_danger=True)
    assert sig.reason == "emergency_rugcheck_danger" and sig.fraction == 1.0


def test_exit_thresholds_are_config(s):
    s.STOP_LOSS_PCT = 20
    assert check_exit(st(), E * 0.79, T0, s).reason == "stop_loss"
