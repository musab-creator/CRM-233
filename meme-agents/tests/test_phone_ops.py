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
    """Stands in for run_command: applies set-env.sh writes to the test .env, answers systemctl
    (`states` is one ActiveState answer per poll, the last one repeating), notes whether the
    keep-pause marker was there when the restart ran, and what update.sh "printed"."""

    def __init__(self, env, states=("active",), sudo_password=False, restart_code=0, update_out="deployed abc123",
                 marker=None, sudo_nnp=False):
        self.env, self.calls, self.sudo_password, self.restart_code = env, [], sudo_password, restart_code
        self.sudo_nnp = sudo_nnp
        self.states, self.update_out, self.marker, self.marker_seen = list(states), update_out, marker, []

    def __call__(self, argv, timeout, cwd, tick=None):
        self.calls.append((argv, timeout))
        if tick:
            tick()
        if argv[:2] == SET_ENV:
            key, value = argv[2].split("=", 1)
            lines = [ln for ln in self.env.read_text().splitlines() if not ln.startswith(key + "=")]
            self.env.write_text("\n".join([*lines, f"{key}={value}"]) + "\n")
            return 0, f"updated {key}\napply with: sudo systemctl restart meme-agents\n"
        if argv[0] == "sudo" or argv[-1].endswith("update.sh"):
            if self.marker is not None:
                self.marker_seen.append(self.marker.exists())
            if argv[0] == "sudo":
                if self.sudo_nnp:
                    return 1, ('sudo: The "no new privileges" flag is set, which prevents sudo from running as root.\n'
                               "sudo: If sudo is running in a container, you may need to adjust the container "
                               "configuration to disable the flag.")
                return (1, "sudo: a password is required") if self.sudo_password else (self.restart_code, "")
            return 0, self.update_out
        if argv[:3] == ["systemctl", "show", "-p"]:
            state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
            return 0, state + "\n"
        return 0, ""


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
    # nothing ran but update.sh (plus a read of the bot's state afterwards)
    assert [a for a, _ in runner.calls if a[:2] != ["systemctl", "show"]] == [["bash", str(s.path(".") / "deploy" / "update.sh")]]
    assert "cannot be changed from the phone" in done["1-set"]["output"]
    assert "unknown action" in done["2-shell"]["output"]
    assert "already 10 min old when the ops service came up" in done["3-restart"]["output"]
    assert "interrupted" in done["4-update"]["output"] and not (d / "4-update.running").exists()
    assert "args must be an object" in done["7-args"]["output"] and "args must be an object" in done["9-list"]["output"]
    assert "min old" in done["8-ts"]["output"]
    assert "POSITION_MIN_USD=16 refused: POSITION_MIN_USD must not exceed POSITION_MAX_USD" in done["a-min"]["output"]
    assert (d / "6-escape.result").exists() and not list(tmp_path.parent.glob("escaped.result"))
    assert not list(tmp_path.glob("*.result")) and not (d / "1-set.request").exists()
    assert not (d / "5-junk.request").exists() and (d / "5-junk.request.bad").exists()   # set aside, once
    assert ops.format_result(done["3-restart"]).startswith("❌ restart failed")
    assert ops.watch_once(s, runner) == []                                 # nothing left, nothing re-run
    nothing = {"action": "update", "args": {}, "ok": True, "output": "already at abc on main; nothing to do",
               "started": 1.0, "finished": 2.0}
    assert ops.format_result(nothing).startswith("✅ update: already on the latest code")
    git_auth = {**nothing, "ok": False, "code": 128, "output": "fatal: could not read Username for 'https://github.com'"}
    assert "git config credential.helper store" in ops.format_result(git_auth)
    weird = {"action": "set", "args": "x", "ok": True, "output": 7, "started": "a", "finished": None}
    assert ops.format_result(weird).startswith("✅ set None=None") and ops.describe(weird) == "set None=None"


def test_requests_made_while_the_service_runs_never_expire(tmp_path, monkeypatch, _isolated):
    s = _settings(tmp_path)
    t0 = 1_700_000_000.0
    clock = [t0]
    monkeypatch.setattr(ops, "now_s", lambda: clock[0])
    ops.request(s, "update")
    runner = FakeRunner(_isolated)

    def slow(argv, timeout, cwd, tick=None):
        if argv[-1].endswith("update.sh"):
            clock[0] += 300                                           # five minutes in, the phone sends /restart
            ops.request(s, "restart")
            clock[0] += ops.TIMEOUT_S["update"] - 300                 # ... and the build runs 20 more minutes
        return runner(argv, timeout, cwd, tick)

    since = ops.service_up_since(s)
    assert since == t0
    done = ops.watch_once(s, slow, since=since)
    assert [r["action"] for r in done] == ["update"] and done[0]["ok"]
    [res] = ops.watch_once(s, runner, since=ops.service_up_since(s))   # the next round picks the restart up
    assert res["action"] == "restart" and res["ok"], res["output"]
    assert res["started"] - t0 >= ops.TIMEOUT_S["update"] and res["started"] - ops.MAX_REQUEST_AGE_S > t0 + 300
    # update.sh, a read of the bot's state after it, then the restart and its settle check
    assert [a[0] for a, _ in runner.calls] == ["bash", "systemctl", "sudo", "systemctl"]
    # a request made before the service came up, and long before, is the one that is refused
    (ops.ops_dir(s) / "0-old.request").write_text(json.dumps({"id": "0-old", "action": "restart", "args": {},
                                                               "ts": t0 - ops.MAX_REQUEST_AGE_S - 1}))
    [res] = ops.watch_once(s, runner, since=t0)
    assert not res["ok"] and "it was not running when it was made" in res["output"]
    # ... while one made just before it came up still runs
    (ops.ops_dir(s) / "1-recent.request").write_text(json.dumps({"id": "1-recent", "action": "restart", "args": {},
                                                                  "ts": t0 - 60}))
    [res] = ops.watch_once(s, runner, since=t0)
    assert res["ok"]


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


def test_a_restart_the_bot_does_not_survive_undoes_that_one_key(tmp_path, _isolated):
    s = _settings(tmp_path, MODE="live", LIVE_DRY_RUN="false")
    # dry run is never undone, whatever the restart does: the boundary is one way
    ops.request(s, "set", {"key": "LIVE_DRY_RUN", "value": "true", "restart": True})
    runner = FakeRunner(_isolated, states=["failed"])
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and ops.describe(res) == "dry run ON"
    assert [a[0] for a, _ in runner.calls] == ["bash", "sudo", "systemctl"]
    assert "LIVE_DRY_RUN stays on" in res["output"] and "LIVE_DRY_RUN=true" in _isolated.read_text()
    # a /set the bot will not start on: that key goes back, hand edits made in between stay
    ops.request(s, "set", {"key": "POSITION_MAX_USD", "value": "12"})
    [res] = ops.watch_once(s, FakeRunner(_isolated))
    assert res["ok"] and "POSITION_MAX_USD=12" in _isolated.read_text() and (ops.ops_dir(s) / "env.change.json").exists()
    _isolated.write_text(_isolated.read_text() + "HELIUS_API_KEY=rotated-by-hand\n")
    ops.request(s, "restart")
    runner = FakeRunner(_isolated, states=["failed", "active"])
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and "POSITION_MAX_USD is put back to 10 and the bot restarted again" in res["output"]
    assert "the bot is active again with POSITION_MAX_USD=10" in res["output"]
    assert [a for a, _ in runner.calls][2] == [*SET_ENV, "POSITION_MAX_USD=10"]
    assert [a[0] for a, _ in runner.calls] == ["sudo", "systemctl", "bash", "sudo", "systemctl"]
    assert "POSITION_MAX_USD=10" in _isolated.read_text() and "HELIUS_API_KEY=rotated-by-hand" in _isolated.read_text()
    assert not (ops.ops_dir(s) / "env.change.json").exists()
    # a /set the bot already started on is retired: a later failing restart does not touch it
    ops.request(s, "set", {"key": "POSITION_MAX_USD", "value": "14", "restart": True})
    [res] = ops.watch_once(s, FakeRunner(_isolated, states=["activating", "activating", "active"]))
    assert res["ok"] and "POSITION_MAX_USD=14" in _isolated.read_text()
    ops.request(s, "restart")
    runner = FakeRunner(_isolated, states=["failed"])
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and "put back" not in res["output"] and "not active after the restart (failed)" in res["output"]
    assert [a[0] for a, _ in runner.calls] == ["sudo", "systemctl"] and "POSITION_MAX_USD=14" in _isolated.read_text()
    # a key that was not in .env before goes back to the bot's default
    ops.request(s, "set", {"key": "TRAILING_STOP_PCT", "value": "40", "restart": True})
    runner = FakeRunner(_isolated, states=["failed", "active"])
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and "TRAILING_STOP_PCT is put back to 30" in res["output"]
    assert "TRAILING_STOP_PCT=30" in _isolated.read_text()
    # systemd still retrying ("activating") is not a failure yet, and a timed-out command whose bot is up is a success
    ops.request(s, "restart")
    runner = FakeRunner(_isolated, states=["activating", "activating", "activating", "active"], restart_code=124)
    [res] = ops.watch_once(s, runner)
    assert res["ok"] and "reported an error but the bot is active" in res["output"]
    # no password, no retry loop: fail at once with the sudoers hint
    ops.request(s, "restart")
    runner = FakeRunner(_isolated, sudo_password=True)
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and res["code"] == 1 and [a[0] for a, _ in runner.calls] == ["sudo"]
    assert "sudoers line" in ops.format_result(res)
    # a planted change record undoes nothing it is not allowed to
    (ops.ops_dir(s) / "env.change.json").write_text(json.dumps({"key": "MODE", "previous": "paper", "ts": now_s()}))
    assert ops.last_change(s) is None
    (ops.ops_dir(s) / "env.change.json").write_text(json.dumps({"key": "POSITION_MAX_USD", "previous": "99", "ts": now_s()}))
    assert ops.last_change(s) is None


def test_a_set_whose_write_fails_restores_the_backup(tmp_path, _isolated):
    s = _settings(tmp_path)
    original = _isolated.read_text()
    ops.request(s, "set", {"key": "LLM_DAILY_BUDGET_USD", "value": "7"})

    def cut_short(argv, timeout, cwd, tick=None):
        _isolated.write_text("POSITION_MIN")                     # truncated mid-write, then the process died
        return 137, ""

    [res] = ops.watch_once(s, cut_short)
    assert not res["ok"] and "the write did not complete; the previous .env is restored" in res["output"]
    assert _isolated.read_text() == original and not (ops.ops_dir(s) / "env.change.json").exists()


def test_the_keep_pause_marker_exists_only_while_the_restart_runs(tmp_path, _isolated):
    s = _settings(tmp_path)
    marker = ops.keep_pause_path(s)
    ops.request(s, "restart", keep_pause=True)
    runner = FakeRunner(_isolated, marker=marker)
    [res] = ops.watch_once(s, runner)
    assert res["ok"] and runner.marker_seen == [True] and not marker.exists()
    ops.request(s, "restart", keep_pause=False)                       # /restart reset
    runner = FakeRunner(_isolated, marker=marker)
    [res] = ops.watch_once(s, runner)
    assert res["ok"] and runner.marker_seen == [False] and not marker.exists()
    ops.request(s, "update", keep_pause=True)                         # nothing to deploy: no restart, no marker left
    runner = FakeRunner(_isolated, marker=marker, update_out="already at abc; nothing to do")
    [res] = ops.watch_once(s, runner)
    assert res["ok"] and runner.marker_seen == [True] and not marker.exists()
    ops.request(s, "restart", keep_pause=True)
    runner = FakeRunner(_isolated, marker=marker, sudo_password=True)  # refused: the marker must not linger
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and not marker.exists()
    ops.request(s, "set", {"key": "POSITION_MAX_USD", "value": "12"}, keep_pause=True)   # no restart: never marked
    runner = FakeRunner(_isolated, marker=marker)
    [res] = ops.watch_once(s, runner)
    assert res["ok"] and runner.marker_seen == [] and not marker.exists()


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
    assert sent[17]["text"] == "MODE=paper: nothing is ever sent. /dryrun applies to live mode only"   # same checks as /dryrun
    assert sent[18]["text"].startswith("current settings (running values; /set changes")
    assert "LIVE_DRY_RUN=True" in sent[18]["text"]
    queued = ops.pending(s)
    assert [(r["action"], r["args"]) for r in queued] == [
        ("update", {}), ("set", {"key": "POSITION_MAX_USD", "value": "15", "restart": False}), ("restart", {})]
    assert all(r["from"] == "telegram" and r["keep_pause"] is False for r in queued)


def test_dryrun_on_in_live_mode_refuses_while_positions_are_open(tmp_path, _isolated):
    s = _settings(tmp_path, MODE="live", LIVE_DRY_RUN="false")
    ops.beat(s)
    http = FakeHttp([[_msg(1, "/dryrun on"), _msg(2, "/dryrun on force"), _msg(3, "/dryrun off"),
                      _msg(31, "/set LIVE_DRY_RUN=true")],
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
    assert sent[3]["text"].startswith("not queued: 2 open live position(s).")        # /set LIVE_DRY_RUN=true: same guard
    assert sent[4]["text"].startswith("queued: dry run ON.") and "closed in paper" not in sent[4]["text"]
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
            for _ in range(3):
                await tc.poll_once()
        finally:
            await db.close()

    asyncio.run(go())
    assert [r["keep_pause"] for r in ops.pending(s)] == [True, False, True] and not ops.keep_pause_path(s).exists()
    sent = [j["text"] for m, j in http.posts if m == "sendMessage"]
    assert "The daily-loss pause is kept across this restart (/restart reset would end it)" in sent[0]
    assert "This ends the daily-loss pause and restarts the loss window" in sent[1]
    assert "The daily-loss pause is kept" in sent[2]
    # the engine consumes the marker once, and ignores a stale one
    ops.keep_pause_path(s).write_text("x\n")
    assert ops.consume_keep_pause(s) is True and ops.consume_keep_pause(s) is False
    ops.keep_pause_path(s).write_text("x\n")
    old = time.time() - ops.KEEP_PAUSE_MAX_AGE_S - 5
    os.utime(ops.keep_pause_path(s), (old, old))
    assert ops.consume_keep_pause(s) is False and not ops.keep_pause_path(s).exists()
    assert ops.request(s, "set", {"key": "POSITION_MAX_USD", "value": "12"}, keep_pause=True)["keep_pause"] is False


def test_results_reach_the_chat_and_survive_a_refused_send(tmp_path, _isolated):
    s = _settings(tmp_path)
    d = ops.ops_dir(s)
    d.mkdir(parents=True)
    t = now_s()                         # results finished just now: a late one gets a first line (tested below)
    base = {"started": t - 3, "finished": t, "code": 0}
    (d / "1-set.result").write_text(json.dumps({**base, "id": "1-set", "action": "set", "ok": True,
                                                "args": {"key": "POSITION_MAX_USD", "value": "15", "restart": False},
                                                "output": "updated POSITION_MAX_USD"}))
    (d / "2-update.result").write_text(json.dumps({**base, "id": "2-update", "action": "update", "ok": False, "code": 128,
                                                   "args": {}, "output": "fatal: could not read Username for 'https://github.com'"}))
    (d / "3-update.result").write_text(json.dumps({**base, "id": "3-update", "action": "update", "ok": True, "args": {},
                                                   "started": t - 300, "finished": t,
                                                   "output": "validating main\n" + "x\n" * 30 + "deployed abc123"}))
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
    assert sorted(p.name for p in d.iterdir()) == ["5-bad.result.bad"]
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
    assert sorted(p.name for p in d.iterdir()) == ["5-bad.result.bad", "7-restart.result", "8-old.result.bad"]


def test_the_telegram_offset_survives_a_restart_so_a_restart_is_not_replayed(tmp_path, _isolated):
    s = _settings(tmp_path)
    ops.beat(s)
    http = FakeHttp([[_msg(41, "/restart")]])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            first = TelegramCommands(Telegram(http, "1:a", "42"), db, s)
            saved = []
            original = first.handle_update

            async def handle(u):                         # the offset is on disk before the command acts
                saved.append(await db.kv_get("telegram_offset"))
                return await original(u)

            first.handle_update = handle
            await first.poll_once()                     # the bot that queued the restart is killed right after
            assert saved == ["42"]
            second = TelegramCommands(Telegram(http, "1:a", "42"), db, s)
            stop = asyncio.Event()
            task = asyncio.create_task(second.run(stop))   # the restarted bot starts after 41, never re-reads it
            await asyncio.sleep(0.05)
            stop.set()
            await asyncio.wait_for(task, 2)
            assert second.offset == 42
        finally:
            await db.close()

    asyncio.run(go())
    assert [g.get("offset") for g in http.gets][:2] == [None, 42]
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


def test_engine_keeps_the_loss_cap_pause_when_the_marker_is_set(tmp_path):
    import json as _json

    from bot.sim import SIM_OVERRIDES, build_sim_engine
    base = dict(SIM_OVERRIDES, DB_PATH=str(tmp_path / "e.db"), LOG_FILE="", STOP_FILE=str(tmp_path / "STOP"),
                REPORTS_DIR=str(tmp_path / "rep"))
    reason = "daily loss cap hit: -25.00 USD <= -25.00 USD; restart to resume"

    async def seed_and_run(marker: bool):
        db = await Database(base["DB_PATH"]).open()
        try:                                             # as an unclean stop left it: paused
            await db.kv_set("risk_state:paper", _json.dumps({"started_at": now_s() - 600, "paused_reason": reason,
                                                             "clean_stop": False}))
        finally:
            await db.close()
        s = load_settings(overrides=base)
        if marker:
            ops.keep_pause_path(s).parent.mkdir(parents=True, exist_ok=True)
            ops.keep_pause_path(s).write_text("x\n")
        eng = build_sim_engine(s, 1)
        await eng.run(0.5)                               # a clean stop (SIGTERM from a phone /restart)
        db = await Database(base["DB_PATH"]).open()
        try:
            return _json.loads(await db.kv_get("risk_state:paper")), ops.keep_pause_path(s).exists()
        finally:
            await db.close()

    state, marker_left = asyncio.run(seed_and_run(marker=True))
    assert state["clean_stop"] is False and state["paused_reason"] == reason and not marker_left
    state, _ = asyncio.run(seed_and_run(marker=False))
    assert state["clean_stop"] is True


def test_dry_run_executor_reads_the_receipt_of_a_pending_real_transaction(tmp_path):
    from solders.keypair import Keypair

    from bot.live.executor import LiveExecutor
    from tests.test_live_executor import FakeHttp as TxHttp
    from tests.test_live_executor import FakeRpc, unsigned_tx
    s = _settings(tmp_path, MODE="live", LIVE_DRY_RUN="true")
    mint = "MintAddr"

    class FakeChain:
        async def signature_status(self, sig):
            return "ok"

        async def rpc(self, method, params):
            assert method == "getTransaction" and params[0] == "sig-real"
            return {"transaction": {"message": {"accountKeys": [{"pubkey": pubkey}]}},
                    "meta": {"err": None, "fee": 5000, "preBalances": [1_000_000_000], "postBalances": [949_995_000],
                             "preTokenBalances": [],
                             "postTokenBalances": [{"mint": mint, "owner": pubkey,
                                                    "uiTokenAmount": {"amount": "1000000000", "decimals": 6}}]}}

    kp_probe = Keypair()
    pubkey = str(kp_probe.pubkey())

    async def go2():
        db = await Database(s.DB_PATH).open()
        http = TxHttp(unsigned_tx(kp_probe))
        ex = LiveExecutor(s, db, http, kp_probe, is_graduated=lambda m: False, chain=FakeChain())
        await ex.rpc.close()
        ex.rpc = FakeRpc()
        intent = {"signature": "sig-real", "side": "buy", "mint": mint, "amount": 0.05, "price": 1e-7, "route": "pumpportal"}
        await db.kv_set(ex._intent_key(mint, "buy"), json.dumps(intent))
        fill = await ex.buy(mint, 0.05, 1e-7)
        await db.close()
        return fill, http, ex.rpc

    fill, http, rpc = asyncio.run(go2())
    assert fill.tx_sig == "sig-real" and fill.tokens == 1000.0 and abs(fill.sol - 0.050005) < 1e-9
    assert http.posts == [] and rpc.simulated == []                 # no new transaction built or simulated


# systemd sets the kernel's no-new-privileges flag on a service with a User= as soon as the unit asks for
# any seccomp-based hardening, whatever NoNewPrivileges= says; sudo then refuses to run at all
# ("sudo: The "no new privileges" flag is set, which prevents sudo from running as root"), which is how
# the first /update from the phone failed on the server.
NNP_IMPLYING = ("NoNewPrivileges", "ProtectKernelTunables", "ProtectKernelModules", "ProtectKernelLogs", "ProtectClock",
                "ProtectHostname", "LockPersonality", "RestrictRealtime", "RestrictSUIDSGID", "RestrictNamespaces",
                "RestrictAddressFamilies", "PrivateDevices", "MemoryDenyWriteExecute", "SystemCallFilter",
                "SystemCallArchitectures", "DynamicUser", "RestrictFileSystems", "SystemCallLog")


def test_the_ops_unit_never_implies_the_no_new_privileges_flag():
    unit = (ROOT / "deploy" / "meme-agents-ops.service").read_text()
    directives = {ln.split("=", 1)[0].strip() for ln in unit.splitlines() if "=" in ln and not ln.lstrip().startswith("#")}
    assert "User" in directives and "ExecStart" in directives
    assert not directives & set(NNP_IMPLYING), directives & set(NNP_IMPLYING)
    # the bot's own unit keeps the flag: it never needs sudo
    assert "NoNewPrivileges=true" in (ROOT / "deploy" / "meme-agents.service").read_text()


def test_no_new_privs_is_read_reported_and_fails_a_restart_at_once(tmp_path, _isolated):
    status = tmp_path / "status"
    status.write_text("Name:\tpython\nNoNewPrivs:\t1\nSeccomp:\t2\n")
    assert ops.no_new_privs(status) is True
    status.write_text("Name:\tpython\nNoNewPrivs:\t0\n")
    assert ops.no_new_privs(status) is False
    assert ops.no_new_privs(tmp_path / "missing") is None
    s = _settings(tmp_path)
    # sudo refusing under the flag: no settle loop, no undo, the hint names the reinstall
    ops.request(s, "restart")
    runner = FakeRunner(_isolated, sudo_nnp=True)
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and [a[0] for a, _ in runner.calls] == ["sudo"]
    text = ops.format_result(res)
    assert "no-new-privileges flag" in text and "bash deploy/update.sh && bash deploy/install.sh --ops" in text
    assert "sudoers line" not in text
    # /ops shows the flag while the watcher is up, and nothing once a reinstalled watcher reports it clear
    ops.beat(s)
    ops._write_json(ops.info_path(s), {"pid": 1, "no_new_privs": True, "started": now_s()})
    assert "⚠️ the ops service runs with the no-new-privileges flag" in ops.format_queue(s)
    ops._write_json(ops.info_path(s), {"pid": 2, "no_new_privs": False, "started": now_s()})
    assert "no-new-privileges" not in ops.format_queue(s)
    # the watcher writes that file itself at start (this process has no such flag)
    info = ops.write_info(s)
    assert info["pid"] == os.getpid() and ops.watcher_info(s)["no_new_privs"] in (False, None)


def test_update_starts_a_bot_that_had_crashed_but_leaves_a_stopped_one_alone(tmp_path, _isolated):
    """update.sh leaves a bot that was not running as it found it. The rescue's /update runs while
    the bot is down (crashed, or refused to start): that one must come back on the new code."""
    s = _settings(tmp_path)
    update = ["bash", str(s.path(".") / "deploy" / "update.sh")]
    restart = ["sudo", "-n", "systemctl", "restart", "meme-agents"]

    ops.request(s, "update", who="telegram-rescue")
    runner = FakeRunner(_isolated, states=["failed", "active"])
    [res] = ops.watch_once(s, runner)
    assert res["ok"], res["output"]
    assert [a for a, _ in runner.calls if a[:2] != ["systemctl", "show"]] == [update, restart]
    assert "the bot was down before the update (failed); starting it on the new code" in res["output"]

    ops.request(s, "update")
    runner = FakeRunner(_isolated, states=["inactive"])             # stopped on purpose: stays stopped
    [res] = ops.watch_once(s, runner)
    assert res["ok"] and [a for a, _ in runner.calls if a[:2] != ["systemctl", "show"]] == [update]
    assert "starting it" not in res["output"]

    ops.request(s, "update")
    plain = FakeRunner(_isolated)

    def failing(argv, timeout, cwd, tick=None):
        if argv[-1].endswith("update.sh"):
            plain.calls.append((argv, timeout))
            return 1, "deployment failed; restoring the previous code and environment"
        return plain(argv, timeout, cwd, tick)
    [res] = ops.watch_once(s, failing)
    assert not res["ok"] and res["code"] == 1 and [a for a, _ in plain.calls] == [update]   # no state read, no restart

    ops.request(s, "update")
    runner = FakeRunner(_isolated, states=["failed", "failed"])     # the new code does not start either
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and "the bot is not active after the restart (failed)" in res["output"]


class LoggingRunner(FakeRunner):
    """A FakeRunner whose restarts make the (failing) bot write `lines` to its log, as the real one does."""

    def __init__(self, env, log_file, lines, **kw):
        super().__init__(env, **kw)
        self.log_file, self.lines = log_file, list(lines)

    def __call__(self, argv, timeout, cwd, tick=None):
        if argv[0] == "sudo" and self.lines:
            now = time.time()
            stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)) + f",{int(now * 1000) % 1000:03d}"
            with open(self.log_file, "a", encoding="utf-8") as f:
                for ln in self.lines.pop(0):
                    f.write(ln.replace("{ts}", stamp) + "\n")
        return super().__call__(argv, timeout, cwd, tick)


def test_a_failed_restart_says_what_the_bot_said(tmp_path, _isolated):
    log_file = tmp_path / "bot.log"
    s = _settings(tmp_path, LOG_FILE=str(log_file))
    # an error from before the restart is old news and never offered as the reason
    log_file.write_text("2026-10-08 18:51:14,428 ERROR   bot.positions: live entry failed #738: receipt reconciliation failed\n")
    refused = "refusing to start live mode: wallet Ddzf holds 2.9500 SOL > 0.5 SOL limit"
    ops.request(s, "restart")
    runner = LoggingRunner(_isolated, log_file, [[f"{{ts}} WARNING bot.engine: LIVE MODE wallet Ddzf",
                                                  f"{{ts}} ERROR   bot.__main__: {refused}"]], states=["failed"])
    [res] = ops.watch_once(s, runner)
    assert not res["ok"] and f"not active after the restart (failed); the bot said: {refused}" in res["output"]
    assert "journalctl" not in res["output"] and "receipt" not in res["output"]
    # the change it then undoes is reported with the bot's own words, and so is a second failure
    ops.request(s, "set", {"key": "POSITION_MAX_USD", "value": "12"})
    [res] = ops.watch_once(s, FakeRunner(_isolated))
    assert res["ok"]
    ops.request(s, "restart")
    crash = ["{ts} ERROR   bot.__main__: command failed; check the error below and run python -m bot preflight",
             "Traceback (most recent call last):",
             '  File "/home/bot/CRM-233/meme-agents/bot/db.py", line 251, in open',
             "    await self.conn.executescript(SCHEMA)",
             "sqlite3.OperationalError: database is locked"]
    runner = LoggingRunner(_isolated, log_file, [[f"{{ts}} ERROR   bot.__main__: {refused}"], crash],
                           states=["failed"])
    [res] = ops.watch_once(s, runner)
    out = res["output"]
    assert f"the bot said: {refused}" in out and "POSITION_MAX_USD is put back to 10" in out
    assert out.index("the bot said") < out.index("is put back")
    assert ("the bot is still not active (failed, restart command exit 0); the bot said: command failed; check the "
            "error below and run python -m bot preflight (sqlite3.OperationalError: database is locked)") in out
    # nothing in the log after the restart: the journal is all that is left to point at
    log_file.write_text("2026-10-08 22:48:01,123 ERROR   bot.__main__: from an earlier run\n")
    ops.request(s, "restart")
    [res] = ops.watch_once(s, FakeRunner(_isolated, states=["failed"]))
    assert "not active after the restart (failed); check journalctl -u meme-agents" in res["output"]


def test_startup_error_reads_only_this_restart_and_masks_keys(tmp_path):
    log_file = tmp_path / "bot.log"
    s = _settings(tmp_path, LOG_FILE=str(log_file))
    assert ops.startup_error(s, now_s()) is None                       # no log file yet
    since = now_s() - 5
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    log_file.write_text(f"2020-01-01 00:00:00,000 ERROR   bot.x: ancient\n{now},000 INFO    bot.engine: started\n"
                        f"{now},500 ERROR   bot.__main__: startup failed: https://x/?api-key=abcdef1234567890abcdef\n"
                        "garbage line without a timestamp\n")
    why = ops.startup_error(s, since)
    assert why.startswith("startup failed: ") and "abcdef1234567890abcdef" not in why and "ancient" not in why
    assert ops.startup_error(_settings(tmp_path, LOG_FILE=""), now_s()) is None


def test_a_result_sent_late_says_when_it_happened(tmp_path, _isolated):
    s = _settings(tmp_path)
    d = ops.ops_dir(s)
    d.mkdir(parents=True)
    t = now_s()
    old = {"id": "1-restart", "action": "restart", "args": {}, "ok": False, "code": 1, "started": t - 7211,
           "finished": t - 7200, "output": "the bot is not active after the restart (failed)"}
    (d / "1-restart.result").write_text(json.dumps(old))
    (d / "2-restart.result").write_text(json.dumps({**old, "id": "2-restart", "ok": True, "started": t - 5,
                                                    "finished": t - 1, "output": "active"}))
    http = FakeHttp([])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            return await TelegramCommands(Telegram(http, "1:a", "42"), db, s).deliver_results()
        finally:
            await db.close()

    assert asyncio.run(go()) == 2
    late, fresh = [j["text"] for m, j in http.posts if m == "sendMessage"]
    when = time.strftime("%d %b %H:%MZ", time.gmtime(t - 7200))
    assert late.startswith(f"⏳ from {when}, sent late (the bot was not running to send it)\n❌ restart failed (11 s)")
    assert fresh.startswith("✅ restart done")
    assert ops.late_note({"finished": None}) == "" and ops.late_note({"finished": t - 100}, now=t) == ""


def test_status_and_ops_show_the_code_each_one_runs(tmp_path, _isolated):
    from bot.status import build_status
    from bot.util import git_commit
    s = _settings(tmp_path)

    async def status(hb):
        db = await Database(s.DB_PATH).open()
        try:
            await db.kv_set("heartbeat", json.dumps(hb))
            return await build_status(db, s)
        finally:
            await db.close()

    first = asyncio.run(status({"ts": now_s(), "started_at": now_s() - 60, "mode": "paper", "code": "18d7e50"}))
    assert first.splitlines()[0].endswith("mode=paper  code=18d7e50")
    odd = asyncio.run(status({"ts": now_s(), "started_at": now_s() - 60, "mode": "paper", "code": "x; rm -rf"}))
    assert "code=" not in odd.splitlines()[0]
    ops.beat(s)
    ops._write_json(ops.info_path(s), {"pid": 1, "no_new_privs": False, "started": now_s(), "code": "18d7e50"})
    assert ops.format_queue(s).splitlines()[0].endswith(", code 18d7e50")
    ops._write_json(ops.info_path(s), {"pid": 1, "no_new_privs": False, "started": now_s()})   # an older watcher
    assert "code" not in ops.format_queue(s).splitlines()[0]
    assert git_commit(tmp_path) is None                                    # not a repository
    head = git_commit(ROOT)
    assert head is None or (len(head) == 7 and all(c in "0123456789abcdef" for c in head))


def test_a_refused_env_on_run_reaches_the_log_file(tmp_path, monkeypatch, capsys):
    import bot.config
    from bot.__main__ import main
    monkeypatch.setattr(bot.config, "ROOT", tmp_path)
    (tmp_path / ".env").write_text("LOG_FILE=logs/bot.log\nMODE=weird\n")
    since = now_s()
    assert main(["run"]) == 2
    assert "config error: MODE must be paper or live" in capsys.readouterr().err
    line = (tmp_path / "logs" / "bot.log").read_text()
    assert "ERROR   bot.__main__: config error: MODE must be paper or live" in line
    s = _settings(tmp_path, LOG_FILE=str(tmp_path / "logs" / "bot.log"))
    assert ops.startup_error(s, since) == "config error: MODE must be paper or live"
    (tmp_path / ".env").write_text("LOG_FILE=\nMODE=weird\n")                 # no log file configured: stderr only
    assert main(["run"]) == 2 and (tmp_path / "logs" / "bot.log").read_text() == line
