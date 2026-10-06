"""X API v2 (pay-per-use) with a hard monthly budget and a post cache.

Cost model (configurable): $0.005 per post returned, $0.01 per user lookup.

* Before each call the worst case (max_results posts) is reserved against the budget; the
  actual number of posts returned is settled afterwards.
* Every post is stored once in `x_posts`; `x_post_sources` links it to each query/timeline
  that returned it, so cached results are complete and no post is requested twice for the
  same query.
* Each query only fetches the part of its time window not fetched before: by `since_id`
  when the previous fetch covered the window start, otherwise by `start_time`. A `since_id`
  older than 6 days is dropped (recent search rejects ids older than 7 days).
* Results are limited to the requested window, so a ticker reused by an older token does not
  leak that token's posts into a new candidate's evidence.
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

SINCE_ID_MAX_AGE_S = 6 * 86400       # recent search only accepts ids from the last 7 days
SEARCH_LOOKBACK_MAX_S = 6.9 * 86400  # start_time must be within 7 days


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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

    # --- cache --------------------------------------------------------------------
    async def _store(self, source: str, posts: list[dict]) -> None:
        for p in posts:
            await self.db.execute(
                "INSERT OR IGNORE INTO x_posts(post_id,source,author,text,created_at,metrics,fetched_at)"
                " VALUES(?,?,?,?,?,?,?)",
                [p["id"], source, p.get("author_id"), p.get("text"), p.get("created_at"),
                 json.dumps(p.get("public_metrics") or {}), time.time()])
            await self.db.execute("INSERT OR IGNORE INTO x_post_sources(source, post_id) VALUES(?,?)",
                                  [source, p["id"]])

    async def _cached(self, source: str, since_iso: str, limit: int = 50) -> list[dict]:
        rows = await self.db.fetchall(
            "SELECT p.post_id, p.author, p.text, p.created_at, p.metrics FROM x_posts p"
            " JOIN x_post_sources s ON s.post_id = p.post_id"
            " WHERE s.source = ? AND p.created_at >= ? ORDER BY p.created_at DESC LIMIT ?",
            [source, since_iso, limit])
        for r in rows:
            r["metrics"] = json.loads(r["metrics"] or "{}")
        return rows

    async def _cursor(self, source: str) -> dict:
        raw = await self.db.kv_get(f"xsince:{source}")
        try:
            cur = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            cur = {}
        if not isinstance(cur, dict):
            cur = {}
        if cur.get("id") and time.time() - (cur.get("fetched") or 0) > SINCE_ID_MAX_AGE_S:
            cur = {}  # too old for the API: fall back to start_time
        return cur

    async def _advance(self, source: str, cur: dict, newest: str | None, fetched_at: float) -> None:
        await self.db.kv_set(f"xsince:{source}", json.dumps({"id": newest or cur.get("id"), "fetched": fetched_at}))

    def _window_params(self, cur: dict, since_ts: float, now: float) -> dict:
        """Fetch only what earlier calls for this source did not cover."""
        fetched = cur.get("fetched") or 0
        if fetched >= since_ts and cur.get("id"):
            return {"since_id": cur["id"]}
        start = max(since_ts, fetched, now - SEARCH_LOOKBACK_MAX_S)
        return {"start_time": iso(min(start, now - 15))}

    async def _fetch(self, source: str, url: str, params: dict, max_results: int, since_ts: float,
                     label: str) -> dict:
        now = time.time()
        cur = await self._cursor(source)
        worst = max_results * self.post_usd
        try:
            await self.budget.reserve(worst)
        except BudgetExceeded as e:
            return {"error": str(e), "posts": await self._cached(source, iso(since_ts))}
        actual = 0.0
        err = None
        try:
            params = {**params, **self._window_params(cur, since_ts, now)}
            data = await request_json(self.c, "GET", url, params=params, headers=self._h(), retries=1) or {}
            posts = data.get("data") or []
            actual = len(posts) * self.post_usd
            await self._store(source, posts)
            await self._advance(source, cur, (data.get("meta") or {}).get("newest_id"), now)
        except HttpError as e:
            err = str(e)
            log.warning("x %s failed: %s", label, e)
            if e.status == 400 and cur.get("id"):
                await self.db.kv_set(f"xsince:{source}", "{}")  # e.g. since_id rejected: start over
        finally:
            await self.budget.settle(worst, actual, label)
        out: dict = {"posts": await self._cached(source, iso(since_ts))}
        if err:
            out["error"] = err
        return out

    # --- endpoints -------------------------------------------------------------------
    async def search(self, query: str, max_results: int = 10, since_ts: float | None = None) -> dict:
        """Recent search limited to posts created after `since_ts` (default: 24h ago)."""
        if not self.enabled:
            return {"error": "X API disabled (no X_BEARER_TOKEN)", "posts": []}
        now = time.time()
        since_ts = max(since_ts if since_ts is not None else now - 86400, now - SEARCH_LOOKBACK_MAX_S)
        return await self._fetch(
            f"search:{query}", f"{self.base}/tweets/search/recent",
            {"query": query, "max_results": max(10, min(100, max_results)),
             "tweet.fields": "created_at,public_metrics,author_id,lang"},
            max(10, min(100, max_results)), since_ts, f"search {query[:80]}")

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

    async def users(self, ids: list[str]) -> dict:
        """Profiles for up to 100 author ids: created_at, follower counts, verified. One user read
        each against the X budget."""
        ids = [str(i) for i in ids if str(i).strip()][:100]
        if not self.enabled:
            return {"error": "X API disabled (no X_BEARER_TOKEN)", "users": []}
        if not ids:
            return {"users": []}
        worst = len(ids) * self.user_usd
        try:
            await self.budget.reserve(worst)
        except BudgetExceeded as e:
            return {"error": str(e), "users": []}
        actual = 0.0
        err = None
        users: list[dict] = []
        try:
            data = await request_json(self.c, "GET", f"{self.base}/users", headers=self._h(), retries=1,
                                      params={"ids": ",".join(ids),
                                              "user.fields": "created_at,public_metrics,verified,description"}) or {}
            for u in data.get("data") or []:
                m = u.get("public_metrics") or {}
                users.append({"id": u.get("id"), "username": u.get("username"), "created_at": u.get("created_at"),
                              "followers": m.get("followers_count"), "following": m.get("following_count"),
                              "posts": m.get("tweet_count"), "verified": bool(u.get("verified")),
                              "description": (u.get("description") or "")[:160]})
            actual = len(users) * self.user_usd
        except HttpError as e:
            err = str(e)
            log.warning("x users failed: %s", e)
        finally:
            await self.budget.settle(worst, actual, f"users x{len(ids)}")
        out: dict = {"users": users}
        if err:
            out["error"] = err
        return out

    async def timeline(self, handle: str, window_min: float, refresh_min: float, max_results: int = 5) -> dict:
        """Posts by `handle` in the last `window_min` minutes. Refetches at most every `refresh_min`."""
        source = f"timeline:{handle.lower()}"
        since_ts = time.time() - window_min * 60
        if not self.enabled:
            return {"error": "X API disabled", "posts": []}
        if time.time() - self._timeline_fetched.get(handle, 0) < refresh_min * 60:
            return {"posts": await self._cached(source, iso(since_ts))}
        self._timeline_fetched[handle] = time.time()
        try:
            uid = await self._user_id(handle)
        except (BudgetExceeded, HttpError) as e:
            return {"error": str(e), "posts": await self._cached(source, iso(since_ts))}
        if not uid:
            return {"error": f"unknown handle {handle}", "posts": []}
        n = max(5, min(100, max_results))
        res = await self._fetch(source, f"{self.base}/users/{uid}/tweets",
                                {"max_results": n, "tweet.fields": "created_at,public_metrics",
                                 "exclude": "retweets,replies"}, n, since_ts, f"timeline {handle}")
        for p in res["posts"]:
            p["author"] = handle
        return res
