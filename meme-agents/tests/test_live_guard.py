import asyncio

import pytest
from solders.keypair import Keypair

from bot.live.guard import LiveRefused, check_live_startup, static_checks


def live(s, **kw):
    s.MODE = "live"
    s.LIVE_CONFIRM = "I_ACCEPT_LOSSES"
    s.WALLET_PRIVATE_KEY = str(Keypair())
    s.HELIUS_API_KEY = "k"
    s.ANTHROPIC_API_KEY = "k"
    for k, v in kw.items():
        setattr(s, k, v)
    return s


def bal(x):
    async def f(pubkey):
        return x
    return f


def test_paper_mode_needs_nothing(s):
    assert static_checks(s) is None
    assert asyncio.run(check_live_startup(s, bal(100))) is None


def test_live_passes_with_everything_and_small_balance(s):
    kp = asyncio.run(check_live_startup(live(s), bal(0.5)))
    assert kp is not None


@pytest.mark.parametrize("field,value,msg", [
    ("LIVE_CONFIRM", "", "LIVE_CONFIRM"),
    ("LIVE_CONFIRM", "yes", "LIVE_CONFIRM"),
    ("WALLET_PRIVATE_KEY", "", "WALLET_PRIVATE_KEY is not set"),
    ("WALLET_PRIVATE_KEY", "not-a-key", "does not parse"),
    ("HELIUS_API_KEY", "", "HELIUS_API_KEY"),
    ("ANTHROPIC_API_KEY", "", "ANTHROPIC_API_KEY"),
])
def test_live_refuses_missing_requirements(s, field, value, msg):
    with pytest.raises(LiveRefused, match=msg):
        asyncio.run(check_live_startup(live(s, **{field: value}), bal(0.1)))


def test_live_refuses_balance_over_limit(s):
    with pytest.raises(LiveRefused, match="0.5"):
        asyncio.run(check_live_startup(live(s), bal(0.5001)))


def test_live_refuses_when_balance_unreadable(s):
    async def boom(pubkey):
        raise ConnectionError("rpc down")
    with pytest.raises(LiveRefused, match="balance"):
        asyncio.run(check_live_startup(live(s), boom))


def test_unknown_mode_refused(s):
    s.MODE = "yolo"
    with pytest.raises(LiveRefused):
        static_checks(s)


def test_refusal_never_contains_private_key(s):
    secret = str(Keypair())
    with pytest.raises(LiveRefused) as e:
        asyncio.run(check_live_startup(live(s, WALLET_PRIVATE_KEY=secret, LIVE_CONFIRM="no"), bal(0.1)))
    assert secret not in str(e.value)


def test_json_array_key_accepted(s):
    kp = Keypair()
    s = live(s, WALLET_PRIVATE_KEY=str(list(bytes(kp))))
    assert str(static_checks(s).pubkey()) == str(kp.pubkey())


# A failed live check no longer ends the process: tests/test_live_lock.py covers the lock through
# the simulated engine (a real Engine.setup would reach DexScreener here).
