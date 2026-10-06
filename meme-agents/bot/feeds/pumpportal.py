"""PumpPortal data WebSocket: one connection, re-subscribed after every reconnect.

Messages sent (per PumpPortal's data API):
  {"method": "subscribeNewToken"}                         free: every launch
  {"method": "subscribeMigration"}                        free: every graduation
  {"method": "subscribeTokenTrade",   "keys": [mint, ...]}   paid since May 1, 2026: API key with a
  {"method": "subscribeAccountTrade", "keys": [wallet, ...]} funded wallet, 0.01 SOL per 10,000 trades
  {"method": "unsubscribeTokenTrade", "keys": [...]}   (and unsubscribeAccountTrade)
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Awaitable, Callable

import websockets

from ..util import backoff_delay

log = logging.getLogger("bot.pumpportal")

CHUNK = 200  # keys per subscribe message


class PumpPortalFeed:
    def __init__(self, url: str, on_message: Callable[[dict], Awaitable[None]], max_backoff: float = 60.0,
                 stall_s: float = 90.0):
        self.url = url
        self.on_message = on_message
        self.max_backoff = max_backoff
        # pump.fun launches arrive every few seconds; this much silence means a dead stream
        # even if the socket still answers pings
        self.stall_s = stall_s
        self.stalls = 0
        self.last_msg_at = 0.0
        self.token_keys: set[str] = set()
        self.account_keys: set[str] = set()
        self._ws = None
        self._send_lock = asyncio.Lock()
        self.connected = asyncio.Event()
        self.reconnects = 0

    async def _send(self, payload: dict) -> None:
        ws = self._ws
        if ws is None:
            return  # will be sent by the resubscribe on connect
        async with self._send_lock:
            try:
                await ws.send(json.dumps(payload))
            except websockets.ConnectionClosed:
                pass

    async def _bulk(self, method: str, keys: list[str]) -> None:
        for i in range(0, len(keys), CHUNK):
            await self._send({"method": method, "keys": keys[i:i + CHUNK]})

    async def subscribe_tokens(self, mints: list[str]) -> None:
        new = [m for m in mints if m not in self.token_keys]
        self.token_keys.update(new)
        await self._bulk("subscribeTokenTrade", new)

    async def unsubscribe_tokens(self, mints: list[str]) -> None:
        gone = [m for m in mints if m in self.token_keys]
        self.token_keys.difference_update(gone)
        await self._bulk("unsubscribeTokenTrade", gone)

    async def subscribe_accounts(self, wallets: list[str]) -> None:
        new = [w for w in wallets if w and w not in self.account_keys]
        self.account_keys.update(new)
        await self._bulk("subscribeAccountTrade", new)

    async def unsubscribe_accounts(self, wallets: list[str]) -> None:
        gone = [w for w in wallets if w in self.account_keys]
        self.account_keys.difference_update(gone)
        await self._bulk("unsubscribeAccountTrade", gone)

    async def _resubscribe(self) -> None:
        await self._send({"method": "subscribeNewToken"})
        await self._send({"method": "subscribeMigration"})
        await self._bulk("subscribeTokenTrade", sorted(self.token_keys))
        await self._bulk("subscribeAccountTrade", sorted(self.account_keys))

    async def run(self, stop: asyncio.Event) -> None:
        attempt = 0
        while not stop.is_set():
            try:
                async with websockets.connect(self.url, ping_interval=20, ping_timeout=20,
                                              max_size=2 ** 22, open_timeout=20) as ws:
                    self._ws = ws
                    await self._resubscribe()
                    self.connected.set()
                    log.info("pumpportal connected (%d tokens, %d accounts)",
                             len(self.token_keys), len(self.account_keys))
                    attempt = 0
                    last = time.monotonic()
                    while not stop.is_set():
                        try:
                            # cancelling recv() is safe in websockets >= 13: no message is lost
                            raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                        except asyncio.TimeoutError:
                            if time.monotonic() - last > self.stall_s:
                                self.stalls += 1
                                log.warning("pumpportal: no data for %.0fs, forcing reconnect", self.stall_s)
                                break
                            continue
                        last = time.monotonic()
                        self.last_msg_at = time.time()
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(msg, dict):
                            if "txType" not in msg:
                                if msg.get("message") or msg.get("errors"):
                                    log.debug("pumpportal: %s", msg)
                                continue
                            await self.on_message(msg)
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as e:
                log.warning("pumpportal disconnected: %s", e)
            except Exception:
                log.exception("pumpportal loop error")
            finally:
                self._ws = None
                self.connected.clear()
            if stop.is_set():
                break
            delay = backoff_delay(attempt, base=1.0, cap=self.max_backoff)
            attempt += 1
            self.reconnects += 1
            log.info("pumpportal reconnect in %.1fs (attempt %d)", delay, attempt)
            try:
                await asyncio.wait_for(stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass
