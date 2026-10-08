"""Phone ops: Telegram /update /restart /set /dryrun /ops queue requests as files; the ops service
re-validates each one against the same allowlist and the bot's own config rules, runs only the
deploy scripts, reverts a change the bot will not start on, and reports back."""
import asyncio
import json
import os
import signal
import time

import pytest

from bot import ops
from bot.commands import CONFIRM, PANEL, TelegramCommands
from bot.config import ROOT, load_settings
from bot.db import Database
from bot.telegram import Telegram
from bot.util import now_s
from tests.test_commands import FakeHttp, Resp, _cb, _msg, _settings

SET_ENV = ["bash", str(ROOT / "deploy" / "set-env.sh")]
RESTART = [["sudo", "-n", "systemctl", "restart", "meme-agents"], ["systemctl", "is-active", "meme-agents"]]


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """Never touch the repository's .env or sleep for real."""
    env = tmp_path / ".env"
    env.write_text("POSITION_MIN_USD=5\nPOSITION_MAX_USD=10\n")
    monkeypatch.setattr(ops, "env_path", lambda s: env)
    monkeypatch.setattr(ops, "_sleep", lambda secs: None)
    for key in ops.SETTABLE:
        monkeypatch.delenv(key, raising=False)
    return env


class FakeRunner:
    """Stands in for run_command: applies set-env.sh writes to the test .env, answers systemctl."""

    def __init__(self, env, active=None, sudo_password=False, restart_code=0):
        self.env, self.calls, self.sudo_password, self.restart_code = env, [], sudo_password, restart_code
        self.active = list(active) if active is not None else [True] * 20   # one answer per is-active call

    def __call__(self, argv, timeout, cwd, tick=None):
        self.calls.append((argv, timeout))
        if tick:
            tick()
        if argv[:2] == SET_ENV:
            key, value = argv[2].split("=", 1)
            lines = [ln for ln in self.env.read_text().splitlines() if not ln.startswith(key + "=")]
            self.env.write_text("\n".join([*lines, f"{key}={value}"]) + "\n")
            return 0, f"updated {key}\napply with: sudo systemctl restart meme-agents\n"
        if argv[0] == "sudo":
            return (1, "sudo: a password is required") if self.sudo_password else (self.restart_code, "")
        if argv[:2] == ["systemctl", "is-active"]:
            return (0, "active") if self.active.pop(0) else (3, "inactive")
        return 0, "deployed abc123"


def test_settable_allowlist_and_bounds(tmp_path):
    assert ops.validate_set("POSITION_MAX_USD", "15") == "15"
    assert ops.validate_set("position_max_usd", " 7.5 ") == "7.5"
    assert ops.validate_set("MAX_OPEN_POSITIONS", "4") == "4"
    assert ops.validate_set("PF_MIN_LIQUIDITY_USD", "1e5") == "100000"
    assert ops.validate_set("GATE_NEUTRAL_VOTES", "off") == "false"
    assert ops.validate_set("TRIAGE_ENABLED", "Yes") == "true"
    assert ops.validate_set("TELEGRAM_DIGEST", "Wins") == "wins"
    assert ops.validate_set("X_MONTHLY_BUDGET_USD", "150") == "150"      # the server's current value must fit
    for word in ("true", "on", "YES", "1"):
        assert ops.validate_set("LIVE_DRY_RUN", word) == "true"
    with pytest.raises(ops.OpsError, match="can only be turned on"):
        ops.validate_set("LIVE_DRY_RUN", "off")
    with pytest.raises(ops.OpsError, match="use /dryrun on"):
        ops.validate_set("LIVE_DRY_RUN", "maybe")
    for key, raw in [("POSITION_MAX_USD", "50"), ("BANKROLL_USD", "0"), ("BANKROLL_USD", "nan"), ("BANKROLL_USD", "inf"),
                     ("MAX_OPEN_POSITIONS", "2.5"), ("MAX_OPEN_POSITIONS", "9"), ("CONSENSUS_MIN_MEAN_CONFIDENCE", "0.6"),
                     ("GATE_NEUTRAL_VOTES", "maybe"), ("TELEGRAM_DIGEST", "loud"), ("LIVE_DRY_RUN", "false"),
                     ("LIVE_DRY_RUN", "0"), ("POSITION_MAX_USD", ""), ("POSITION_MAX_USD", "15; rm -rf /")]:
        with pytest.raises(ops.OpsError):
            ops.validate_set(key, raw)
    for key in ("MODE", "LIVE_CONFIRM", "LIVE_MAX_WALLET_SOL", "WALLET_PRIVATE_KEY", "ANTHROPIC_API_KEY",
                "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "DB_PATH", "STOP_FILE", "HELIUS_RPC_URL",
                "PUMPPORTAL_TRADE_URL", "LLM_MODEL", "", "LLM_DAILY_BUDGET_USD; rm -rf /"):
        with pytest.raises(ops.OpsError):
            ops.validate_set(key, "1")
    # the bot's own cross-field rules, against the settings as .env would load them
    s = _settings(tmp_path)
    assert ops.validate_set("POSITION_MIN_USD", "9", s) == "9"
    with pytest.raises(ops.OpsError, match="POSITION_MIN_USD=15 refused: POSITION_MIN_USD must not exceed"):
        ops.validate_set("POSITION_MIN_USD", "15", s)
    with pytest.raises(ops.OpsError, match="must not exceed POSITION_MAX_USD"):
        ops.validate_set("POSITION_MAX_USD", "3", s)
    with pytest.raises(ops.OpsError, match="PF_MIN_AGE_MIN must not exceed"):
        ops.validate_set("PF_MIN_AGE_MIN", "100", s)
    assert ops.validate("update", None) == {} and ops.validate("restart", {"key": "MODE"}) == {}
    with pytest.raises(ops.OpsError, match="args must be an object"):
        ops.validate("set", "abc")
    with pytest.raises(ops.OpsError, match="args must be an object"):
        ops.validate("set", ["x"])
    with pytest.raises(ops.OpsError):
        ops.validate("shell", {"cmd": "id"})
    assert ops.validate("set", {"key": "live_dry_run", "value": "on", "restart": 1}) == {
        "key": "LIVE_DRY_RUN", "value": "true", "restart": True}
    assert ops.allowed("POSITION_MAX_USD") == "1 to 20" and ops.allowed("TELEGRAM_DIGEST") == "all/wins/off"
    assert ops.allowed("LIVE_DRY_RUN") == "true only" and ops.allowed("TRIAGE_ENABLED") == "true/false"
    assert ops.SETTABLE["CONSENSUS_MIN_MEAN_CONFIDENCE"][1] == 0.65     # the brief's gate cannot be lowered
    words = ("KEY", "TOKEN", "SECRET", "PRIVATE", "URL", "PATH", "FILE", "DIR", "MODE", "CONFIRM", "WALLET", "CHAT")
    assert not [k for k in ops.SETTABLE if any(w in k for w in words)]


def test_set_listing_shows_running_values_and_what_waits_in_env(tmp_path, _isolated):
    s = _settings(tmp_path)
    text = ops.settable_text(s)
    assert text.startswith("/set KEY=VALUE") and "Running values" in text
    assert "POSITION_MAX_USD=10.0  (1 to 20)" in text and "LIVE_DRY_RUN=true  (true only)" in text
    assert "restart to apply" not in text
    _isolated.write_text("POSITION_MAX_USD=15\nLIVE_DRY_RUN=true\nTELEGRAM_DIGEST=wins\n")
    text = ops.settable_text(s)
    assert "POSITION_MAX_USD=10.0  (1 to 20)  -> 15 in .env, restart to apply" in text
    assert "TELEGRAM_DIGEST=all  (all/wins/off)  -> wins in .env, restart to apply" in text
    assert "LIVE_DRY_RUN=true  (true only)\n" in text                      # same value: no note
    # the cross-field check uses .env's pending values (max 15), not the running ones (max 10)
    assert ops.validate_set("POSITION_MIN_USD", "12", ops.current_settings(s)) == "12"
    with pytest.raises(ops.OpsError, match="must not exceed"):
        ops.validate_set("POSITION_MIN_USD", "12", s)
    _isolated.write_text("MODE=weird\n")                                  # a broken .env: the running values stand in
    assert ops.current_settings(s) is s and ops.env_loads(s) == "MODE must be paper or live"


def test_queue_round_trip_and_the_executor_checks_again(tmp_path, _isolated):
    s = _settings(tmp_path)
    req = ops.request(s, "set", {"key": "position_max_usd", "value": "15"})
    assert req["args"] == {"key": "POSITION_MAX_USD", "value": "15", "restart": False}
    assert (ops.ops_dir(s) / f"{req['id']}.request").exists() and ops.ops_dir(s) == tmp_path / "ops"
    assert [r["id"] for r in ops.pending(s)] == [req["id"]]
    runner = FakeRunner(_isolated)
    done = ops.watch_once(s, runner)
    assert len(done) == 1 and done[0]["ok"] and done[0]["code"] == 0 and ops.describe(done[0]) == "set POSITION_MAX_USD=15"
    assert runner.calls == [([*SET_ENV, "POSITION_MAX_USD=15"], 60)]
    assert "POSITION_MAX_USD=15" in _isolated.read_text()
    assert (ops.ops_dir(s) / "env.backup").read_text() == "POSITION_MIN_USD=5\nPOSITION_MAX_USD=10\n"
    assert not ops.pending(s) and ops.watcher_alive(s)
    got = ops.results(s)
    assert len(got) == 1 and got[0][1]["id"] == req["id"] and got[0][0].name == f"{req['id']}.result"
    assert ops.history(s)[0]["action"] == "set" and ops.history(s)[0]["output"].startswith("updated")
    assert ops.format_result(done[0]).startswith("✅ set POSITION_MAX_USD=15: written to .env (0 s). Restart to apply")
    # a request file written by anything else must pass the same checks, or it is refused unrun;
    # nothing in it chooses where the result goes, and nothing in it can take the watcher down
    d = ops.ops_dir(s)
    (d / "1-set.request").write_text(json.dumps({"id": "1-set", "action": "set", "ts": now_s(),
                                                 "args": {"key": "MODE", "value": "live"}}))
    (d / "2-shell.request").write_text(json.dumps({"id": "2-shell", "action": "shell", "ts": now_s(),
                                                   "args": {"cmd": "rm -rf /"}}))
    (d / "3-restart.request").write_text(json.dumps({"id": "3-restart", "action": "restart", "args": {},
                                                     "ts": now_s() - ops.MAX_REQUEST_AGE_S - 1}))
    (d / "4-update.running").write_text(json.dumps({"id": "4-update", "action": "update", "args": {}, "ts": now_s()}))
    (d / "5-junk.request").write_text("not json")
    (d / "6-escape.request").write_text(json.dumps({"id": "../../escaped", "action": "update", "args": {}, "ts": now_s()}))
    (d / "7-args.request").write_text(json.dumps({"id": "7-args", "action": "set", "args": "abc", "ts": now_s()}))
    (d / "8-ts.request").write_text(json.dumps({"id": "8-ts", "action": "restart", "args": {}, "ts": "zzz"}))
    (d / "9-list.request").write_text(json.dumps({"id": "9-list", "action": "set", "args": ["x"], "ts": now_s()}))
    (d / "a-min.request").write_text(json.dumps({"id": "a-min", "action": "set", "ts": now_s(),
                                                 "args": {"key": "POSITION_MIN_USD", "value": "16"}}))
    runner.calls.clear()
    done = {r["id"]: r for r in ops.watch_once(s, runner)}
    assert sorted(done) == ["../../escaped", "1-set", "2-shell", "3-restart", "4-update", "7-args", "8-ts", "9-list", "a-min"]
    assert [r["ok"] for r in done.values()].count(True) == 1 and done["../../escaped"]["ok"]
    assert [a for a, _ in runner.calls] == [["bash", str(s.path(".") / "deploy" / "update.sh")]]
    assert "cannot be changed from the phone" in done["1-set"]["output"]
    assert "unknown action" in done["2-shell"]["output"]
    assert "already 10 min old when the ops service first saw it" in done["3-restart"]["output"]
    assert "interrupted" in done["4-update"]["output"] and not (d / "4-update.running").exists()
    assert "args must be an object" in done["7-args"]["output"] and "args must be an object" in done["9-list"]["output"]
    assert "min old" in done["8-ts"]["output"]
    assert "POSITION_MIN_USD=16 refused: POSITION_MIN_USD must not exceed POSITION_MAX_USD" in done["a-min"]["output"]
    assert (d / "6-escape.result").exists() and not list(tmp_path.parent.glob("escaped.result"))
    assert not list(tmp_path.glob("*.result")) and not (d / "1-set.request").exists() and (d / "5-junk.request").exists()
    assert ops.format_result(done["3-restart"]).startswith("❌ restart failed")
    assert ops.watch_once(s, runner) == []                                 # nothing left, nothing re-run
    nothing = {"action": "update", "args": {}, "ok": True, "output": "already at abc on main; nothing to do",
               "started": 1.0, "finished": 2.0}
    assert ops.format_result(nothing).startswith("✅ update: already on the latest code")
    git_auth = {**nothing, "ok": False, "code": 128, "output": "fatal: could not read Username for 'https://github.com'"}
    assert "git config credential.helper store" in ops.format_result(git_auth)
    weird = {"action": "set", "args": "x", "ok": True, "output": 7, "started": "a", "finished": None}
    assert ops.format_result(weird).startswith("✅ set None=None") and ops.describe(weird) == "set None=None"


def test_requests_wait_behind_a_long_update_without_expiring(tmp_path, monkeypatch, _isolated):
    s = _settings(tmp_path)
    clock = [1_700_000_000.0]
    monkeypatch.setattr(ops, "now_s", lambda: clock[0])
    ops.request(s, "update")
    ops.request(s, "restart")
    runner = FakeRunner(_isolated)

    def slow(argv, timeout, cwd, tick=None):
        if argv[-1].endswith("update.sh"):
            clock[0] += ops.TIMEOUT_S["update"]                        # a 25-minute build and test
        return runner(argv, timeout, cwd, tick)

    done = ops.watch_once(s, slow)
    assert [r["action"] for r in done] == ["update", "restart"] and all(r["ok"] for r in done)
    assert [a[0] for a, _ in runner.calls] == ["bash", "sudo", "systemctl"]
    assert done[1]["started"] - ops.pending.__globals__["MAX_REQUEST_AGE_S"] > done[1]["finished"] - 2000  # it did wait


def test_a_set_the_bot_will_not_load_is_reverted_before_any_restart(tmp_path, _isolated):
    s = _settings(tmp_path)
    ops.request(s, "set", {"key": "LLM_DAILY_BUDGET_USD", "value": "7"})
    original = _isolated.read_text()

    def corrupting(argv, timeout, cwd, tick=None):      # set-env.sh "succeeds" but leaves a file the bot refuses
        _isolated.write_text(original + "MODE=weird\n")
        return 0, "updated LLM_DAILY_BUDGET_USD"

    [res] = ops.watch_once(s, corrupting)
    assert not res["ok"] and "refused: .env would not load afterwards (MODE must be paper or live)" in res["output"]
    assert "the previous .env is restored" in res["output"] and _isolated.read_text() == original
    assert ops.format_result(res).startswith("❌ set LLM_DAILY_BUDGET_USD=7 failed")


def test_a_restart_the_bot_does_not_survive_reverts_the_last_change(tmp_path, _isolated):
    s = _settings(tmp_path, MODE="live", LIVE_DRY_RUN="false")
    original = _isolated.read_text()
    ops.request(s, "set", {"key": "LIVE_DRY_RUN", "value": "true", "restart": True})
    runner = FakeRunner(_isolated, active=[False, False, True])         # down, still down after settling, up on revert
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and ops.describe(res) == "dry run ON"
    assert [a[0] for a, _ in runner.calls] == ["bash", "sudo", "systemctl", "systemctl", "sudo", "systemctl"]
    assert "the previous .env is restored and the bot restarted again" in res["output"]
    assert "the bot is active again on the previous settings" in res["output"]
    assert _isolated.read_text() == original
    # a plain /restart after a plain /set behaves the same while the backup is fresh ...
    ops.request(s, "set", {"key": "POSITION_MAX_USD", "value": "12"})
    runner = FakeRunner(_isolated, active=[False, False, True])
    [res] = ops.watch_once(s, runner)
    assert res["ok"] and "POSITION_MAX_USD=12" in _isolated.read_text()
    ops.request(s, "restart")
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and "previous .env is restored" in res["output"] and _isolated.read_text() == original
    # ... and not once the backup is old or equal to .env
    ops.request(s, "restart")
    runner = FakeRunner(_isolated, active=[False, False])
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and "previous .env is restored" not in res["output"] and "not active after the restart" in res["output"]
    assert [a[0] for a, _ in runner.calls] == ["sudo", "systemctl", "systemctl"]
    # a restart whose command timed out but whose bot is up is a success, with a note
    ops.request(s, "restart")
    runner = FakeRunner(_isolated, restart_code=124)
    [res] = ops.watch_once(s, runner)
    assert res["ok"] and "reported an error but the bot is active" in res["output"]
    # no password, no retry loop: fail at once with the sudoers hint
    ops.request(s, "restart")
    runner = FakeRunner(_isolated, sudo_password=True)
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and res["code"] == 1 and [a[0] for a, _ in runner.calls] == ["sudo"]
    assert "sudoers line" in ops.format_result(res)


def test_run_command_has_no_terminal_and_kills_the_whole_process_group(tmp_path, monkeypatch):
    monkeypatch.setattr(ops, "HEARTBEAT_S", 0.05)
    ticks = []
    code, out = ops.run_command(["bash", "-c", "echo hi; echo err >&2; exit 3"], 10, tmp_path, lambda: ticks.append(1))
    assert code == 3 and out == "hi\nerr\n"
    code, out = ops.run_command(["bash", "-c", 'read -r x; echo "stdin:$x $MEME_AGENTS_NONINTERACTIVE $GIT_TERMINAL_PROMPT"'],
                                10, tmp_path)
    assert code == 0 and out == "stdin: 1 0\n"
    t0 = time.monotonic()                                   # `sleep` is a grandchild holding the pipe
    code, out = ops.run_command(["bash", "-c", "echo start; sleep 30; true"], 0.2, tmp_path, lambda: ticks.append(1))
    assert code == 124 and out.startswith("start") and "timed out" in out and ticks
    assert time.monotonic() - t0 < 10
    code, out = ops.run_command(["/no/such/program"], 1, tmp_path)
    assert code == 127 and "cannot run" in out


def test_watch_loop_exits_after_a_deploy_on_sigterm_and_never_runs_twice(tmp_path, monkeypatch, _isolated):
    s = _settings(tmp_path)
    handlers, restored = {}, []

    def fake_signal(sig, handler):
        restored.append((sig, handler)) if handler is None or handler == "prev" else handlers.__setitem__(sig, handler)
        return "prev"

    monkeypatch.setattr(ops.signal, "signal", fake_signal)
    heads = iter(["aaa", "bbb"])
    monkeypatch.setattr(ops, "_git_head", lambda app: next(heads, "bbb"))
    ops.request(s, "update")
    slept = []
    assert ops.watch(s, lambda *a, **k: (0, "deployed bbb"), interval=0.01, sleep=slept.append) == 0
    assert not slept and not ops.pending(s)                    # left at once, for systemd to restart it
    assert sorted(restored) == [(signal.SIGINT, "prev"), (signal.SIGTERM, "prev")]   # handlers put back
    # nothing to deploy: the loop keeps going until the service stops it
    monkeypatch.setattr(ops, "_git_head", lambda app: "bbb")
    ops.request(s, "update")

    def sleep_then_stop(secs):
        slept.append(secs)
        handlers[signal.SIGTERM](signal.SIGTERM, None)

    assert ops.watch(s, lambda *a, **k: (0, "nothing to do"), interval=0.01, sleep=sleep_then_stop) == 0
    assert slept == [0.01] and ops.history(s, 1)[0]["ok"]
    # one watcher at a time: a hand-run `ops --once` refuses while the service holds the lock
    fd = ops.try_lock(s)
    assert fd is not None
    try:
        with pytest.raises(ops.OpsError, match="another ops watcher is running"):
            ops.watch_once(s)
        assert ops.watch(s, lambda *a, **k: (0, ""), sleep=slept.append) == 1
    finally:
        os.close(fd)
    assert ops.watch_once(s) == []


class FakeRisk:
    paused_reason = None


class FakePositions:
    def __init__(self, held=0):
        self.held = held

    def active(self, kind="real"):
        return [object()] * self.held


class FakeEngine:
    def __init__(self, held=0, paused=None):
        self.risk = FakeRisk()
        self.risk.paused_reason = paused
        self.positions = FakePositions(held)


def test_phone_commands_queue_for_the_ops_service(tmp_path, _isolated):
    s = _settings(tmp_path)
    http = FakeHttp([
        [_msg(1, "/update")],                                           # no ops service yet
        [_msg(2, "/panel"), _cb(3, "confirm:update"), _cb(4, "update"), _msg(5, "/set"),
         _msg(6, "/set position_max_usd=15"), _msg(7, "/set LIVE_DRY_RUN=false"), _msg(8, "/set MODE=live"),
         _msg(9, "/set WALLET_PRIVATE_KEY=abc"), _msg(10, "/set BANKROLL_USD"), _msg(11, "/dryrun"),
         _cb(12, "dryrun on"), _cb(13, "confirm:dryrun"), _msg(14, "/restart"), _msg(15, "/ops"), _cb(16, "ops"),
         _msg(17, "/set POSITION_MIN_USD=15"), _msg(18, "/set LIVE_DRY_RUN=on"), _msg(19, "/settings")],
    ])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            tc = TelegramCommands(Telegram(http, s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID), db, s)
            first = await tc.poll_once()
            ops.beat(s)
            return first, await tc.poll_once()
        finally:
            await db.close()

    assert asyncio.run(go()) == (1, 18)
    sent = [j for m, j in http.posts if m == "sendMessage"]
    assert sent[0]["text"].startswith("not queued: the ops service is not running") and "--ops" in sent[0]["text"]
    rows = sent[1]["reply_markup"]["inline_keyboard"]
    assert [b["callback_data"] for b in rows[3]] == ["confirm:update", "confirm:restart", "confirm:dryrun"]
    assert rows[4] == [{"text": "Ops", "callback_data": "ops"}] and PANEL[2][2][1] == "confirm:stop"
    assert sent[2]["text"].startswith("/update:") and sent[2]["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == "update"
    assert sent[3]["text"].startswith("queued: update.") and "pause" not in sent[3]["text"]
    assert sent[4]["text"].startswith("/set KEY=VALUE") and "POSITION_MAX_USD=10.0  (1 to 20)" in sent[4]["text"]
    assert "Not from the phone: MODE, LIVE_CONFIRM" in sent[4]["text"]
    assert sent[5]["text"].startswith("queued: set POSITION_MAX_USD=15.")
    assert sent[6]["text"].startswith("LIVE_DRY_RUN can only be turned on from the phone")
    assert sent[7]["text"].startswith("MODE cannot be changed from the phone")
    assert sent[8]["text"].startswith("WALLET_PRIVATE_KEY cannot be changed from the phone")
    assert sent[9]["text"] == "use /set KEY=VALUE; /set alone lists the keys and their limits"
    assert sent[10]["text"].startswith("/dryrun on is the only direction")
    assert sent[11]["text"] == "MODE=paper: nothing is ever sent. /dryrun applies to live mode only"
    assert sent[12]["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == "dryrun on" and CONFIRM["dryrun"] == "dryrun on"
    assert sent[13]["text"].startswith("queued: restart.") and "pause" not in sent[13]["text"]
    assert sent[14]["text"].startswith("ops service: running") and "queued: 3" in sent[14]["text"]
    assert "· update" in sent[14]["text"] and "· set POSITION_MAX_USD=15" in sent[14]["text"] and "· restart" in sent[14]["text"]
    assert sent[15]["text"] == sent[14]["text"]
    assert sent[16]["text"] == "POSITION_MIN_USD=15 refused: POSITION_MIN_USD must not exceed POSITION_MAX_USD"
    assert sent[17]["text"].startswith("queued: dry run ON.")           # /set LIVE_DRY_RUN=on is the same flag
    assert sent[18]["text"].startswith("current settings (running values; /set changes")
    assert "LIVE_DRY_RUN=True" in sent[18]["text"]
    queued = ops.pending(s)
    assert [(r["action"], r["args"]) for r in queued] == [
        ("update", {}), ("set", {"key": "POSITION_MAX_USD", "value": "15", "restart": False}), ("restart", {}),
        ("set", {"key": "LIVE_DRY_RUN", "value": "true", "restart": False})]
    assert all(r["from"] == "telegram" for r in queued) and not ops.keep_pause_path(s).exists()


def test_dryrun_on_in_live_mode_refuses_while_positions_are_open(tmp_path, _isolated):
    s = _settings(tmp_path, MODE="live", LIVE_DRY_RUN="false")
    ops.beat(s)
    http = FakeHttp([[_msg(1, "/dryrun on"), _msg(2, "/dryrun on force"), _msg(3, "/dryrun off")],
                     [_msg(4, "/dryrun on")]])
    eng = FakeEngine(held=2)

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            tc = TelegramCommands(Telegram(http, "1:a", "42"), db, s, engine=eng)
            await tc.poll_once()
            eng.positions.held = 0
            await tc.poll_once()
        finally:
            await db.close()

    asyncio.run(go())
    sent = [j for m, j in http.posts if m == "sendMessage"]
    assert sent[0]["text"].startswith("not queued: 2 open live position(s).") and "/dryrun on force" in sent[0]["text"]
    assert sent[1]["text"].startswith("queued: dry run ON.") and "2 open position(s) will be closed in paper" in sent[1]["text"]
    assert sent[2]["text"].startswith("/dryrun on is the only direction")
    assert sent[3]["text"].startswith("queued: dry run ON.") and "closed in paper" not in sent[3]["text"]
    assert [r["args"] for r in ops.pending(s)] == [{"key": "LIVE_DRY_RUN", "value": "true", "restart": True}] * 2
    s2 = _settings(tmp_path, MODE="live", LIVE_DRY_RUN="true")
    http = FakeHttp([[_msg(5, "/dryrun on")]])

    async def again():
        db = await Database(s2.DB_PATH).open()
        try:
            await TelegramCommands(Telegram(http, "1:a", "42"), db, s2).poll_once()
        finally:
            await db.close()

    asyncio.run(again())
    assert http.posts[0][1]["text"] == "dry run is already on (LIVE_DRY_RUN=true): live mode, nothing is sent"


def test_a_phone_restart_keeps_the_daily_loss_pause_unless_reset(tmp_path, _isolated):
    s = _settings(tmp_path)
    ops.beat(s)
    eng = FakeEngine(paused="daily loss cap hit: -25.00 USD <= -25.00 USD; restart to resume")
    http = FakeHttp([[_msg(1, "/restart")], [_msg(2, "/restart reset")], [_msg(3, "/update")]])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            tc = TelegramCommands(Telegram(http, "1:a", "42"), db, s, engine=eng)
            out = []
            for _ in range(3):
                await tc.poll_once()
                out.append(ops.keep_pause_path(s).exists())
                ops.keep_pause_path(s).unlink(missing_ok=True)
            return out
        finally:
            await db.close()

    assert asyncio.run(go()) == [True, False, True]
    sent = [j["text"] for m, j in http.posts if m == "sendMessage"]
    assert "The daily-loss pause is kept across this restart (/restart reset would end it)" in sent[0]
    assert "This ends the daily-loss pause and restarts the loss window" in sent[1]
    assert "The daily-loss pause is kept" in sent[2]
    # the engine consumes the marker once, and ignores a stale one
    ops.request(s, "restart", keep_pause=True)
    assert ops.consume_keep_pause(s) is True and ops.consume_keep_pause(s) is False
    ops.request(s, "restart", keep_pause=True)
    old = time.time() - ops.KEEP_PAUSE_MAX_AGE_S - 5
    os.utime(ops.keep_pause_path(s), (old, old))
    assert ops.consume_keep_pause(s) is False and not ops.keep_pause_path(s).exists()
    ops.request(s, "set", {"key": "POSITION_MAX_USD", "value": "12"}, keep_pause=True)   # no restart: no marker
    assert not ops.keep_pause_path(s).exists()


def test_results_reach_the_chat_and_survive_a_refused_send(tmp_path, _isolated):
    s = _settings(tmp_path)
    d = ops.ops_dir(s)
    d.mkdir(parents=True)
    base = {"started": 100.0, "finished": 103.0, "code": 0}
    (d / "1-set.result").write_text(json.dumps({**base, "id": "1-set", "action": "set", "ok": True,
                                                "args": {"key": "POSITION_MAX_USD", "value": "15", "restart": False},
                                                "output": "updated POSITION_MAX_USD"}))
    (d / "2-update.result").write_text(json.dumps({**base, "id": "2-update", "action": "update", "ok": False, "code": 128,
                                                   "args": {}, "output": "fatal: could not read Username for 'https://github.com'"}))
    (d / "3-update.result").write_text(json.dumps({**base, "id": "3-update", "action": "update", "ok": True, "args": {},
                                                   "finished": 400.0, "output": "validating main\n" + "x\n" * 30 + "deployed abc123"}))
    (d / "4-set.result").write_text(json.dumps({**base, "id": "4-set", "action": "set", "ok": True,
                                                "args": {"key": "LIVE_DRY_RUN", "value": "true", "restart": True},
                                                "output": "updated LIVE_DRY_RUN\nactive"}))
    (d / "5-bad.result").write_text("{")
    (d / "6-odd.result").write_text(json.dumps({"id": "6-odd", "action": "set", "args": "x", "ok": True,
                                                "started": "soon", "finished": None, "output": ["list"]}))
    http = FakeHttp([])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            tc = TelegramCommands(Telegram(http, "1:a", "42"), db, s)
            n = await tc.deliver_results()
            return n, await tc.deliver_results()
        finally:
            await db.close()

    assert asyncio.run(go()) == (5, 0)
    sent = [j for m, j in http.posts if m == "sendMessage"]
    assert sent[0]["text"].startswith("✅ set POSITION_MAX_USD=15: written to .env (3 s). Restart to apply")
    assert sent[0]["reply_markup"]["inline_keyboard"] == [[{"text": "Restart now", "callback_data": "confirm:restart"}]]
    assert sent[1]["text"].startswith("❌ update failed (3 s) (exit 128)") and "credential.helper store" in sent[1]["text"]
    assert "reply_markup" not in sent[1]
    assert sent[2]["text"].startswith("✅ update done (5 min 0 s)") and sent[2]["text"].endswith("deployed abc123")
    assert sent[2]["text"].count("\n") <= 13                     # only the tail of a long output
    assert sent[3]["text"].startswith("✅ dry run ON: written to .env and the bot restarted (3 s)")
    assert sent[4]["text"].startswith("✅ set None=None")          # odd types never block the queue
    assert sorted(p.name for p in d.iterdir()) == ["5-bad.result"]
    # Telegram refusing a message keeps the file for the next round; an old one is set aside
    (d / "7-restart.result").write_text(json.dumps({**base, "id": "7-restart", "action": "restart", "ok": True,
                                                    "args": {}, "output": "active", "finished": now_s()}))
    (d / "8-old.result").write_text(json.dumps({**base, "id": "8-old", "action": "restart", "ok": True,
                                                "args": {}, "output": "active", "finished": now_s() - 3600}))

    class Refusing(FakeHttp):
        async def post(self, url, json=None, **kw):
            self.posts.append((url.rsplit("/", 1)[1], json))
            return Resp(502, {"ok": False})

    http = Refusing([])

    async def refused():
        db = await Database(s.DB_PATH).open()
        try:
            return await TelegramCommands(Telegram(http, "1:a", "42"), db, s).deliver_results()
        finally:
            await db.close()

    assert asyncio.run(refused()) == 0
    assert sorted(p.name for p in d.iterdir()) == ["5-bad.result", "7-restart.result", "8-old.result.bad"]


def test_the_telegram_offset_survives_a_restart_so_a_restart_is_not_replayed(tmp_path, _isolated):
    s = _settings(tmp_path)
    ops.beat(s)
    http = FakeHttp([[_msg(41, "/restart")]])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            first = TelegramCommands(Telegram(http, "1:a", "42"), db, s)
            await first.poll_once()                     # the bot that queued the restart is killed right after
            assert await db.kv_get("telegram_offset") == "42"
            second = TelegramCommands(Telegram(http, "1:a", "42"), db, s)
            await second._load_offset()
            assert second.offset == 42
            await second.poll_once()                    # a fresh getUpdates asks for 42, never 41 again
        finally:
            await db.close()

    asyncio.run(go())
    assert [g.get("offset") for g in http.gets] == [None, 42]
    assert len([r for r in ops.pending(s) if r["action"] == "restart"]) == 1


def test_ops_queue_text_and_the_cli(tmp_path, monkeypatch, capsys):
    s = _settings(tmp_path)
    assert ops.format_queue(s).startswith("ops service: never seen") and "queued: nothing" in ops.format_queue(s)
    ops.beat(s)
    stale = now_s() - ops.HEARTBEAT_STALE_S - 120
    os.utime(ops.heartbeat_path(s), (stale, stale))
    assert ops.format_queue(s).startswith("ops service: DOWN (last seen ") and not ops.watcher_alive(s)
    assert "min ago). On the server: sudo systemctl restart meme-agents-ops" in ops.format_queue(s)
    import bot.config
    from bot.__main__ import main
    monkeypatch.setattr(bot.config, "ROOT", tmp_path)                      # the CLI's .env and data/ live here
    (tmp_path / ".env").write_text("LOG_FILE=\n")
    assert main(["ops", "--once"]) == 0 and "nothing queued" in capsys.readouterr().out
    assert main(["ops"]) == 0 and capsys.readouterr().out.startswith("ops service: ")
    cli = load_settings(tmp_path / ".env")
    ops.request(cli, "restart")
    monkeypatch.setattr(ops, "run_command", lambda argv, timeout, cwd, tick=None: (1, "sudo: a password is required"))
    assert main(["ops", "--once"]) == 1 and "1 request(s) processed" in capsys.readouterr().out
    # a .env the bot refuses must not take the ops service down: /set is how it gets repaired
    (tmp_path / ".env").write_text("LOG_FILE=\nMODE=weird\n")
    assert main(["ops"]) == 0
    out = capsys.readouterr()
    assert out.out.startswith("ops service: ") and "config error: MODE must be paper or live" in out.err
    assert "so that /set can repair .env" in out.err
