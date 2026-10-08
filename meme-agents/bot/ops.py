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
"""
from __future__ import annotations

import itertools
import json
import logging
import math
import os
import signal
import subprocess
import time
from pathlib import Path

from .config import DIGEST_MODES, ConfigError, Settings, _coerce
from .util import now_s

log = logging.getLogger("bot.ops")

ACTIONS = ("update", "restart", "set")
MAX_REQUEST_AGE_S = 600       # a request the watcher finds later than this is refused, not run
HEARTBEAT_S = 2.0             # the watcher touches its heartbeat file this often, also mid-command
HEARTBEAT_STALE_S = 30.0      # ... and counts as down when the file is older than this
OUTPUT_KEEP = 1500            # characters of command output kept in a result
HISTORY_KEEP = 200            # lines of data/ops/history.jsonl kept
TIMEOUT_S = {"update": 1500, "restart": 200, "set": 60}
SERVICE = "meme-agents"

# What the phone may change: (type, low, high) for numbers, bool, a tuple of choices, or
# ("true",) for a one-way flag. Bounds keep a bad tap inside the brief's limits: the gate
# never drops below the brief's 0.65, a position never exceeds $20, the bankroll $100.
SETTABLE: dict[str, object] = {
    "LLM_DAILY_BUDGET_USD": (float, 0, 50),
    "X_MONTHLY_BUDGET_USD": (float, 0, 100),
    "LLM_BUDGET_PACING": bool,
    "BANKROLL_USD": (float, 1, 100),
    "MAX_OPEN_POSITIONS": (int, 1, 5),
    "POSITION_MIN_USD": (float, 1, 20),
    "POSITION_MAX_USD": (float, 1, 20),
    "DAILY_LOSS_CAP_PCT": (float, 1, 100),
    "STOP_LOSS_PCT": (float, 5, 90),
    "TAKE_PROFIT_PCT": (float, 5, 500),
    "TRAILING_STOP_PCT": (float, 5, 90),
    "TIME_STOP_HOURS": (float, 0.25, 48),
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


_seq = itertools.count()


class OpsError(Exception):
    """A request the phone is not allowed to make; the message is shown in the chat."""


def ops_dir(s: Settings) -> Path:
    """Next to the database: data/ops in production, the test's temporary directory in tests."""
    return s.path(s.DB_PATH).parent / "ops"


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


def validate_set(key: str, raw: str) -> str:
    """The normalized value to write for KEY=raw, or OpsError. Mirrors the bot's own parsing."""
    key = (key or "").strip().upper()
    raw = (raw or "").strip()
    if key not in SETTABLE:
        raise OpsError(f"{key or '(empty)'} cannot be changed from the phone; /set lists what can")
    spec = SETTABLE[key]
    if not raw:
        raise OpsError(f"{key}: give a value, e.g. /set {key}=...")
    if spec is bool:
        try:
            return "true" if _coerce(raw, True, key) else "false"
        except ConfigError as e:
            raise OpsError(str(e)) from None
    if isinstance(spec, tuple) and spec and isinstance(spec[0], type):
        kind, lo, hi = spec
        try:
            value = _coerce(raw, kind(0), key)
        except (ConfigError, ValueError, OverflowError):
            raise OpsError(f"{key}: use a {'whole ' if kind is int else ''}number between {allowed(key)}") from None
        if not math.isfinite(value) or not lo <= value <= hi:
            raise OpsError(f"{key}: {raw} is outside {allowed(key)}")
        return str(int(value)) if kind is int else f"{float(value):.10g}"
    choice = raw.lower()
    if choice not in spec:
        if spec == ("true",):
            raise OpsError(f"{key} can only be turned on from the phone (LIVE_DRY_RUN=false needs nano .env on the server)")
        raise OpsError(f"{key}: use one of {allowed(key)}")
    return choice


def validate(action: str, args: dict | None) -> dict:
    """Normalized args for an action, or OpsError. Run both where a request is made and where it is executed."""
    args = dict(args or {})
    if action not in ACTIONS:
        raise OpsError(f"unknown action {action!r}")
    if action in ("update", "restart"):
        return {}
    key = str(args.get("key") or "").strip().upper()
    value = validate_set(key, str(args.get("value") or ""))
    return {"key": key, "value": value, "restart": bool(args.get("restart", False))}


def describe(req: dict) -> str:
    action, args = req.get("action"), req.get("args") or {}
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


def request(s: Settings, action: str, args: dict | None = None, who: str = "telegram") -> dict:
    """Queue one action for the watcher. Returns the request as written."""
    args = validate(action, args)
    d = ops_dir(s)
    d.mkdir(parents=True, exist_ok=True)
    ts = now_s()
    rid = f"{int(ts * 1000):013d}-{next(_seq) % 1000:03d}-{action}"   # file order = request order
    body = {"id": rid, "action": action, "args": args, "ts": ts, "from": who}
    _write_json(d / f"{rid}.request", body)
    log.info("ops: queued %s (%s)", describe(body), rid)
    return body


def pending(s: Settings, suffix: str = ".request") -> list[dict]:
    """Queued requests, oldest first. Unreadable files are skipped (and reported by the watcher)."""
    out = []
    for p in sorted(ops_dir(s).glob(f"*{suffix}")):
        body = _read_json(p)
        if body is not None:
            body["_path"] = str(p)
            out.append(body)
    return out


def results(s: Settings) -> list[tuple[Path, dict]]:
    """Finished results not yet delivered to the chat; the caller unlinks each one it has sent."""
    out = []
    for p in sorted(ops_dir(s).glob("*.result")):
        body = _read_json(p)
        if body is not None:
            out.append((p, body))
    return out


def history(s: Settings, n: int = 5) -> list[dict]:
    path = ops_dir(s) / "history.jsonl"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines[-n:]:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
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


# --- the executor --------------------------------------------------------------------------
def steps_for(s: Settings, action: str, args: dict) -> list[tuple[list[str], int]]:
    """The commands one request runs, in order; a failing step stops the rest."""
    app = s.path(".")
    restart = [(["sudo", "-n", "systemctl", "restart", SERVICE], TIMEOUT_S["restart"]),
               (["systemctl", "is-active", SERVICE], 20)]
    if action == "update":
        return [(["bash", str(app / "deploy" / "update.sh")], TIMEOUT_S["update"])]
    if action == "restart":
        return restart
    steps = [(["bash", str(app / "deploy" / "set-env.sh"), f"{args['key']}={args['value']}"], TIMEOUT_S["set"])]
    return steps + restart if args.get("restart") else steps


def run_command(argv: list[str], timeout: float, cwd, tick=None) -> tuple[int, str]:
    """Run one command without a terminal; `tick()` is called every HEARTBEAT_S while it runs."""
    env = {**os.environ, "MEME_AGENTS_NONINTERACTIVE": "1", "GIT_TERMINAL_PROMPT": "0"}
    try:
        p = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True)
    except OSError as e:
        return 127, f"cannot run {argv[0]}: {e}"
    deadline = time.monotonic() + timeout
    while True:
        try:
            out, _ = p.communicate(timeout=HEARTBEAT_S)
            return p.returncode, out or ""
        except subprocess.TimeoutExpired:
            if tick:
                tick()
            if time.monotonic() > deadline:
                p.terminate()
                try:
                    out, _ = p.communicate(timeout=30)
                except subprocess.TimeoutExpired:
                    p.kill()
                    out, _ = p.communicate()
                return 124, f"{out or ''}\ntimed out after {timeout:.0f}s"


def _git_head(app: Path) -> str | None:
    try:
        r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(app), capture_output=True, text=True, timeout=20,
                           check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def _finish(s: Settings, req: dict, ok: bool, output: str, started: float, code: int | None = None) -> dict:
    result = {"id": req.get("id"), "action": req.get("action"), "args": req.get("args") or {}, "ok": ok,
              "code": code, "output": output[-OUTPUT_KEEP:], "started": started, "finished": now_s()}
    d = ops_dir(s)
    d.mkdir(parents=True, exist_ok=True)
    hist = d / "history.jsonl"
    with open(hist, "a", encoding="utf-8") as f:
        f.write(json.dumps(result, sort_keys=True) + "\n")
    try:                                        # keep the file small; it is only for /ops
        lines = hist.read_text(encoding="utf-8").splitlines()
        if len(lines) > HISTORY_KEEP:
            hist.write_text("\n".join(lines[-HISTORY_KEEP:]) + "\n", encoding="utf-8")
    except OSError:
        pass
    _write_json(d / f"{req.get('id') or int(started * 1000)}.result", result)
    path = req.get("_path")
    if path:
        Path(path).unlink(missing_ok=True)
    log.log(logging.INFO if ok else logging.WARNING, "ops: %s %s (%.0fs)%s", describe(req),
            "done" if ok else "FAILED", result["finished"] - started, "" if ok else f": {output.strip()[-300:]}")
    return result


def execute(s: Settings, req: dict, runner=run_command) -> dict:
    """Run one request after checking it again. Always writes a result, never raises."""
    started = now_s()
    action = str(req.get("action") or "")
    try:
        args = validate(action, req.get("args"))
    except OpsError as e:
        return _finish(s, req, False, f"refused: {e}", started)
    age = started - float(req.get("ts") or 0)
    if age > MAX_REQUEST_AGE_S:
        return _finish(s, req, False, f"refused: request is {age / 60:.0f} min old (the ops service was not running"
                                      " when it was made); send it again", started)
    out: list[str] = []
    for argv, timeout in steps_for(s, action, args):
        code, text = runner(argv, timeout, s.path("."), lambda: beat(s))
        out.append(text.strip())
        if code != 0:
            return _finish(s, req, False, "\n".join(x for x in out if x), started, code)
    return _finish(s, req, True, "\n".join(x for x in out if x), started, 0)


def watch_once(s: Settings, runner=run_command) -> list[dict]:
    """Process everything queued, oldest first. A request interrupted by a watcher restart is
    reported, not re-run (it would restart or deploy a second time)."""
    beat(s)
    done = []
    for req in pending(s, ".running"):
        done.append(_finish(s, req, False, "interrupted: the ops service restarted while this ran; "
                                           "check /status and send it again if needed", now_s()))
    for req in pending(s):
        running = Path(req["_path"]).with_suffix(".running")
        try:
            Path(req["_path"]).replace(running)          # claim it first
        except OSError:
            continue
        req["_path"] = str(running)
        done.append(execute(s, req, runner))
    beat(s)
    return done


def watch(s: Settings, runner=run_command, interval: float = HEARTBEAT_S, sleep=time.sleep) -> int:
    """Run until SIGTERM/SIGINT, finishing the current request first. Returns after a deploy
    changed the code so systemd (Restart=always) starts the watcher again on the new version."""
    stopping = False

    def _stop(signum, frame):
        nonlocal stopping
        stopping = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _stop)
        except ValueError:                          # not the main thread (tests)
            pass
    app = s.path(".")
    head = _git_head(app)
    log.info("ops watcher on: queue %s, deploys %s at %s", ops_dir(s), SERVICE, (head or "?")[:12])
    while not stopping:
        for result in watch_once(s, runner):
            if result["action"] == "update" and result["ok"] and _git_head(app) != head:
                log.info("ops: code updated; exiting so the service starts this watcher on the new version")
                return 0
        sleep(interval)
    log.info("ops watcher stopped")
    return 0


def format_result(res: dict, max_lines: int = 12) -> str:
    """One chat message for a finished request."""
    what = describe(res)
    secs = float(res.get("finished") or 0) - float(res.get("started") or 0)
    took = f" ({secs / 60:.0f} min {secs % 60:.0f} s)" if secs >= 60 else f" ({secs:.0f} s)"
    tail = [ln for ln in str(res.get("output") or "").strip().splitlines() if ln.strip()][-max_lines:]
    body = "\n".join(tail)
    if res.get("ok"):
        if res.get("action") == "set" and (res.get("args") or {}).get("restart"):
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
    lines = [state]
    queued = pending(s) + pending(s, ".running")
    if queued:
        lines.append(f"queued: {len(queued)}")
        for req in queued:
            lines.append(f"  · {describe(req)} ({(now_s() - float(req.get('ts') or 0)) / 60:.0f} min ago)"
                         + (" running" if str(req.get("_path", "")).endswith(".running") else ""))
    else:
        lines.append("queued: nothing")
    past = history(s, 5)
    if past:
        lines.append("last results:")
        for res in reversed(past):
            when = time.strftime("%H:%MZ", time.gmtime(float(res.get("finished") or 0)))
            lines.append(f"  {'✅' if res.get('ok') else '❌'} {when} {describe(res)}")
    return "\n".join(lines)


def settable_text(s: Settings) -> str:
    rows = []
    for key in SETTABLE:
        cur = getattr(s, key, None)
        cur = str(cur).lower() if isinstance(cur, bool) else cur
        rows.append(f"{key}={cur}  ({allowed(key)})")
    return ("/set KEY=VALUE writes the value to .env on the server (restart to apply). Allowed:\n"
            + "\n".join(rows)
            + "\n\nNot from the phone: MODE, LIVE_CONFIRM, LIVE_MAX_WALLET_SOL, keys, tokens, the wallet, chat id, URLs.")
