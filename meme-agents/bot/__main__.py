"""CLI.

    python -m bot                 run the bot (same as `run`)
    python -m bot run [--minutes N]
    python -m bot report [--day YYYY-MM-DD]
    python -m bot simulate [--minutes N] [--seed S]
    python -m bot status [--sim]  what the bot is doing right now
    python -m bot live-check      run the live-mode startup checks and exit
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys

from .config import load_settings
from .live.guard import LiveRefused
from .util import setup_logging

log = logging.getLogger("bot")


def _install_signals(engine) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, engine.stop.set)
        except NotImplementedError:  # Windows
            pass


async def _run(minutes: float | None) -> int:
    from .engine import Engine, StartupError
    s = load_settings()
    eng = Engine(s)
    _install_signals(eng)
    try:
        await eng.run(minutes * 60 if minutes else None)
    except LiveRefused as e:
        log.error("%s", e)
        return 2
    except StartupError as e:
        log.error("startup failed: %s", e)
        return 3
    return 0


async def _simulate(minutes: float, seed: int) -> int:
    from .sim import SIM_OVERRIDES, build_sim_engine
    s = load_settings(overrides=SIM_OVERRIDES)
    eng = build_sim_engine(s, seed)
    _install_signals(eng)
    await eng.run(minutes * 60)
    return 0


async def _report(day: str | None, sim: bool) -> int:
    from .db import Database
    from .report import write_daily
    overrides = None
    if sim:
        from .sim import SIM_OVERRIDES
        overrides = SIM_OVERRIDES
    s = load_settings(overrides=overrides)
    path = s.path(s.DB_PATH)
    if not path.exists():
        print(f"no database at {path}; run the bot first", file=sys.stderr)
        return 1
    db = await Database(path).open()
    try:
        text, out = await write_daily(db, s, day)
    finally:
        await db.close()
    print(text)
    print(f"\nwritten: {out}")
    return 0


async def _status(s) -> int:
    from .db import Database
    from .status import build_status
    path = s.path(s.DB_PATH)
    if not path.exists():
        print(f"no database at {path}; run the bot first", file=sys.stderr)
        return 1
    db = await Database(path).open()
    try:
        print(await build_status(db, s))
    finally:
        await db.close()
    return 0


async def _live_check() -> int:
    import httpx

    from .feeds.helius import Helius
    from .live.guard import check_live_startup
    s = load_settings()
    async with httpx.AsyncClient(timeout=20) as http:
        h = Helius(http, s.helius_rpc(), s.HELIUS_API_URL, s.HELIUS_API_KEY, s.HELIUS_RPC_RPS, s.HELIUS_ENHANCED_RPS)
        try:
            kp = await check_live_startup(s, h.balance_sol)
        except LiveRefused as e:
            print(e)
            return 2
    if kp is None:
        print("MODE=paper: live checks not required")
    else:
        print(f"live checks passed for wallet {kp.pubkey()} (dry_run={s.LIVE_DRY_RUN})")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m bot")
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("run", help="run the bot")
    r.add_argument("--minutes", type=float, default=None, help="stop after N minutes")
    rp = sub.add_parser("report", help="print metrics and write reports/daily-YYYY-MM-DD.md")
    rp.add_argument("--day", default=None, help="UTC day for the daily section (default today)")
    rp.add_argument("--sim", action="store_true", help="report on the simulation database")
    sm = sub.add_parser("simulate", help="offline end-to-end run with synthetic data")
    sm.add_argument("--minutes", type=float, default=10)
    sm.add_argument("--seed", type=int, default=7)
    sub.add_parser("live-check", help="run live-mode startup checks")
    st = sub.add_parser("status", help="what the bot is doing right now (safe while it runs)")
    st.add_argument("--sim", action="store_true", help="status of the simulation database")
    a = p.parse_args(argv)

    cmd = a.cmd or "run"
    from .config import ConfigError
    from .sim import SIM_OVERRIDES
    sim = cmd == "simulate" or getattr(a, "sim", False)
    try:
        s = load_settings(overrides=SIM_OVERRIDES if sim else None)
    except ConfigError as e:
        print(f"config error: {e}", file=sys.stderr)
        return 2
    # only long-running commands write the log file
    setup_logging(s.LOG_LEVEL, s.path(s.LOG_FILE) if s.LOG_FILE and cmd in ("run", "simulate") else None)
    if cmd == "run":
        return asyncio.run(_run(getattr(a, "minutes", None)))
    if cmd == "report":
        return asyncio.run(_report(a.day, a.sim))
    if cmd == "simulate":
        return asyncio.run(_simulate(a.minutes, a.seed))
    if cmd == "live-check":
        return asyncio.run(_live_check())
    if cmd == "status":
        return asyncio.run(_status(s))
    p.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
