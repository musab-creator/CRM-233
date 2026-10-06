"""CLI.

    python -m bot                 run the bot (same as `run`)
    python -m bot run [--minutes N]
    python -m bot report [--day YYYY-MM-DD]
    python -m bot simulate [--minutes N] [--seed S]
    python -m bot status [--sim] [--check [--alert]]   what the bot is doing right now
    python -m bot preflight [--probe] [--seconds N] [--no-llm]   are the APIs and keys working?
    python -m bot acceptance [--minutes 60] [--sim] [--no-llm]   the brief's "Done when" test
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


async def _status(s, check: bool = False, alert: bool = False) -> int:
    from .db import Database
    from .status import build_status, health
    path = s.path(s.DB_PATH)
    if not path.exists():
        print(f"{'DOWN: ' if check else ''}no database at {path}; run the bot first", file=sys.stderr)
        return 1
    db = await Database(path).open()
    try:
        if not check:
            print(await build_status(db, s))
            return 0
        state, line = await health(db, s)
    finally:
        await db.close()
    print(f"{state}: {line}")
    if alert:
        await _alert_on_change(s, state, line)
    return 0 if state in ("OK", "PAUSED") else 1  # DEGRADED, DOWN and BLIND page you


async def _alert_on_change(s, state: str, line: str) -> None:
    """Telegram message when the health state changes (kept in <db>.health), not on every check."""
    import httpx

    from .telegram import Telegram
    marker = s.path(s.DB_PATH).with_suffix(".health")
    before = marker.read_text().strip() if marker.exists() else "OK"
    if state == before:
        return
    async with httpx.AsyncClient(timeout=15) as http:
        tg = Telegram(http, s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID)
        if tg.enabled:
            await tg.send(f"meme-agents health: {before} -> {state}\n{line}")
    marker.write_text(state)


async def _preflight(s, probe: bool, seconds: float, no_llm: bool) -> int:
    from .preflight import run_preflight
    return await run_preflight(s, probe, seconds, need_llm=not no_llm)


async def _acceptance(minutes: float, sim: bool, seed: int, no_llm: bool) -> int:
    from .acceptance import run_acceptance
    if sim:
        from .sim import SIM_OVERRIDES, build_sim_engine
        s = load_settings(overrides=SIM_OVERRIDES)
        return await run_acceptance(s, minutes, lambda st: build_sim_engine(st, seed), no_llm=no_llm,
                                    install_signals=_install_signals)
    from .engine import Engine
    s = load_settings()
    if not s.ANTHROPIC_API_KEY and not no_llm:
        print("ANTHROPIC_API_KEY is not set: add it to .env, or pass --no-llm for a run without the agents "
              "(the decision-cycle check is then skipped)", file=sys.stderr)
        return 2
    return await run_acceptance(s, minutes, Engine, no_llm=no_llm, install_signals=_install_signals)


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
    st.add_argument("--check", action="store_true", help="one line for monitoring; exit 1 if down or blind")
    st.add_argument("--alert", action="store_true", help="with --check: Telegram message when the state changes")
    pf = sub.add_parser("preflight", help="check every API and key (free calls only)")
    pf.add_argument("--probe", action="store_true", help="also record what the live APIs return (~3 min)")
    pf.add_argument("--seconds", type=float, default=150, help="probe capture length")
    pf.add_argument("--no-llm", action="store_true", help="do not require ANTHROPIC_API_KEY")
    ac = sub.add_parser("acceptance", help="run paper mode for N minutes and check the brief's done criteria")
    ac.add_argument("--minutes", type=float, default=60)
    ac.add_argument("--sim", action="store_true", help="against the offline simulator (tests the harness)")
    ac.add_argument("--seed", type=int, default=7)
    ac.add_argument("--no-llm", action="store_true", help="run without ANTHROPIC_API_KEY (result INCOMPLETE)")
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
    setup_logging(s.LOG_LEVEL, s.path(s.LOG_FILE) if s.LOG_FILE and cmd in ("run", "simulate", "acceptance") else None)
    if cmd == "run":
        return asyncio.run(_run(getattr(a, "minutes", None)))
    if cmd == "report":
        return asyncio.run(_report(a.day, a.sim))
    if cmd == "simulate":
        return asyncio.run(_simulate(a.minutes, a.seed))
    if cmd == "live-check":
        return asyncio.run(_live_check())
    if cmd == "status":
        return asyncio.run(_status(s, a.check, a.alert))
    if cmd == "preflight":
        return asyncio.run(_preflight(s, a.probe, a.seconds, a.no_llm))
    if cmd == "acceptance":
        return asyncio.run(_acceptance(a.minutes, a.sim, a.seed, a.no_llm))
    p.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
