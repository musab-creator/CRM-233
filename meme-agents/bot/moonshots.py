"""Moonshot tracker: every coin the bot evaluated, watched on DexScreener for MOONSHOT_TRACK_DAYS.

The shadow book closes each evaluated coin at the bot's own exits within hours, so a coin that went
100x or 500x over the following days showed up nowhere (9 Oct: "I'm looking for the 500x"). This
loop reads every coin seen in the last MOONSHOT_TRACK_DAYS and keeps its highest confirmed price, so
the report can say how many went 10x/100x/500x from the price the bot saw, whether the agents
bought, passed, were vetoed or skipped them at triage, and what the bot's trade and shadow got.

A confirmed peak is the lower of two consecutive reads: one bad quote, or a spike that lasts a
single poll, never counts, at the cost of understating a peak by what the price moved between two
reads. The tracker measures; it never trades."""
from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime, timezone

import httpx

from .config import Settings
from .db import SPIKED_SHADOWS_SQL, Database
from .feeds.dexscreener import sol_price_native
from .feeds.http import HttpError
from .util import now_s

log = logging.getLogger("bot.moonshots")

MULTIPLES = (2, 10, 100, 500)
GROUPS = ("bought", "gate BUY, no entry", "committee PASS", "vetoed", "triage skipped")
BATCH = 30                 # DexScreener's addresses per call
REQUEST_GAP_S = 1.0        # between batches: the bot's positions and agents share DexScreener's limit
YOUNG_S = 86400.0          # coins seen within a day are read every pass, older ones every OLD_EVERY-th
OLD_EVERY = 4
NEVER_LISTED_MISSES = 24   # a coin DexScreener never priced in SOL is dropped after this many empty reads
LATE_FIRST_READ_S = 86400.0
COLS = ("peak_price", "peak_at", "peak_mcap_usd", "prev_price", "last_price", "last_mcap_usd", "last_at",
        "first_at", "supply", "polls", "readings", "misses", "alerted_at", "done")
FETCH_ERRORS = (HttpError, httpx.HTTPError, asyncio.TimeoutError)


def _num(v) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def reading(pairs: list[dict] | None) -> dict | None:
    """The SOL price of the deepest wrapped-SOL pair, its market cap in dollars and the token supply
    that implies; None when no pair is quoted in SOL (a USDC pair's native price is not in SOL)."""
    sol_pairs = [p for p in pairs or [] if sol_price_native(p)]
    if not sol_pairs:
        return None
    p = max(sol_pairs, key=lambda q: _num((q.get("liquidity") or {}).get("usd")) or 0)
    price = sol_price_native(p)
    usd, mcap = _num(p.get("priceUsd")), _num(p.get("marketCap")) or _num(p.get("fdv"))
    usd = usd if usd and usd > 0 else None
    mcap = mcap if mcap and mcap > 0 else None
    return {"price": price, "mcap_usd": mcap, "sol_usd": usd / price if usd else None,
            "supply": mcap / usd if mcap and usd else None}


def advance(row: dict, r: dict | None, now: float) -> dict:
    """The row after one read: a new peak only when this read and the one before both reached it."""
    out = {**row, "polls": (row["polls"] or 0) + 1, "last_at": now}
    if r is None:
        out["misses"] = (row["misses"] or 0) + 1
        if not row["readings"] and out["misses"] >= NEVER_LISTED_MISSES:
            out["done"] = 2
        return out
    price = r["price"]
    out.update(readings=(row["readings"] or 0) + 1, misses=0, last_price=price, prev_price=price,
               last_mcap_usd=r["mcap_usd"], first_at=row["first_at"] or now, supply=r["supply"] or row["supply"])
    prev = row["prev_price"]
    if prev and prev > 0:
        confirmed = min(prev, price)
        if confirmed > (row["peak_price"] or 0):
            out.update(peak_price=confirmed, peak_at=now,
                       peak_mcap_usd=confirmed * r["sol_usd"] * out["supply"] if r["sol_usd"] and out["supply"]
                       else None)
    return out


class MoonshotTracker:
    def __init__(self, s: Settings, db: Database, dex, notify=None):
        self.s, self.db, self.dex, self.notify = s, db, dex, notify
        self.gap_s = REQUEST_GAP_S
        self._stop: asyncio.Event | None = None

    async def sync(self, now: float) -> int:
        """Start watching every coin whose shadow opened inside the window. The reference is its first
        shadow's entry price: what the bot could have bought at when it looked."""
        rows = await self.db.fetchall(
            "SELECT p.mint, p.candidate_id, p.entry_price, p.opened_at, p.sol_usd_entry FROM positions p "
            "WHERE p.kind='shadow' AND p.entry_price>0 AND p.opened_at>=? AND p.mint IS NOT NULL "
            "AND NOT EXISTS (SELECT 1 FROM moonshots m WHERE m.mint=p.mint) ORDER BY p.opened_at, p.id",
            [now - self.s.MOONSHOT_TRACK_DAYS * 86400])
        await self.db.executemany(
            "INSERT OR IGNORE INTO moonshots (mint, candidate_id, ref_price, ref_at, ref_sol_usd) VALUES (?,?,?,?,?)",
            [(r["mint"], r["candidate_id"], r["entry_price"], r["opened_at"], r["sol_usd_entry"]) for r in rows])
        return len({r["mint"] for r in rows})

    async def _pairs(self, mints: list[str]) -> dict[str, list[dict]]:
        if hasattr(self.dex, "token_pair_lists"):
            return await self.dex.token_pair_lists(mints) or {}
        return {m: [q] for m, q in (await self.dex.tokens(mints) or {}).items() if q}   # simulator

    async def _wait(self, seconds: float) -> bool:
        """Sleep, cut short by the bot stopping; True when it is stopping."""
        if self._stop is None:
            await asyncio.sleep(seconds)
            return False
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass
        return self._stop.is_set()

    async def poll_once(self, now: float) -> dict:
        stats = {"added": await self.sync(now), "due": 0, "priced": 0, "failed": 0, "alerts": 0}
        await self.db.execute("UPDATE moonshots SET done=1 WHERE done=0 AND ref_at<?",
                              [now - self.s.MOONSHOT_TRACK_DAYS * 86400])
        step = self.s.MOONSHOT_POLL_MIN * 60
        rows = await self.db.fetchall("SELECT * FROM moonshots WHERE done=0 ORDER BY ref_at DESC")
        due = [r for r in rows if r["last_at"] is None or now - r["last_at"]
               >= (step if now - (r["ref_at"] or 0) < YOUNG_S else step * OLD_EVERY) - 0.05 * step]
        stats["due"] = len(due)
        alerts, error = [], None
        for i in range(0, len(due), BATCH):
            if i and self.gap_s and await self._wait(self.gap_s):
                break
            chunk = due[i:i + BATCH]
            try:
                lists = await self._pairs([r["mint"] for r in chunk])
            except FETCH_ERRORS as e:
                stats["failed"] += 1
                error = e
                continue
            new_rows = []
            for r in chunk:
                new = advance(r, reading(lists.get(r["mint"])), now)
                stats["priced"] += new["readings"] != r["readings"]
                if (self.notify and self.s.MOONSHOT_ALERT_MULTIPLE and not new["alerted_at"] and new["peak_price"]
                        and r["ref_price"] and new["peak_price"] / r["ref_price"] >= self.s.MOONSHOT_ALERT_MULTIPLE):
                    new["alerted_at"] = now
                    alerts.append(r["mint"])
                new_rows.append(tuple(new[c] for c in COLS) + (r["mint"],))
            await self.db.executemany(f"UPDATE moonshots SET {','.join(c + '=?' for c in COLS)} WHERE mint=?",
                                      new_rows)
        if error is not None:
            log.warning("moonshot tracker: DexScreener failed for %d of %d batches (%s)", stats["failed"],
                        math.ceil(len(due) / BATCH), error)
        for mint in alerts:
            try:
                item = (await items(self.db, self.s, mint))[0]
                await self.notify(alert_text(item))
                stats["alerts"] += 1
            except Exception:
                log.exception("moonshot alert for %s failed", mint)
        if due:
            log.info("moonshot tracker: %d coins watched, %d read, %d priced, %d new", len(rows), len(due),
                     stats["priced"], stats["added"])
        return stats

    async def run(self, stop: asyncio.Event) -> None:
        self._stop = stop
        while not stop.is_set():
            try:
                await self.poll_once(now_s())
            except FETCH_ERRORS as e:
                log.warning("moonshot tracker pass failed: %s", e)
            await self._wait(self.s.MOONSHOT_POLL_MIN * 60)


# --- what the report and the alert show -------------------------------------------------------

def group_of(cand: dict | None, bought: bool) -> str:
    if bought:
        return "bought"
    reason = (cand or {}).get("gate_reason") or ""
    if reason.startswith("triage:"):
        return "triage skipped"
    if reason.startswith("veto from"):
        return "vetoed"
    if (cand or {}).get("decision") == "BUY":
        return "gate BUY, no entry"            # the kill switch, the regime or a risk limit kept it out
    return "committee PASS"


async def items(db: Database, s: Settings, mint: str | None = None) -> list[dict]:
    """One entry per tracked coin: the price the bot saw, its highest confirmed price (the tracker's,
    or its shadow's own peak while the shadow was open), the decision, the shadow and the real trade."""
    only, args = (" AND mint=?", [mint]) if mint else ("", [])
    rows = await db.fetchall("SELECT ms.*, mi.symbol FROM moonshots ms LEFT JOIN mints mi ON mi.mint=ms.mint "
                             "WHERE ms.ref_price>0" + only.replace("mint", "ms.mint"), args)
    if not rows:
        return []
    spiked = {r["position_id"] for r in await db.fetchall(SPIKED_SHADOWS_SQL)}
    tracked = "mint IN (SELECT mint FROM moonshots)" + only
    shadows: dict[str, list[dict]] = {}
    for p in await db.fetchall("SELECT id, mint, peak_price, status, pnl_sol, cost_sol, exit_reason, opened_at, "
                               "closed_at FROM positions WHERE kind='shadow' AND " + tracked + " ORDER BY opened_at, id",
                               args):
        shadows.setdefault(p["mint"], []).append(p)
    trades: dict[str, list[dict]] = {}
    for p in await db.fetchall("SELECT id, mint, status, entry_price, size_usd, pnl_usd, exit_reason, runner_active "
                               "FROM positions WHERE kind='real' AND (mode=? OR mode IS NULL) AND status IN "
                               "('open','closed') AND entry_price>0 AND " + tracked + " ORDER BY opened_at, id",
                               [s.MODE, *args]):
        trades.setdefault(p["mint"], []).append(p)
    cands: dict[str, dict] = {}
    for c in await db.fetchall("SELECT id, mint, decision, gate_reason, ts FROM candidates WHERE decision IS NOT NULL "
                               "AND " + tracked + " ORDER BY ts, id", args):
        cands[c["mint"]] = c                   # the latest decision on the coin
    out = []
    for r in rows:
        ref = r["ref_price"]
        own = [p for p in shadows.get(r["mint"], []) if p["id"] not in spiked and (p["peak_price"] or 0) > 0]
        shadow_peak = max((p["peak_price"] for p in own), default=None)
        tracker_peak = r["peak_price"] if (r["peak_price"] or 0) > 0 else None
        peak = max(v for v in (tracker_peak, shadow_peak, ref) if v)
        from_tracker = tracker_peak is not None and tracker_peak >= (shadow_peak or 0) and tracker_peak >= ref
        supply, rate = _num(r["supply"]), _num(r["ref_sol_usd"])
        first = (shadows.get(r["mint"]) or [None])[0]
        trade = (trades.get(r["mint"]) or [None])[0]
        cand = cands.get(r["mint"])
        out.append({
            "mint": r["mint"], "symbol": r["symbol"] or r["mint"][:8], "candidate_id": (cand or {}).get("id")
            or r["candidate_id"], "group": group_of(cand, trade is not None),
            "reason": (cand or {}).get("gate_reason") or "", "decision": (cand or {}).get("decision"),
            "ref_at": r["ref_at"], "multiple": peak / ref,
            "now_multiple": r["last_price"] / ref if (r["last_price"] or 0) > 0 else None,
            "peak_source": "tracker" if from_tracker else "shadow" if shadow_peak and shadow_peak > ref else None,
            "peak_after_s": (r["peak_at"] - r["ref_at"]) if from_tracker and r["peak_at"] and r["ref_at"] else None,
            "ref_mcap_usd": ref * rate * supply if rate and supply else None,
            # the tracker's own figure, else the peak at the dollar rate of the day the bot saw it
            "peak_mcap_usd": (from_tracker and r["peak_mcap_usd"]) or (peak * rate * supply if rate and supply
                                                                       else None),
            "first_read_late": bool(r["first_at"] and r["ref_at"] and r["first_at"] - r["ref_at"] > LATE_FIRST_READ_S),
            "priced": bool(r["readings"]),
            "shadow": None if not first else {
                "status": first["status"], "exit": first["exit_reason"],
                "ret": first["pnl_sol"] / first["cost_sol"] if first["status"] == "closed"
                and _num(first["pnl_sol"]) is not None and (_num(first["cost_sol"]) or 0) > 0 else None},
            "trade": None if not trade else {
                "id": trade["id"], "status": trade["status"], "size_usd": trade["size_usd"],
                "exit": trade["exit_reason"], "pnl_usd": _num(trade["pnl_usd"]), "runner": bool(trade["runner_active"]),
                "peak_vs_entry": peak / trade["entry_price"]},
        })
    return out


async def summary(db: Database, s: Settings, top: int = 8) -> dict | None:
    rows = await items(db, s)
    if not rows:
        return None
    counts = {g: {"n": 0, **{f"{x}x": 0 for x in MULTIPLES}} for g in ("all", *GROUPS)}
    for it in rows:
        for g in ("all", it["group"]):
            counts[g]["n"] += 1
            for x in MULTIPLES:
                counts[g][f"{x}x"] += it["multiple"] >= x
    ten = [it for it in rows if it["multiple"] >= 10]
    firsts = await db.fetchone("SELECT MIN(first_at) a FROM moonshots")
    return {"n": len(rows), "priced": sum(it["priced"] for it in rows), "days": s.MOONSHOT_TRACK_DAYS,
            "since": firsts["a"] if firsts else None, "late": sum(it["first_read_late"] for it in rows),
            "counts": counts,
            "over_10x": len(ten),
            "over_10x_shadow_sold_under_2x": sum(1 for it in ten if it["shadow"] and it["shadow"]["ret"] is not None
                                                 and it["shadow"]["ret"] < 1.0),
            "top": sorted((it for it in rows if it["multiple"] >= 2), key=lambda it: -it["multiple"])[:top]}


def _x(m: float) -> str:
    return f"{m:,.0f}x" if m >= 10 else f"{m:.1f}x"


def _usd(v: float | None) -> str:
    if v is None:
        return "?"
    if v >= 1e6:
        return f"${v / 1e6:.2f}M"
    return f"${v / 1e3:.1f}k" if v >= 1e3 else f"${v:.0f}"


def _dur(seconds: float) -> str:
    return f"{seconds / 3600:.1f}h" if seconds < 48 * 3600 else f"{seconds / 86400:.1f}d"


def _when(ts: float | None) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%m-%d %H:%M") if ts else "?"


def _shadow_text(sh: dict | None) -> str:
    if not sh:
        return "none"
    if sh["status"] != "closed":
        return sh["status"]
    return f"{sh['exit'] or '?'} {sh['ret'] * 100:+.0f}%" if sh["ret"] is not None else (sh["exit"] or "?")


def _trade_text(t: dict | None) -> str:
    if not t:
        return "none"
    size = f"${t['size_usd']:.0f}" if _num(t["size_usd"]) is not None else "?"
    if t["status"] == "closed":
        pnl = f" for ${t['pnl_usd']:+.2f}" if t["pnl_usd"] is not None else ""
        how = f"#{t['id']} {size}, closed by {t['exit'] or '?'}{pnl}"
    else:
        how = f"#{t['id']} {size}, still open{' (runner)' if t['runner'] else ''}"
    return f"{how}; the peak was {_x(t['peak_vs_entry'])} its entry"


def _peak_text(it: dict) -> str:
    mcap = (f" (~{_usd(it['ref_mcap_usd'])} -> ~{_usd(it['peak_mcap_usd'])} market cap)"
            if it["ref_mcap_usd"] and it["peak_mcap_usd"] else "")
    when = (f", {_dur(it['peak_after_s'])} after it was seen" if it["peak_after_s"] is not None
            else ", while its shadow was open" if it["peak_source"] == "shadow" else "")
    return mcap + when


def alert_text(it: dict) -> str:
    reason = f" ({it['reason'][:160]})" if it["reason"] else ""
    return (f"🚀 Moonshot: {it['symbol']} reached {_x(it['multiple'])} the price the bot saw{_peak_text(it)}.\n"
            f"Decision #{it['candidate_id']}: {it['group']}{reason}\n"
            f"Shadow: {_shadow_text(it['shadow'])}. Bot's trade: {_trade_text(it['trade'])}.\n"
            f"mint {it['mint']}\nhttps://dexscreener.com/solana/{it['mint']}")


def render_lines(m: dict | None) -> list[str]:
    if not m:
        return []
    lines = ["", f"== Moonshot tracker: every evaluated coin, watched {m['days']:g} days from the price the bot saw ==",
             f"{m['n']} coins, {m['priced']} priced on DexScreener so far"
             + (f" (reading since {_when(m['since'])} UTC)" if m["since"] else " (no read yet)")
             + "; a peak counts when two reads in a row reach it, or the shadow's own peak while it was open"]
    if m["late"]:
        lines.append(f"{m['late']} were first read more than a day after the bot saw them (seen before the tracker "
                     "existed): a peak between their shadow's exit and that read is not counted")
    lines.append(f"{'peak vs price seen':<20}" + "".join(f"{'>=' + str(x) + 'x':>8}" for x in MULTIPLES)
                 + f"{'coins':>8}")
    for g in ("all", *GROUPS):
        c = m["counts"][g]
        if g == "all" or c["n"]:
            lines.append(f"  {g:<18}" + "".join(f"{c[f'{x}x']:>8}" for x in MULTIPLES) + f"{c['n']:>8}")
    if m["over_10x"]:
        lines.append(f"exits: {m['over_10x']} coin{'s' if m['over_10x'] != 1 else ''} reached 10x or more; the bot's "
                     f"exits (on the shadow) had sold {m['over_10x_shadow_sold_under_2x']} of them for under +100%")
    if m["top"]:
        lines.append("top coins by peak (decision; shadow; the bot's trade):")
        for it in m["top"]:
            now = f", now {_x(it['now_multiple'])}" if it["now_multiple"] is not None else ""
            reason = f": {it['reason'][:70]}" if it["reason"] and it["group"] != "bought" else ""
            lines.append(f"  {_x(it['multiple']):>7} {it['symbol']} seen {_when(it['ref_at'])}{_peak_text(it)}{now}"
                         f" | #{it['candidate_id']} {it['group']}{reason} | shadow {_shadow_text(it['shadow'])}"
                         f" | trade {_trade_text(it['trade'])}")
    return lines
