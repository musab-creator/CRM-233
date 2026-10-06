# meme-agents-claude

A Solana meme-coin bot for pump.fun launches. Three Claude agents must all vote BUY before
any trade. **Paper mode is the only mode** until you deliberately unlock live mode, and live
mode in this build is a dry run: it builds and signs transactions but never sends them.

```
PumpPortal WS ──► ingest (SQLite) ──► pre-filter (rules) ──► Scout · Hunter · Analyst (Claude, parallel)
                                                                       │
                     report ◄── exits (rules) ◄── paper executor ◄── consensus gate (3×BUY, mean conf ≥ 0.65)
```

The design notes and every assumption are in [PLAN.md](PLAN.md).

## Setup (VPS, about 10 minutes)

1. Install Python 3.12 and git (on Ubuntu: `sudo apt install python3.12 python3.12-venv git`).
2. Clone the repo and `cd meme-agents`.
3. Create a virtualenv: `python3.12 -m venv .venv && . .venv/bin/activate`.
4. Install the dependencies: `pip install -r requirements.txt`.
5. Run `cp .env.example .env` and `chmod 600 .env`.
6. In `.env`, set `ANTHROPIC_API_KEY` and `HELIUS_API_KEY` (the free plan is enough).
7. Optionally, also set:
   - `X_BEARER_TOKEN` (pay-per-use, capped by `X_MONTHLY_BUDGET_USD`)
   - `CRYPTOPANIC_TOKEN`
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
   - `TRUTH_SOCIAL_RSS_URL`
   - `PUMPPORTAL_API_KEY`
8. Run the tests: `python -m pytest -q`. All of them should pass.
9. Smoke-test offline with `python -m bot simulate --minutes 5`, which uses synthetic data and
   needs no keys. Then run `python -m bot report --sim`.
10. Start the bot under systemd or tmux with `python -m bot`. Read results with
    `python -m bot report`, which also writes `reports/daily-YYYY-MM-DD.md`.

Example systemd unit (`/etc/systemd/system/meme-agents.service`):

```ini
[Service]
WorkingDirectory=/home/bot/CRM-233/meme-agents
ExecStart=/home/bot/CRM-233/meme-agents/.venv/bin/python -m bot
Restart=always
User=bot
```

## Commands

| Command | What it does |
|---|---|
| `python -m bot` / `python -m bot run [--minutes N]` | Run the pipeline, in paper mode unless live is unlocked |
| `python -m bot report [--day YYYY-MM-DD]` | Print closed trades, win rate, expectancy, profit factor, max drawdown, PnL in SOL and USD, and per-agent accuracy. Writes the daily markdown file. |
| `python -m bot simulate [--minutes N]` | Offline end-to-end run with synthetic launches and fake APIs. Uses `data/sim.db`. |
| `python -m bot report --sim` | Report on the simulation database |
| `python -m bot live-check` | Run the live-mode startup checks and exit |
| `touch STOP` | Kill switch: stops new entries and closes every open position. Remove the file to resume entries. |

## How a token moves through the pipeline

1. **Ingest.** One PumpPortal WebSocket carries the subscriptions:
   - `subscribeNewToken` for every launch.
   - `subscribeTokenTrade` for each mint while it is younger than 90 minutes, or while it is a
     candidate or has a position.
   - `subscribeAccountTrade` for the creator wallet of every position.

   Every trade is written to `data/bot.db`. Each mint keeps its creator, first-trade time,
   bonding-curve progress, trade count, unique buyers (the creator is excluded) and net SOL
   inflow. The socket reconnects with exponential backoff and re-subscribes.
2. **Pre-filter.** These checks are deterministic and every threshold is in `.env`:
   - age between 5 and 90 minutes
   - at least 40 unique buyers
   - at least 15 SOL of net inflow
   - no danger-level risk on Rugcheck
   - mint and freeze authority both null
   - top-10 holders under 35%, not counting the bonding curve and AMM pool accounts
   - a DexScreener pair with at least $8,000 of liquidity

   The Rugcheck and DexScreener lookups only run for mints that pass the stream checks.
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

   If a vote is invalid, an agent errors, or the budget stops it, that vote counts as PASS
   with confidence 0.
4. **Consensus gate.** The bot buys only if all three agents vote BUY and their mean confidence
   is at least 0.65. Every vote is stored in `votes`, including PASS votes, errors and costs.
   Every gate result is stored in `candidates`.
5. **Paper executor.** The entry fills at the next PumpPortal trade after the decision. Modeled
   costs are:
   - 1% pump.fun fee
   - 0.5% PumpPortal fee
   - 0.005 SOL network fee on each fill
   - 3% slippage in and 5% slippage out

   Every trade tick marks open positions to market. PumpPortal streams trades on PumpSwap
   (after graduation) only to connections with an API key, so set `PUMPPORTAL_API_KEY` if you
   have one. Without it, a position whose stream goes quiet is marked at DexScreener's price.
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

## Data

Everything is in `data/bot.db` (SQLite, WAL mode):

| Table | Contents |
|---|---|
| `mints` | Per-mint aggregates |
| `trades` | Raw stream. Trades for non-candidates are pruned after 48 hours. |
| `prefilter_results` | Pre-filter outcomes |
| `candidates` | Candidates and gate results |
| `votes` | Every agent vote |
| `positions` | Paper, live and shadow positions |
| `fills` | Every fill |
| `ledger` | LLM and X spend |
| `x_posts` | Every X post read |
| `live_tx` | Live transaction signatures |
| `events` | Other events |
