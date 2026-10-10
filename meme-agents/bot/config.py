"""Settings loaded from `.env`; process overrides apply only to non-secret fields.

Every threshold in the pipeline lives here so it can be tuned without code changes.
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field, fields
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path) -> dict[str, str]:
    """Minimal KEY=VALUE parser: comments, blank lines, optional quotes, `export ` prefix."""
    out: dict[str, str] = {}
    try:
        if not path.exists():
            return out
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise ConfigError(f"Cannot read .env ({type(exc).__name__}); check file access and UTF-8 encoding") from None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:]
        key, _, val = line.partition("=")
        val = val.strip()
        if val and val[0] in "'\"":
            quote = val[0]
            end = val.find(quote, 1)
            if end < 0 or (val[end + 1:].strip() and not val[end + 1:].strip().startswith("#")):
                raise ConfigError(f"{key.strip()}: invalid quoted value")
            val = val[1:end]
        elif val.startswith("#"):
            val = ""  # empty value followed by a comment
        else:
            val = val.split(" #", 1)[0].strip()
        out[key.strip()] = val
    return out


def _csv(v: str) -> list[str]:
    return [x.strip() for x in v.split(",") if x.strip()]


LIVE_WALLET_CEILING_SOL = 3.0   # the most LIVE_MAX_WALLET_SOL may be set to (operator's call, 8 Oct: 0.5 -> 1 -> 3)


@dataclass
class Settings:
    # --- mode -------------------------------------------------------------------
    MODE: str = "paper"
    LIVE_CONFIRM: str = ""
    LIVE_DRY_RUN: bool = True
    LIVE_MAX_WALLET_SOL: float = 0.5          # raised to at most LIVE_WALLET_CEILING_SOL in .env on the server
    LIVE_ACCOUNT_RENT_SOL: float = 0.0025    # a buy may also pay rent for a new token account (0.00204 SOL)

    # --- secrets (never logged) ------------------------------------------------
    ANTHROPIC_API_KEY: str = field(default="", repr=False)
    PUMPPORTAL_API_KEY: str = field(default="", repr=False)
    HELIUS_API_KEY: str = field(default="", repr=False)
    X_BEARER_TOKEN: str = field(default="", repr=False)
    JUPITER_API_KEY: str = field(default="", repr=False)
    CRYPTOPANIC_TOKEN: str = field(default="", repr=False)
    TELEGRAM_BOT_TOKEN: str = field(default="", repr=False)
    TELEGRAM_CHAT_ID: str = ""
    TELEGRAM_DIGEST: str = "all"              # hourly Telegram digest: all | wins (hours with a winning trade) | off
    TELEGRAM_COMMANDS: bool = True            # answer /status /digest /report /stop /resume from TELEGRAM_CHAT_ID
    WALLET_PRIVATE_KEY: str = field(default="", repr=False)

    # --- paths -----------------------------------------------------------------
    DB_PATH: str = "data/bot.db"
    REPORTS_DIR: str = "reports"
    STOP_FILE: str = "STOP"
    LOG_LEVEL: str = "INFO"
    LOG_FILE: str = "logs/bot.log"

    # --- endpoints -------------------------------------------------------------
    PUMPPORTAL_WS: str = "wss://pumpportal.fun/api/data"
    PUMPPORTAL_TRADE_URL: str = "https://pumpportal.fun/api/trade-local"
    DEXSCREENER_URL: str = "https://api.dexscreener.com"
    # used only when DexScreener returns no wrapped-SOL pair (empty = DexScreener only)
    SOL_USD_FALLBACK_URL: str = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    RUGCHECK_URL: str = "https://api.rugcheck.xyz/v1"
    HELIUS_RPC_URL: str = "https://mainnet.helius-rpc.com/?api-key={key}"
    HELIUS_API_URL: str = "https://api-mainnet.helius-rpc.com/v0"
    HELIUS_WS_URL: str = "wss://mainnet.helius-rpc.com/?api-key={key}"   # insider watch (transactionSubscribe)
    JUPITER_URL: str = "https://api.jup.ag/swap/v2"
    X_API_URL: str = "https://api.x.com/2"
    CRYPTOPANIC_URL: str = "https://cryptopanic.com/api/developer/v2/posts/"
    NEWS_RSS_URLS: list[str] = field(default_factory=lambda: [
        "https://cointelegraph.com/rss",
        "https://www.coindesk.com/arc/outboundfeeds/rss/",
    ])
    TRUTH_SOCIAL_RSS_URL: str = ""

    # --- bankroll & risk -------------------------------------------------------
    BANKROLL_USD: float = 50.0
    MAX_OPEN_POSITIONS: int = 3
    MAX_POSITIONS_PER_CREATOR: int = 1
    POSITION_MIN_USD: float = 5.0
    POSITION_MAX_USD: float = 10.0
    DAILY_LOSS_CAP_PCT: float = 50.0

    # --- pre-filter ------------------------------------------------------------
    PF_MIN_AGE_MIN: float = 5.0
    PF_MAX_AGE_MIN: float = 90.0
    PF_MIN_UNIQUE_BUYERS: int = 40
    PF_MIN_NET_INFLOW_SOL: float = 15.0
    PF_MAX_TOP10_PCT: float = 35.0
    PF_MIN_LIQUIDITY_USD: float = 8000.0
    PF_REQUIRE_NULL_AUTHORITIES: bool = True
    # DexScreener reports no liquidity.usd for pump.fun bonding-curve pairs (live probe, Oct 2026:
    # 0 of 59), only for AMM pools. Without this, no token could pass before graduation.
    PF_CURVE_LIQUIDITY_FALLBACK: bool = True
    PF_SCAN_INTERVAL_S: float = 20.0

    # --- consensus -------------------------------------------------------------
    CONSENSUS_MIN_MEAN_CONFIDENCE: float = 0.65
    GATE_NEUTRAL_VOTES: bool = True           # Scout/Hunter: "nothing found" is a neutral BUY (0.5-0.6), not a PASS

    # --- paper costs -----------------------------------------------------------
    PUMPFUN_FEE_PCT: float = 1.0
    PUMPPORTAL_FEE_PCT: float = 0.5
    NETWORK_FEE_SOL: float = 0.005            # the most one transaction may cost (spend and balance checks)
    # The priority fee sent with each PumpPortal transaction. Buys and planned sells (take-profit,
    # trailing and time stops, the runner's target) pay PRIORITY_FEE_SOL; a stop loss, an emergency,
    # the kill switch and any sale retried after a failure pay URGENT_PRIORITY_FEE_SOL, to land fast
    # in a dump. 9 Oct: a flat 0.004 SOL on every transaction was 9-22% of a $10 trade.
    PRIORITY_FEE_SOL: float = 0.001
    URGENT_PRIORITY_FEE_SOL: float = 0.004
    ENTRY_SLIPPAGE_PCT: float = 3.0
    EXIT_SLIPPAGE_PCT: float = 5.0
    ENTRY_FILL_TIMEOUT_S: float = 300.0
    # A live buy the pre-broadcast checks refuse (a moved price, an RPC slip) is retried on later
    # ticks, with a fresh transaction each time, this many times in all before the entry is dropped.
    LIVE_ENTRY_ATTEMPTS: int = 3
    EXIT_FILL_TIMEOUT_S: float = 120.0
    EXIT_RETRY_BASE_S: float = 5.0
    EXIT_RETRY_MAX_S: float = 300.0
    LIVE_CONFIRM_TIMEOUT_S: float = 60.0

    # --- exits -----------------------------------------------------------------
    STOP_LOSS_PCT: float = 40.0
    TAKE_PROFIT_PCT: float = 60.0
    TAKE_PROFIT_SELL_FRACTION: float = 0.5
    TRAILING_STOP_PCT: float = 30.0
    TIME_STOP_HOURS: float = 6.0
    # Runner: after a take-profit, the core's trailing or time stop sells all but this share of the
    # original tokens, kept only while the sales so far plus that one cover the entry cost. The
    # runner then exits at its price target, its hold limit or an emergency (see RUNNER_STOP_LOSS).
    # Recorded on each position when it is created, so a change applies to new positions only.
    RUNNER_ENABLED: bool = False
    RUNNER_FRACTION: float = 0.10         # of the original tokens
    RUNNER_TARGET_MULTIPLE: float = 300.0 # sell it when the price reaches this multiple of the entry price
    RUNNER_MAX_HOLD_HOURS: float = 168.0  # counted from the entry
    # A runner exists only once the sales so far covered the entry cost, so it has no stop loss unless
    # this is on: a dip below the entry must not sell the free tokens of a coin that may still run 500x.
    # Read at every price, so it applies to runners already open; emergencies and the kill switch still sell.
    RUNNER_STOP_LOSS: bool = False
    EMERGENCY_LIQ_DROP_PCT: float = 50.0
    # a real buy is refused when the curve's depth fell more than this since the scan (0 = off)
    ENTRY_MAX_LIQ_SLIP_PCT: float = 20.0
    LIQ_POLL_S: float = 60.0
    RUGCHECK_POLL_S: float = 300.0
    # A mark more than this many times above or below the last one is held until a second tick
    # confirms it; 0 disables. One bad tick must not fill a take-profit or a stop.
    TICK_SANITY_FACTOR: float = 20.0

    # --- moonshot tracker (measures only, never trades) --------------------------
    # Every evaluated coin is watched on DexScreener for this many days from the price its shadow
    # opened at, so the report can show which ones went 10x/100x/500x and what the bot did. 0 = off.
    MOONSHOT_TRACK_DAYS: float = 14.0
    MOONSHOT_POLL_MIN: float = 15.0        # coins older than a day are read every 4th pass
    MOONSHOT_ALERT_MULTIPLE: float = 100.0 # Telegram note once a coin's confirmed peak reaches this; 0 = off

    # --- data sources -----------------------------------------------------------
    # PumpPortal streams per-token trades only to funded API keys since May 2026, at 0.01 SOL
    # per 10,000 trades. off: read the chain through Helius instead (free plan, default).
    # positions: also stream trades for candidates and open positions. all: stream every launch.
    PUMPPORTAL_TRADE_STREAM: str = "off"
    PUMPPORTAL_DAILY_BUDGET_SOL: float = 0.01
    PUMPPORTAL_SOL_PER_TRADE: float = 0.000001
    HELIUS_MONTHLY_CREDITS: int = 1_000_000
    CURVE_POLL_CALLS_PER_MIN: float = 8.0     # getMultipleAccounts calls (100 curves, 1 credit each)
    CURVE_HOT_POLL_S: float = 15.0            # candidates, open positions and shadows
    # Real positions only, on their own loop: every held curve in one call (1 credit) this often, so
    # a stop or take-profit acts within seconds and a decided buy fills on the next read instead of
    # waiting for the launch poller (9 Oct: GIGACHAD's stop filled at -44% between 15 s reads).
    # After graduation DexScreener's pool price every POSITION_DEX_POLL_S. 0 turns either off.
    POSITION_POLL_S: float = 2.0
    POSITION_DEX_POLL_S: float = 10.0
    # Insider sales on held coins (insiders.py): stream every trade on the curve of each open position
    # (real ones first, then the newest shadows, at most INSIDER_WATCH_MAX coins) and record each sale
    # by the coin's creator, launch-minute buyers, snipers, bundle wallets or top holders after the buy.
    # INSIDER_EXIT=false only records (/report shows what acting would have done); true sells as an
    # emergency once the insiders' sales since the buy reach INSIDER_EXIT_SUPPLY_PCT of the supply.
    INSIDER_WATCH: bool = True
    INSIDER_EXIT: bool = False
    INSIDER_EXIT_SUPPLY_PCT: float = 2.0
    INSIDER_WATCH_MAX: int = 60
    # Wallet memory (wallets.py): each candidate's launch buyers and creator, scored on the coins the bot
    # evaluated in the last LAUNCH_MEMORY_DAYS; measured in /report, not shown to the agents yet. Past
    # coins without launch buyers on record are read back from the chain, LAUNCH_BACKFILL_PER_MIN a minute.
    LAUNCH_MEMORY_DAYS: float = 7.0
    LAUNCH_BACKFILL_PER_MIN: float = 10.0
    CURVE_FIRST_POLL_S: float = 60.0          # first read of a launch (most are dead within a minute)
    CURVE_POLL_SCALE: float = 1.0             # multiplies the 20/45/120/240 s read cadence of launches
    CURVE_DROP_AFTER_MIN: float = 15.0        # stop following a launch this old ...
    CURVE_DROP_BELOW_SOL: float = 1.0         # ... that has taken in less than this
    HOLDERS_REFRESH_S: float = 300.0          # DAS holder count (10 credits) at most this often per mint
    HOLDER_CHECKS_PER_SCAN: int = 4           # ... and at most this many per 20 s pre-filter scan
    BACKFILL_WINDOW_S: float = 60.0           # rebuild a candidate's trades from its first minute ...
    BACKFILL_MAX_TX: int = 80                 # ... reading at most this many transactions (1 credit each)

    # --- ingest ----------------------------------------------------------------
    MAX_TRACKED_MINTS: int = 3000
    TRADE_RETENTION_HOURS: float = 48.0
    WS_MAX_BACKOFF_S: float = 60.0
    WS_STALL_S: float = 90.0

    # --- LLM -------------------------------------------------------------------
    LLM_MODEL: str = "claude-sonnet-4-6"
    LLM_DAILY_BUDGET_USD: float = 5.0
    LLM_BUDGET_PACING: bool = True            # release the daily budget evenly over the UTC day ...
    LLM_BUDGET_BURST_HOURS: float = 2.0       # ... with this many hours' worth available up front
    LLM_PRICE_IN_PER_MTOK: float = 3.0
    LLM_PRICE_OUT_PER_MTOK: float = 15.0
    LLM_MAX_TURNS: int = 6
    LLM_MAX_TOKENS: int = 2048
    LLM_MAX_INPUT_BYTES: int = 120000
    LLM_TIMEOUT_S: float = 120.0
    LLM_CONCURRENCY: int = 2
    AGENT_MIN_GROUNDING: float = 0.5
    TRIAGE_ENABLED: bool = True               # a cheap first screen before the three agents (bot/agents/triage.py)
    TRIAGE_MODEL: str = "claude-haiku-4-5"
    TRIAGE_PRICE_IN_PER_MTOK: float = 1.0
    TRIAGE_PRICE_OUT_PER_MTOK: float = 5.0
    TRIAGE_MAX_TOKENS: int = 600
    TRIAGE_MIN_CONFIDENCE: float = 0.7        # a triage PASS below this still goes to the committee
    VETO_ENABLED: bool = True                 # after a unanimous BUY, the forensics and social agents may still block
    VETO_MIN_CONFIDENCE: float = 0.7          # a veto needs this confidence and grounded tool evidence
    FORENSICS_HOLDER_WALLETS: int = 8         # top holders whose funding the forensics agent traces (100 credits each)
    SOCIAL_MAX_AUTHORS: int = 10              # X author profiles the social agent may look up ($0.01 each)
    REGIME_ENABLED: bool = True               # market regime agent: sizes entries down or pauses them (bot/regime.py)
    REGIME_MODEL: str = "claude-haiku-4-5"
    REGIME_REFRESH_MIN: float = 15.0          # how often the regime is re-assessed (one small call each time)
    REGIME_MIN_MULTIPLIER: float = 0.25       # the smallest size multiplier the regime agent may set

    # --- X ---------------------------------------------------------------------
    X_MONTHLY_BUDGET_USD: float = 20.0
    X_POST_READ_USD: float = 0.005
    X_USER_READ_USD: float = 0.01
    X_SEARCH_MAX_RESULTS: int = 10
    X_TIMELINE_MAX_RESULTS: int = 5
    X_TIMELINE_REFRESH_MIN: float = 10.0
    WATCHLIST_HANDLES: list[str] = field(default_factory=lambda: ["elonmusk", "realDonaldTrump"])
    CATALYST_WINDOW_MIN: float = 60.0
    NEWS_REFRESH_MIN: float = 5.0

    # --- rate limits (per second) ---------------------------------------------
    DEX_TOKENS_RPS: float = 300 / 60
    DEX_BOOSTS_RPS: float = 60 / 60
    RUGCHECK_RPS: float = 2.0
    HELIUS_RPC_RPS: float = 10.0
    HELIUS_ENHANCED_RPS: float = 2.0
    JUPITER_RPS: float = 1.0

    @property
    def is_live(self) -> bool:
        return self.MODE.strip().lower() == "live"

    def path(self, rel: str) -> Path:
        p = Path(rel)
        return p if p.is_absolute() else ROOT / p

    def pumpportal_ws(self) -> str:
        """PumpSwap (post-graduation) trades only stream with a PumpPortal API key."""
        if not self.PUMPPORTAL_API_KEY:
            return self.PUMPPORTAL_WS
        sep = "&" if "?" in self.PUMPPORTAL_WS else "?"
        return f"{self.PUMPPORTAL_WS}{sep}api-key={self.PUMPPORTAL_API_KEY}"

    def helius_rpc(self) -> str:
        return self.HELIUS_RPC_URL.format(key=self.HELIUS_API_KEY)


class ConfigError(ValueError):
    pass


STREAM_MODES = ("off", "positions", "all")
DIGEST_MODES = ("all", "wins", "off")


_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def _coerce(raw: str, current, name: str = ""):
    if isinstance(current, bool):
        v = raw.strip().lower()
        if v in _TRUE:
            return True
        if v in _FALSE:
            return False
        # a typo must never silently flip a safety flag (e.g. LIVE_DRY_RUN=ture -> sends real trades)
        raise ConfigError(f"{name}: invalid boolean; use true/false")
    if isinstance(current, int):
        value = float(raw)
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError("must be a finite whole number")
        return int(value)
    if isinstance(current, float):
        return float(raw)
    if isinstance(current, list):
        return _csv(raw)
    return raw


def load_settings(env_file: Path | None = None, overrides: dict[str, str] | None = None) -> Settings:
    values = load_dotenv(env_file or ROOT / ".env")
    secret_fields = {f.name for f in fields(Settings) if not f.repr}
    values.update({k: v for k, v in os.environ.items() if k not in secret_fields})
    if overrides:
        values.update(overrides)
    s = Settings()
    for f in fields(s):
        if f.name in values and values[f.name] != "":
            try:
                setattr(s, f.name, _coerce(values[f.name], getattr(s, f.name), f.name))
            except ConfigError:
                raise
            except (ValueError, OverflowError):
                raise ConfigError(f"{f.name}: invalid numeric value") from None
    validate_settings(s)
    s.PUMPPORTAL_TRADE_STREAM = s.PUMPPORTAL_TRADE_STREAM.strip().lower()
    if s.PUMPPORTAL_TRADE_STREAM not in STREAM_MODES:
        raise ConfigError(f"PUMPPORTAL_TRADE_STREAM: use one of {', '.join(STREAM_MODES)}")
    s.TELEGRAM_DIGEST = s.TELEGRAM_DIGEST.strip().lower()
    if s.TELEGRAM_DIGEST not in DIGEST_MODES:
        raise ConfigError(f"TELEGRAM_DIGEST: use one of {', '.join(DIGEST_MODES)}")
    return s


def validate_settings(s: Settings) -> None:
    """Reject unsafe numeric settings before any network client or order is created."""
    s.MODE = s.MODE.strip().lower()
    if s.MODE not in ("paper", "live"):
        raise ConfigError("MODE must be paper or live")
    for f in fields(s):
        value = getattr(s, f.name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if not math.isfinite(value) or value < 0:
                raise ConfigError(f"{f.name} must be finite and non-negative")
    positive = (
        "BANKROLL_USD", "MAX_OPEN_POSITIONS", "MAX_POSITIONS_PER_CREATOR",
        "POSITION_MIN_USD", "POSITION_MAX_USD", "MAX_TRACKED_MINTS", "TRADE_RETENTION_HOURS",
        "PF_SCAN_INTERVAL_S", "LIQ_POLL_S", "RUGCHECK_POLL_S", "WS_STALL_S", "WS_MAX_BACKOFF_S",
        "LLM_MAX_TURNS", "LLM_MAX_TOKENS", "LLM_MAX_INPUT_BYTES", "LLM_TIMEOUT_S", "LLM_CONCURRENCY",
        "LLM_PRICE_IN_PER_MTOK", "LLM_PRICE_OUT_PER_MTOK", "TRIAGE_PRICE_IN_PER_MTOK",
        "TRIAGE_PRICE_OUT_PER_MTOK", "TRIAGE_MAX_TOKENS", "TIME_STOP_HOURS",
        "ENTRY_FILL_TIMEOUT_S", "LIVE_ENTRY_ATTEMPTS", "EXIT_FILL_TIMEOUT_S", "EXIT_RETRY_BASE_S", "EXIT_RETRY_MAX_S",
        "LIVE_CONFIRM_TIMEOUT_S", "CURVE_POLL_CALLS_PER_MIN", "CURVE_HOT_POLL_S", "CURVE_POLL_SCALE",
        "DEX_TOKENS_RPS", "DEX_BOOSTS_RPS", "RUGCHECK_RPS", "HELIUS_RPC_RPS",
        "HELIUS_ENHANCED_RPS", "JUPITER_RPS", "REGIME_REFRESH_MIN",
    )
    for name in positive:
        if getattr(s, name) <= 0:
            raise ConfigError(f"{name} must be greater than zero")
    if s.POSITION_MIN_USD > s.POSITION_MAX_USD:
        raise ConfigError("POSITION_MIN_USD must not exceed POSITION_MAX_USD")
    if s.POSITION_POLL_S and not 1 <= s.POSITION_POLL_S <= 60:
        raise ConfigError("POSITION_POLL_S must be 0 (off) or between 1 and 60 seconds")
    if s.POSITION_DEX_POLL_S and not 5 <= s.POSITION_DEX_POLL_S <= 300:
        raise ConfigError("POSITION_DEX_POLL_S must be 0 (off) or between 5 and 300 seconds")
    if s.MOONSHOT_TRACK_DAYS > 60:
        raise ConfigError("MOONSHOT_TRACK_DAYS must be 60 or less (0 turns the tracker off)")
    if s.MOONSHOT_TRACK_DAYS > 0 and s.MOONSHOT_POLL_MIN < 1:
        raise ConfigError("MOONSHOT_POLL_MIN must be at least 1")
    if 0 < s.MOONSHOT_ALERT_MULTIPLE < 2:
        raise ConfigError("MOONSHOT_ALERT_MULTIPLE must be 0 (off) or at least 2")
    if not 0.1 <= s.INSIDER_EXIT_SUPPLY_PCT <= 50:
        raise ConfigError("INSIDER_EXIT_SUPPLY_PCT must be between 0.1 and 50 (% of the supply)")
    if not 1 <= s.INSIDER_WATCH_MAX <= 500:
        raise ConfigError("INSIDER_WATCH_MAX must be between 1 and 500 coins")
    if s.INSIDER_WATCH and not s.HELIUS_WS_URL.startswith("wss://"):
        raise ConfigError("HELIUS_WS_URL must be a wss:// address")
    if not 0 <= s.LAUNCH_MEMORY_DAYS <= 30:
        raise ConfigError("LAUNCH_MEMORY_DAYS must be between 0 (off) and 30")
    if not 0 <= s.LAUNCH_BACKFILL_PER_MIN <= 60:
        raise ConfigError("LAUNCH_BACKFILL_PER_MIN must be between 0 (off) and 60")
    if not 0.01 <= s.RUNNER_FRACTION <= 0.25:
        raise ConfigError("RUNNER_FRACTION must be between 0.01 and 0.25")
    if s.RUNNER_TARGET_MULTIPLE <= 1:
        raise ConfigError("RUNNER_TARGET_MULTIPLE must be greater than 1")
    if s.RUNNER_MAX_HOLD_HOURS <= 0:
        raise ConfigError("RUNNER_MAX_HOLD_HOURS must be greater than zero")
    if s.RUNNER_ENABLED and s.RUNNER_MAX_HOLD_HOURS <= s.TIME_STOP_HOURS:
        raise ConfigError("RUNNER_MAX_HOLD_HOURS must be longer than TIME_STOP_HOURS")
    if s.RUNNER_ENABLED and s.TAKE_PROFIT_SELL_FRACTION + s.RUNNER_FRACTION >= 1:
        raise ConfigError("TAKE_PROFIT_SELL_FRACTION plus RUNNER_FRACTION must stay below 1")
    if s.PF_MIN_AGE_MIN > s.PF_MAX_AGE_MIN:
        raise ConfigError("PF_MIN_AGE_MIN must not exceed PF_MAX_AGE_MIN")
    if s.EXIT_RETRY_BASE_S > s.EXIT_RETRY_MAX_S:
        raise ConfigError("EXIT_RETRY_BASE_S must not exceed EXIT_RETRY_MAX_S")
    if 0 < s.TICK_SANITY_FACTOR <= 1:
        raise ConfigError("TICK_SANITY_FACTOR must be above 1, or 0 to disable the check")
    if s.LIVE_MAX_WALLET_SOL > LIVE_WALLET_CEILING_SOL:
        raise ConfigError(f"LIVE_MAX_WALLET_SOL must not exceed {LIVE_WALLET_CEILING_SOL:g} SOL")
    for name in ("CONSENSUS_MIN_MEAN_CONFIDENCE", "AGENT_MIN_GROUNDING", "TRIAGE_MIN_CONFIDENCE",
                 "VETO_MIN_CONFIDENCE", "TAKE_PROFIT_SELL_FRACTION", "REGIME_MIN_MULTIPLIER"):
        if not 0 < getattr(s, name) <= 1:
            raise ConfigError(f"{name} must be greater than zero and at most one")
    if not 0 <= s.ENTRY_MAX_LIQ_SLIP_PCT < 100:
        raise ConfigError("ENTRY_MAX_LIQ_SLIP_PCT must be at least 0 and below 100")
    for name in ("DAILY_LOSS_CAP_PCT", "STOP_LOSS_PCT", "TRAILING_STOP_PCT",
                 "EMERGENCY_LIQ_DROP_PCT", "PF_MAX_TOP10_PCT"):
        if not 0 < getattr(s, name) <= 100:
            raise ConfigError(f"{name} must be greater than zero and at most 100")
    for name in ("PUMPFUN_FEE_PCT", "PUMPPORTAL_FEE_PCT", "ENTRY_SLIPPAGE_PCT", "EXIT_SLIPPAGE_PCT"):
        if getattr(s, name) >= 100:
            raise ConfigError(f"{name} must be below 100")
    if not 0 < s.PRIORITY_FEE_SOL <= s.URGENT_PRIORITY_FEE_SOL:
        raise ConfigError("PRIORITY_FEE_SOL must be above 0 and at most URGENT_PRIORITY_FEE_SOL")
    if s.URGENT_PRIORITY_FEE_SOL > 0.8 * s.NETWORK_FEE_SOL + 1e-12:
        # the spend check allows NETWORK_FEE_SOL per transaction; the priority fee keeps 20% of it
        # for the signature fee and what PumpPortal adds, as the single 0.8 x NETWORK_FEE_SOL did
        raise ConfigError("URGENT_PRIORITY_FEE_SOL must be at most 80% of NETWORK_FEE_SOL")
