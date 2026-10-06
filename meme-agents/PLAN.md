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
2. **Prices are in SOL per token.** They come from the bonding curve's virtual reserves,
   `virtual_sol / virtual_tokens`, read from chain (assumption 18). With the paid stream on,
   they come from each trade's `solAmount / tokenAmount` instead. USD figures use a SOL/USD
   price that is refreshed every 60 s from DexScreener's wrapped-SOL pairs. The $50 bankroll
   is converted to SOL at startup.
3. **Exit triggers use the raw observed trade price** compared with the raw entry fill price,
   before costs. With costs counted, a position starts about 9% down: 3% entry slippage,
   1.5% fees each way and 5% exit slippage. If triggers used net PnL, the -40% stop
   would really fire at about -34% of price. PnL in reports is net of every modeled cost.
4. **Paper fills:**
   - Entries fill at the first trade observed after the decision. Without the paid stream,
     that is the first curve read whose reserves moved, because a move means trades happened.
     It fills at the price the curve shows then.
   - Exits triggered by a trade fill at that trade's price.
   - Exits not triggered by a trade (time stop, emergency, kill switch) fill at the next
     trade. If no trade arrives within `EXIT_FILL_TIMEOUT_S` (120 s), they fill at the
     last observed price.
5. **Cost model:**
   - Entry: tokens = `sol_in × (1 − 1% − 0.5%) / (price × 1.03)`, and cost = `sol_in + 0.005`.
   - Exit: proceeds = `tokens × price × 0.95 × (1 − 1.5%) − 0.005`.
6. **Bonding progress** is `(1,073,000,000 − vTokensInBondingCurve) / 793,100,000`, clamped
   to the range 0 to 1. These are pump.fun's initial virtual token reserves and its sellable
   real reserves. A mint counts as graduated when any of these happens: its curve reads
   `complete`, PumpPortal sends a free `migrate` event, or a streamed trade's `pool` is not
   `pump`.
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
10. **Tracking:** every launch is tracked from its create event until 90 min of age, unless
    it is a candidate, a shadow or a position. A launch is dropped earlier if it is 15 min old
    with under 1 SOL of inflow. The total is capped by `MAX_TRACKED_MINTS` (3000). Raw trades
    are pruned after `TRADE_RETENTION_HOURS` (48) unless they belong to a candidate. With the
    paid stream on, `subscribeAccountTrade` also watches the creator wallets of open and
    shadow positions.
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
    `simulateTransaction` through Helius, but never sends. Sending exists in code behind an
    explicit `LIVE_DRY_RUN=false` (booleans are parsed strictly) and the same startup checks.
    Sent trades are reconciled against wallet balances after confirmation. Sells are
    percentages of actual holdings, and retries check whether an earlier attempt already landed.
14. **The pump.fun fee is fixed at 1%** (`PUMPFUN_FEE_PCT`) as the brief says, even though
    pump.fun's live fee schedule and the PumpSwap fee after graduation differ. You can change it.
15. **Graduated tokens:** after graduation the price lives in the PumpSwap pool, not the
    curve. If a position gets no tick for longer than `LIQ_POLL_S`, DexScreener's
    `priceNative` is used as the mark, so stops and exits still fire.
16. **DexScreener reports no liquidity for bonding-curve pairs (verified).** The live probe on
    6 Oct 2026 found `liquidity.usd` on 0 of 59 pump.fun curve pairs, and on 6 of 6 graduated
    PumpSwap pairs. Applied literally, the brief's "DexScreener liquidity ≥ $8k" rule would
    reject every token before graduation, although the brief's universe starts at the first
    bonding-curve trade. So `PF_CURVE_LIQUIDITY_FALLBACK=true` is the default: when DexScreener
    has a pair but no liquidity figure, the bot uses 2 × the curve's real SOL reserve (exact,
    read from chain) × SOL/USD. That is the depth of an AMM pool holding the same SOL. At
    SOL = $120 the $8k bar means about 33 SOL in the curve, which is stricter than the 15 SOL
    inflow rule. A reported liquidity is never overridden. Set it to `false` to trade only
    graduated tokens.
17. **No `.env` library:** `bot/config.py` parses `.env` itself, because the brief allows no
    extra framework.

Added after the build, when research showed a change in PumpPortal's data API:

18. **Per-token data comes from the chain, not PumpPortal's trade stream.** Since May 1, 2026,
    PumpPortal streams `subscribeTokenTrade` and `subscribeAccountTrade` only to an API key
    whose linked wallet holds at least 0.02 SOL. It charges 0.01 SOL per 10,000 trades.
    pump.fun runs over a million trades a day, so following every launch, as the original
    design did, would cost about 1 SOL a day against a $50 bankroll. Launches and graduations
    are still free. The facts the pre-filter needs are read from chain through the Helius
    free plan the brief already includes:
    - **Net inflow** is the bonding curve's `real_sol_reserves`. Per pump.fun's program docs it
      starts at 0 and moves by exactly the SOL of every buy and sell, and fees are paid
      elsewhere. It is read with `getMultipleAccounts`, 100 curves for 1 credit.
    - **Price and progress** come from the curve's virtual reserves.
    - **Unique buyers** see assumption 19.
    - **Flow features** for a candidate come from the launch minute's trades, rebuilt from its
      first transactions by balance deltas (not by decoding pump.fun's events, whose layout
      has changed before), plus current holder balances and the bot's own curve reads.
    The paid stream remains as an option (`PUMPPORTAL_TRADE_STREAM=positions|all`) under a
    daily SOL budget.
19. **Unique buyers are wallets with a token account,** excluding the creator and the curve,
    from Helius DAS `getTokenAccounts`, which includes emptied accounts. This is a lower bound
    on distinct buyers: a wallet that sold out and closed its account is not counted. So the
    40-buyer rule is, if anything, stricter than the brief's. A token passes only after a
    fresh on-chain curve read; before it, the only inflow known is the dev's own launch buy.
20. **Helius credits are budgeted** (`HELIUS_MONTHLY_CREDITS`, 1M on the free plan). Curve
    reads are capped at `CURVE_POLL_CALLS_PER_MIN` (8). If the month's usage runs more than 10%
    ahead of pace, curve reads halve, holder counts refresh half as often and the launch-minute
    backfill reads half as many transactions. If the budget is spent, chain reads stop until
    the next month and the health check reports PAUSED. The first live hour used 4,362 credits
    for 1,789 launches and 17 candidates.
21. **SOL/USD is the median over deep SOL/USDC and SOL/USDT pairs on DexScreener,** and a
    reading more than 20% from the last accepted one is held until it repeats three times
    (three minutes). The live run saw one $166.66 reading between readings of $121.70; it sized
    a shadow entry a third too small and would have inflated the curve-depth liquidity rule.
22. **Launch-slot order.** `getSignaturesForAddress` lists signatures newest first, inside a
    slot too. The launch-minute backfill reverses them before sorting by slot, so the create
    transaction and the snipers bundled into its slot keep block order, and the create is never
    pushed past `BACKFILL_MAX_TX`. The live probe's `launch_trade_matches_create` check
    verifies this on every run.
23. **The LLM budget is paced** (`LLM_BUDGET_PACING`, default on): the daily budget is released
    evenly over the UTC day with `LLM_BUDGET_BURST_HOURS` (2) hours' worth up front, so the bot
    evaluates throughout the day instead of spending it all in the first two hours. The brief's
    cap still holds: nothing is spent beyond `LLM_DAILY_BUDGET_USD`.
24. **Telegram commands come only from `TELEGRAM_CHAT_ID`.** The bot long-polls `getUpdates`
    (no inbound port, so the firewall stays closed) and answers `/status`, `/digest`, `/report`,
    `/stop` and `/resume` from that chat alone; other chats are logged and ignored. `/stop` writes
    the same STOP file as the kill switch, so the two paths cannot disagree. Nothing in the chat
    can change a setting, unlock live mode or send a transaction.

## File tree

```
meme-agents/
  PLAN.md  README.md  .env.example  .gitignore  pyproject.toml  requirements.txt
  bot/
    __main__.py      CLI: run | report | simulate | status | preflight | acceptance | live-check
    config.py        .env loader + typed Settings, every threshold
    db.py            aiosqlite schema + queries (WAL, batched writes)
    util.py          logging, token-bucket rate limiter, backoff
    budget.py        LLM daily + X monthly budget ledger (persisted)
    feeds/
      pumpportal.py  one WS, subscribe/unsubscribe, reconnect w/ backoff
      dexscreener.py tokens (30/call, 300 rpm), search, boosts (60 rpm)
      rugcheck.py    summary + full report, normalised
      helius.py      RPC (10 rps) + DAS/Enhanced (2 rps), credit metering: holders, balance, simulate, send
      pumpchain.py   bonding-curve decode, trades rebuilt from transactions, holder snapshots
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
    status.py        live status and the health check for cron
    preflight.py     API/key checks and the live-data probe
    acceptance.py    the brief's "Done when" test, automated
    telegram.py      optional alerts and the getUpdates poller
    digest.py        the hourly Telegram digest
    commands.py      Telegram commands (/status /digest /report /stop /resume) from the configured chat
    engine.py        wires everything together
    sim.py           offline synthetic feed for smoke runs (no network, no keys)
  tests/  test_prefilter.py test_consensus.py test_paper.py test_exits.py
          test_live_guard.py test_ingest.py test_budget.py test_agents.py
  deploy/ install.sh  update.sh  set-env.sh  meme-agents.service  healthcheck.sh  VPS.md
  KEYS.md            where to get each API key, where to store it
.github/workflows/meme-agents-live.yml   paper run on a GitHub runner (probe / 60-min acceptance)
```
(The test file names above were the plan; the suite has since grown, see `tests/`.)

## Build order

1. Ingest
2. Pre-filter
3. Paper executor and exits
4. Agents
5. Consensus
6. Report
7. Live mode (dry run)
