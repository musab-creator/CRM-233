# meme-agents-claude

A Solana meme-coin bot for pump.fun launches. Three Claude agents must all vote BUY before
any trade. **Paper mode is the only mode** until you deliberately unlock live mode, and live
mode in this build is a dry run: it builds and signs transactions but never sends them.

```
PumpPortal WS (launches) ─┐
Helius (curves, holders) ─┴► ingest (SQLite) ──► pre-filter (rules) ──► Scout · Hunter · Analyst (Claude, parallel)
                                                                                  │
                     report ◄── exits (rules) ◄── paper executor ◄── consensus gate (3×BUY, mean conf ≥ 0.65)
```

The design notes and every assumption are in [PLAN.md](PLAN.md). **[KEYS.md](KEYS.md)** says
where to get each API key and where to store it.

> **Data source change (May 2026).** PumpPortal now streams per-token trades only to a funded
> API key, at 0.01 SOL per 10,000 trades. That is about 1 SOL a day if you follow every launch.
> This bot therefore uses PumpPortal only for its free launch and graduation events. It reads
> each token's state from the chain through Helius's free plan: net inflow and price from the
> bonding-curve account, and buyers from token accounts. The paid stream is optional and
> budgeted; see [Data sources and costs](#data-sources-and-costs).

## Setup (VPS, about 10 minutes)

1. Install Python 3.12 and git. On Ubuntu: `sudo apt install python3.12 python3.12-venv git`.
2. Clone the repo and `cd meme-agents`.
3. Run `deploy/install.sh`. It creates `.venv`, installs the dependencies, creates `.env` from
   `.env.example` with `chmod 600`, and runs the tests. It is safe to run again.
4. Get an Anthropic key and a Helius key (the free plan is enough). Optionally get X and
   Telegram keys too. [KEYS.md](KEYS.md) walks through each one.
5. Put the keys in `.env`, and nowhere else.
6. Run `.venv/bin/python -m bot preflight`. Every required row should say PASS.
7. Smoke-test offline with `.venv/bin/python -m bot simulate --minutes 5`, then
   `.venv/bin/python -m bot report --sim`. This uses synthetic data and needs no keys.
8. Run the brief's done test: `.venv/bin/python -m bot acceptance --minutes 60`. It runs paper
   mode for an hour and prints PASS or FAIL for each criterion.
9. Run `deploy/install.sh --systemd --cron`, then `sudo systemctl start meme-agents`. The bot
   runs 24/7, restarts after a crash or hang, and a cron health check alerts on Telegram.
10. Watch it with `.venv/bin/python -m bot status`, and read results with
    `.venv/bin/python -m bot report`, which writes `reports/daily-YYYY-MM-DD.md`.

## Commands

| Command | What it does |
|---|---|
| `python -m bot` / `python -m bot run [--minutes N]` | Run the pipeline, in paper mode unless live is unlocked |
| `python -m bot report [--day YYYY-MM-DD]` | Print closed trades, win rate, expectancy, profit factor, max drawdown, PnL in SOL and USD, and per-agent accuracy. Writes the daily markdown file. |
| `python -m bot simulate [--minutes N]` | Offline end-to-end run with synthetic launches and fake APIs. Uses `data/sim.db`. |
| `python -m bot report --sim` | Report on the simulation database |
| `python -m bot status [--sim]` | Live view, safe to run while the bot runs: heartbeat, stream health, budgets, today's funnel, open positions with net PnL, the last 5 decisions with each agent's vote |
| `python -m bot status --check [--alert]` | One line for monitoring (OK, PAUSED, DEGRADED, DOWN or BLIND); exits 1 if degraded, down or blind. `--alert` sends a Telegram message when the state changes. |
| `python -m bot preflight [--probe]` | Checks every API and key with free calls. `--probe` also records what the live APIs return and tests this build's assumptions against it (about 3 minutes). |
| `python -m bot acceptance [--minutes 60] [--sim]` | The brief's "Done when" test: runs paper mode for N minutes, then checks crash-free, at least one full decision cycle, and that the report runs. Writes `reports/acceptance-*.md` with the pipeline funnel. |
| `python -m bot live-check` | Run the live-mode startup checks and exit |
| `touch STOP` | Kill switch: stops new entries and closes every open position. Remove the file to resume entries. |

## How a token moves through the pipeline

1. **Ingest.**
   - One PumpPortal WebSocket carries the free `subscribeNewToken` and `subscribeMigration`
     events: every launch and every graduation. It reconnects with exponential backoff,
     re-subscribes, and forces a reconnect if it goes silent for `WS_STALL_S`.
   - Each launch's bonding-curve account is read through Helius `getMultipleAccounts`, 100
     curves per call and 1 credit each. The read gives:
     - net SOL inflow, which is exactly the curve's real SOL reserve;
     - price, bonding progress and graduation.
   - A launch is read sooner the closer it gets to the inflow bar: every 20 s, 45 s, 120 s or
     240 s. Candidates, positions and shadows are read every `CURVE_HOT_POLL_S` (15 s).
     Launches older than 15 minutes with under 1 SOL of inflow are dropped.
   - When a launch passes the age and inflow rules, the bot reads its token accounts through
     Helius DAS, at most once every 5 minutes per token. Wallets that bought, excluding the
     creator, are the unique-buyer count. This is a lower bound: a wallet that sold out and
     closed its account disappears.
   - With the optional paid stream, trades come straight from PumpPortal instead
     (`PUMPPORTAL_TRADE_STREAM`).

   Everything is written to `data/bot.db`.
2. **Pre-filter.** These checks are deterministic and every threshold is in `.env`:
   - age between 5 and 90 minutes
   - at least 40 unique buyers
   - at least 15 SOL of net inflow
   - no danger-level risk on Rugcheck
   - mint and freeze authority both null
   - top-10 holders under 35%, not counting the bonding curve and AMM pool accounts
   - a DexScreener pair with at least $8,000 of liquidity

   The Rugcheck and DexScreener lookups only run for mints that pass the first three checks.
   Inflow must come from at least one on-chain curve read. Before that read, the only inflow
   the bot knows is the dev's own launch buy.
   During the first hour on the VPS, check `prefilter_results.reason`. If
   `dexscreener pair reports no liquidity` dominates, DexScreener is not reporting liquidity
   for bonding-curve pairs. You can then set `PF_CURVE_LIQUIDITY_FALLBACK=true` (see
   PLAN.md, assumption 16).
3. **Agents.** Three Claude calls run in parallel. Each has its own tools and must finish with
   a strict `submit_vote` call: `{"vote","confidence","reasons","evidence"}`. The Analyst also
   returns `size_usd`.
   - **Scout (المحقق):** `x_search`, `dexscreener_profile`, `dexscreener_boosts`. It judges
     organic attention against spam.
   - **Hunter (القناص):** `x_user_timeline` for the watchlist accounts, plus a Truth Social RSS
     mirror if one is set, and `news_feed` from CryptoPanic and RSS. It looks for a catalyst in
     the last 60 minutes that matches the token.
   - **Analyst (البروفيسور):** `rugcheck`, `holders` (from Helius, including the creator wallet's
     activity), `dexscreener_pair`, `recent_trades`. It reviews market structure and proposes
     a size.

   All three agents also receive **flow features** that the bot computes itself
   (`bot/features.py`). It rebuilds the launch minute's trades from the curve's first
   transactions, using balance changes, for about 80 Helius credits per candidate. It adds
   what every wallet holds now and its own curve reads:
   - snipers: the top 3 wallets' buying in the first 60 s, and whether they still hold
   - bundling: buyers in the launch slot, and 3 or more wallets buying the same amount within 3 s
   - early-buyer retention: how many of the first 20 buyers have already exited
   - dev sold %, and how much of the supply the dev still holds
   - holder concentration: top-5 share, HHI and effective holder count
   - 5-minute inflow and price momentum, and drawdown from the peak

   With the paid stream on, the same features come from every trade instead. A value the
   bot doesn't have is null, never guessed.

   The LLM weighs these numbers; it doesn't have to estimate them from raw trades.

   If a vote is invalid, an agent errors, or the budget stops it, that vote counts as PASS
   with confidence 0.

   **Grounding guard.** A BUY counts only if the agent made at least one successful tool call
   and at least half of its `evidence` items cite a number, address or post id found in the
   data it received. The candidate's own mint address doesn't count. Otherwise the BUY becomes
   a PASS, and the vote stores the agent's original vote, the grounding score and the reason
   (`votes.raw_vote`, `grounding`, `guard`). This stops trades based on invented facts. It
   cannot prove an argument is right: a number can match by coincidence.
4. **Consensus gate.** The bot buys only if all three agents vote BUY and their mean confidence
   is at least 0.65. Every vote is stored in `votes`, including PASS votes, errors and costs.
   Every gate result is stored in `candidates`.
5. **Paper executor.** The entry fills at the next observed trade after the decision: the
   first curve read whose reserves moved (that means trades happened), or the next streamed
   trade with the paid stream. Modeled costs are:
   - 1% pump.fun fee
   - 0.5% PumpPortal fee
   - 0.005 SOL network fee on each fill
   - 3% slippage in and 5% slippage out

   Every tick (a curve move or a streamed trade) marks open positions to market. After
   graduation the price lives in the AMM pool, so a position with no tick for `LIQ_POLL_S` is
   marked at DexScreener's price.
6. **Exits.** These are rules only:
   - stop loss at -40%
   - at +60%, sell half, then put a 30% trailing stop on the rest
   - time stop at 6 hours
   - emergency exit if liquidity falls 50% (checked every 60 s) or Rugcheck turns to danger
     (checked every 5 minutes)
7. **Risk.**
   - at most 3 open positions
   - at most 1 position per creator wallet
   - a daily loss cap of 50% of the bankroll pauses entries until you restart the bot
   - entries are refused when the bankroll can't fund them

Every evaluated candidate also gets a **shadow position**: a $5 paper position with no bankroll
that runs through the same exit rules. This gives every vote an outcome, even when the token
was never traded, so the report can score each agent's BUY votes separately.

## Is the LLM worth it? Reading the report

`python -m bot report` answers that question from your own data. It does not re-run any
model. Every evaluated candidate has a shadow outcome, so it can show:

- **Per-agent accuracy, lift and Brier score.** Lift is an agent's BUY win rate divided by
  the base win rate of all scored candidates. Above 1 means its BUYs pick winners better than
  the pre-filter alone. The Brier score checks whether the agent's confidence is honest:
  0.25 is a coin flip and lower is better.
- **Gate what-if.** The recorded votes are replayed through the gate at mean-confidence
  thresholds from 0.50 to 0.90, both unanimous and 2-of-3. A *pre-filter only* baseline row
  sits on top. If no gate row beats the baseline over a few hundred candidates, the agents
  are not earning their cost. That is the time to change prompts or thresholds.
- **Signal check.** For each flow feature, it compares the outcomes of candidates above and
  below the median, which shows which signals actually separate winners from losers in your
  data.

Any sample under 30 is flagged as noise. Don't tune on it.

## Operations

- Logs go to the console and to `logs/bot.log`, rotated at 20 MB with 5 files kept. Secrets
  that appear in URLs are redacted.
- **Stall watchdog.** If PumpPortal sends nothing for `WS_STALL_S` seconds (default 90),
  the client reconnects and re-subscribes, even when the socket still answers pings.
- The engine writes a heartbeat to the database every 60 s. `python -m bot status --check`
  turns it into one line plus an exit code. `deploy/healthcheck.sh` runs it from cron every
  5 minutes and sends a Telegram message when the state changes:
  - DOWN: no heartbeat for 3 minutes;
  - BLIND: no PumpPortal message for 5 minutes;
  - PAUSED: the daily loss cap was hit;
  - DEGRADED: the last 6 agent votes all failed, for example because the Anthropic key expired.
- **systemd** (`deploy/meme-agents.service`) restarts the bot after a crash, and after a hang:
  the bot pings systemd's watchdog every 60 s. Configuration errors (exit 2) are not
  retried. The unit can write only `data/`, `logs/` and `reports/`.
- **One bot per database.** A lock next to `data/bot.db` refuses a second process, such as
  the service plus a manual run. Without it, two bots would trade the same bankroll.
- **Self-healing loops.** Every background loop is supervised. If one ever raises, it is
  logged with its traceback, counted, shown by `status`, and restarted.
- **Restarts are safe.** Open positions, queued candidates and budgets all resume from
  SQLite. Older databases are migrated in place.

## Budgets

- **LLM.** The bot tracks spend per UTC day from each response's `usage`, at $3 per million
  input tokens and $15 per million output tokens for `claude-sonnet-4-6`. When
  `LLM_DAILY_BUDGET_USD` is reached, it stops evaluating candidates; they are recorded as
  `skipped_budget`.
- **X.** The bot tracks spend per UTC month. Before each call it reserves the worst case
  (`max_results × $0.005`, or `$0.01` for a user lookup) and refuses the call if that doesn't
  fit in `X_MONTHLY_BUDGET_USD`. It stores every post id in `x_posts` and uses `since_id`, so
  no post is read twice. Watchlist timelines refresh at most every 10 minutes and are shared
  by all candidates.

Both budgets are stored in SQLite, so a restart does not reset them.

## Data sources and costs

| Source | Used for | Cost |
|---|---|---|
| PumpPortal `subscribeNewToken`, `subscribeMigration` | Every launch and graduation | Free |
| Helius RPC `getMultipleAccounts` | Bonding curves: inflow, price, progress (100 per call) | 1 credit per call |
| Helius DAS `getTokenAccounts` | Buyers and holders, for tokens past the age and inflow rules | 10 credits per call |
| Helius `getSignaturesForAddress` + `getTransaction` | A candidate's launch-minute trades | about 80 credits per candidate |
| DexScreener, Rugcheck | Liquidity, pairs, risks | Free |
| PumpPortal `subscribeTokenTrade` (optional) | Exact per-trade data for candidates and positions (`positions`) or every launch (`all`) | 0.01 SOL per 10,000 trades, from a wallet linked to your API key |

With the defaults, curve reads make at most 8 calls a minute, the hot set included. That is at
most about 0.35M credits a month. DAS holder reads, launch-minute backfills and the Analyst's
Helius tools bring the expected total to about 0.6M of the free plan's 1M; the Analyst's
`holders` tool reads the creator's recent wallet activity, at 100 credits per candidate. The
bot records every credit against `HELIUS_MONTHLY_CREDITS`. If the month's usage runs ahead of
pace, it halves the curve reads. `status` and the heartbeat show credits used this month.

The paid stream is off by default. With `PUMPPORTAL_TRADE_STREAM=positions` or `all`, the
bot counts every streamed trade per UTC day. When `PUMPPORTAL_DAILY_BUDGET_SOL` is reached,
it unsubscribes everything and carries on with the chain reads until midnight UTC.

## Test run on GitHub (free compute)

`.github/workflows/meme-agents-live.yml` runs the bot on a GitHub-hosted runner with open
internet, in paper mode only.

- Add the label **`live-probe`** to a pull request. It runs the unit tests, the preflight and
  the live-data probe, takes about 5 minutes, and is free.
- Add **`live-paper-run`**, or click **Run workflow** on the Actions tab. It runs the same,
  then the 60-minute acceptance test and the report.

Keys come from repository secrets (`ANTHROPIC_API_KEY`, `HELIUS_API_KEY`, optionally
`X_BEARER_TOKEN`; see [KEYS.md](KEYS.md)). The results appear in the job summary and as a
downloadable artifact. Remove and re-add the label to run it again.

## Live mode (locked)

Live mode starts only if **all** of these are true. Otherwise it refuses with exit code 2:

- `MODE=live`
- `LIVE_CONFIRM=I_ACCEPT_LOSSES`
- `WALLET_PRIVATE_KEY` parses
- `HELIUS_API_KEY` and `ANTHROPIC_API_KEY` are set
- the wallet's on-chain balance is 0.5 SOL or less at startup

Orders go to PumpPortal's Local Trade API (`POST /api/trade-local`, `pool: "auto"`) and are
signed locally with `solders`. Graduated tokens go through Jupiter Swap API v2 instead
(`/order` then `/execute`) when `JUPITER_API_KEY` is set.

With `LIVE_DRY_RUN=true` (the default in this build), each transaction is simulated through
Helius (`simulateTransaction`) instead of being sent. Every signature, dry-run or sent, goes
into the `live_tx` table. The private key is never logged.

Boolean settings are parsed strictly. Only `true/false/1/0/yes/no/on/off` are accepted, and
anything else stops the bot at startup. A typo such as `LIVE_DRY_RUN=ture` can therefore never
turn on real sends.

If you ever set `LIVE_DRY_RUN=false`, sending is built not to trust a model of what happened:
- **Fills are reconciled against the wallet.** After each send the bot waits for the
  signature to confirm (`LIVE_CONFIRM_TIMEOUT_S`). It then records the tokens and SOL that
  actually moved, read from wallet balances before and after the trade.
- **Sells are a percentage of what the wallet holds**: `"100%"` on a full exit, `"50%"` on
  take-profit. A position can't get stuck because the real fill differed from the model.
- **Retries check before selling again.** If the wallet already shows that an earlier
  attempt landed, that attempt is recorded as the fill instead of selling twice.
- **Failed exits back off** at 5 s, 10 s, 20 s and so on, up to 5 minutes, and keep retrying.
  After 3 failures a Telegram alert asks you to check the wallet.
- **Live trades run in the background**, one at a time per position. Waiting for a
  confirmation never stalls the trade stream or the other positions.

## Data

Everything is in `data/bot.db` (SQLite, WAL mode):

| Table | Contents |
|---|---|
| `mints` | Per-mint state: curve reserves, inflow, buyers, holders, status |
| `trades` | Launch buys, candidates' rebuilt launch-minute trades, and the paid stream if on. Trades for non-candidates are pruned after 48 hours. |
| `prefilter_results` | Pre-filter outcomes |
| `candidates` | Candidates and gate results |
| `votes` | Every agent vote |
| `positions` | Paper, live and shadow positions |
| `fills` | Every fill |
| `ledger` | LLM and X spend |
| `kv` | Heartbeat, bankroll, Helius credits per month, streamed trades per day |
| `x_posts` | Every X post read |
| `live_tx` | Live transaction signatures |
| `events` | Other events |
