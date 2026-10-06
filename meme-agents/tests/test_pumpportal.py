"""PumpPortal client against a local WebSocket server: resubscribe on connect, stall watchdog."""
import asyncio
import json

import websockets

from bot.feeds.pumpportal import PumpPortalFeed


def test_resubscribes_and_reconnects_after_a_silent_stall():
    received: list[list[dict]] = []

    async def handler(ws):
        got: list[dict] = []
        received.append(got)
        # one trade, then silence while still answering pings
        await ws.send(json.dumps({"txType": "buy", "mint": "M1", "solAmount": 1, "tokenAmount": 10}))
        try:
            async for raw in ws:
                got.append(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    async def go():
        msgs = []

        async def on_message(m):
            msgs.append(m)

        async with websockets.serve(handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            feed = PumpPortalFeed(f"ws://127.0.0.1:{port}", on_message, max_backoff=0.2, stall_s=1.0)
            await feed.subscribe_tokens(["M1", "M2"])  # before connecting: must be sent on connect
            await feed.subscribe_accounts(["DEV"])
            stop = asyncio.Event()
            task = asyncio.create_task(feed.run(stop))
            for _ in range(100):
                await asyncio.sleep(0.1)
                if feed.stalls >= 1 and len(received) >= 2:
                    break
            stop.set()
            await asyncio.wait_for(task, 5)
        return feed, msgs

    feed, msgs = asyncio.run(go())
    assert feed.stalls >= 1 and feed.reconnects >= 1
    assert len(received) >= 2, "client did not reconnect after the stall"
    for conn in received[:2]:  # every connection gets the full subscription set again
        methods = {(m["method"], tuple(m.get("keys", []))) for m in conn}
        assert ("subscribeNewToken", ()) in methods
        assert ("subscribeTokenTrade", ("M1", "M2")) in methods
        assert ("subscribeAccountTrade", ("DEV",)) in methods
    assert msgs and msgs[0]["mint"] == "M1"


def test_unsubscribe_removes_keys_from_future_resubscribes():
    async def go():
        async def on_message(m):
            pass
        feed = PumpPortalFeed("ws://127.0.0.1:9", on_message)
        await feed.subscribe_tokens(["A", "B"])
        await feed.unsubscribe_tokens(["A"])
        await feed.subscribe_accounts(["W"])
        await feed.unsubscribe_accounts(["W"])
        return feed
    feed = asyncio.run(go())
    assert feed.token_keys == {"B"} and feed.account_keys == set()
