"""CLI.

    python -m bot                 run the bot (same as `run`)
    python -m bot run [--minutes N]
    python -m bot report [--day YYYY-MM-DD]
    python -m bot simulate [--minutes N] [--seed S]
    python -m bot status [--sim] [--check [--alert]]   what the bot is doing right now
    python -m bot preflight [--probe] [--seconds N] [--no-llm]   are the APIs and keys working?
    python -m bot acceptance [--minutes 60] [--sim] [--no-llm]   the brief's "Done when" test
    python -m bot live-check      run the live-mode startup checks and exit
    python -m bot ops [--watch | --once]   run server actions queued from Telegram (the ops service)
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import math
from dataclasses import fields
from datetime import date
import signal
import sys

from .config import load_settings
from .live.guard import LiveRefused
from .util import redact, register_secrets, setup_logging

log = logging.getLogger("bot")


def _install_signals(engine) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, engine.stop.set)
        except NotImplementedError:  # Windows ProactorEventLoop has no add_signal_handler.
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(engine.stop.set))


async def _run(minutes: float | None) -> int:
    from .engine import Engine, StartupError
    s = load_settings()
    eng = Engine(s)
    _install_signals(eng)
    try:
        await eng.run(minutes * 60 if minutes is not None else None)
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
    # --no-llm must prevent API spend even when a key already exists in .env/environment.
    s = load_settings(overrides={"ANTHROPIC_API_KEY": ""} if no_llm else None)
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


def _ops(s, watch: bool, once: bool) -> int:
    """The companion service behind Telegram /update, /restart, /set and /dryrun (bot/ops.py)."""
    from .ops import format_queue, watch_once
    from .ops import watch as watch_queue
    if watch:
        return watch_queue(s)
    if once:
        done = watch_once(s)
        print(f"{len(done)} request(s) processed" if done else "nothing queued")
        return 0 if all(r["ok"] for r in done) else 1
    print(format_queue(s))
    return 0


def _positive_duration(value: str) -> float:
    try:
        duration = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError("use a number greater than zero") from None
    if not math.isfinite(duration) or duration <= 0:
        raise argparse.ArgumentTypeError("use a finite number greater than zero")
    return duration


def _utc_day(value: str) -> str:
    try:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError
    except ValueError:
        raise argparse.ArgumentTypeError("use a valid date in YYYY-MM-DD format") from None
    return value


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m bot")
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("run", help="run the bot")
    r.add_argument("--minutes", type=_positive_duration, default=None, help="stop after N minutes")
    rp = sub.add_parser("report", help="print metrics and write reports/daily-YYYY-MM-DD.md")
    rp.add_argument("--day", type=_utc_day, default=None, help="UTC day for the daily section (default today)")
    rp.add_argument("--sim", action="store_true", help="report on the simulation database")
    sm = sub.add_parser("simulate", help="offline end-to-end run with synthetic data")
    sm.add_argument("--minutes", type=_positive_duration, default=10)
    sm.add_argument("--seed", type=int, default=7)
    sub.add_parser("live-check", help="run live-mode startup checks")
    op = sub.add_parser("ops", help="server actions queued from Telegram: list them, or run them")
    op.add_argument("--watch", action="store_true", help="run queued actions as they arrive (the ops service)")
    op.add_argument("--once", action="store_true", help="run what is queued now, then exit")
    st = sub.add_parser("status", help="what the bot is doing right now (safe while it runs)")
    st.add_argument("--sim", action="store_true", help="status of the simulation database")
    st.add_argument("--check", action="store_true", help="one line for monitoring; exit 1 if down or blind")
    st.add_argument("--alert", action="store_true", help="with --check: Telegram message when the state changes")
    pf = sub.add_parser("preflight", help="check every API and key (free calls only)")
    pf.add_argument("--probe", action="store_true", help="also record what the live APIs return (~3 min)")
    pf.add_argument("--seconds", type=_positive_duration, default=150, help="probe capture length")
    pf.add_argument("--no-llm", action="store_true", help="do not require ANTHROPIC_API_KEY")
    ac = sub.add_parser("acceptance", help="run paper mode for N minutes and check the brief's done criteria")
    ac.add_argument("--minutes", type=_positive_duration, default=60)
    ac.add_argument("--sim", action="store_true", help="against the offline simulator (tests the harness)")
    ac.add_argument("--seed", type=int, default=7)
    ac.add_argument("--no-llm", action="store_true", help="run without ANTHROPIC_API_KEY (result INCOMPLETE)")
    a = p.parse_args(argv)
    if getattr(a, "alert", False) and not a.check:
        p.error("--alert requires --check")

    cmd = a.cmd or "run"
    from .config import ConfigError
    from .sim import SIM_OVERRIDES
    sim = cmd == "simulate" or getattr(a, "sim", False)
    try:
        s = load_settings(overrides=SIM_OVERRIDES if sim else None)
    except ConfigError as e:
        if cmd != "ops":
            print(redact(f"config error: {e}"), file=sys.stderr)
            return 2
        # The ops service must stay up on a broken .env: a /set from the phone is how it gets repaired.
        from .config import Settings
        print(redact(f"config error: {e}; the ops service runs with default paths so that /set can repair .env"),
              file=sys.stderr)
        s = Settings()
    register_secrets(getattr(s, field.name) for field in fields(s) if not field.repr)
    # Only long-running commands write the log file.
    try:
        setup_logging(s.LOG_LEVEL, s.path(s.LOG_FILE)
                      if s.LOG_FILE and cmd in ("run", "simulate", "acceptance") else None)
        if cmd == "ops":
            return _ops(s, a.watch, a.once)
        if cmd == "run":
            coro = _run(getattr(a, "minutes", None))
        elif cmd == "report":
            coro = _report(a.day, a.sim)
        elif cmd == "simulate":
            coro = _simulate(a.minutes, a.seed)
        elif cmd == "live-check":
            coro = _live_check()
        elif cmd == "status":
            coro = _status(s, a.check, a.alert)
        elif cmd == "preflight":
            coro = _preflight(s, a.probe, a.seconds, a.no_llm)
        elif cmd == "acceptance":
            coro = _acceptance(a.minutes, a.sim, a.seed, a.no_llm)
        else:
            p.print_help()
            return 1
        return asyncio.run(coro)
    except KeyboardInterrupt:
        return 130
    except OSError as exc:
        print(redact(f"cannot access a required file or service: {exc}. "
                     "Check the project directory, permissions and network connection."), file=sys.stderr)
        return 3
    except Exception:
        # Keep diagnostics useful while the formatter masks keys even in tracebacks.
        log.exception("command failed; check the error below and run python -m bot preflight")
        return 1



if __name__ == "__main__":
    sys.exit(main())
