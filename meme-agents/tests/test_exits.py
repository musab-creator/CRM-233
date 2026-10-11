import pytest

from bot.exits import ExitState, check_exit

T0 = 1_800_000_000.0
E = 1e-7


def st(tp=False, peak=E, liq=10_000.0):
    return ExitState(entry_price=E, peak_price=peak, tp_done=tp, opened_at=T0, entry_liq_usd=liq)


def test_hold_inside_band(s):
    assert check_exit(st(), E * 1.2, T0 + 60, s) is None
    assert check_exit(st(), E * 0.71, T0 + 60, s) is None


def test_stop_loss_at_minus_30(s):
    """11 Oct: -40% filled near -47% after the paper costs, and the coins that doubled had never dipped
    below -20% first, so the default stop is -30%."""
    assert s.STOP_LOSS_PCT == 30
    sig = check_exit(st(), E * 0.70, T0 + 60, s)
    assert sig.reason == "stop_loss" and sig.fraction == 1.0


def test_take_profit_sells_half_at_plus_60(s):
    assert check_exit(st(), E * 1.599, T0, s) is None
    sig = check_exit(st(), E * 1.60, T0, s)
    assert sig.reason == "take_profit" and sig.fraction == 0.5


def test_the_trailing_stop_runs_before_the_take_profit_once_the_coin_has_run(s):
    """11 Oct: 69% of the shadows left by the stop loss or the liquidity rule at a median -41%, many
    after being well up first. Once the peak is TRAILING_ARM_PCT (30%) above the entry, a fall of
    TRAILING_STOP_PCT from it sells everything as early_trailing_stop; below the arm level nothing
    changes, and the stop loss still comes first on the same tick."""
    assert s.TRAILING_ARM_PCT == 30
    assert check_exit(st(peak=E * 1.5), E * 1.06, T0, s) is None
    sig = check_exit(st(peak=E * 1.5), E * 1.04, T0, s)
    assert sig.reason == "early_trailing_stop" and sig.fraction == 1.0
    assert check_exit(st(peak=E * 1.29), E * 0.71, T0, s) is None             # not armed: no trail yet
    assert check_exit(st(peak=E * 1.29), E * 0.70, T0, s).reason == "stop_loss"
    assert check_exit(st(peak=E * 1.3), E * 1.3, T0, s) is None               # a new peak never sells
    assert check_exit(st(peak=E * 1.3), E * 0.70, T0, s).reason == "stop_loss"
    assert check_exit(st(peak=E * 1.3), E * 0.90, T0, s).reason == "early_trailing_stop"
    s.TRAILING_ARM_PCT = 0                                                     # the old rule
    assert check_exit(st(peak=E * 1.5), E * 1.04, T0, s) is None
    # after TP: 30% from peak, the planned trailing stop
    assert check_exit(st(tp=True, peak=E * 2), E * 1.41, T0, s) is None
    sig = check_exit(st(tp=True, peak=E * 2), E * 1.40, T0, s)
    assert sig.reason == "trailing_stop" and sig.fraction == 1.0


def test_the_early_trail_arms_below_the_take_profit_and_sells_with_the_urgent_fee(s):
    from bot.config import ConfigError, validate_settings
    from bot.positions import urgent_exit
    s.TRAILING_ARM_PCT = 60
    with pytest.raises(ConfigError, match="TRAILING_ARM_PCT must be below TAKE_PROFIT_PCT"):
        validate_settings(s)
    s.TRAILING_ARM_PCT = 59.9
    validate_settings(s)
    s.TRAILING_ARM_PCT = 0
    validate_settings(s)
    assert urgent_exit("early_trailing_stop") and urgent_exit("stop_loss") and not urgent_exit("trailing_stop")


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
