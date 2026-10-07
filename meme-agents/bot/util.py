from __future__ import annotations

import asyncio
import logging
import math
import os
import random
import re
import time
from collections.abc import Iterable
from urllib.parse import quote, quote_plus

log = logging.getLogger("bot")

# Provider exception bodies may contain headers, URL parameters or serialized settings.
_SECRET_RE = re.compile(
    r"(?P<prefix>\b(?:api[-_]key|x[-_]api[-_]key|auth[-_]token|"
    r"(?:anthropic|helius|pumpportal|jupiter)_api_key|x_bearer_token|"
    r"cryptopanic_token|telegram_bot_token|wallet_private_key)"
    r"[\"']?\s*[:=]\s*[\"']?)(?:\[[^\]\r\n]*\]|[^\s&\"',}<>]+)",
    re.IGNORECASE,
)
_AUTH_RE = re.compile(r"(?P<prefix>\b(?:Bearer|Basic)\s+)[^\s\"',}<>]+", re.IGNORECASE)
_TELEGRAM_RE = re.compile(r"(?P<prefix>/bot)[0-9]+:[A-Za-z0-9_-]+", re.IGNORECASE)
_KNOWN_SECRETS: set[str] = set()


def register_secrets(values: Iterable[str]) -> None:
    """Register configured credentials so even unlabelled provider errors are masked.

    Values stay in memory only. URL-encoded forms also occur in SDK exception URLs.
    """
    for value in values:
        if value:
            _KNOWN_SECRETS.update((value, quote(value, safe=""), quote_plus(value)))


def redact(text: str) -> str:
    """Mask configured keys and credential-shaped URL, header and JSON fields."""
    for secret in sorted(_KNOWN_SECRETS, key=len, reverse=True):
        text = text.replace(secret, "***")
    for pattern in (_SECRET_RE, _AUTH_RE, _TELEGRAM_RE):
        text = pattern.sub(lambda match: match.group("prefix") + "***", text)
    return text


class RedactingFormatter(logging.Formatter):
    """Strips anything that looks like an API key out of log lines (URLs carry keys)."""

    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


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
        if not math.isfinite(rate_per_s) or rate_per_s <= 0:
            raise ValueError("rate_per_s must be finite and greater than zero")
        if burst is not None and (not math.isfinite(burst) or burst <= 0):
            raise ValueError("burst must be finite and greater than zero")
        self.rate = rate_per_s
        # Fractional request rates still need room for one complete request.
        self.capacity = max(1.0, burst if burst is not None else rate_per_s)
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
    if not math.isfinite(base) or not math.isfinite(cap) or base <= 0 or cap <= 0:
        raise ValueError("backoff base and cap must be finite and greater than zero")
    exponent = max(0, attempt)
    # Saturate before exponentiation: prolonged outages must not overflow 2 ** attempt.
    if base >= cap or exponent >= math.ceil(math.log2(cap) - math.log2(base)):
        ceiling = cap
    else:
        ceiling = math.ldexp(base, exponent)
    return random.uniform(0, ceiling)


def now_s() -> float:
    return time.time()


def sd_notify(state: str) -> bool:
    """systemd's notify protocol (READY=1, WATCHDOG=1, STOPPING=1), stdlib only. A no-op unless
    systemd started the process with Type=notify."""
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return False
    if addr.startswith("@"):  # abstract namespace socket
        addr = "\0" + addr[1:]
    import socket
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.connect(addr)
            sock.sendall(state.encode())
        return True
    except OSError:
        return False


class InstanceLock:
    """Exclusive lock on a file next to the database, so two bot processes never trade the same
    bankroll (for example a systemd service plus a manual `python -m bot`). The OS releases it
    when the process exits, even after a crash or kill -9, so it never needs cleaning up."""

    def __init__(self, path):
        self.path = str(path)
        self.fd: int | None = None

    def acquire(self) -> bool:
        if self.fd is not None:
            return True
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if os.name == "nt":
                import msvcrt
                if os.fstat(fd).st_size < 1:
                    os.write(fd, b"\0")
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        self.fd = fd
        return True

    def release(self) -> None:
        if self.fd is not None:
            os.close(self.fd)  # closing the descriptor drops the lock
            self.fd = None
