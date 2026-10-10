"""Moonshot tracker: every coin the bot evaluated, watched on DexScreener for MOONSHOT_TRACK_DAYS.

The shadow book closes each evaluated coin at the bot's own exits within hours, so a coin that went
100x or 500x over the following days showed up nowhere (9 Oct: "I'm looking for the 500x"). This
loop reads every coin seen in the last MOONSHOT_TRACK_DAYS and keeps its highest confirmed price, so
the report can say how many went 10x/100x/500x from the price the bot saw, whether the agents
bought, passed, were vetoed or skipped them at triage, and what the bot's trade and shadow got.

A confirmed peak is the lower of two consecutive reads: one bad quote, or a spike that lasts a
single poll, never counts, at the cost of understating a peak by what the price moved between two
reads. A confirmed low is the higher of two, for the same reason. The tracker measures; it never trades.

Dips and timing (10 Oct: 14 of the 36 bought coins doubled, yet only 9 of 33 closed trades won):
for each coin it also keeps its lowest price before its peak and before its first 2x of the price
the bot saw, when that 2x came, and its price 6, 12 and 24 hours after the bot saw it. Its shadow's
own marks cover the time the shadow was open, trade by trade."""
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
from .paper import open_result
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
        "first_at", "supply", "polls", "readings", "misses", "alerted_at", "done", "low_price", "low_at",
        "low_before_peak", "first_2x_at", "low_before_2x", "price_6h", "price_12h", "price_24h", "low_0h_6h",
        "low_6h_12h", "low_12h_24h")
SNAPSHOTS = ((6, "price_6h"), (12, "price_12h"), (24, "price_24h"))
WINDOWS = ((0, 6, "low_0h_6h"), (6, 12, "low_6h_12h"), (12, 24, "low_12h_24h"))
SNAPSHOT_LATE_S = 7200.0   # a first read this long after the hour is no picture of the price at that hour
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
    """The row after one read: a new peak only when this read and the one before both reached it, a new
    low only when both fell to it. A row with `dips` also keeps its low before the peak and before the
    first 2x of the price the bot saw (the low as it stood before the read that confirmed it), when
    that 2x came, its price 6, 12 and 24 hours after the bot saw it and its lowest in between."""
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
    dips, ref, seen = row.get("dips"), row.get("ref_price"), row.get("ref_at")
    if dips and seen:
        age = now - seen
        for hours, col in SNAPSHOTS:
            if row.get(col) is None and hours * 3600 <= age <= hours * 3600 + SNAPSHOT_LATE_S:
                out[col] = price
    if prev and prev > 0:
        confirmed = min(prev, price)
        if confirmed > (row["peak_price"] or 0):
            out.update(peak_price=confirmed, peak_at=now,
                       peak_mcap_usd=confirmed * r["sol_usd"] * out["supply"] if r["sol_usd"] and out["supply"]
                       else None)
            if dips:
                out["low_before_peak"] = row.get("low_price")
        if dips and ref and ref > 0 and row.get("first_2x_at") is None and confirmed >= 2 * ref:
            out.update(first_2x_at=now, low_before_2x=row.get("low_price"))
        low = max(prev, price)
        if dips and low < (row.get("low_price") or math.inf):
            out.update(low_price=low, low_at=now)
        if dips and seen:
            for start, end, col in WINDOWS:
                if start * 3600 < now - seen <= end * 3600 and low < (row.get(col) or math.inf):
                    out[col] = low
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
            "INSERT OR IGNORE INTO moonshots (mint, candidate_id, ref_price, ref_at, ref_sol_usd, dips) "
            "VALUES (?,?,?,?,?,1)",
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

def dip_record(r: dict, sh: dict | None) -> dict | None:
    """A coin's dips and timing, as a change from the price the bot saw and seconds after it saw it: its
    lowest so far and in its first 6 h, its lowest before its peak and before its first 2x, when each
    came, and its price 6, 12 and 24 h on with its lowest in between. The first shadow's marks cover the
    time it was open, trade by trade; the tracker's confirmed reads the rest. None for a coin tracked
    before these were recorded."""
    ref, seen = _num(r.get("ref_price")), _num(r.get("ref_at"))
    if not r.get("dips") or not ref or ref <= 0 or seen is None:
        return None
    sh_trough, sh_trough_at = (_num(sh.get("trough_price")), _num(sh.get("trough_at"))) if sh else (None, None)
    if sh_trough is None or sh_trough_at is None:
        sh, sh_trough = None, None                  # a shadow opened before its marks were kept
    sh_2x, tr_2x = _num(sh.get("first_2x_at")) if sh else None, _num(r.get("first_2x_at"))
    if sh_2x is not None and (tr_2x is None or sh_2x <= tr_2x):
        x2_at, low_2x = sh_2x, _num(sh.get("trough_before_2x"))
    elif tr_2x is not None:
        x2_at = tr_2x
        low_2x = _lowest(r.get("low_before_2x"), sh_trough if sh and sh_trough_at <= tr_2x else None)
    else:
        x2_at = low_2x = None
    sh_peak, sh_peak_at = (_num(sh.get("peak_price")) or 0, _num(sh.get("peak_at"))) if sh else (0, None)
    tr_peak, tr_peak_at = _num(r.get("peak_price")) or 0, _num(r.get("peak_at"))
    if sh_peak_at is not None and sh_peak >= tr_peak:
        peak_at, low_peak = sh_peak_at, _num(sh.get("trough_before_peak"))
    elif tr_peak > 0 and tr_peak_at is not None:
        peak_at = tr_peak_at
        before = (sh_trough if sh and sh_trough_at <= tr_peak_at else
                  sh.get("trough_before_peak") if sh_peak_at is not None and sh_peak_at <= tr_peak_at else None)
        low_peak = _lowest(r.get("low_before_peak"), before)
    else:
        peak_at = low_peak = None

    timed = sh is not None and sh.get("status") == "closed" and sh.get("exit_reason") == "time_stop"

    def vs_seen(v):
        v = _num(v)
        return v / ref - 1 if v and v > 0 else None
    return {"low": vs_seen(_lowest(r.get("low_price"), sh_trough)),
            "time_stop_sale": vs_seen(sh.get("last_price")) if timed else None,
            "low_6h": vs_seen(_lowest(r.get("low_0h_6h"), sh_trough if sh and sh_trough_at <= seen + 6 * 3600
                                      else None)),
            "low_before_peak": vs_seen(low_peak), "peak_after_s": peak_at - seen if peak_at is not None else None,
            "low_before_2x": vs_seen(low_2x), "x2_after_s": x2_at - seen if x2_at is not None else None,
            **{f"p{h}h": vs_seen(r.get(col)) for h, col in SNAPSHOTS},
            **{col: vs_seen(r.get(col)) for _, _, col in WINDOWS}}


def _lowest(*values) -> float | None:
    return min((v for v in map(_num, values) if v and v > 0), default=None)


DIP_BUCKETS = ((-0.2, "above -20%"), (-0.4, "-20 to -40%"), (-0.5, "-40 to -50%"), (-0.6, "-50 to -60%"),
               (-math.inf, "-60% or lower"))
WIDER_STOPS = (0.5, 0.6)
STOP_WINDOW_H = 6          # the what-ifs judge a stop inside the first 6 h: the time stop's default


def _bucket_of(low: float) -> str:
    """The dip bucket of a low (a change from the price seen): a stop at -X% fires at -X% or lower."""
    for edge, label in DIP_BUCKETS:
        if low > edge:
            return label
    return DIP_BUCKETS[-1][1]


def _median(xs: list[float]) -> float | None:
    xs = sorted(xs)
    n = len(xs)
    return None if not n else xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _between(low: float | None, stop: float, level: float) -> bool:
    """A low through today's stop (-stop or lower) that a wider one at -level would have survived."""
    return low is not None and -level < low <= -stop


def _span(seconds: float, edges: tuple[float, ...]) -> int:
    """Which of the hour ranges (up to each edge, then longer) `seconds` falls in."""
    return next((i for i, e in enumerate(edges) if seconds <= e * 3600), len(edges))


def dip_summary(rows: list[dict], s: Settings, now: float) -> dict | None:
    """How deep the coins that later doubled dipped first, and what a wider stop or a later time stop
    would have kept against what it would have cost. Counted from the recorded prices, not replayed:
    a take-profit or trailing stop a longer-held coin would then have hit is not simulated, and each
    change is in shares of the stake, as if the whole stake were still held."""
    recs = [it for it in rows if it.get("dips")]
    if not recs:
        return None
    stop, stake, window = s.STOP_LOSS_PCT / 100, s.POSITION_MIN_USD, STOP_WINDOW_H * 3600

    def dip(it, key):
        return it["dips"][key]
    won = [it for it in recs if dip(it, "x2_after_s") is not None]
    dips_2x = [dip(it, "low_before_2x") for it in won if dip(it, "low_before_2x") is not None]
    buckets = {label: 0 for _, label in DIP_BUCKETS}
    for low in dips_2x:
        buckets[_bucket_of(low)] += 1
    ten = [dip(it, "low_before_2x") for it in won if it["multiple"] >= 10 and dip(it, "low_before_2x") is not None]
    to_2x = [0] * 5
    for it in won:
        to_2x[_span(dip(it, "x2_after_s"), (1, 6, 12, 24))] += 1
    peaked = [it for it in won if dip(it, "peak_after_s") is not None]
    to_peak = [0] * 4
    for it in peaked:
        to_peak[_span(dip(it, "peak_after_s"), (6, 24, 72))] += 1
    # a wider stop, judged on coins whose first 6 h are over: the ones that doubled inside them after a dip
    # through today's stop are kept; the rest of the dips through it run on to the wider stop, or to 6 h
    done = [it for it in recs if it["ref_at"] and now - it["ref_at"] >= window]
    quick = [it for it in done if dip(it, "x2_after_s") is not None and dip(it, "x2_after_s") <= window]
    slow = [it for it in done if it not in quick]
    wider = []
    for level in (x for x in WIDER_STOPS if x > stop + 1e-9):
        kept = [it for it in quick if _between(dip(it, "low_before_2x"), stop, level)]
        through = [it for it in slow if dip(it, "low_6h") is not None and dip(it, "low_6h") <= -level]
        held = [it for it in slow if _between(dip(it, "low_6h"), stop, level)]
        at_6h = [dip(it, "p6h") + stop for it in held if dip(it, "p6h") is not None]
        wider.append({"stop": level, "kept": len(kept), "kept_median_peak": _median([it["multiple"] for it in kept]),
                      "kept_later": sum(1 for it in won if _between(dip(it, "low_before_2x"), stop, level)
                                        and dip(it, "x2_after_s") > window),
                      "fell_through": len(through), "held": len(held), "held_unread": len(held) - len(at_6h),
                      "held_median": _median(at_6h),
                      "usd": stake * (math.fsum(at_6h) - (level - stop) * len(through))})
    # a later time stop, on the coins the time stop sold: what they did over the next hours
    timed = [it for it in recs if dip(it, "time_stop_sale") is not None]
    later = []
    for hours in (12, 24):
        if hours <= s.TIME_STOP_HOURS:
            continue
        windows = [col for start, end, col in WINDOWS if end > s.TIME_STOP_HOURS and start < hours]
        ready = [it for it in timed if now - it["ref_at"] >= hours * 3600 + SNAPSHOT_LATE_S]
        doubled = stopped = unread = 0
        moves = []
        for it in ready:
            sold, x2 = dip(it, "time_stop_sale"), dip(it, "x2_after_s")
            if x2 is not None and s.TIME_STOP_HOURS * 3600 < x2 <= hours * 3600 and not (
                    dip(it, "low_before_2x") is not None and dip(it, "low_before_2x") <= -stop):
                doubled += 1
            elif any(dip(it, w) is not None and dip(it, w) <= -stop for w in windows):
                stopped += 1
                moves.append(-stop - sold)
            elif dip(it, f"p{hours}h") is not None:
                moves.append(dip(it, f"p{hours}h") - sold)
            else:
                unread += 1
        later.append({"hours": hours, "n": len(ready), "doubled": doubled, "stopped": stopped, "unread": unread,
                      "sold": len(moves) - stopped, "median_move": _median(moves), "better": sum(m > 0 for m in moves),
                      "usd": stake * math.fsum(moves)})
    return {"n": len(recs), "since": min((it["ref_at"] for it in recs if it["ref_at"]), default=None),
            "stop": stop, "time_stop_hours": s.TIME_STOP_HOURS, "stake_usd": stake,
            "doubled": len(won), "dip_before_2x": buckets, "dip_unknown": len(won) - len(dips_2x),
            "median_dip_before_2x": _median(dips_2x), "ten_x": len(ten),
            "ten_x_through_stop": sum(low <= -stop for low in ten),
            "time_to_2x": to_2x, "time_to_peak": to_peak,
            "median_dip_before_peak": _median([dip(it, "low_before_peak") for it in peaked
                                               if dip(it, "low_before_peak") is not None]),
            "judged": len(done), "doubled_in_window": len(quick), "wider": wider,
            "time_stopped": len(timed), "later": later}


def dip_lines(d: dict | None) -> list[str]:
    if not d:
        return []
    stop, stake = d["stop"], d["stake_usd"]
    lines = ["", f"== Dips before the run: {d['n']} coins seen since {_when(d['since'])} UTC, from the price the "
                 f"bot saw (today's stop -{stop:.0%}, time stop {d['time_stop_hours']:g}h) ==",
             "lows: the shadow's own trades while it was open, then DexScreener every 15 min (hourly after a day); "
             "a low or a 2x counts when two reads in a row reach it, so a dip between two reads is missed"]
    n2 = d["doubled"]
    lines.append(f"reached 2x: {n2} of {d['n']}" + (" (none yet)" if not n2 else
                 "; their lowest price before the 2x: " + " | ".join(f"{k} {v}" for k, v in d["dip_before_2x"].items())
                 + (f" | unknown {d['dip_unknown']}" if d["dip_unknown"] else "")
                 + (f"  (median {d['median_dip_before_2x']:+.0%})" if d["median_dip_before_2x"] is not None else "")))
    if d["ten_x"]:
        lines.append(f"  of them reached 10x: {d['ten_x']}; {d['ten_x_through_stop']} of those fell through "
                     f"-{stop:.0%} before their 2x")
    if n2:
        lines.append("time to 2x: " + " | ".join(f"{label} {v}" for label, v in zip(
            ("under 1h", "1-6h", "6-12h", "12-24h", "over 24h"), d["time_to_2x"])))
    if sum(d["time_to_peak"]):
        lines.append("time to the peak, coins that reached 2x: " + " | ".join(f"{label} {v}" for label, v in zip(
            ("under 6h", "6-24h", "1-3 days", "over 3 days"), d["time_to_peak"]))
            + (f"  (median low before the peak {d['median_dip_before_peak']:+.0%})"
               if d["median_dip_before_peak"] is not None else ""))
    other = (f"; judged with a {STOP_WINDOW_H}h time stop, today's is {d['time_stop_hours']:g}h"
             if d["time_stop_hours"] != STOP_WINDOW_H else "")
    if d["wider"] and not d["judged"]:
        lines.append(f"a wider stop: judged once a coin's first {STOP_WINDOW_H}h are over (none yet)")
    elif d["wider"]:
        lines.append(f"a wider stop, on the {d['judged']} coins whose first {STOP_WINDOW_H}h are over "
                     f"({d['doubled_in_window']} doubled inside them; not replayed, shares of a ${stake:g} stake{other}):")
    for w in d["wider"] if d["judged"] else []:
        extra, band = w["stop"] - stop, f"-{stop:.0%} to -{w['stop']:.0%}"
        peak = f", median peak {_x(w['kept_median_peak'])}" if w["kept_median_peak"] is not None else ""
        later = (f"; {w['kept_later']} more doubled after {STOP_WINDOW_H}h and would also need a longer time stop"
                 if w["kept_later"] else "")
        lines.append(f"  -{w['stop']:.0%} keeps {w['kept']} that dipped {band} and then doubled within "
                     f"{STOP_WINDOW_H}h{peak} (not valued){later}")
        held = (f"; {w['held']} dipped {band} without doubling and would be held to {STOP_WINDOW_H}h"
                + (f", selling a median {w['held_median']:+.0%} of the stake better than at -{stop:.0%}"
                   if w["held_median"] is not None else "")
                + (f" ({w['held_unread']} unread at {STOP_WINDOW_H}h)" if w["held_unread"] else ""))
        lines.append(f"  -{w['stop']:.0%} costs: {w['fell_through']} fell through -{w['stop']:.0%} without doubling, "
                     f"{extra:.0%} of the stake more each{held}; measured on these ${w['usd']:+.2f}")
    if d["later"] and not d["time_stopped"]:
        lines.append("a later time stop: the time stop has sold none of these coins yet")
    elif d["later"]:
        lines.append(f"a later time stop, on the {d['time_stopped']} coins the time stop sold (the stop loss still on; "
                     "the change against the time stop's sale, in shares of the stake):")
    for x in d["later"] if d["time_stopped"] else []:
        if not x["n"]:
            lines.append(f"  to {x['hours']}h: none old enough yet")
            continue
        lines.append(f"  to {x['hours']}h ({x['n']} old enough): {x['doubled']} doubled after the sale (not valued), "
                     f"{x['stopped']} fell through -{stop:.0%} first (sold there), {x['sold']} sold at {x['hours']}h"
                     + (f"; against the time stop's sale: median {x['median_move']:+.0%}, {x['better']} better, "
                        f"measured change ${x['usd']:+.2f}" if x["median_move"] is not None else "")
                     + (f"; {x['unread']} unread" if x["unread"] else ""))
    return lines


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
                               "closed_at, entry_price, last_price, runner_active, proceeds_sol, tokens_remaining, "
                               "sol_usd_entry, trough_price, trough_at, peak_at, trough_before_peak, first_2x_at, "
                               "trough_before_2x FROM positions WHERE kind='shadow' AND " + tracked
                               + " ORDER BY opened_at, id", args):
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
        # the shadow the reference price came from: the first one that bought (sync skips a cancelled one)
        filled = next((p for p in shadows.get(r["mint"], []) if (_num(p["entry_price"]) or 0) > 0), None)
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
                and _num(first["pnl_sol"]) is not None and (_num(first["cost_sol"]) or 0) > 0 else None,
                # an open runner at today's price (report.py counts it the same way)
                "runner_ret": (open_result(first, s) or {}).get("ret") if first["status"] == "open"
                and first["runner_active"] else None},
            "dips": dip_record(r, filled if filled and filled["id"] not in spiked else None),
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
            "dips": dip_summary(rows, s, now_s()),
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
    if sh.get("runner_ret") is not None:
        return f"open runner {sh['runner_ret'] * 100:+.0f}% at today's price"
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
    return lines + dip_lines(m.get("dips"))
