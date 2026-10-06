"""X API v2 (pay-per-use) with a hard monthly budget and a post-id cache.

Cost model (configurable): $0.005 per post returned, $0.01 per user lookup.
Before each call the worst case (max_results posts) is reserved against the budget; the
actual count is settled afterwards. `since_id` is stored per query/timeline so a post is
never read twice, and every post is kept in `x_posts`.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone

import httpx

from ..budget import Budget, BudgetExceeded
from ..db import Database
from .http import HttpError, request_json

log = logging.getLogger("bot.x")


class XClient:
    def __init__(self, client: httpx.AsyncClient, base: str, bearer: str, db: Database, budget: Budget,
                 post_usd: float, user_usd: float):
        self.c = client
        self.base = base.rstrip("/")
        self.bearer = bearer
        self.db = db
        self.budget = budget
        self.post_usd = post_usd
        self.user_usd = user_usd
        self._timeline_fetched: dict[str, float] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.bearer)

    def _h(self) -> dict:
        return {"Authorization": f"Bearer {self.bearer}"}

    async def _store(self, source: str, posts: list[dict]) -> None:
        for p in posts:
            await self.db.execute(
                "INSERT OR IGNORE INTO x_posts(post_id,source,author,text,created_at,metrics,fetched_at)"
                " VALUES(?,?,?,?,?,?,?)",
                [p["id"], source, p.get("author_id"), p.get("text"), p.get("created_at"),
                 json.dumps(p.get("public_metrics") or {}), time.time()])

    async def _cached(self, source: str, since_iso: str | None = None, limit: int = 50) -> list[dict]:
        sql = "SELECT post_id,author,text,created_at,metrics FROM x_posts WHERE source=?"
        args: list = [source]
        if since_iso:
            sql += " AND created_at >= ?"
            args.append(since_iso)
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        rows = await self.db.fetchall(sql, args)
        for r in rows:
            r["metrics"] = json.loads(r["metrics"] or "{}")
        return rows

    async def search(self, query: str, max_results: int = 10) -> dict:
        """Recent search (last 7 days). Returns new + previously cached posts for this query."""
        source = f"search:{query}"
        if not self.enabled:
            return {"error": "X API disabled (no X_BEARER_TOKEN)", "posts": []}
        max_results = max(10, min(100, max_results))
        worst = max_results * self.post_usd
        try:
            await self.budget.reserve(worst)
        except BudgetExceeded as e:
            return {"error": str(e), "posts": await self._cached(source)}
        actual = 0.0
        try:
            params = {"query": query, "max_results": max_results,
                      "tweet.fields": "created_at,public_metrics,author_id,lang"}
            since = await self.db.kv_get(f"xsince:{source}")
            if since:
                params["since_id"] = since
            data = await request_json(self.c, "GET", f"{self.base}/tweets/search/recent", params=params,
                                      headers=self._h(), retries=1) or {}
            posts = data.get("data") or []
            actual = len(posts) * self.post_usd
            await self._store(source, posts)
            newest = (data.get("meta") or {}).get("newest_id")
            if newest:
                await self.db.kv_set(f"xsince:{source}", newest)
        except HttpError as e:
            log.warning("x search failed: %s", e)
            return {"error": str(e), "posts": await self._cached(source)}
        finally:
            await self.budget.settle(worst, actual, f"search {query[:80]}")
        return {"posts": await self._cached(source)}

    async def _user_id(self, handle: str) -> str | None:
        key = f"xuser:{handle.lower()}"
        uid = await self.db.kv_get(key)
        if uid:
            return uid
        await self.budget.reserve(self.user_usd)
        actual = 0.0
        try:
            data = await request_json(self.c, "GET", f"{self.base}/users/by/username/{handle}",
                                      headers=self._h(), retries=1) or {}
            uid = (data.get("data") or {}).get("id")
            actual = self.user_usd
        finally:
            await self.budget.settle(self.user_usd, actual, f"user {handle}")
        if uid:
            await self.db.kv_set(key, uid)
        return uid

    async def timeline(self, handle: str, window_min: float, refresh_min: float, max_results: int = 5) -> dict:
        """Posts by `handle` in the last `window_min` minutes. Refetches at most every `refresh_min`."""
        source = f"timeline:{handle.lower()}"
        since_iso = datetime.fromtimestamp(time.time() - window_min * 60, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        if not self.enabled:
            return {"error": "X API disabled", "posts": []}
        if time.time() - self._timeline_fetched.get(handle, 0) < refresh_min * 60:
            return {"posts": await self._cached(source, since_iso)}
        self._timeline_fetched[handle] = time.time()
        try:
            uid = await self._user_id(handle)
        except (BudgetExceeded, HttpError) as e:
            return {"error": str(e), "posts": await self._cached(source, since_iso)}
        if not uid:
            return {"error": f"unknown handle {handle}", "posts": []}
        max_results = max(5, min(100, max_results))
        worst = max_results * self.post_usd
        try:
            await self.budget.reserve(worst)
        except BudgetExceeded as e:
            return {"error": str(e), "posts": await self._cached(source, since_iso)}
        actual = 0.0
        try:
            params = {"max_results": max_results, "tweet.fields": "created_at,public_metrics",
                      "exclude": "retweets,replies"}
            since = await self.db.kv_get(f"xsince:{source}")
            if since:
                params["since_id"] = since
            else:
                params["start_time"] = since_iso + "Z"
            data = await request_json(self.c, "GET", f"{self.base}/users/{uid}/tweets", params=params,
                                      headers=self._h(), retries=1) or {}
            posts = data.get("data") or []
            actual = len(posts) * self.post_usd
            for p in posts:
                p["author_id"] = handle
            await self._store(source, posts)
            newest = (data.get("meta") or {}).get("newest_id")
            if newest:
                await self.db.kv_set(f"xsince:{source}", newest)
        except HttpError as e:
            log.warning("x timeline %s failed: %s", handle, e)
        finally:
            await self.budget.settle(worst, actual, f"timeline {handle}")
        return {"posts": await self._cached(source, since_iso)}
