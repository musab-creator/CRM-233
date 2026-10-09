"""While the bot service is down, the ops watcher answers /restart and /update on Telegram."""
import json
import time

import httpx

from bot import ops
from bot.rescue import CONFLICT_COOLDOWN_S, Rescue
from bot.util import now_s


class Systemd:
    """A runner answering systemctl with one ActiveState per call, the last one repeating."""

    def __init__(self, *states):
        self.states, self.calls = list(states), []

    def __call__(self, argv, timeout, cwd, tick=None):
        self.calls.append(argv)
        if argv[:3] == ["systemctl", "show", "-p"]:
            state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
            return 0, state + "\n"
        return 0, ""


class Chat:
    """Telegram over httpx.MockTransport: queued updates in, sent messages out."""

    def __init__(self, updates=(), status=200):
        self.updates, self.status, self.sent, self.offsets = list(updates), status, [], []
        self.client = httpx.Client(transport=httpx.MockTransport(self.handle))

    def handle(self, req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/getUpdates"):
            self.offsets.append(req.url.params.get("offset"))
            if self.status != 200:
                return httpx.Response(self.status)
            batch, self.updates = self.updates, []
            return httpx.Response(200, json={"ok": True, "result": batch})
        self.sent.append(json.loads(req.content)["text"])
        return httpx.Response(200, json={"ok": True})


def _msg(uid, text, chat=42, age=0):
    return {"update_id": uid, "message": {"chat": {"id": chat}, "text": text, "date": int(now_s()) - age}}


def _rescue(s, systemd, chat):
    s.TELEGRAM_BOT_TOKEN, s.TELEGRAM_CHAT_ID = "1:a", "42"
    clock = [0.0]
    r = Rescue(s, systemd, http=chat.client, clock=lambda: clock[0])
    return r, clock


def test_a_down_bot_is_announced_once_and_restart_is_queued_from_the_chat(s):
    chat = Chat([_msg(7, "/status"), _msg(8, "/restart"), _msg(9, "/update"),
                 _msg(10, "/restart", chat=99),            # a stranger
                 _msg(11, "/restart", age=7200)])          # an hour-old command is not acted on
    r, clock = _rescue(s, Systemd("active", "inactive", "failed", "failed"), chat)
    assert r.tick() == [] and chat.offsets == []           # active: nothing read from Telegram
    clock[0] += 10
    assert r.tick() == [] and chat.offsets == []           # first down answer: a restart passes through inactive
    clock[0] += 10
    sent = r.tick()
    assert sent[0].startswith("⚠️ The bot service is failed and not answering. Send /restart or /update here")
    assert "only /restart and /update work" in sent[1]     # /status
    assert sent[2].startswith("⏳ restart queued") and sent[3].startswith("⏳ update queued")
    assert len(sent) == 4 and chat.sent == sent
    queued = ops.pending(s)
    assert [q["action"] for q in queued] == ["restart", "update"] and all(q["from"] == "telegram-rescue" for q in queued)
    assert r.offset == 12 and json.loads((ops.ops_dir(s) / "rescue.json").read_text()) == {"offset": 12}
    clock[0] += 10
    assert r.tick() == [] and chat.offsets[-1] == "12"      # still down: polled again from the saved offset, no repeat notice


def test_results_of_rescue_requests_are_delivered_by_the_watcher(s):
    chat = Chat()
    r, clock = _rescue(s, Systemd("failed"), chat)
    req = ops.request(s, "restart", who="telegram-rescue")
    other = ops.request(s, "restart")                      # queued by the bot: the bot delivers that one
    for q in ops.pending(s):
        ops._finish(s, q, q["id"] == req["id"], "restart done" if q["id"] == req["id"] else "sudo: a password is required",
                    now_s(), code=None if q["id"] == req["id"] else 1)
    sent = r.tick()                                        # first down answer: results go out, no notice yet
    assert sent == ["✅ restart done (0 s)\nrestart done"]
    left = [res for _, res in ops.results(s)]
    assert [res["id"] for res in left] == [other["id"]]
    clock[0] += 10                                         # down confirmed: the bot cannot send its own either
    sent = r.tick()
    assert sent[0].startswith("⚠️ The bot service is failed") and sent[1].startswith("❌ restart failed (0 s) (exit 1)")
    assert "sudoers line" in sent[1] and ops.results(s) == []


def test_rescue_stops_polling_when_the_bot_is_back_and_backs_off_on_conflict(s):
    chat = Chat([_msg(1, "/restart")], status=409)
    r, clock = _rescue(s, Systemd("failed", "failed", "active", "failed", "failed"), chat)
    r.tick(); clock[0] += 10
    sent = r.tick()
    assert len(sent) == 1 and sent[0].startswith("⚠️") and r.conflict_until == clock[0] + CONFLICT_COOLDOWN_S
    assert ops.pending(s) == []
    clock[0] += 10
    assert r.tick() == [] and not r.noticed                # active again: the bot's own loop answers
    clock[0] += 10
    r.tick(); clock[0] += 10
    chat.status = 200
    assert r.tick()[0].startswith("⚠️")                     # down again later: a fresh notice


def test_rescue_is_off_without_a_telegram_token(s):
    chat = Chat([_msg(1, "/restart")])
    r = Rescue(s, Systemd("failed"), http=chat.client, clock=lambda: 0.0)
    assert not r.enabled and r.tick() == [] and chat.offsets == []
