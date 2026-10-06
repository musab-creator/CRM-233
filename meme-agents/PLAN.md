# meme-agents-claude — build plan

Paper trading only until `MODE=live` passes every startup check. This file is the
plan shown before any code was written; it stays in the repo as the design record.

## Assumptions

Given in the brief:

- Chain is Solana. The universe is tokens launched on pump.fun, followed from the first
  bonding-curve trade through graduation to PumpSwap (`pool: "pump-amm"`) or Raydium.
- Bankroll is $50 in SOL, with at most 3 open positions and positions of $5 to $10.
- The bot runs on an always-on VPS, and secrets come only from `.env`.

Added by me (each one is a config value unless it says otherwise):

1. **The project lives in `meme-agents/`.** This repo already holds two Node apps, so the
   bot gets its own directory. Run `python -m bot` from `meme-agents/`.
2. **Prices are in SOL per token** and come from each PumpPortal trade, as
   `solAmount / tokenAmount`. USD figures use a SOL/USD price that is refreshed every
   60 s from DexScreener's wrapped-SOL pairs. The $50 bankroll is converted to SOL at startup.
3. **Exit triggers use the raw observed trade price** compared with the raw entry fill price,
   before costs. With costs counted, a position starts about 9% down: 3% entry slippage,
   1.5% fees each way and 5% exit slippage. If triggers used net PnL, the -40% stop
   would really fire at about -34% of price. PnL in reports is net of every modeled cost.
4. **Paper fills:**
   - Entries fill at the first trade observed after the decision.
   - Exits triggered by a trade fill at that trade's price.
   - Exits not triggered by a trade (time stop, emergency, kill switch) fill at the next
     trade. If no trade arrives within `EXIT_FILL_TIMEOUT_S` (120 s), they fill at the
     last observed price.
5. **Cost model:**
   - Entry: tokens = `sol_in × (1 − 1% − 0.5%) / (price × 1.03)`, and cost = `sol_in + 0.005`.
   - Exit: proceeds = `tokens × price × 0.95 × (1 − 1.5%) − 0.005`.
6. **Bonding progress** is `(1,073,000,000 − vTokensInBondingCurve) / 793,100,000`, clamped
   to the range 0 to 1. These are pump.fun's initial virtual token reserves and its sellable
   real reserves. A trade whose `pool` is not `pump` marks the mint as graduated.
7. **Top-10 holder share** leaves out the bonding-curve account and any AMM pool or LP vault
   that Rugcheck lists in `markets`. Otherwise the curve itself (often 70% or more) would fail
   every token.
8. **Each mint is evaluated by the agents at most once.** After that, it gets a *shadow
   position* that runs through the same exit engine with no bankroll. That makes per-agent
   accuracy measurable even for candidates that were never traded. Without shadows, every
   traded candidate had three BUY votes by definition, so all three agents would always score
   the same accuracy.
9. **The daily loss cap** counts realized losses since the later of UTC midnight and process
   start, so a restart clears the pause, as the brief asks. The LLM and X budgets are stored
   in SQLite, so a restart does not reset them.
10. **Trade subscriptions:** each new mint is subscribed to `subscribeTokenTrade` when its
    create event arrives. The subscription is dropped at 90 min of age unless the mint is a
    candidate, a shadow or a position. The total is capped by `MAX_TRACKED_MINTS` (3000).
    Raw trades are pruned after `TRADE_RETENTION_HOURS` (48) unless they belong to a
    candidate. `subscribeAccountTrade` watches the creator wallets of open and shadow
    positions, so a dev dump is caught even after the mint's own window has passed.
11. **Agents** use the Anthropic Messages API in a manual tool loop of at most 6 turns. Each
    agent finishes by calling a strict `submit_vote` tool whose schema is the required JSON.
    Missing or invalid output counts as `PASS` with confidence 0. Cost is computed from
    `usage` at $3 / $15 per million tokens for `claude-sonnet-4-6`, which you can set with
    `LLM_PRICE_IN_PER_MTOK` and `LLM_PRICE_OUT_PER_MTOK`.
12. **X API use:**
    - The bearer token comes from `X_BEARER_TOKEN`.
    - Before each call, the worst-case cost (`max_results × $0.005`, plus user reads at
      $0.01) is checked against the budget that is left.
    - Repeated queries pass `since_id`, and every post id is stored and never re-read.
    - Watchlist timelines and the news feed are cached and refreshed every 10 and 5 minutes.
      They are shared across candidates, so their cost does not grow with the candidate count.
13. **Live mode is dry run** in this build. It builds and signs the transaction and calls
    `simulateTransaction` through Helius, but never sends. Sending exists in code behind
    `LIVE_DRY_RUN=false` and the same startup checks.
14. **The pump.fun fee is fixed at 1%** (`PUMPFUN_FEE_PCT`) as the brief says, even though
    pump.fun's live fee schedule and the PumpSwap fee after graduation differ. You can change it.
15. **Graduated tokens:** PumpPortal streams PumpSwap trades (after graduation) only to
    connections that use an API key. `PUMPPORTAL_API_KEY` is optional. If a position's stream
    goes quiet for longer than `LIQ_POLL_S`, DexScreener's `priceNative` is used as the mark,
    so stops and exits still fire.
16. **DexScreener liquidity on the bonding curve is unverified.** I could not confirm, from
    this container, that DexScreener fills in `liquidity.usd` for pump.fun pairs that have not
    graduated. If it doesn't, those tokens are rejected with the reason
    `dexscreener pair reports no liquidity`, which keeps to the brief. Setting
    `PF_CURVE_LIQUIDITY_FALLBACK=true` substitutes 2 × the curve's real SOL reserve × SOL/USD
    instead. The default is off.
17. **No `.env` library:** `bot/config.py` parses `.env` itself, because the brief allows no
    extra framework.

## File tree

```
meme-agents/
  PLAN.md  README.md  .env.example  .gitignore  pyproject.toml  requirements.txt
  bot/
    __main__.py      CLI: run | report | simulate | live-check
    config.py        .env loader + typed Settings, every threshold
    db.py            aiosqlite schema + queries (WAL, batched writes)
    util.py          logging, token-bucket rate limiter, backoff
    budget.py        LLM daily + X monthly budget ledger (persisted)
    feeds/
      pumpportal.py  one WS, subscribe/unsubscribe, reconnect w/ backoff
      dexscreener.py tokens (30/call, 300 rpm), search, boosts (60 rpm)
      rugcheck.py    summary + full report, normalised
      helius.py      RPC (10 rps) + Enhanced Tx (2 rps): holders, balance, simulate, send
      xapi.py        recent search, user timeline; budget + post-id cache
      news.py        CryptoPanic + RSS (incl. Truth Social mirror)
      prices.py      SOL/USD
    ingest.py        trade -> per-mint aggregates (buyers, inflow, progress)
    prefilter.py     deterministic gate (pure function + async data fetch)
    paper.py         fill math + paper executor
    exits.py         exit rules (pure)
    risk.py          position / creator / daily-loss limits, STOP kill switch
    positions.py     position manager: mark-to-market, exits, shadows
    agents/
      base.py        tool loop, submit_vote schema, validation, cost
      prompts.py     Scout / Hunter / Analyst role prompts
      tools.py       tool implementations per agent
    consensus.py     unanimous BUY + mean confidence >= 0.65
    live/
      guard.py       startup refusal checks
      executor.py    PumpPortal trade-local / Jupiter v2, sign, simulate
    report.py        metrics + reports/daily-YYYY-MM-DD.md
    telegram.py      optional alerts
    engine.py        wires everything together
    sim.py           offline synthetic feed for smoke runs (no network, no keys)
  tests/  test_prefilter.py test_consensus.py test_paper.py test_exits.py
          test_live_guard.py test_ingest.py test_budget.py test_agents.py
```

## Build order

1. Ingest
2. Pre-filter
3. Paper executor and exits
4. Agents
5. Consensus
6. Report
7. Live mode (dry run)
