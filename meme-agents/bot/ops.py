"""Phone ops: deploy, restart and bounded settings from Telegram, run by a companion service.

The bot runs with its code and `.env` read-only and without privileges (deploy/meme-agents.service),
so it cannot pull code, edit a setting or restart itself. Instead the Telegram loop writes a
request file under `data/ops/`, and `python -m bot ops --watch` (deploy/meme-agents-ops.service,
the same user, outside the bot's sandbox) picks it up, re-validates it against the same
allowlist, runs the matching deploy script and writes a result file that the bot sends back
to the chat. The watcher is the only process that acts, and it only ever runs:

    update   bash deploy/update.sh       fast-forward the tracked branch after its tests pass
    restart  sudo -n systemctl restart meme-agents
    set      bash deploy/set-env.sh KEY=VALUE   for a key in SETTABLE, inside its bounds

Never settable from the phone: MODE, LIVE_CONFIRM, LIVE_MAX_WALLET_SOL, any key, token or
wallet, TELEGRAM_CHAT_ID, paths and URLs. LIVE_DRY_RUN can only be turned on. Enabling real
sends, raising the wallet cap or touching a secret still needs a shell on the server.

The watcher trusts nothing in a request file beyond what it re-validates: a result is named
after the request file, never after a field in it; a malformed file is refused and quarantined,
never allowed to crash the service; a `set` is checked against the bot's own cross-field rules
(as `.env` would load afterwards), `.env` is backed up first, and a change the bot will not start
on is undone (that one key, back to its previous value; never LIVE_DRY_RUN) so the phone never
locks itself out.
"""
from __future__ import annotations

import dataclasses
import fcntl
import itertools
import json
import logging
import math
import os
import re
import signal
import subprocess
import time
from pathlib import Path

from .config import (
    _FALSE,
    _TRUE,
    DIGEST_MODES,
    ConfigError,
    Settings,
    _coerce,
    load_dotenv,
    load_settings,
    validate_settings,
)
from .util import git_commit, now_s, redact

log = logging.getLogger("bot.ops")

ACTIONS = ("update", "restart", "set")
MAX_REQUEST_AGE_S = 600       # a request the watcher first sees later than this is refused, not run
HEARTBEAT_S = 2.0             # the watcher touches its heartbeat file this often, also mid-command
HEARTBEAT_STALE_S = 30.0      # ... and counts as down when the file is older than this
OUTPUT_KEEP = 1500            # characters of command output kept in a result
HISTORY_KEEP = 200            # lines of data/ops/history.jsonl kept
# restart: the bot's unit may take 150 s to stop (draining live exits) and 180 s to start
TIMEOUT_S = {"update": 1500, "restart": 400, "set": 60}
RESTART_SETTLE_S = 120.0      # how long a restart may sit in systemd's "activating" (its own retries) before it counts as down
ENV_BACKUP_MAX_AGE_S = 3600.0 # a failed restart undoes a /set made within this long
KEEP_PAUSE_MAX_AGE_S = 1800.0 # a "keep the loss-cap pause" marker older than this is ignored
LATE_RESULT_S = 300.0         # a result the bot sends longer than this after it finished waited for the bot to come back
# one line of the bot's log (bot/util.py setup_logging): "2026-10-08 22:48:01,123 ERROR   bot.__main__: ..."
LOG_LINE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} (?P<level>[A-Z]+)\s+(?P<name>[\w.]+): (?P<msg>.*)$")
SERVICE = "meme-agents"
_seq = itertools.count()
_sleep = time.sleep           # replaced in tests

# What the phone may change: (type, low, high) for numbers, bool, a tuple of choices, or
# ("true",) for a one-way flag. Bounds keep a bad tap inside the brief's limits: the gate
# never drops below the brief's 0.65, a position never exceeds $20, the bankroll $100, at most 20
# positions are open at once (the live wallet's balance limits them first).
SETTABLE: dict[str, object] = {
    "LLM_DAILY_BUDGET_USD": (float, 0, 150),
    "X_MONTHLY_BUDGET_USD": (float, 0, 200),
    "LLM_BUDGET_PACING": bool,
    "BANKROLL_USD": (float, 1, 500),
    "MAX_OPEN_POSITIONS": (int, 1, 20),
    "POSITION_MIN_USD": (float, 1, 20),
    "POSITION_MAX_USD": (float, 1, 20),
    "DAILY_LOSS_CAP_PCT": (float, 1, 100),
    "STOP_LOSS_PCT": (float, 5, 90),
    "TAKE_PROFIT_PCT": (float, 5, 500),
    "TRAILING_STOP_PCT": (float, 5, 90),
    "TIME_STOP_HOURS": (float, 0.25, 48),
    "RUNNER_ENABLED": bool,
    "RUNNER_FRACTION": (float, 0.01, 0.25),
    "RUNNER_TARGET_MULTIPLE": (float, 2, 1000),
    "RUNNER_MAX_HOLD_HOURS": (float, 1, 336),
    "RUNNER_STOP_LOSS": bool,
    "EMERGENCY_LIQ_DROP_PCT": (float, 20, 90),
    "POSITION_POLL_S": (float, 0, 15),
    "POSITION_DEX_POLL_S": (float, 0, 120),
    "INSIDER_WATCH": bool,
    "INSIDER_EXIT": bool,
    "INSIDER_EXIT_SUPPLY_PCT": (float, 0.5, 20),
    "INSIDER_WATCH_MAX": (int, 1, 200),
    "LAUNCH_MEMORY_DAYS": (int, 0, 14),
    "LAUNCH_BACKFILL_PER_MIN": (float, 0, 60),
    "CURVE_POLL_CALLS_PER_MIN": (float, 1, 60),
    "CURVE_HOT_POLL_S": (float, 3, 60),
    "ENTRY_MAX_LIQ_SLIP_PCT": (float, 0, 90),
    "MOONSHOT_ALERT_MULTIPLE": (float, 0, 10000),
    "PRIORITY_FEE_SOL": (float, 0.0001, 0.004),
    "URGENT_PRIORITY_FEE_SOL": (float, 0.0005, 0.004),
    "CONSENSUS_MIN_MEAN_CONFIDENCE": (float, 0.65, 1.0),
    "GATE_NEUTRAL_VOTES": bool,
    "TRIAGE_ENABLED": bool,
    "TRIAGE_MIN_CONFIDENCE": (float, 0.5, 1.0),
    "VETO_ENABLED": bool,
    "VETO_MIN_CONFIDENCE": (float, 0.5, 1.0),
    "REGIME_ENABLED": bool,
    "PF_MIN_AGE_MIN": (float, 0, 1440),
    "PF_MAX_AGE_MIN": (float, 1, 1440),
    "PF_MIN_UNIQUE_BUYERS": (int, 1, 10000),
    "PF_MIN_NET_INFLOW_SOL": (float, 0, 10000),
    "PF_MAX_TOP10_PCT": (float, 1, 100),
    "PF_MIN_LIQUIDITY_USD": (float, 0, 10_000_000),
    "TELEGRAM_DIGEST": DIGEST_MODES,
    "LIVE_DRY_RUN": ("true",),
}


class OpsError(Exception):
    """A request the phone is not allowed to make; the message is shown in the chat."""


def ops_dir(s: Settings) -> Path:
    """Next to the database: data/ops in production, the test's temporary directory in tests."""
    return s.path(s.DB_PATH).parent / "ops"


def env_path(s: Settings) -> Path:
    return s.path(".env")


def _args_of(req) -> dict:
    args = req.get("args") if isinstance(req, dict) else None
    return args if isinstance(args, dict) else {}


def _num(x) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    return v if math.isfinite(v) else 0.0


def allowed(key: str) -> str:
    """The rule for one key, for the /set listing."""
    spec = SETTABLE[key]
    if spec is bool:
        return "true/false"
    if isinstance(spec, tuple) and spec and isinstance(spec[0], type):
        kind, lo, hi = spec
        fmt = (lambda v: f"{v:.10g}") if kind is float else str
        return f"{fmt(lo)} to {fmt(hi)}"
    if spec == ("true",):
        return "true only"
    return "/".join(spec)


def current_settings(s: Settings) -> Settings:
    """The settings as .env loads now (a /set may have changed .env since the bot started),
    or the running ones when .env does not load (a /set is then the way to repair it)."""
    try:
        return load_settings(env_path(s))
    except ConfigError:
        return s


def _check_with(current: Settings, key: str, value: str) -> None:
    """The bot's own cross-field rules, on the settings as they would be after the change."""
    try:
        cand = dataclasses.replace(current)
        setattr(cand, key, _coerce(value, getattr(current, key), key))
        validate_settings(cand)
    except ConfigError as e:
        raise OpsError(f"{key}={value} refused: {e}") from None
    except (ValueError, OverflowError):
        raise OpsError(f"{key}={value} refused: not a value the bot can load") from None


def validate_set(key: str, raw: str, current: Settings | None = None) -> str:
    """The normalized value to write for KEY=raw, or OpsError. Mirrors the bot's own parsing,
    and with `current` also its cross-field rules (POSITION_MIN_USD <= POSITION_MAX_USD, ...)."""
    key = (key or "").strip().upper()
    raw = (raw or "").strip()
    if key not in SETTABLE:
        raise OpsError(f"{key or '(empty)'} cannot be changed from the phone; /set lists what can")
    spec = SETTABLE[key]
    if not raw:
        raise OpsError(f"{key}: give a value, e.g. /set {key}=...")
    if spec is bool:
        try:
            value = "true" if _coerce(raw, True, key) else "false"
        except ConfigError as e:
            raise OpsError(str(e)) from None
    elif isinstance(spec, tuple) and spec and isinstance(spec[0], type):
        kind, lo, hi = spec
        try:
            number = _coerce(raw, kind(0), key)
        except (ConfigError, ValueError, OverflowError):
            raise OpsError(f"{key}: use a {'whole ' if kind is int else ''}number between {allowed(key)}") from None
        if not math.isfinite(number) or not lo <= number <= hi:
            raise OpsError(f"{key}: {raw} is outside {allowed(key)}")
        value = str(int(number)) if kind is int else f"{float(number):.10g}"
    elif spec == ("true",):
        word = raw.lower()
        if word in _TRUE:
            value = "true"
        elif word in _FALSE:
            raise OpsError(f"{key} can only be turned on from the phone ({key}=false needs nano .env on the server)")
        else:
            raise OpsError(f"{key}: use /dryrun on, or /set {key}=true")
    else:
        value = raw.lower()
        if value not in spec:
            raise OpsError(f"{key}: use one of {allowed(key)}")
    if current is not None:
        _check_with(current, key, value)
    return value


def validate(action: str, args, current: Settings | None = None) -> dict:
    """Normalized args for an action, or OpsError. Run both where a request is made and where it is executed."""
    if args is not None and not isinstance(args, dict):
        raise OpsError("args must be an object")
    args = dict(args or {})
    if action not in ACTIONS:
        raise OpsError(f"unknown action {action!r}")
    if action in ("update", "restart"):
        return {}
    key = str(args.get("key") or "").strip().upper()
    value = validate_set(key, str(args.get("value") or ""), current)
    return {"key": key, "value": value, "restart": bool(args.get("restart", False))}


def describe(req: dict) -> str:
    action, args = req.get("action"), _args_of(req)
    if action == "set":
        if args.get("key") == "LIVE_DRY_RUN":
            return "dry run ON"
        return f"set {args.get('key')}={args.get('value')}"
    return str(action)


# --- the queue ---------------------------------------------------------------------------
def _write_json(path: Path, body: dict) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(body, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path) -> dict | None:
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return body if isinstance(body, dict) else None


def request(s: Settings, action: str, args: dict | None = None, who: str = "telegram",
            keep_pause: bool = False) -> dict:
    """Queue one action for the watcher. Returns the request as written. `keep_pause` asks the
    watcher to mark the restart this causes so it does not end a daily-loss pause (bot/engine.py)."""
    args = validate(action, args, current_settings(s))
    d = ops_dir(s)
    d.mkdir(parents=True, exist_ok=True)
    ts = now_s()
    rid = f"{int(ts * 1000):013d}-{next(_seq) % 1000:03d}-{action}"   # file order = request order
    restarts = action in ("update", "restart") or bool(args.get("restart"))
    body = {"id": rid, "action": action, "args": args, "ts": ts, "from": who, "keep_pause": bool(keep_pause and restarts)}
    _write_json(d / f"{rid}.request", body)
    log.info("ops: queued %s (%s)", describe(body), rid)
    return body


def pending(s: Settings, suffix: str = ".request") -> list[dict]:
    """Queued requests, oldest first. A file that is not a JSON object is set aside, once."""
    out = []
    for p in sorted(ops_dir(s).glob(f"*{suffix}")):
        body = _read_json(p)
        if body is None:
            quarantine(p, "not a JSON object")
            continue
        body["_path"] = str(p)
        out.append(body)
    return out


def results(s: Settings) -> list[tuple[Path, dict]]:
    """Finished results not yet delivered to the chat; the caller unlinks each one it has sent.
    A file that is not a JSON object is set aside, once."""
    out = []
    for p in sorted(ops_dir(s).glob("*.result")):
        body = _read_json(p)
        if body is None:
            quarantine(p, "not a JSON object")
            continue
        out.append((p, body))
    return out


def quarantine(path: Path, why: str) -> None:
    """Move a file the watcher or the bot cannot handle out of the way, once, with a log line."""
    try:
        path.replace(path.with_suffix(path.suffix + ".bad"))
        log.warning("ops: %s set aside as %s.bad: %s", path.name, path.name, why)
    except OSError as e:
        log.warning("ops: could not set %s aside (%s): %s", path.name, e, why)


def history(s: Settings, n: int = 5) -> list[dict]:
    path = ops_dir(s) / "history.jsonl"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines[-n:]:
        try:
            body = json.loads(line)
        except ValueError:
            continue
        if isinstance(body, dict):
            out.append(body)
    return out


def heartbeat_path(s: Settings) -> Path:
    return ops_dir(s) / "watcher.alive"


def beat(s: Settings) -> None:
    p = heartbeat_path(s)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.touch()


def watcher_age(s: Settings) -> float | None:
    """Seconds since the watcher last reported in, None when it never has."""
    try:
        return max(0.0, time.time() - heartbeat_path(s).stat().st_mtime)
    except OSError:
        return None


def watcher_alive(s: Settings) -> bool:
    age = watcher_age(s)
    return age is not None and age <= HEARTBEAT_STALE_S


def no_new_privs(status: Path = Path("/proc/self/status")) -> bool | None:
    """Whether this process carries the kernel's no-new-privileges flag, under which sudo refuses
    to run. systemd sets it on a service with a User= when the unit asks for any seccomp-based
    hardening (ProtectKernelTunables, LockPersonality, ...), not only with NoNewPrivileges=.
    None when the answer is not available (not Linux)."""
    try:
        for line in status.read_text().splitlines():
            if line.startswith("NoNewPrivs:"):
                return line.split(":", 1)[1].strip() == "1"
    except OSError:
        pass
    return None


def info_path(s: Settings) -> Path:
    return ops_dir(s) / "watcher.info"


def write_info(s: Settings) -> dict:
    """What the watcher found out about itself at start, for /ops to show."""
    info = {"pid": os.getpid(), "no_new_privs": no_new_privs(), "started": now_s(),
            "code": git_commit(s.path(".")) or ""}
    _write_json(info_path(s), info)
    return info


def watcher_info(s: Settings) -> dict:
    return _read_json(info_path(s)) or {}


NNP_HINT = ("the ops service runs with the no-new-privileges flag, so sudo refuses to run: nothing can restart "
            "or update the bot from the phone until the service is reinstalled. On the server, once: "
            "bash deploy/update.sh && bash deploy/install.sh --ops")


def sudo_refused(out: list[str]) -> bool:
    """sudo itself failed (password, policy, the no-new-privileges flag): the command never ran."""
    return any(ln.startswith("sudo:") for ln in "\n".join(out).splitlines())


def service_up_since(s: Settings) -> float:
    """When the ops service came up, as far as the queue is concerned. A watcher that starts
    while the heartbeat is still fresh (the restart after a deploy) continues the previous
    one's span; only a real gap starts a new one. A request made after this moment was made
    while the service was running and is never refused as stale."""
    p = ops_dir(s) / "watcher.since"
    age = watcher_age(s)
    if age is not None and age <= HEARTBEAT_STALE_S:
        try:
            return float(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    p.parent.mkdir(parents=True, exist_ok=True)
    now = now_s()
    p.write_text(f"{now}\n", encoding="utf-8")
    return now


def keep_pause_path(s: Settings) -> Path:
    return ops_dir(s) / "keep-pause"


def consume_keep_pause(s: Settings) -> bool:
    """True once when a phone-initiated restart asked to keep the daily-loss pause (the marker
    is removed either way; one older than KEEP_PAUSE_MAX_AGE_S no longer counts)."""
    p = keep_pause_path(s)
    try:
        age = time.time() - p.stat().st_mtime
    except OSError:
        return False
    try:
        p.unlink()
    except OSError:
        pass
    return age <= KEEP_PAUSE_MAX_AGE_S


# --- .env safety -------------------------------------------------------------------------
def backup_env(s: Settings) -> Path | None:
    """A copy of .env (0600) taken before a change, for revert."""
    src = env_path(s)
    if not src.exists():
        return None
    dst = ops_dir(s) / "env.backup"
    dst.parent.mkdir(parents=True, exist_ok=True)
    data = src.read_bytes()
    fd = os.open(str(dst), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    return dst


def backup_differs(s: Settings) -> bool:
    """The backup and .env differ (a write happened, or was cut short)."""
    src, cur = ops_dir(s) / "env.backup", env_path(s)
    try:
        return cur.exists() and src.read_bytes() != cur.read_bytes()
    except OSError:
        return False


def record_change(s: Settings, key: str) -> None:
    """Remember which key a /set is about to change and what it was, so a restart the bot does
    not survive can undo that one key and nothing else (hand edits made since stay)."""
    try:
        previous = load_dotenv(env_path(s)).get(key)
    except ConfigError:
        previous = None
    _write_json(ops_dir(s) / "env.change.json", {"key": key, "previous": previous, "ts": now_s()})


def last_change(s: Settings) -> dict | None:
    """The change a failed restart may undo: recent, about an allowlisted key, previous value
    sane. Anything else (including a planted file) is ignored."""
    rec = _read_json(ops_dir(s) / "env.change.json")
    if not rec or not isinstance(rec.get("key"), str):
        return None
    key = rec["key"]
    if key not in SETTABLE or key == "LIVE_DRY_RUN" or now_s() - _num(rec.get("ts")) > ENV_BACKUP_MAX_AGE_S:
        return None
    previous = rec.get("previous")
    if previous is None:                        # the key was not in .env before: back to the bot's default
        default = getattr(Settings(), key)
        previous = str(default).lower() if isinstance(default, bool) else str(default)
    try:
        return {"key": key, "previous": validate_set(key, str(previous))}
    except OpsError:
        return None


def retire_change(s: Settings) -> None:
    (ops_dir(s) / "env.change.json").unlink(missing_ok=True)


def restore_env(s: Settings) -> bool:
    """Put the backup back, writing into the existing file (its inode carries the bot's
    read-only bind mount; a rename over it would detach that mount)."""
    src, dst = ops_dir(s) / "env.backup", env_path(s)
    try:
        data = src.read_bytes()
        fd = os.open(str(dst), os.O_WRONLY)
    except OSError:
        return False
    try:
        os.ftruncate(fd, 0)
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    return True


def env_loads(s: Settings) -> str | None:
    """None when .env loads with the bot's own parser and rules, else the error."""
    try:
        load_settings(env_path(s))
    except ConfigError as e:
        return str(e)
    return None


# --- the executor --------------------------------------------------------------------------
def run_command(argv: list[str], timeout: float, cwd, tick=None) -> tuple[int, str]:
    """Run one command without a terminal; `tick()` is called every HEARTBEAT_S while it runs.
    The command gets its own process group so a deadline kills update.sh's pip, pytest and git
    with it instead of leaving them holding the pipe."""
    env = {**os.environ, "MEME_AGENTS_NONINTERACTIVE": "1", "GIT_TERMINAL_PROMPT": "0"}
    try:
        p = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, start_new_session=True)
    except OSError as e:
        return 127, f"cannot run {argv[0]}: {e}"
    out = _communicate(p, time.monotonic() + timeout, tick)
    if out is not None:
        return p.returncode, out
    for sig, grace in ((signal.SIGTERM, 30.0), (signal.SIGKILL, 30.0)):
        try:
            os.killpg(p.pid, sig)
        except ProcessLookupError:
            pass
        out = _communicate(p, time.monotonic() + grace, tick)
        if out is not None:
            return 124, f"{out}\ntimed out after {timeout:.0f}s"
    return 124, f"timed out after {timeout:.0f}s and the command did not stop"


def _communicate(p, deadline: float, tick) -> str | None:
    """Output once the command exits, None at the deadline; keeps the heartbeat going meanwhile."""
    while True:
        try:
            out, _ = p.communicate(timeout=HEARTBEAT_S)
            return out or ""
        except subprocess.TimeoutExpired:
            if tick:
                tick()
            if time.monotonic() > deadline:
                return None


def _wait(seconds: float, tick) -> None:
    """Sleep in heartbeat-sized steps so /ops keeps seeing the watcher."""
    steps = max(1, math.ceil(seconds / HEARTBEAT_S))
    for _ in range(steps):
        _sleep(seconds / steps)
        if tick:
            tick()


def _git_head(app: Path) -> str | None:
    try:
        r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(app), capture_output=True, text=True, timeout=20,
                           check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def _finish(s: Settings, req: dict, ok: bool, output: str, started: float, code: int | None = None) -> dict:
    """Write the result (named after the request file, never after anything inside it), append
    it to the history and drop the request."""
    result = {"id": str(req.get("id") or ""), "action": str(req.get("action") or ""), "args": _args_of(req),
              "from": str(req.get("from") or "telegram"),
              "ok": ok, "code": code, "output": output[-OUTPUT_KEEP:], "started": started, "finished": now_s()}
    d = ops_dir(s)
    d.mkdir(parents=True, exist_ok=True)
    keep_pause_path(s).unlink(missing_ok=True)   # a restart that happened has consumed it; one that did not must not linger
    hist = d / "history.jsonl"
    try:
        with open(hist, "a", encoding="utf-8") as f:
            f.write(json.dumps(result, sort_keys=True) + "\n")
        lines = hist.read_text(encoding="utf-8").splitlines()     # keep the file small; it is only for /ops
        if len(lines) > HISTORY_KEEP:
            hist.write_text("\n".join(lines[-HISTORY_KEEP:]) + "\n", encoding="utf-8")
    except OSError:
        log.exception("ops: history could not be written")
    path = req.get("_path")
    name = Path(path).stem if path else f"{int(started * 1000):013d}-000-{result['action'] or 'request'}"
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name).lstrip(".") or "request"
    try:
        _write_json(d / f"{name}.result", result)
    except OSError:
        log.exception("ops: result could not be written")
    if path:
        Path(path).unlink(missing_ok=True)
    log.log(logging.INFO if ok else logging.WARNING, "ops: %s %s (%.0fs)%s", describe(req),
            "done" if ok else "FAILED", result["finished"] - started, "" if ok else f": {output.strip()[-300:]}")
    return result


def execute(s: Settings, req: dict, runner=None) -> dict:
    """Run one request after checking it again. Always writes a result, never raises."""
    started = now_s()
    try:
        return _execute(s, req, runner or run_command, started)
    except Exception as e:                      # a malformed file must not take the service down
        log.exception("ops: request %s is malformed", req.get("id"))
        try:
            return _finish(s, req, False, f"refused: malformed request ({type(e).__name__}: {e})", started)
        except Exception:
            path = req.get("_path")
            if path:
                quarantine(Path(path), f"{type(e).__name__}: {e}")
            return {"id": str(req.get("id") or ""), "action": str(req.get("action") or ""), "args": {}, "ok": False,
                    "code": None, "output": f"refused: malformed request ({type(e).__name__})", "started": started,
                    "finished": now_s()}


def _execute(s: Settings, req: dict, runner, started: float) -> dict:
    action = str(req.get("action") or "")
    try:
        args = validate(action, req.get("args"), current_settings(s))
    except OpsError as e:
        return _finish(s, req, False, f"refused: {e}", started)
    ts, claimed = _num(req.get("ts")), _num(req.get("claimed")) or started
    since = _num(req.get("since")) or claimed
    if ts < since and since - ts > MAX_REQUEST_AGE_S:     # made while the service was down, and long before it came up
        return _finish(s, req, False, f"refused: the request was already {(since - ts) / 60:.0f} min old when the "
                                      "ops service came up (it was not running when it was made); send it again", started)
    app = s.path(".")
    out: list[str] = []

    def tick() -> None:
        beat(s)

    def run_raw(argv: list[str], timeout: float) -> tuple[int, str]:
        return runner(argv, timeout, app, tick)

    def run(argv: list[str], timeout: float) -> int:
        code, text = run_raw(argv, timeout)
        if text.strip():
            out.append(text.strip())
        return code

    def finish(ok: bool, code: int | None) -> dict:
        return _finish(s, req, ok, "\n".join(out), started, code)

    def mark_pause() -> None:                   # right before the restart, so it can only mean this one
        if req.get("keep_pause"):
            keep_pause_path(s).write_text(f"{req.get('id')}\n", encoding="utf-8")

    if action == "update":
        mark_pause()
        code = run(["bash", str(app / "deploy" / "update.sh")], TIMEOUT_S["update"])
        if code != 0:
            return finish(False, code)
        # update.sh leaves a bot that was not running as it found it. One that had crashed or
        # refused to start (systemd: failed) was not stopped on purpose: start it on the new code.
        # This is the rescue's /update while the bot is down (bot/rescue.py).
        if _unit_state(run_raw) != "failed":
            return finish(True, 0)
        out.append("the bot was down before the update (failed); starting it on the new code")
        ok, code = _restart(s, run, run_raw, tick, out)
        return finish(ok, code)
    if action == "set":
        backup_env(s)
        record_change(s, args["key"])
        code = run(["bash", str(app / "deploy" / "set-env.sh"), f"{args['key']}={args['value']}"], TIMEOUT_S["set"])
        if code != 0:
            if backup_differs(s) and restore_env(s):
                out.append("the write did not complete; the previous .env is restored")
            retire_change(s)
            return finish(False, code)
        error = env_loads(s)
        if error:                               # belt and braces: the bot would refuse to start on this file
            restored = restore_env(s)
            retire_change(s)
            out.append(f"refused: .env would not load afterwards ({error}); "
                       + ("the previous .env is restored" if restored else "restore .env by hand"))
            return finish(False, 1)
        if not args.get("restart"):
            return finish(True, 0)
    mark_pause()
    ok, code = _restart(s, run, run_raw, tick, out)
    return finish(ok, code)


def _unit_state(run_raw) -> str:
    """The bot unit's ActiveState now, in one read ("unknown" when systemctl cannot say)."""
    code, text = run_raw(["systemctl", "show", "-p", "ActiveState", "--value", SERVICE], 20)
    text = (text or "").strip()
    return text.splitlines()[-1].strip() if code == 0 and text else "unknown"


def _settle(run_raw, tick, limit: float = RESTART_SETTLE_S) -> str:
    """Poll the unit's ActiveState until it is active, or failed/inactive, or `limit` passes
    (then it is still "activating": systemd retrying a startup error, or a slow start)."""
    state = "unknown"
    for _ in range(max(1, math.ceil(limit / HEARTBEAT_S))):
        code, text = run_raw(["systemctl", "show", "-p", "ActiveState", "--value", SERVICE], 20)
        state = (text or "").strip().splitlines()[-1].strip() if (text or "").strip() else "unknown"
        if code != 0:
            state = "unknown"
        if state in ("active", "failed", "inactive"):
            return state
        _sleep(HEARTBEAT_S)
        if tick:
            tick()
    return state


def _restart(s: Settings, run, run_raw, tick, out: list[str]) -> tuple[bool, int]:
    """Restart the bot and make sure it is up. When it is not, undo the last /set (that one key,
    back to what it was, never LIVE_DRY_RUN) and restart again: a setting the bot refuses must
    never leave the phone without a bot to talk to. A /set the bot has already started on is
    retired and never undone by a later restart."""
    mark = log_mark(s)
    code = run(["sudo", "-n", "systemctl", "restart", SERVICE], TIMEOUT_S["restart"])
    if code != 0 and sudo_refused(out):          # the bot is still up only because nothing touched it
        return False, code
    state = _settle(run_raw, tick)
    if state == "active":
        retire_change(s)
        if code != 0:
            out.append("the restart command reported an error but the bot is active")
        return True, 0
    why = startup_error(s, mark)
    change = last_change(s)
    if change is None:
        rec = _read_json(ops_dir(s) / "env.change.json") or {}
        if rec.get("key") == "LIVE_DRY_RUN":
            out.append("the bot is not active after the restart; LIVE_DRY_RUN stays on (it is never turned back on "
                       "from here). " + (f"The bot said: {why}" if why else f"Check journalctl -u {SERVICE} on the server"))
        else:
            out.append(f"the bot is not active after the restart ({state}); "
                       + (f"the bot said: {why}" if why else f"check journalctl -u {SERVICE}"))
        return False, code or 1
    key, previous = change["key"], change["previous"]
    retire_change(s)
    if why:
        out.append(f"the bot said: {why}")
    out.append(f"the bot did not start after {key} changed ({state}): {key} is put back to {previous} and the bot "
               "restarted again")
    code2 = run(["bash", str(s.path(".") / "deploy" / "set-env.sh"), f"{key}={previous}"], TIMEOUT_S["set"])
    if code2 != 0:
        out.append(f"could not write {key}={previous} back; check .env on the server")
        return False, code or 1
    mark = log_mark(s)
    code2 = run(["sudo", "-n", "systemctl", "restart", SERVICE], TIMEOUT_S["restart"])
    state = _settle(run_raw, tick)
    if state == "active":
        out.append(f"the bot is active again with {key}={previous}")
    else:
        why = startup_error(s, mark)
        out.append(f"the bot is still not active ({state}, restart command exit {code2}); "
                   + (f"the bot said: {why}" if why else f"check journalctl -u {SERVICE}"))
    return False, code or 1


def log_mark(s: Settings) -> tuple[int, int] | None:
    """Where the bot's log ends now (inode, size): startup_error reads only what comes after."""
    if not s.LOG_FILE:
        return None
    try:
        st = os.stat(s.path(s.LOG_FILE))
    except OSError:
        return (0, 0)                               # no log yet: everything written later is new
    return (st.st_ino, st.st_size)


def startup_error(s: Settings, mark: tuple[int, int] | None) -> str | None:
    """Why the restarted bot quit, in its own words, so a failed phone restart says it instead of
    pointing at journalctl, which a phone cannot run (9 Oct: a restart failed on a wallet over its
    cap and the chat only said "check journalctl"). Only what the log gained after `mark` counts,
    and of that only the new process: an error after its "starting (pid N)" line on the loggers that
    end a run (bot: refused live mode, a startup problem, an exception; bot.__main__: a refused
    .env, written before any marker). The old process stopping, or a bot started by hand that shares
    the file, cannot be quoted as the reason. A rotated log is read from its start."""
    if mark is None or not s.LOG_FILE:
        return None
    path = s.path(s.LOG_FILE)
    try:
        with open(path, "rb") as f:
            st = os.fstat(f.fileno())
            offset = mark[1] if st.st_ino == mark[0] and st.st_size >= mark[1] else 0
            f.seek(max(offset, st.st_size - 1_000_000))   # a megabyte is far more than one startup writes
            text = f.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    found = None
    for ln in text.splitlines():
        m = LOG_LINE.match(ln)
        if m is None:
            continue
        if m["name"] == "bot" and m["msg"].startswith("starting (pid "):
            found = None                            # a new process: only its own errors count
        elif m["level"] in ("ERROR", "CRITICAL") and m["name"] in ("bot", "bot.__main__"):
            found = m["msg"].strip()
    return redact(found)[:400] if found else None


def late_note(res: dict, now: float | None = None, up_since: float | None = None) -> str:
    """A first line for a result the bot sends after it waited (9 Oct: last night's failed restart
    arrived the next morning and was taken for a new failure). `up_since`: when this bot process
    came up; a result that finished before it waited for the bot to come back."""
    finished = _num(res.get("finished"))
    if finished <= 0:
        return ""
    when = time.strftime("%d %b %H:%MZ", time.gmtime(finished))
    if up_since is not None and finished < up_since:
        return f"⏳ from {when}, before the bot was back up (it was not running to send it)\n"
    now = now_s() if now is None else now
    if now - finished > LATE_RESULT_S:
        return f"⏳ from {when}, sent late\n"
    return ""


# --- the watcher ---------------------------------------------------------------------------
def try_lock(s: Settings) -> int | None:
    """One watcher at a time: the service, or a hand-run `python -m bot ops --once`, not both."""
    d = ops_dir(s)
    d.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(d / "watcher.lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def _safe_finish(s: Settings, req: dict, output: str) -> dict:
    try:
        return _finish(s, req, False, output, now_s())
    except Exception as e:
        quarantine(Path(req["_path"]), f"{type(e).__name__}: {e}")
        return {"id": str(req.get("id") or ""), "action": str(req.get("action") or ""), "args": {}, "ok": False,
                "code": None, "output": output, "started": now_s(), "finished": now_s()}


def watch_once(s: Settings, runner=None, lock_fd: int | None = None, since: float | None = None) -> list[dict]:
    """Process everything queued, oldest first. A request made while the service was up (after
    `since`) is never refused as stale, however long it waited behind an update. A request
    interrupted by a watcher restart is reported, not re-run (it would restart or deploy twice)."""
    own = lock_fd is None
    if own:
        lock_fd = try_lock(s)
        if lock_fd is None:
            raise OpsError(f"another ops watcher is running (data/ops/watcher.lock is held, probably by "
                           f"the {SERVICE}-ops service)")
    try:
        if since is None:
            since = service_up_since(s)
        beat(s)
        done = []
        for req in pending(s, ".running"):
            done.append(_safe_finish(s, req, "interrupted: the ops service restarted while this ran; "
                                             "check /status and send it again if needed"))
        claimed, now = [], now_s()
        for req in pending(s):
            running = Path(req["_path"]).with_suffix(".running")
            try:
                Path(req["_path"]).replace(running)          # claim it first
            except OSError:
                continue
            req["_path"], req["claimed"], req["since"] = str(running), now, since
            claimed.append(req)
        for req in claimed:
            beat(s)
            done.append(execute(s, req, runner))
        beat(s)
        return done
    finally:
        if own:
            os.close(lock_fd)


def watch(s: Settings, runner=None, interval: float = HEARTBEAT_S, sleep=time.sleep, rescue=None) -> int:
    """Run until SIGTERM/SIGINT, finishing the current request first. Returns after a deploy
    changed the code so systemd (Restart=always) starts the watcher again on the new version.
    While the bot service is down, `rescue` (bot/rescue.py) answers /restart and /update on
    Telegram in its place."""
    lock_fd = try_lock(s)
    if lock_fd is None:
        log.error("ops: another watcher holds %s; not starting a second one", ops_dir(s) / "watcher.lock")
        return 1
    stopping = False

    def _stop(signum, frame):
        nonlocal stopping
        stopping = True

    previous: dict = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            previous[sig] = signal.signal(sig, _stop)
        except ValueError:                          # not the main thread (tests)
            pass
    try:
        app = s.path(".")
        head = _git_head(app)
        since = service_up_since(s)
        if write_info(s).get("no_new_privs"):
            log.warning("ops: %s", NNP_HINT)
        log.info("ops watcher on: queue %s, deploys %s at %s", ops_dir(s), SERVICE, (head or "?")[:12])
        if rescue is None:
            from .rescue import Rescue
            rescue = Rescue(s, runner or run_command)
        while not stopping:
            for result in watch_once(s, runner, lock_fd, since):
                if result["action"] == "update" and result["ok"] and _git_head(app) != head:
                    log.info("ops: code updated; exiting so the service starts this watcher on the new version")
                    return 0
            try:
                rescue.tick()
            except Exception:                 # the rescue is a convenience; the queue must keep running
                log.exception("ops: rescue poll failed")
            sleep(interval)
        log.info("ops watcher stopped")
        return 0
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        os.close(lock_fd)


# --- what the chat shows -------------------------------------------------------------------
def format_result(res: dict, max_lines: int = 12) -> str:
    """One chat message for a finished request."""
    what = describe(res)
    args = _args_of(res)
    secs = max(0.0, _num(res.get("finished")) - _num(res.get("started")))
    took = f" ({secs / 60:.0f} min {secs % 60:.0f} s)" if secs >= 60 else f" ({secs:.0f} s)"
    tail = [ln for ln in str(res.get("output") or "").strip().splitlines() if ln.strip()][-max_lines:]
    body = "\n".join(tail)
    if res.get("ok"):
        if res.get("action") == "set" and args.get("restart"):
            head = f"✅ {what}: written to .env and the bot restarted{took}"
        elif res.get("action") == "set":
            head = f"✅ {what}: written to .env{took}. Restart to apply"
        elif res.get("action") == "update" and "nothing to do" in body:
            head = f"✅ update: already on the latest code{took}"
        else:
            head = f"✅ {what} done{took}"
    else:
        code = res.get("code")
        head = f"❌ {what} failed{took}" + (f" (exit {code})" if code not in (None, 0) else "")
        if "could not read Username" in body or "Authentication failed" in body or "terminal prompts disabled" in body:
            body += ("\n\ngit cannot fetch without a password. On the server, once: "
                     "git config credential.helper store && git fetch   (type the token when asked)")
        elif "no new privileges" in body:
            body += "\n\n" + NNP_HINT
        elif "a password is required" in body or "sudo:" in body:
            body += "\n\nsudo asked for a password: add the sudoers line from deploy/VPS.md, 'Control from your phone'"
    return head + ("\n" + body if body else "")


def format_queue(s: Settings) -> str:
    """The /ops answer: watcher state, queued requests, last results."""
    age = watcher_age(s)
    if age is None:
        state = "ops service: never seen. Install it once on the server: bash deploy/install.sh --ops"
    elif age > HEARTBEAT_STALE_S:
        state = f"ops service: DOWN (last seen {age / 60:.0f} min ago). On the server: sudo systemctl restart {SERVICE}-ops"
    else:
        state = f"ops service: running (seen {age:.0f} s ago)"
        code = str(watcher_info(s).get("code") or "")
        if re.fullmatch(r"[0-9a-f]{7}(\+dirty)?", code):
            state += f", code {code}"
    lines = [state]
    if age is not None and age <= HEARTBEAT_STALE_S and watcher_info(s).get("no_new_privs"):
        lines.append("⚠️ " + NNP_HINT)
    queued = pending(s) + pending(s, ".running")
    if queued:
        lines.append(f"queued: {len(queued)} (one runs at a time; one behind an update waits for it)")
        for req in queued:
            lines.append(f"  · {describe(req)} ({(now_s() - _num(req.get('ts'))) / 60:.0f} min ago)"
                         + (" running" if str(req.get("_path", "")).endswith(".running") else ""))
    else:
        lines.append("queued: nothing")
    past = history(s, 5)
    if past:
        lines.append("last results:")
        for res in reversed(past):
            when = time.strftime("%H:%MZ", time.gmtime(_num(res.get("finished"))))
            lines.append(f"  {'✅' if res.get('ok') else '❌'} {when} {describe(res)}")
    return "\n".join(lines)


def _differs(current, raw: str, key: str) -> bool:
    try:
        return _coerce(raw, current, key) != current
    except (ConfigError, ValueError, OverflowError):
        return True


def settable_text(s: Settings) -> str:
    """The /set listing: running values, and the value waiting in .env where one differs."""
    try:
        in_env = load_dotenv(env_path(s))
    except ConfigError:
        in_env = {}
    rows = []
    for key in SETTABLE:
        cur = getattr(s, key, None)
        shown = str(cur).lower() if isinstance(cur, bool) else cur
        row = f"{key}={shown}  ({allowed(key)})"
        waiting = (in_env.get(key) or "").strip()
        if waiting and _differs(cur, waiting, key):
            row += f"  -> {waiting} in .env, restart to apply"
        rows.append(row)
    return ("/set KEY=VALUE writes the value to .env on the server; a restart applies it. Running values:\n"
            + "\n".join(rows)
            + "\n\nNot from the phone: MODE, LIVE_CONFIRM, LIVE_MAX_WALLET_SOL, keys, tokens, the wallet, chat id, URLs.")
