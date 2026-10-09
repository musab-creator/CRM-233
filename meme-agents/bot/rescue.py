"""Phone rescue: when the bot service is down, the ops watcher answers Telegram itself.

The bot's Telegram loop is the only listener for /update and /restart, and both run through
the ops service. When the bot cannot start (8 Oct: the wallet grew past its cap, live mode
refused, and systemd does not restart that exit), a phone-only operator had no way back in.
The ops watcher now asks systemd about the bot every CHECK_S; once it has been inactive or
failed for CONFIRM_POLLS checks in a row, the watcher says so in the chat, reads the chat's
own messages, queues /restart and /update for itself, and reports their results. Any other
command gets one line saying the bot is down. The watcher never polls while the bot runs:
two getUpdates readers on one token conflict, and the bot's own loop is the one that counts.
"""
from __future__ import annotations

import logging
import time

import httpx

from .config import Settings
from .util import now_s, redact

log = logging.getLogger("bot.rescue")

CHECK_S = 10.0              # how often the watcher asks systemd about the bot
CONFIRM_POLLS = 2           # consecutive down answers before the rescue starts: a restart passes through inactive
MAX_AGE_S = 3600.0          # a command older than this is left alone
CONFLICT_COOLDOWN_S = 300.0 # after a 409 (someone else reads this token), wait this long before trying again
DOWN_STATES = ("inactive", "failed")
COMMANDS = ("restart", "update")
WHO = "telegram-rescue"


class TelegramConflict(Exception):
    pass


def service_state(runner, cwd) -> str | None:
    """systemd's ActiveState for the bot, or None when it cannot be read (never a reason to poll)."""
    from .ops import SERVICE
    try:
        code, out = runner(["systemctl", "show", "-p", "ActiveState", "--value", SERVICE], 20, cwd)
    except Exception as e:  # a runner that cannot run systemctl at all
        log.debug("rescue: systemctl unavailable: %s", e)
        return None
    text = (out or "").strip()
    return text.splitlines()[0].strip() if code == 0 and text else None


class Rescue:
    def __init__(self, s: Settings, runner, http: httpx.Client | None = None, clock=time.monotonic):
        from .ops import ops_dir, _read_json
        self.s, self.runner, self.clock = s, runner, clock
        self.http = http or httpx.Client(timeout=15)
        self.path = ops_dir(s) / "rescue.json"
        state = _read_json(self.path) or {}
        self.offset = int(state["offset"]) if isinstance(state.get("offset"), int) else None
        self.down_polls = 0
        self.noticed = False
        self.state: str | None = None
        self.next_check = 0.0
        self.conflict_until = 0.0

    @property
    def enabled(self) -> bool:
        return bool(self.s.TELEGRAM_BOT_TOKEN and self.s.TELEGRAM_CHAT_ID)

    # --- one watcher loop iteration ---------------------------------------------------
    def tick(self) -> list[str]:
        """Called by the ops watcher after each queue pass. Returns the texts it sent."""
        if not self.enabled:
            return []
        sent = self._deliver_results()
        now = self.clock()
        if now < self.next_check:
            return sent
        self.next_check = now + CHECK_S
        self.state = service_state(self.runner, self.s.path("."))
        if self.state not in DOWN_STATES:
            self.down_polls, self.noticed = 0, False        # the bot is back, or systemd is unsure: its loop answers
            return sent
        self.down_polls += 1
        if self.down_polls < CONFIRM_POLLS:
            return sent
        if not self.noticed:
            self.noticed = True
            sent.append(self._send(f"⚠️ The bot service is {self.state} and not answering. Send /restart or /update "
                                   "here: the ops service runs them while the bot is down and reports back."))
        # results the bot itself would send (a failed restart and why) must not wait for it to come back
        sent += self._deliver_results(everything=True)
        if now < self.conflict_until:
            return sent
        try:
            updates = self._get_updates()
        except TelegramConflict:
            self.conflict_until = now + CONFLICT_COOLDOWN_S
            log.warning("rescue: another process reads this bot token (409); not polling for %.0f s",
                        CONFLICT_COOLDOWN_S)
            return sent
        for u in updates:
            self.offset = max(self.offset or 0, int(u.get("update_id", 0)) + 1)
            self._save()                                     # before acting: a restart must not replay this
            reply = self._handle(u.get("message") or {})
            if reply:
                sent.append(self._send(reply))
        return sent

    def _handle(self, msg: dict) -> str | None:
        from .ops import OpsError, request
        chat = str((msg.get("chat") or {}).get("id", ""))
        text = str(msg.get("text") or "").strip()
        if chat != str(self.s.TELEGRAM_CHAT_ID).strip() or not text.startswith("/"):
            return None
        if now_s() - float(msg.get("date") or 0) > MAX_AGE_S:
            return None
        name = text[1:].split()[0].lower().split("@")[0]
        if name not in COMMANDS:
            return (f"The bot service is {self.state}: only /restart and /update work until it is back. "
                    "A restart that fails again reports why.")
        try:
            req = request(self.s, name, who=WHO)
        except OpsError as e:
            return f"❌ {name} refused: {e}"
        log.warning("rescue: %s queued from Telegram while the bot is %s", name, self.state)
        return f"⏳ {name} queued; the result arrives here in a minute or two"

    def _deliver_results(self, everything: bool = False) -> list[str]:
        """Results of the requests this rescue queued: the bot would deliver them, but it may still be down.
        `everything` (the bot is confirmed down this tick): also those the bot queued itself."""
        from .ops import format_result, late_note, results
        sent = []
        for path, res in results(self.s):
            if res.get("from") != WHO and not everything:
                continue
            try:
                path.unlink()                                # first: the bot may come up and read it too
            except OSError:
                continue
            sent.append(self._send(redact(late_note(res) + format_result(res))))
        return sent

    # --- Telegram, synchronous ------------------------------------------------------------
    def _url(self, method: str) -> str:
        return f"https://api.telegram.org/bot{self.s.TELEGRAM_BOT_TOKEN}/{method}"

    def _send(self, text: str) -> str:
        try:
            r = self.http.post(self._url("sendMessage"), json={"chat_id": self.s.TELEGRAM_CHAT_ID, "text": text[:4000],
                                                               "disable_web_page_preview": True})
            if r.status_code != 200:
                log.warning("rescue: telegram send failed: HTTP %s", r.status_code)
        except httpx.HTTPError as e:
            log.warning("rescue: telegram send failed: %s", type(e).__name__)
        return text

    def _get_updates(self) -> list[dict]:
        params: dict = {"timeout": 0, "allowed_updates": '["message"]'}
        if self.offset is not None:
            params["offset"] = self.offset
        try:
            r = self.http.get(self._url("getUpdates"), params=params)
        except httpx.HTTPError as e:
            log.warning("rescue: telegram getUpdates failed: %s", type(e).__name__)
            return []
        if r.status_code == 409:
            raise TelegramConflict()
        if r.status_code != 200:
            log.warning("rescue: telegram getUpdates HTTP %s", r.status_code)
            return []
        try:
            body = r.json() or {}
        except ValueError:
            return []
        return (body.get("result") or []) if body.get("ok") else []

    def _save(self) -> None:
        from .ops import _write_json
        try:
            _write_json(self.path, {"offset": self.offset})
        except OSError:
            log.exception("rescue: offset could not be saved")
