"""Settings loaded from `.env` (and the process environment, which wins).

Every threshold in the pipeline lives here so it can be tuned without code changes.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path) -> dict[str, str]:
    """Minimal KEY=VALUE parser: comments, blank lines, optional quotes, `export ` prefix."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:]
        key, _, val = line.partition("=")
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
            val = val[1:-1]
        elif val.startswith("#"):
            val = ""  # empty value followed by a comment
        else:
            val = val.split(" #", 1)[0].strip()
        out[key.strip()] = val
    return out


def _csv(v: str) -> list[str]:
    return [x.strip() for x in v.split(",") if x.strip()]


@dataclass
class Settings:
    # --- mode -------------------------------------------------------------------
    MODE: str = "paper"
    LIVE_CONFIRM: str = ""
    LIVE_DRY_RUN: bool = True
    LIVE_MAX_WALLET_SOL: float = 0.5

    # --- secrets (never logged) ------------------------------------------------
    ANTHROPIC_API_KEY: str = field(default="", repr=False)
    PUMPPORTAL_API_KEY: str = field(default="", repr=False)
    HELIUS_API_KEY: str = field(default="", repr=False)
    X_BEARER_TOKEN: str = field(default="", repr=False)
    JUPITER_API_KEY: str = field(default="", repr=False)
    CRYPTOPANIC_TOKEN: str = field(default="", repr=False)
    TELEGRAM_BOT_TOKEN: str = field(default="", repr=False)
    TELEGRAM_CHAT_ID: str = ""
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
    RUGCHECK_URL: str = "https://api.rugcheck.xyz/v1"
    HELIUS_RPC_URL: str = "https://mainnet.helius-rpc.com/?api-key={key}"
    HELIUS_API_URL: str = "https://api-mainnet.helius-rpc.com/v0"
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

    # --- paper costs -----------------------------------------------------------
    PUMPFUN_FEE_PCT: float = 1.0
    PUMPPORTAL_FEE_PCT: float = 0.5
    NETWORK_FEE_SOL: float = 0.005
    ENTRY_SLIPPAGE_PCT: float = 3.0
    EXIT_SLIPPAGE_PCT: float = 5.0
    ENTRY_FILL_TIMEOUT_S: float = 300.0
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
    EMERGENCY_LIQ_DROP_PCT: float = 50.0
    LIQ_POLL_S: float = 60.0
    RUGCHECK_POLL_S: float = 300.0

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
    LLM_TIMEOUT_S: float = 120.0
    LLM_CONCURRENCY: int = 2
    AGENT_MIN_GROUNDING: float = 0.5

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
        raise ConfigError(f"{name}={raw!r} is not a boolean; use true/false")
    if isinstance(current, int):
        return int(float(raw))
    if isinstance(current, float):
        return float(raw)
    if isinstance(current, list):
        return _csv(raw)
    return raw


def load_settings(env_file: Path | None = None, overrides: dict[str, str] | None = None) -> Settings:
    values = load_dotenv(env_file or ROOT / ".env")
    values.update({k: v for k, v in os.environ.items()})
    if overrides:
        values.update(overrides)
    s = Settings()
    for f in fields(s):
        if f.name in values and values[f.name] != "":
            try:
                setattr(s, f.name, _coerce(values[f.name], getattr(s, f.name), f.name))
            except ConfigError:
                raise
            except ValueError as e:
                raise ConfigError(f"{f.name}={values[f.name]!r}: {e}") from None
    s.PUMPPORTAL_TRADE_STREAM = s.PUMPPORTAL_TRADE_STREAM.strip().lower()
    if s.PUMPPORTAL_TRADE_STREAM not in STREAM_MODES:
        raise ConfigError(f"PUMPPORTAL_TRADE_STREAM={s.PUMPPORTAL_TRADE_STREAM!r}: use one of {', '.join(STREAM_MODES)}")
    return s
