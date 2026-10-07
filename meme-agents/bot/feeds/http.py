from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from ..util import RateLimiter, backoff_delay

log = logging.getLogger("bot.http")


class HttpError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status


async def request_json(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    limiter: RateLimiter | None = None,
    retries: int = 3,
    **kw: Any,
) -> Any:
    """JSON request with rate limiting and retry on 429/5xx/network errors."""
    for attempt in range(retries + 1):
        if limiter:
            await limiter.acquire()
        try:
            r = await client.request(method, url, **kw)
        except (httpx.TransportError, httpx.TimeoutException) as e:
            if attempt == retries:
                raise
            log.debug("%s %s transport error %s, retrying", method, url.split("?")[0], e)
            await asyncio.sleep(backoff_delay(attempt, 0.5, 8))
            continue
        if r.status_code == 429 or r.status_code >= 500:
            if attempt == retries:
                raise HttpError(r.status_code, r.text)
            retry_after = r.headers.get("retry-after")
            delay = float(retry_after) if retry_after and retry_after.isdigit() else backoff_delay(attempt + 1, 0.5, 15)
            await asyncio.sleep(delay)
            continue
        if r.status_code >= 400:
            raise HttpError(r.status_code, r.text)
        if not r.content:
            return None
        return r.json()
    return None
