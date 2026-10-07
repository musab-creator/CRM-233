# API keys: where to get each one and where to store it

Checked against each provider's own documentation in October 2026. Prices and limits change,
so check the linked page before you pay for anything.

## What you need

| Variable in `.env` | Needed? | What the bot uses it for | Cost |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Required** | The three agents (Scout, Hunter, Analyst) | Pay per token. The bot stops evaluating at `LLM_DAILY_BUDGET_USD` (default $5/day). |
| `HELIUS_API_KEY` | **Required** | On-chain data: bonding-curve state, holders, the creator's wallet, and the live-mode RPC | Free plan: 1M credits/month, 10 RPC req/s, 2 DAS req/s. The bot paces itself under `HELIUS_MONTHLY_CREDITS`. |
| `X_BEARER_TOKEN` | Optional, **but without it the bot almost never buys** (see below) | Scout searches X; Hunter reads the watchlist timelines | Pay per use: $0.005 per post read, $0.01 per user read. The bot stops at `X_MONTHLY_BUDGET_USD` (default $20/month). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional | Alerts for entries, exits, the hourly digest, the daily summary and health; `/status` and `/report` from your phone | Free |
| `JUPITER_API_KEY` | Optional, live mode only | Swaps for graduated tokens | Free plan: 1 req/s |
| `PUMPPORTAL_API_KEY` | **Not needed** (see below) | Paid per-token trade stream, off by default | 0.01 SOL per 10,000 trades from a wallet you fund |
| `CRYPTOPANIC_TOKEN` | Optional | Extra news headlines | Paid plans only (the free plan was discontinued in early 2026). Without it the bot uses free RSS feeds. |
| `WALLET_PRIVATE_KEY` | Live mode only | Signing live transactions | Use a brand-new wallet. The bot refuses to start live mode if it holds more than 0.5 SOL. |

DexScreener, Rugcheck and PumpPortal's new-token and migration stream need no key.

## Where to store them

**On your server, in `meme-agents/.env` and nowhere else.**

```bash
cd meme-agents
cp .env.example .env      # skip if deploy/install.sh already did it
chmod 600 .env            # only your user can read it
nano .env                 # paste each value after the = sign, no quotes, no spaces
```

`.gitignore` already excludes `.env`, so git never picks it up. Keys are read from this file
only: a key exported in the shell environment is ignored (non-secret settings can still be
overridden that way). The bot masks the configured keys in its logs.

**For the test run on GitHub:** use repository secrets, never a file in the repo.

1. Open the repository on GitHub and click **Settings**.
2. Go to **Secrets and variables → Actions**, then click **New repository secret**.
3. Set the name exactly as the variable (for example `ANTHROPIC_API_KEY`), paste the value
   and click **Add secret**.

The workflow `.github/workflows/meme-agents-live.yml` writes the secrets into a temporary
`.env` on GitHub's throwaway runner. It forces `MODE=paper` and never reads
`WALLET_PRIVATE_KEY`. GitHub masks secret values in its logs and does not pass them to pull
requests from forks. Add only `ANTHROPIC_API_KEY` and `HELIUS_API_KEY` there, plus
`X_BEARER_TOKEN` if you want the agents to read X during the test.

**Never put a key** in code, a commit, an issue, a PR description, a comment or a chat
message, including a chat with Claude. If one leaks, revoke it at the provider straight away
and create a new one. Every provider below lets you do that from the same page where you
created the key.

## Step by step

### Anthropic (`ANTHROPIC_API_KEY`), required

1. Sign in at [platform.claude.com](https://platform.claude.com).
2. **Settings → Billing**: add a payment method and buy some credit. A new key returns
   authentication errors until billing is set up.
3. **Settings → Workspaces**: create a workspace called `meme-agents` and give it a monthly
   **spend limit**. About $150 matches 30 days at the bot's default $5/day. The Default
   workspace cannot have its own limit, which is why you need a new one. This is a hard
   ceiling at Anthropic on top of the bot's own `LLM_DAILY_BUDGET_USD`.
4. **Settings → API keys** ([direct link](https://platform.claude.com/settings/keys)) →
   **Create key**:
   - **Name:** `meme-agents-vps`. Make a separate key for the GitHub test run so you can revoke
     each one on its own.
   - **Scope:** the `meme-agents` workspace, **not "Organization"**. Anthropic rejects every
     call from an organization-scoped key unless the request sends an `anthropic-workspace-id`
     header, and the bot doesn't send one. An organization key can also reach the Admin API
     (keys, members, workspaces), which a key on a server should never be able to do.
   - **Expires:** anything works. When the key expires, every agent vote fails until you
     replace it in `.env`. `python -m bot status --check` then reports DEGRADED, and the cron
     health check alerts you on Telegram. Choose 90 days and set a reminder, or a shorter
     period if you prefer to rotate often.
   - **Linked account / key type:** a personal key is fine if you own the organization. A
     workspace or service key is better for an unattended bot if the console offers one,
     because it stays active if your user leaves the organization.
5. The key starts with `sk-ant-` and is shown only once. Paste it straight into `.env` or a
   GitHub secret.

### Helius (`HELIUS_API_KEY`), required, free

1. Sign up at [dashboard.helius.dev](https://dashboard.helius.dev). The Free plan needs no card.
2. Open **API Keys** and copy the key, which is a UUID like `1a2b3c4d-...`. Paste only the
   key, not the whole URL. The bot builds `https://mainnet.helius-rpc.com/?api-key=...` itself.
3. Free plan limits (see [Helius plans](https://www.helius.dev/docs/billing/plans)): 1M
   credits per month, 10 RPC requests/s, 2 DAS or Enhanced requests/s and one API key. An RPC
   call costs 1 credit, a DAS call 10 and an Enhanced Transactions call 100
   ([credit table](https://www.helius.dev/docs/billing/credits)). The bot's defaults stay
   under these limits, and `python -m bot status` shows the credits used this month.
4. **On a paid plan**, tell the bot its new limits so it paces itself against the right budget
   and uses the extra speed. Developer ($49/month, 10M credits, 50 RPC req/s, 10 DAS req/s):
   ```
   HELIUS_MONTHLY_CREDITS=10000000
   HELIUS_RPC_RPS=50
   HELIUS_ENHANCED_RPS=10
   CURVE_POLL_CALLS_PER_MIN=30     # fresher curve reads (default 8)
   CURVE_HOT_POLL_S=5              # positions and candidates every 5 s (default 15)
   CURVE_FIRST_POLL_S=30           # first read of a launch (default 60)
   HOLDERS_REFRESH_S=120           # holder counts every 2 min (default 300)
   BACKFILL_MAX_TX=200             # more of the launch minute (default 80)
   ```
   That uses roughly 3M credits a month. Business (100M, 200 RPC req/s, 50 DAS req/s) and
   Professional (200M, 500, 100) follow the same pattern. Restart the bot after editing.

   `deploy/set-env.sh` changes settings without an editor. Professional, in one line:
   ```bash
   deploy/set-env.sh HELIUS_MONTHLY_CREDITS=200000000 HELIUS_RPC_RPS=200 HELIUS_ENHANCED_RPS=50 \
     CURVE_POLL_CALLS_PER_MIN=60 CURVE_POLL_SCALE=0.25 CURVE_HOT_POLL_S=2 CURVE_FIRST_POLL_S=15 \
     HOLDERS_REFRESH_S=120 HOLDER_CHECKS_PER_SCAN=12 BACKFILL_MAX_TX=400
   sudo systemctl restart meme-agents
   ```
   That reads positions every 2 seconds and every launch every 5-60 seconds, and uses roughly
   10-15M of the plan's 200M credits a month.

### X API (`X_BEARER_TOKEN`), optional, pay per use

1. Sign in at [console.x.com](https://console.x.com) with your X account and create an app.
2. Open the app's **Keys and tokens** and generate a **Bearer Token**. That is the only
   credential the bot needs, since it only reads and never posts.
3. Buy credits in the console. X API is prepaid pay-per-use with no subscription
   ([X API docs](https://docs.x.com/x-api/introduction)). It costs $0.005 per post read and
   $0.01 per user read, which are the bot's defaults `X_POST_READ_USD` and `X_USER_READ_USD`.
4. Your prepaid balance is a hard ceiling. The bot also stops calling X at
   `X_MONTHLY_BUDGET_USD`, stores every post id and never pays to read the same post twice.

**Why it matters.** Hunter's job is to confirm a live catalyst from the watchlist accounts
(`WATCHLIST_HANDLES`, default @elonmusk and @realDonaldTrump), and Scout's is to judge organic
attention on X. Without a token, Hunter only has crypto news RSS, which almost never explains a
five-minute-old meme coin, so it votes PASS, and the gate needs all three BUY. In the
60-minute live run without X, all 17 decisions were PASS. The bot still runs, learns and
reports without X; it just will not enter.

**What it costs.** Scout spends up to $0.10 per candidate (2 searches × `X_SEARCH_MAX_RESULTS`
10 posts) and Hunter's watchlist reads are cached across candidates. At the ~40 candidates a
day the $5 LLM budget allows, that is about $4 a day, so the default `X_MONTHLY_BUDGET_USD=20`
lasts about five days a month. Raise it, or lower `X_SEARCH_MAX_RESULTS`, to have X all month.

### Telegram alerts (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), optional, free

1. In Telegram, message [@BotFather](https://t.me/BotFather) and send `/newbot`. Choose a
   name and a username ending in `bot`. BotFather replies with the token, which looks like
   `123456789:AA...`.
2. Send any message (for example "hi") to your new bot.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser, with your token in
   place of `<TOKEN>`. In the reply, the number at `"chat":{"id":...}` is your
   `TELEGRAM_CHAT_ID`. For a group, add the bot to the group, post a message there and use
   the group's id, which is negative.
4. Run `python -m bot preflight`. It checks the token with `getMe`, then sends a test message to
   your chat. `chat not found` means the id is wrong; `bot can't initiate conversation with a
   user` means you have not sent the bot a message yet (step 2).

What the bot sends: every entry and exit (✅ WIN / ❌ LOSS with the return, reason and hold
time), an **hourly digest** at the top of each UTC hour with the hour's closed trades, open
positions, candidates and today's totals (`TELEGRAM_DIGEST=all`; `wins` sends it only for hours
with a winning trade; `off` disables it), the daily summary at midnight UTC, and health
alerts from the cron check.

What you can ask it: `/panel` shows buttons for everything; as commands they are `/status`,
`/digest` (this hour so far), `/report`, `/trades`, `/log`, `/settings`, `/pause` (no new
entries), `/resume`, `/stop` (kill switch: every position closed) and `/help`. The bot answers
within a few seconds. Only messages from `TELEGRAM_CHAT_ID` are answered; the `/` button in
Telegram shows the menu. Settings and keys cannot be changed from the chat.
`TELEGRAM_COMMANDS=false` turns this off.

### Jupiter (`JUPITER_API_KEY`), optional, live mode only

1. Sign in at [portal.jup.ag](https://portal.jup.ag) and create an API key on the Free plan,
   which allows 1 request/s and 60/min
   ([rate limits](https://developers.jup.ag/docs/portal/rate-limits)).
2. Paper mode never uses it. Live mode uses it only to swap tokens that have graduated off
   the bonding curve.

### PumpPortal (`PUMPPORTAL_API_KEY`): not needed, and it costs SOL

Since **May 1, 2026**, PumpPortal streams per-token trades (`subscribeTokenTrade`,
`subscribeAccountTrade`) only to an API key whose linked wallet holds at least 0.02 SOL. It
charges **0.01 SOL per 10,000 trades** ([PumpPortal data API](https://pumpportal.fun/data-api/real-time/)).
pump.fun handles over a million trades a day, so streaming every launch would cost about
1 SOL a day, far more than a $50 bankroll can carry.

So by default the bot does not use the paid stream (`PUMPPORTAL_TRADE_STREAM=off`):

- New launches still come from PumpPortal's free `subscribeNewToken` stream.
- Net inflow, price, curve progress and graduation come from the bonding-curve account on
  chain, read through Helius in batches of 100 for 1 credit.
- Buyer counts and holder concentration come from Helius DAS, only for tokens that already
  pass the age and inflow rules.

To pay for exact trade-by-trade fills on your open positions anyway:

1. Go to [pumpportal.fun/create-wallet](https://pumpportal.fun/create-wallet/). It creates a
   wallet and an API key together. Save the public key, the private key and the API key in a
   password manager.
2. Send at least 0.02 SOL plus your data budget to that wallet's public key.
3. In `.env`, set `PUMPPORTAL_API_KEY`, `PUMPPORTAL_TRADE_STREAM=positions` and a cap such
   as `PUMPPORTAL_DAILY_BUDGET_SOL=0.01`.

Treat this API key like a private key. PumpPortal's Lightning API can trade the linked
wallet's SOL with it, so keep only your data budget in that wallet.

### CryptoPanic (`CRYPTOPANIC_TOKEN`), optional, paid

CryptoPanic discontinued its free developer plan in early 2026. If you subscribe, the token
is under **Developers → API** on [cryptopanic.com](https://cryptopanic.com/developers/api/).
Without one, Hunter still gets the free Cointelegraph and CoinDesk RSS feeds.

### Live wallet (`WALLET_PRIVATE_KEY`): leave empty until you choose live mode

Live mode is locked behind `MODE=live`, `LIVE_CONFIRM=I_ACCEPT_LOSSES` and a wallet balance of
0.5 SOL or less, and this build only dry-runs it. When you get there, create a **new** wallet
used only by the bot. Never use your main wallet. Paste the base58 secret key, or the JSON
byte array from `solana-keygen`. The bot never logs it.

## Check your keys

```bash
python -m bot preflight            # every API reachable? every key valid? (free calls only)
python -m bot preflight --probe    # also records what the live APIs return (about 3 minutes)
```

Preflight never prints a key. It exits non-zero if a required check fails.
