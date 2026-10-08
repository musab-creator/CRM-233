"""Phone ops: Telegram /update /restart /set /dryrun /ops queue requests as files; the ops service
re-validates each one against the same allowlist, runs only the deploy scripts and reports back."""
import asyncio
import json
import signal

import pytest

from bot import ops
from bot.commands import CONFIRM, PANEL, TelegramCommands
from bot.config import ROOT
from bot.db import Database
from bot.telegram import Telegram
from bot.util import now_s
from tests.test_commands import FakeHttp, _cb, _msg, _settings

SET_ENV = ["bash", str(ROOT / "deploy" / "set-env.sh")]
RESTART = [["sudo", "-n", "systemctl", "restart", "meme-agents"], ["systemctl", "is-active", "meme-agents"]]


def test_settable_allowlist_and_bounds():
    assert ops.validate_set("POSITION_MAX_USD", "15") == "15"
    assert ops.validate_set("position_max_usd", " 7.5 ") == "7.5"
    assert ops.validate_set("MAX_OPEN_POSITIONS", "4") == "4"
    assert ops.validate_set("PF_MIN_LIQUIDITY_USD", "1e5") == "100000"
    assert ops.validate_set("GATE_NEUTRAL_VOTES", "off") == "false"
    assert ops.validate_set("TRIAGE_ENABLED", "Yes") == "true"
    assert ops.validate_set("TELEGRAM_DIGEST", "Wins") == "wins"
    assert ops.validate_set("LIVE_DRY_RUN", "true") == "true"
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
    assert ops.validate("update", None) == {} and ops.validate("restart", {"key": "MODE"}) == {}
    with pytest.raises(ops.OpsError):
        ops.validate("shell", {"cmd": "id"})
    assert ops.validate("set", {"key": "live_dry_run", "value": "true", "restart": 1}) == {
        "key": "LIVE_DRY_RUN", "value": "true", "restart": True}
    assert ops.allowed("POSITION_MAX_USD") == "1 to 20" and ops.allowed("TELEGRAM_DIGEST") == "all/wins/off"
    assert ops.allowed("LIVE_DRY_RUN") == "true only" and ops.allowed("TRIAGE_ENABLED") == "true/false"
    assert ops.SETTABLE["CONSENSUS_MIN_MEAN_CONFIDENCE"][1] == 0.65     # the brief's gate cannot be lowered
    words = ("KEY", "TOKEN", "SECRET", "PRIVATE", "URL", "PATH", "FILE", "DIR", "MODE", "CONFIRM", "WALLET", "CHAT")
    assert not [k for k in ops.SETTABLE if any(w in k for w in words)]
    assert "POSITION_MAX_USD=10.0  (1 to 20)" in ops.settable_text(_settings_for_text())
    assert "LIVE_DRY_RUN=true  (true only)" in ops.settable_text(_settings_for_text())


def _settings_for_text():
    from bot.config import load_settings
    return load_settings(overrides={"LOG_FILE": ""})


def test_queue_round_trip_and_the_executor_checks_again(tmp_path):
    s = _settings(tmp_path)
    req = ops.request(s, "set", {"key": "position_max_usd", "value": "15"})
    assert req["args"] == {"key": "POSITION_MAX_USD", "value": "15", "restart": False}
    assert (ops.ops_dir(s) / f"{req['id']}.request").exists() and ops.ops_dir(s) == tmp_path / "ops"
    assert [r["id"] for r in ops.pending(s)] == [req["id"]]
    ran = []

    def runner(argv, timeout, cwd, tick=None):
        ran.append((argv, timeout))
        tick()
        return 0, "updated POSITION_MAX_USD\napply with: sudo systemctl restart meme-agents\n"

    done = ops.watch_once(s, runner)
    assert len(done) == 1 and done[0]["ok"] and done[0]["code"] == 0 and ops.describe(done[0]) == "set POSITION_MAX_USD=15"
    assert ran == [([*SET_ENV, "POSITION_MAX_USD=15"], 60)]
    assert not ops.pending(s) and ops.watcher_alive(s)
    got = ops.results(s)
    assert len(got) == 1 and got[0][1]["id"] == req["id"] and got[0][0].suffix == ".result"
    assert ops.history(s)[0]["action"] == "set" and ops.history(s)[0]["output"].startswith("updated")
    text = ops.format_result(done[0])
    assert text.startswith("✅ set POSITION_MAX_USD=15: written to .env (0 s). Restart to apply")
    # a request file written by anything else must pass the same checks, or it is refused unrun
    d = ops.ops_dir(s)
    (d / "1-set.request").write_text(json.dumps({"id": "1-set", "action": "set", "ts": now_s(),
                                                 "args": {"key": "MODE", "value": "live"}}))
    (d / "2-shell.request").write_text(json.dumps({"id": "2-shell", "action": "shell", "ts": now_s(),
                                                   "args": {"cmd": "rm -rf /"}}))
    (d / "3-restart.request").write_text(json.dumps({"id": "3-restart", "action": "restart", "args": {},
                                                     "ts": now_s() - ops.MAX_REQUEST_AGE_S - 1}))
    (d / "4-update.running").write_text(json.dumps({"id": "4-update", "action": "update", "args": {}, "ts": now_s()}))
    (d / "5-junk.request").write_text("not json")
    done = {r["id"]: r for r in ops.watch_once(s, runner)}
    assert len(ran) == 1 and not any(r["ok"] for r in done.values())
    assert "cannot be changed from the phone" in done["1-set"]["output"]
    assert "unknown action" in done["2-shell"]["output"]
    assert "min old" in done["3-restart"]["output"]
    assert "interrupted" in done["4-update"]["output"] and not (d / "4-update.running").exists()
    assert not (d / "1-set.request").exists() and (d / "5-junk.request").exists()
    assert ops.format_result(done["3-restart"]).startswith("❌ restart failed")
    # the steps behind each action; a failing step stops the rest
    ops.request(s, "set", {"key": "LIVE_DRY_RUN", "value": "true", "restart": True})
    ran.clear()
    [res] = ops.watch_once(s, runner)
    assert [a for a, _ in ran] == [[*SET_ENV, "LIVE_DRY_RUN=true"], *RESTART] and res["ok"]
    assert ops.describe(res) == "dry run ON" and "the bot restarted" in ops.format_result(res)
    ops.request(s, "update")
    ran.clear()
    [res] = ops.watch_once(s, runner)
    assert [a for a, t in ran] == [["bash", str(s.path(".") / "deploy" / "update.sh")]] and ran[0][1] == 1500

    def no_sudo(argv, timeout, cwd, tick=None):
        ran.append((argv, timeout))
        return (1, "sudo: a password is required") if argv[0] == "sudo" else (0, "ok")

    ops.request(s, "restart")
    ran.clear()
    [res] = ops.watch_once(s, no_sudo)
    assert not res["ok"] and res["code"] == 1 and [a for a, _ in ran] == RESTART[:1]
    assert "sudoers line" in ops.format_result(res)
    assert "could not read Username" not in ops.format_result(res)
    nothing = {"action": "update", "args": {}, "ok": True, "output": "already at abc on main; nothing to do",
               "started": 1.0, "finished": 2.0}
    assert ops.format_result(nothing).startswith("✅ update: already on the latest code")
    git_auth = {**nothing, "ok": False, "code": 128, "output": "fatal: could not read Username for 'https://github.com'"}
    assert "git config credential.helper store" in ops.format_result(git_auth)


def test_run_command_has_no_terminal_and_a_deadline(tmp_path, monkeypatch):
    monkeypatch.setattr(ops, "HEARTBEAT_S", 0.05)
    ticks = []
    code, out = ops.run_command(["bash", "-c", "echo hi; echo err >&2; exit 3"], 10, tmp_path, lambda: ticks.append(1))
    assert code == 3 and out == "hi\nerr\n"
    code, out = ops.run_command(["bash", "-c", 'read -r x; echo "stdin:$x $MEME_AGENTS_NONINTERACTIVE $GIT_TERMINAL_PROMPT"'],
                                10, tmp_path)
    assert code == 0 and out == "stdin: 1 0\n"
    code, out = ops.run_command(["bash", "-c", "echo start; sleep 20"], 0.2, tmp_path, lambda: ticks.append(1))
    assert code == 124 and out.startswith("start") and "timed out" in out and ticks
    code, out = ops.run_command(["/no/such/program"], 1, tmp_path)
    assert code == 127 and "cannot run" in out


def test_watch_loop_exits_after_a_deploy_and_on_sigterm(tmp_path, monkeypatch):
    s = _settings(tmp_path)
    heads = iter(["aaa", "bbb"])
    monkeypatch.setattr(ops, "_git_head", lambda app: next(heads, "bbb"))
    ops.request(s, "update")
    slept = []
    assert ops.watch(s, lambda *a, **k: (0, "deployed bbb"), interval=0.01, sleep=slept.append) == 0
    assert not slept and not ops.pending(s)                    # left at once, for systemd to restart it
    # nothing to deploy: the loop keeps going until the service stops it
    monkeypatch.setattr(ops, "_git_head", lambda app: "bbb")
    ops.request(s, "update")

    def sleep_then_stop(secs):
        slept.append(secs)
        signal.raise_signal(signal.SIGTERM)

    assert ops.watch(s, lambda *a, **k: (0, "nothing to do"), interval=0.01, sleep=sleep_then_stop) == 0
    assert slept == [0.01] and ops.history(s, 1)[0]["ok"]


def test_phone_commands_queue_for_the_ops_service(tmp_path):
    s = _settings(tmp_path)
    http = FakeHttp([
        [_msg(1, "/update")],                                           # no ops service yet
        [_msg(2, "/panel"), _cb(3, "confirm:update"), _cb(4, "update"), _msg(5, "/set"),
         _msg(6, "/set position_max_usd=15"), _msg(7, "/set LIVE_DRY_RUN=false"), _msg(8, "/set MODE=live"),
         _msg(9, "/set WALLET_PRIVATE_KEY=abc"), _msg(10, "/set BANKROLL_USD"), _msg(11, "/dryrun"),
         _cb(12, "dryrun on"), _cb(13, "confirm:dryrun"), _msg(14, "/restart"), _msg(15, "/ops"), _cb(16, "ops")],
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

    assert asyncio.run(go()) == (1, 15)
    sent = [j for m, j in http.posts if m == "sendMessage"]
    assert sent[0]["text"].startswith("not queued: the ops service is not running") and "--ops" in sent[0]["text"]
    rows = sent[1]["reply_markup"]["inline_keyboard"]
    assert [b["callback_data"] for b in rows[3]] == ["confirm:update", "confirm:restart", "confirm:dryrun"]
    assert rows[4] == [{"text": "Ops", "callback_data": "ops"}] and PANEL[2][2][1] == "confirm:stop"
    assert sent[2]["text"].startswith("/update:") and sent[2]["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == "update"
    assert sent[3]["text"].startswith("queued: update.")
    assert sent[4]["text"].startswith("/set KEY=VALUE") and "POSITION_MAX_USD=10.0  (1 to 20)" in sent[4]["text"]
    assert "Not from the phone: MODE, LIVE_CONFIRM" in sent[4]["text"]
    assert sent[5]["text"].startswith("queued: set POSITION_MAX_USD=15.")
    assert sent[6]["text"].startswith("LIVE_DRY_RUN can only be turned on from the phone")
    assert sent[7]["text"].startswith("MODE cannot be changed from the phone")
    assert sent[8]["text"].startswith("WALLET_PRIVATE_KEY cannot be changed from the phone")
    assert sent[9]["text"] == "use /set KEY=VALUE; /set alone lists the keys and their limits"
    assert sent[10]["text"].startswith("/dryrun on is the only direction")
    assert sent[11]["text"].startswith("dry run is already on")           # a button tap carries its argument
    assert sent[12]["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == "dryrun on" and CONFIRM["dryrun"] == "dryrun on"
    assert sent[13]["text"].startswith("queued: restart.")
    assert sent[14]["text"].startswith("ops service: running") and "queued: 3" in sent[14]["text"]
    assert "· update" in sent[14]["text"] and "· set POSITION_MAX_USD=15" in sent[14]["text"] and "· restart" in sent[14]["text"]
    assert sent[15]["text"] == sent[14]["text"]
    queued = ops.pending(s)
    assert [(r["action"], r["args"]) for r in queued] == [
        ("update", {}), ("set", {"key": "POSITION_MAX_USD", "value": "15", "restart": False}), ("restart", {})]
    assert all(r["from"] == "telegram" for r in queued)


def test_dryrun_on_queues_a_write_and_a_restart_in_live_mode(tmp_path):
    s = _settings(tmp_path, LIVE_DRY_RUN="false")
    ops.beat(s)
    http = FakeHttp([[_msg(1, "/dryrun on"), _msg(2, "/dryrun off")]])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await TelegramCommands(Telegram(http, "1:a", "42"), db, s).poll_once()
        finally:
            await db.close()

    asyncio.run(go())
    sent = [j for m, j in http.posts if m == "sendMessage"]
    assert sent[0]["text"].startswith("queued: dry run ON.") and "/stop before" in sent[0]["text"]
    assert sent[1]["text"].startswith("/dryrun on is the only direction")
    assert [r["args"] for r in ops.pending(s)] == [{"key": "LIVE_DRY_RUN", "value": "true", "restart": True}]


def test_results_reach_the_chat_and_a_set_offers_restart(tmp_path):
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
    http = FakeHttp([])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            tc = TelegramCommands(Telegram(http, "1:a", "42"), db, s)
            n = await tc.deliver_results()
            return n, await tc.deliver_results()
        finally:
            await db.close()

    assert asyncio.run(go()) == (4, 0)
    sent = [j for m, j in http.posts if m == "sendMessage"]
    assert sent[0]["text"].startswith("✅ set POSITION_MAX_USD=15: written to .env (3 s). Restart to apply")
    assert sent[0]["reply_markup"]["inline_keyboard"] == [[{"text": "Restart now", "callback_data": "restart"}]]
    assert sent[1]["text"].startswith("❌ update failed (3 s) (exit 128)") and "credential.helper store" in sent[1]["text"]
    assert "reply_markup" not in sent[1]
    assert sent[2]["text"].startswith("✅ update done (5 min 0 s)") and sent[2]["text"].endswith("deployed abc123")
    assert sent[2]["text"].count("\n") <= 13                     # only the tail of a long output
    assert sent[3]["text"].startswith("✅ dry run ON: written to .env and the bot restarted (3 s)")
    assert sorted(p.name for p in d.iterdir()) == ["5-bad.result"]


def test_ops_queue_text_and_the_cli(tmp_path, monkeypatch, capsys):
    s = _settings(tmp_path)
    assert ops.format_queue(s).startswith("ops service: never seen") and "queued: nothing" in ops.format_queue(s)
    ops.beat(s)
    import os
    stale = now_s() - ops.HEARTBEAT_STALE_S - 120
    os.utime(ops.heartbeat_path(s), (stale, stale))
    assert ops.format_queue(s).startswith("ops service: DOWN (last seen ") and not ops.watcher_alive(s)
    assert "min ago). On the server: sudo systemctl restart meme-agents-ops" in ops.format_queue(s)
    from bot.__main__ import main
    monkeypatch.setenv("DB_PATH", str(tmp_path / "cli.db"))
    monkeypatch.setenv("LOG_FILE", "")
    assert main(["ops", "--once"]) == 0 and "nothing queued" in capsys.readouterr().out
    assert main(["ops"]) == 0 and capsys.readouterr().out.startswith("ops service: ")
    ops.request(_settings(tmp_path, DB_PATH=str(tmp_path / "cli.db")), "restart")
    monkeypatch.setattr(ops, "run_command", lambda argv, timeout, cwd, tick=None: (1, "sudo: a password is required"))
    assert main(["ops", "--once"]) == 1 and "1 request(s) processed" in capsys.readouterr().out
