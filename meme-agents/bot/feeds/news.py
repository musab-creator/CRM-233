"""Catalyst feeds: CryptoPanic (free developer API) and RSS/Atom (incl. a Truth Social mirror).

All results are normalised to {source, title, url, published_ts} and cached for
NEWS_REFRESH_MIN so the cost per candidate is zero.
"""
from __future__ import annotations

import logging
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from email.utils import parsedate_to_datetime

import httpx

log = logging.getLogger("bot.news")


def _ts(s: str | None) -> float | None:
    if not s:
        return None
    s = s.strip()
    try:
        return parsedate_to_datetime(s).timestamp()
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def parse_feed(xml_text: str, source: str) -> list[dict]:
    """RSS 2.0 <item> or Atom <entry>; namespace-agnostic."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    out = []
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag not in ("item", "entry"):
            continue
        fields: dict[str, str] = {}
        for ch in el:
            t = ch.tag.rsplit("}", 1)[-1]
            if t == "link" and ch.get("href"):
                fields["link"] = ch.get("href")
            elif ch.text:
                fields.setdefault(t, ch.text.strip())
        title = fields.get("title") or fields.get("description", "")[:200]
        out.append({
            "source": source,
            "title": _strip_html(title)[:300],
            "url": fields.get("link"),
            "published_ts": _ts(fields.get("pubDate") or fields.get("published") or fields.get("updated")
                                or fields.get("date")),
        })
    return out


def _strip_html(s: str) -> str:
    import re
    return re.sub(r"<[^>]+>", " ", s or "").replace("&amp;", "&").strip()


class NewsFeed:
    def __init__(self, client: httpx.AsyncClient, cryptopanic_url: str, cryptopanic_token: str,
                 rss_urls: list[str], truth_rss: str, refresh_min: float):
        self.c = client
        self.cp_url = cryptopanic_url
        self.cp_token = cryptopanic_token
        self.rss_urls = [u for u in rss_urls if u]
        self.truth_rss = truth_rss
        self.refresh_s = refresh_min * 60
        self._cache: tuple[float, list[dict]] = (0.0, [])

    async def _cryptopanic(self) -> list[dict]:
        if not self.cp_token:
            return []
        r = await self.c.get(self.cp_url, params={"auth_token": self.cp_token, "public": "true", "kind": "news"})
        r.raise_for_status()
        out = []
        for p in (r.json() or {}).get("results") or []:
            out.append({"source": "cryptopanic:" + ((p.get("source") or {}).get("title") or ""),
                        "title": (p.get("title") or "")[:300], "url": p.get("url") or p.get("original_url"),
                        "published_ts": _ts(p.get("published_at") or p.get("created_at"))})
        return out

    async def _rss(self, url: str, source: str) -> list[dict]:
        r = await self.c.get(url, follow_redirects=True)
        r.raise_for_status()
        return parse_feed(r.text, source)

    async def items(self) -> list[dict]:
        ts, cached = self._cache
        if time.time() - ts < self.refresh_s:
            return cached
        items: list[dict] = []
        jobs = [("cryptopanic", self._cryptopanic())]
        jobs += [(u, self._rss(u, "rss:" + httpx.URL(u).host)) for u in self.rss_urls]
        if self.truth_rss:
            jobs.append((self.truth_rss, self._rss(self.truth_rss, "truthsocial")))
        for name, coro in jobs:
            try:
                items.extend(await coro)
            except Exception as e:  # one dead feed must not blind the agent
                log.warning("news feed %s failed: %s", name, e)
        items.sort(key=lambda x: x.get("published_ts") or 0, reverse=True)
        self._cache = (time.time(), items)
        return items

    async def recent(self, window_min: float) -> list[dict]:
        cutoff = time.time() - window_min * 60
        return [i for i in await self.items() if (i.get("published_ts") or 0) >= cutoff]
