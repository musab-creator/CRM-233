from __future__ import annotations

import asyncio
import logging
import random
import re
import time

log = logging.getLogger("bot")

_SECRET_RE = re.compile(r"(api-key=|api_key=|auth_token=|Bearer\s+|/bot)[A-Za-z0-9:_\-]{8,}")


class RedactingFormatter(logging.Formatter):
    """Strips anything that looks like an API key out of log lines (URLs carry keys)."""

    def format(self, record: logging.LogRecord) -> str:
        return _SECRET_RE.sub(lambda m: m.group(1) + "***", super().format(record))


def setup_logging(level: str = "INFO", logfile=None) -> None:
    """Console plus, if `logfile` is set, a rotating file (20 MB x 5). Secrets are redacted."""
    from logging.handlers import RotatingFileHandler
    from pathlib import Path

    fmt = RedactingFormatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if logfile:
        Path(logfile).parent.mkdir(parents=True, exist_ok=True)
        handlers.append(RotatingFileHandler(logfile, maxBytes=20 * 1024 * 1024, backupCount=5))
    for h in handlers:
        h.setFormatter(fmt)
    root = logging.getLogger()
    root.handlers = handlers
    root.setLevel(level.upper())
    for noisy in ("httpx", "httpcore", "websockets", "anthropic", "httpx2"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


class RateLimiter:
    """Token bucket. `await acquire()` blocks until a request may be sent."""

    def __init__(self, rate_per_s: float, burst: float | None = None):
        self.rate = rate_per_s
        self.capacity = burst if burst is not None else max(1.0, rate_per_s)
        self.tokens = self.capacity
        self.updated = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                await asyncio.sleep((1 - self.tokens) / self.rate)


def backoff_delay(attempt: int, base: float = 1.0, cap: float = 60.0) -> float:
    """Exponential backoff with full jitter."""
    return random.uniform(0, min(cap, base * (2 ** attempt)))


def now_s() -> float:
    return time.time()
