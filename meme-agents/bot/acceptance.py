"""`python -m bot acceptance [--minutes 60] [--sim] [--no-llm]`: the brief's "Done when" test.

Runs the bot in paper mode for N minutes, then checks the log and the database:
  1. it ran the full N minutes without a crash: no exception escaped, no background loop had
     to be restarted, and no ERROR line was logged. Expected outside failures, such as an API
     timing out, are WARNINGs, so an ERROR means a bug or a failed order;
  2. at least one full decision cycle was recorded during the run: a candidate, three votes
     (Scout, Hunter, Analyst) with no agent error, and the gate's decision with its reason;
  3. the report runs on the recorded data (reports/daily-YYYY-MM-DD.md is written).
"All tests pass" is pytest's job; the GitHub workflow runs it before this.

With --no-llm (no ANTHROPIC_API_KEY), check 2 is skipped and the result can at best be
INCOMPLETE. Everything else still runs against live data, including the pre-filter funnel.

Writes reports/acceptance-YYYYmmdd-HHMMSS.md. Exit code 0 = PASS, 1 = FAIL, 3 = INCOMPLETE.
"""
from __future__ import annotations

import json
import logging
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone

from .config import Settings
from .db import Database
from .report import write_daily
from .util import now_s, redact

log = logging.getLogger("bot.acceptance")

AGENTS = ("analyst", "hunter", "scout")


@dataclass
class Criterion:
    name: str
    status: str   # PASS | FAIL | SKIP
    detail: str


class Recorder(logging.Handler):
    """Counts what the bot logs during the run: every ERROR, warnings per source, DECISION lines."""

    def __init__(self):
        super().__init__(logging.INFO)
        self.errors: list[str] = []
        self.error_count = 0
        self.warnings: Counter = Counter()
        self.warning_samples: dict[str, list[str]] = {}
        self.decisions = 0

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = redact(record.getMessage())
        except Exception:
            msg = str(record.msg)
        if record.levelno >= logging.ERROR:
            self.error_count += 1
            if len(self.errors) < 25:
                self.errors.append(f"{record.levelname} {record.name}: {msg[:300]}"
                                   + (" [traceback]" if record.exc_info else ""))
        elif record.levelno >= logging.WARNING:
            self.warnings[record.name] += 1
            samples = self.warning_samples.setdefault(record.name, [])
            if len(samples) < 3:
                samples.append(msg[:200])
        elif msg.startswith("DECISION #"):
            self.decisions += 1


def reason_keys(reason: str) -> list[str]:
    """A pre-filter rejection reason, split into its rules with the numbers taken out."""
    out = []
    for part in (reason or "").split("; "):
        if part.startswith("rugcheck danger: "):
            out += ["rugcheck danger: " + n.strip() for n in part[len("rugcheck danger: "):].split(", ") if n.strip()]
        elif part.startswith("liquidity $"):
            out.append("liquidity below minimum")
        elif part.startswith("top10 "):
            out.append("top-10 holders above maximum")
        elif part:
            out.append(re.sub(r"[\d.,$%]+", "#", part).strip())
    return out


async def funnel(db: Database, since: float) -> dict:
    one = db.fetchone
    f: dict = {
        "launches": (await one("SELECT COUNT(*) c FROM mints WHERE created_at>=?", [since]))["c"],
        "stage1_passed": (await one("SELECT COUNT(DISTINCT mint) c FROM prefilter_results WHERE ts>=?", [since]))["c"],
        "stage2_passed": (await one("SELECT COUNT(DISTINCT mint) c FROM prefilter_results WHERE ts>=? AND passed=1",
                                    [since]))["c"],
        "candidates": {r["status"]: r["c"] for r in await db.fetchall(
            "SELECT status, COUNT(*) c FROM candidates WHERE ts>=? GROUP BY status", [since])},
        "decisions": {r["decision"]: r["c"] for r in await db.fetchall(
            "SELECT decision, COUNT(*) c FROM candidates WHERE ts>=? AND decision IS NOT NULL GROUP BY decision",
            [since])},
        "votes_with_error": (await one("SELECT COUNT(*) c FROM votes WHERE ts>=? AND error IS NOT NULL", [since]))["c"],
        "votes_downgraded_by_guard": (await one("SELECT COUNT(*) c FROM votes WHERE ts>=? AND guard IS NOT NULL",
                                                [since]))["c"],
        "real_entries": (await one("SELECT COUNT(*) c FROM positions WHERE kind='real' AND decided_at>=?",
                                   [since]))["c"],
        "llm_usd": round((await one("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='llm' AND ts>=?",
                                    [since]))["s"], 4),
        "x_usd": round((await one("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind='x' AND ts>=?",
                                  [since]))["s"], 4),
    }
    any_reason: Counter = Counter()
    sole: Counter = Counter()
    for r in await db.fetchall("SELECT reason FROM prefilter_results WHERE ts>=? AND passed=0", [since]):
        keys = reason_keys(r["reason"])
        any_reason.update(set(keys))
        if len(keys) == 1:
            sole[keys[0]] += 1
    f["stage2_rejections"] = dict(any_reason.most_common(12))
    f["stage2_sole_blocker"] = dict(sole.most_common(8))
    return f


async def first_full_cycle(db: Database, since: float, need_clean_votes: bool) -> tuple[dict | None, int]:
    """(the first full decision cycle of the run, how many there were)."""
    rows = await db.fetchall(
        "SELECT c.id, c.mint, c.ts, c.decision, c.mean_confidence, c.gate_reason, c.metrics, m.symbol "
        "FROM candidates c LEFT JOIN mints m ON m.mint=c.mint WHERE c.decision IS NOT NULL AND c.id IN "
        "(SELECT candidate_id FROM votes WHERE ts>=?) ORDER BY c.ts", [since])
    full, first = 0, None
    for c in rows:
        votes = await db.fetchall("SELECT agent, vote, raw_vote, confidence, reasons, evidence, error, guard, "
                                  "cost_usd FROM votes WHERE candidate_id=? ORDER BY agent", [c["id"]])
        agents = tuple(sorted(v["agent"] for v in votes))
        if agents != AGENTS or not c["gate_reason"] or c["decision"] not in ("BUY", "PASS"):
            continue
        if need_clean_votes and any(v["error"] for v in votes):
            continue
        full += 1
        if first is None:
            first = {**c, "votes": votes}
    return first, full


async def evaluate_run(db: Database, s: Settings, started: float, ended: float, minutes: float,
                       crash: str | None, rec: Recorder, crashes: dict, no_llm: bool) -> list[Criterion]:
    ran_min = (ended - started) / 60
    problems = []
    if crash:
        problems.append(f"stopped by {crash}")
    if ran_min < minutes - 0.2:
        problems.append(f"ran {ran_min:.1f} of {minutes:g} minutes (interrupted)")
    if crashes:
        problems.append("background loops restarted: " + ", ".join(f"{k} x{v}" for k, v in crashes.items()))
    if rec.error_count:
        problems.append(f"{rec.error_count} ERROR log line(s)")
    crit = [Criterion(f"ran {minutes:g} min in paper mode without a crash", "FAIL" if problems else "PASS",
                      "; ".join(problems) or f"ran {ran_min:.1f} min, 0 errors, no loop restarts")]
    first, n_full = await first_full_cycle(db, started, need_clean_votes=True)
    if no_llm:
        _, n_any = await first_full_cycle(db, started, need_clean_votes=False)
        crit.append(Criterion("logged >= 1 full decision cycle (candidate, 3 votes, gate result)", "SKIP",
                              f"no ANTHROPIC_API_KEY: {n_any} candidate(s) reached the gate with placeholder votes"))
    else:
        crit.append(Criterion("logged >= 1 full decision cycle (candidate, 3 votes, gate result)",
                              "PASS" if n_full else "FAIL",
                              f"{n_full} full cycle(s); {rec.decisions} DECISION log line(s)" if n_full else
                              "no candidate got three error-free votes and a gate result; see the funnel below"))
    return crit


def render(crit: list[Criterion], verdict: str, started: float, ended: float, f: dict, first: dict | None,
           rec: Recorder, engine_facts: dict, report_path: str | None) -> str:
    t0 = datetime.fromtimestamp(started, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [f"# Acceptance run {t0}: {verdict}", "",
             f"Ran {(ended - started) / 60:.1f} min. Exit code {EXIT[verdict]}.", "",
             "| Check | Result | Detail |", "|---|---|---|"]
    lines += [f"| {c.name} | **{c.status}** | {c.detail} |" for c in crit]
    lines += ["", "## Pipeline funnel (this run)", "",
              f"- launches seen: {f['launches']}; curve reads: {engine_facts.get('curve_reads')}; "
              f"streamed trades: {engine_facts.get('stream_trades')}",
              f"- passed stage 1 (age, buyers, inflow): {f['stage1_passed']}; passed stage 2 (Rugcheck, "
              f"DexScreener): {f['stage2_passed']}",
              f"- candidates by status: {f['candidates'] or 'none'}; decisions: {f['decisions'] or 'none'}",
              f"- votes with an agent error: {f['votes_with_error']}; downgraded by the grounding guard: "
              f"{f['votes_downgraded_by_guard']}; real paper entries: {f['real_entries']}",
              f"- spend this run: LLM ${f['llm_usd']:.4f}, X ${f['x_usd']:.4f}, Helius credits "
              f"{engine_facts.get('helius_credits')}",
              f"- stage-2 rejections by rule: {json.dumps(f['stage2_rejections']) if f['stage2_rejections'] else 'none'}",
              f"- rule that was the only blocker: {json.dumps(f['stage2_sole_blocker']) if f['stage2_sole_blocker'] else 'none'}"]
    if first:
        m = json.loads(first["metrics"] or "{}")
        pf = m.get("prefilter") or {}
        when = datetime.fromtimestamp(first["ts"], timezone.utc).strftime("%H:%M:%S")
        lines += ["", "## First full decision cycle", "",
                  f"Candidate #{first['id']} {first.get('symbol') or '?'} `{first['mint']}` at {when} UTC: age "
                  f"{pf.get('age_min')} min, {pf.get('unique_buyers')} buyers, {pf.get('net_inflow_sol')} SOL "
                  f"net inflow, liquidity {_usd(pf.get('liquidity_usd'))}", ""]
        for v in first["votes"]:
            reasons = json.loads(v["reasons"] or "[]")
            lines.append(f"- {v['agent']}: **{v['vote']}** {v['confidence']:.2f}"
                         f"{' (guard: ' + v['guard'] + ')' if v['guard'] else ''} - {(reasons or ['-'])[0][:200]}")
        lines.append(f"- gate: **{first['decision']}** (mean confidence {first['mean_confidence'] or 0:.2f}): "
                     f"{first['gate_reason']}")
    lines += ["", "## Log", "", f"- ERROR lines: {rec.error_count}"]
    lines += [f"  - `{e}`" for e in rec.errors]
    lines.append(f"- WARNING lines by source: {dict(rec.warnings) or 'none'}")
    for name, samples in rec.warning_samples.items():
        lines += [f"  - {name}: `{x}`" for x in samples]
    if report_path:
        lines += ["", f"Daily report: `{report_path}`"]
    return "\n".join(lines) + "\n"


EXIT = {"PASS": 0, "FAIL": 1, "INCOMPLETE": 3}


def _usd(v) -> str:
    return f"${v:,.0f}" if isinstance(v, (int, float)) else "unknown"


async def run_acceptance(s: Settings, minutes: float, engine_factory, no_llm: bool = False,
                         install_signals=None) -> int:
    if s.is_live:
        print("acceptance runs in paper mode only: set MODE=paper", flush=True)
        return 2
    rec = Recorder()
    root = logging.getLogger()
    root.addHandler(rec)
    eng = engine_factory(s)
    if install_signals:
        install_signals(eng)
    started = now_s()
    crash = None
    try:
        await eng.run(minutes * 60)
    except Exception as e:  # LiveRefused, StartupError, or a bug: all of them fail check 1
        crash = redact(f"{type(e).__name__}: {e}")[:300]
    ended = now_s()
    root.removeHandler(rec)
    facts = {"curve_reads": eng.ingest.stats.get("curve_reads"), "stream_trades": eng.ingest.stats.get("stream_trades"),
             "helius_credits": getattr(eng.helius, "credits", None)}
    db = await Database(s.path(s.DB_PATH)).open()
    try:
        crit = await evaluate_run(db, s, started, ended, minutes, crash, rec, dict(eng.crashes), no_llm)
        report_path = None
        try:  # the same call `python -m bot report` makes
            text, path = await write_daily(db, s)
            ok = path.exists() and path.stat().st_size > 0 and text.strip() != ""
            report_path = str(path)
            crit.append(Criterion("report runs on the recorded data", "PASS" if ok else "FAIL",
                                  f"wrote {path.name} ({path.stat().st_size} bytes)" if ok else "empty report"))
        except Exception as e:
            crit.append(Criterion("report runs on the recorded data", "FAIL", redact(f"{type(e).__name__}: {e}")[:300]))
        f = await funnel(db, started)
        first, _ = await first_full_cycle(db, started, need_clean_votes=not no_llm)
    finally:
        await db.close()
    statuses = {c.status for c in crit}
    verdict = "FAIL" if "FAIL" in statuses else "INCOMPLETE" if "SKIP" in statuses else "PASS"
    md = render(crit, verdict, started, ended, f, first, rec, facts, report_path)
    out_dir = s.path(s.REPORTS_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"acceptance-{datetime.fromtimestamp(started, timezone.utc).strftime('%Y%m%d-%H%M%S')}.md"
    out.write_text(md)
    print(md, flush=True)
    print(f"written: {out}", flush=True)
    return EXIT[verdict]
