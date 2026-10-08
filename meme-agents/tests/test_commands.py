"""Telegram commands: /status, /digest, /report, /stop, /resume, /help from the configured chat only."""
import asyncio

import pytest

from bot.commands import STALE_COMMAND_S, TelegramCommands, parse_command
from bot.config import load_settings
from bot.db import Database
from bot.telegram import Telegram, TelegramConflict, split_message
from bot.util import now_s


class Resp:
    def __init__(self, code, body):
        self.status_code, self._body = code, body

    def json(self):
        return self._body


class FakeHttp:
    """getUpdates returns the queued batches in order, then nothing; every POST is recorded."""

    def __init__(self, batches):
        self.batches, self.posts, self.gets = list(batches), [], []

    async def get(self, url, params=None, **kw):
        self.gets.append(params)
        if not self.batches:
            return Resp(200, {"ok": True, "result": []})
        nxt = self.batches.pop(0)
        return nxt if isinstance(nxt, Resp) else Resp(200, {"ok": True, "result": nxt})

    async def post(self, url, json=None, **kw):
        self.posts.append((url.rsplit("/", 1)[1], json))
        return Resp(200, {"ok": True})


def _msg(uid, text, chat=42, date=None, **chat_extra):
    return {"update_id": uid, "message": {"date": date or now_s(), "text": text,
                                          "chat": {"id": chat, "type": "private", **chat_extra},
                                          "from": {"username": "someone"}}}


def _settings(tmp_path, **extra):
    return load_settings(tmp_path / "none.env", overrides={
        "DB_PATH": str(tmp_path / "c.db"), "LOG_FILE": "", "STOP_FILE": str(tmp_path / "STOP"),
        "REPORTS_DIR": str(tmp_path / "rep"), "TELEGRAM_BOT_TOKEN": "123:abc", "TELEGRAM_CHAT_ID": "42", **extra})


def test_parse_command_and_split():
    assert parse_command("/status") == ("status", "")
    assert parse_command("/Status@meme_agents_bot  today") == ("status", "today")
    assert parse_command("hello") is None and parse_command("/") is None and parse_command(None) is None
    text = "\n".join(f"line {i}" for i in range(50))
    parts = split_message(text, limit=60)
    assert "\n".join(parts) == text and all(len(p) <= 60 for p in parts) and len(parts) > 1
    assert split_message("x" * 130, limit=60) == ["x" * 60, "x" * 60, "x" * 10]
    assert split_message("") == [""]


def test_commands_answer_only_the_configured_chat(tmp_path):
    s = _settings(tmp_path)
    stale = now_s() - STALE_COMMAND_S - 5
    http = FakeHttp([
        [_msg(1, "/help"), _msg(2, "/status", chat=7, title="strangers"), _msg(3, "/digest", date=stale),
         _msg(4, "/digest"), _msg(5, "just chatting"), _msg(6, "/report"), _msg(7, "/bogus")],
        [_msg(8, "/stop"), _msg(9, "/stop")],
        [_msg(10, "/resume"), _msg(11, "/resume"), _msg(12, "/status@my_bot")],
    ])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.insert("mints", {"mint": "M1", "symbol": "BUMP", "created_at": now_s() - 600})
            await db.insert("positions", {"kind": "real", "mode": "paper", "mint": "M1", "creator": "C",
                                          "status": "open", "size_usd": 5.0, "sol_in": 0.04,
                                          "decided_at": now_s() - 500, "opened_at": now_s() - 400,
                                          "entry_price": 1e-7, "tokens_initial": 1e6, "cost_sol": 0.04,
                                          "tokens_remaining": 1e6, "last_price": 1.2e-7})
            tc = TelegramCommands(Telegram(http, s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID), db, s)
            first = await tc.poll_once()
            second = await tc.poll_once()
            stopped = (tmp_path / "STOP").exists()
            third = await tc.poll_once()
            return first, second, third, stopped, tc.offset
        finally:
            await db.close()

    first, second, third, stopped, offset = asyncio.run(go())
    assert (first, second, third, stopped, offset) == (4, 2, 3, True, 13)
    sent = [j["text"] for m, j in http.posts if m == "sendMessage"]
    assert all(j["chat_id"] == "42" for m, j in http.posts if m == "sendMessage")
    assert sent[0].startswith("meme-agents commands:") and "/status" in sent[0] and "/stop" in sent[0]
    assert sent[1].startswith("meme-agents ") and "UTC (paper)" in sent[1] and "open 1: BUMP $5 +20%" in sent[1]
    assert sent[2].startswith("meme-agents report (paper mode)")
    assert sent[3] == "unknown command /bogus. /help lists them"
    assert sent[4].startswith("kill switch ON")
    assert sent[5].startswith("kill switch already on")
    assert sent[6] == "kill switch OFF. New entries allowed again" and not (tmp_path / "STOP").exists()
    assert sent[7] == "nothing was paused; entries are allowed"
    assert sent[8].startswith("DOWN: no heartbeat recorded") and "open positions (1/" in sent[8]
    # the offset acknowledges every update, the ignored ones included, so none is re-read
    assert [g.get("offset") for g in http.gets] == [None, 8, 10]


def test_get_updates_conflict_and_errors(tmp_path):
    http = FakeHttp([Resp(409, {"ok": False, "description": "Conflict: terminated by other getUpdates request"}),
                     Resp(502, {}), Resp(200, {"ok": False})])
    tg = Telegram(http, "123:abc", "42")
    with pytest.raises(TelegramConflict):
        asyncio.run(tg.get_updates(None))
    assert asyncio.run(tg.get_updates(5)) == [] and asyncio.run(tg.get_updates(5)) == []
    assert http.gets[1]["offset"] == 5 and http.gets[1]["timeout"] == 25


def test_command_loop_sets_menu_and_stops(tmp_path):
    s = _settings(tmp_path)
    http = FakeHttp([])

    async def go():
        db = await Database(s.DB_PATH).open()
        stop = asyncio.Event()
        try:
            tc = TelegramCommands(Telegram(http, s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID), db, s)
            task = asyncio.create_task(tc.run(stop))
            await asyncio.sleep(0.05)
            stop.set()
            await asyncio.wait_for(task, 2)
        finally:
            await db.close()

    asyncio.run(go())
    assert http.posts[0][0] == "setMyCommands"
    assert [c["command"] for c in http.posts[0][1]["commands"]] == [
        "panel", "status", "digest", "report", "trades", "log", "settings", "pause", "resume", "stop",
        "update", "restart", "set", "dryrun", "ops", "help"]


def test_preflight_hint_explains_409_from_the_running_bot():
    from bot.preflight import _telegram_chats_hint
    http = FakeHttp([Resp(409, {"ok": False})])
    hint = asyncio.run(_telegram_chats_hint(http, "https://api.telegram.org/bot123:abc", "my_bot"))
    assert "running bot is reading" in hint and "telegram: ignoring" in hint


def test_engine_adds_the_command_loop_only_with_telegram(tmp_path):
    from bot.sim import SIM_OVERRIDES, build_sim_engine
    base = dict(SIM_OVERRIDES, DB_PATH=str(tmp_path / "e.db"), LOG_FILE="")
    eng = build_sim_engine(load_settings(overrides=base), 1)
    assert not eng.tg.enabled
    on = build_sim_engine(load_settings(overrides={**base, "TELEGRAM_BOT_TOKEN": "1:a", "TELEGRAM_CHAT_ID": "9"}), 1)
    assert on.tg.enabled and on.s.TELEGRAM_COMMANDS
    off = load_settings(overrides={**base, "TELEGRAM_COMMANDS": "false"})
    assert off.TELEGRAM_COMMANDS is False


def _cb(uid, data, chat=42):
    return {"update_id": uid, "callback_query": {"id": f"cb{uid}", "data": data, "from": {"username": "me"},
                                                "message": {"chat": {"id": chat, "type": "private"}}}}


class FakeRisk:
    paused_reason = None


class FakeEngine:
    def __init__(self):
        self.risk = FakeRisk()


def test_panel_buttons_pause_and_the_rest(tmp_path):
    s = _settings(tmp_path, LOG_FILE=str(tmp_path / "bot.log"))
    (tmp_path / "bot.log").write_text("".join(f"line {i}\n" for i in range(100)))
    http = FakeHttp([
        [_msg(1, "/panel"), _cb(2, "pause"), _cb(3, "pause"), _cb(4, "status", chat=7), _cb(5, "confirm:stop"),
         _cb(6, "cancel"), _msg(7, "/log 5"), _msg(8, "/settings"), _msg(9, "/trades"), _cb(10, "resume"),
         _cb(11, "stop"), _msg(12, "/resume")],
    ])
    eng = FakeEngine()

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await db.insert("mints", {"mint": "M1", "symbol": "BUMP", "created_at": now_s() - 9000})
            await db.insert("positions", {"kind": "real", "mode": "paper", "mint": "M1", "creator": "C",
                                          "status": "closed", "size_usd": 5.0, "sol_in": 0.04,
                                          "decided_at": now_s() - 8000, "opened_at": now_s() - 7000,
                                          "closed_at": now_s() - 1000, "entry_price": 1e-7, "tokens_initial": 1e6,
                                          "cost_sol": 0.04, "proceeds_sol": 0.056, "pnl_usd": 2.1,
                                          "exit_reason": "take_profit"})
            tc = TelegramCommands(Telegram(http, s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID), db, s, engine=eng)
            n = await tc.poll_once()
            return n
        finally:
            await db.close()

    n = asyncio.run(go())
    posts = [(m, j) for m, j in http.posts]
    answered = [j["callback_query_id"] for m, j in posts if m == "answerCallbackQuery"]
    assert answered == ["cb2", "cb3", "cb4", "cb5", "cb6", "cb10", "cb11"]   # every tap is acknowledged
    sent = [j for m, j in posts if m == "sendMessage"]
    assert n == 11 and len(sent) == 11
    assert sent[0]["text"] == "meme-agents control panel"
    rows = sent[0]["reply_markup"]["inline_keyboard"]
    assert [b["callback_data"] for b in rows[0]] == ["status", "digest", "report"]
    assert rows[2][2] == {"text": "Stop", "callback_data": "confirm:stop"}
    assert sent[1]["text"].startswith("paused: no new entries") and sent[2]["text"].startswith("already paused")
    assert sent[3]["text"].startswith("/stop:")
    assert sent[3]["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == "stop"
    assert sent[4]["text"] == "cancelled"
    assert sent[5]["text"] == "line 95\nline 96\nline 97\nline 98\nline 99"
    assert sent[6]["text"].startswith("current settings") and "MODE=paper" in sent[6]["text"]
    assert "ANTHROPIC" not in sent[6]["text"] and "TOKEN" not in sent[6]["text"]
    assert sent[7]["text"].startswith("last 1 closed trades:")
    assert "✅ +$2.10 (+40%) BUMP · take profit" in sent[7]["text"]
    assert sent[8]["text"] == "pause cleared. New entries allowed again" and eng.risk.paused_reason is None
    assert sent[9]["text"].startswith("kill switch ON")   # the /resume right after removes the file again
    assert sent[10]["text"] == "kill switch OFF. New entries allowed again" and not (tmp_path / "STOP").exists()


def test_resume_does_not_clear_the_bots_own_loss_cap_pause(tmp_path):
    s = _settings(tmp_path)
    eng = FakeEngine()
    eng.risk.paused_reason = "daily loss cap hit: -25.00 USD <= -25.00 USD; restart to resume"
    http = FakeHttp([[_msg(1, "/resume")]])

    async def go():
        db = await Database(s.DB_PATH).open()
        try:
            await TelegramCommands(Telegram(http, "1:a", "42"), db, s, engine=eng).poll_once()
        finally:
            await db.close()

    asyncio.run(go())
    assert http.posts[0][1]["text"].startswith("still paused by the bot itself (daily loss cap")
    assert eng.risk.paused_reason.startswith("daily loss cap")
