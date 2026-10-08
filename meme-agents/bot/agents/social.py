"""Social graph: pure functions over X author profiles and posts, for the social agent."""
from __future__ import annotations

from datetime import datetime
from statistics import median


def _age_days(created_at: str | None, now: float) -> float | None:
    if not created_at:
        return None
    try:
        ts = datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
    return round((now - ts) / 86400, 1)


def author_stats(users: list[dict], posts: list[dict], now: float) -> dict:
    """How real the people posting look: account ages, follower counts, how many posts each
    author made, verified count. `posts` are the search results (author_id, text)."""
    per_author: dict[str, int] = {}
    for p in posts:
        a = str(p.get("author_id") or p.get("author") or "")
        if a:
            per_author[a] = per_author.get(a, 0) + 1
    ages = []
    rows = []
    under_30d = under_50_followers = follow_heavy = verified = 0
    for u in users:
        age = _age_days(u.get("created_at"), now)
        followers = u.get("followers") or 0
        following = u.get("following") or 0
        if age is not None:
            ages.append(age)
            under_30d += age < 30
        under_50_followers += followers < 50
        follow_heavy += following > 3 * max(followers, 1) and following > 100
        verified += bool(u.get("verified"))
        rows.append({"id": u.get("id"), "username": u.get("username"), "age_days": age, "followers": followers,
                     "following": following, "posts_total": u.get("posts"), "verified": bool(u.get("verified")),
                     "posts_about_token": per_author.get(str(u.get("id")), 0)})
    n = len(users)
    texts = [(p.get("text") or "").strip().lower() for p in posts]
    return {
        "authors_profiled": n,
        "authors_in_posts": len(per_author),
        "median_account_age_days": round(median(ages), 1) if ages else None,
        "share_under_30_days": round(under_30d / n, 2) if n else None,
        "share_under_50_followers": round(under_50_followers / n, 2) if n else None,
        "share_follow_heavy": round(follow_heavy / n, 2) if n else None,
        "verified": verified,
        "max_posts_by_one_author": max(per_author.values(), default=0),
        "duplicate_text_ratio": round(1 - len(set(texts)) / len(texts), 2) if texts else None,
        "authors": rows,
    }
