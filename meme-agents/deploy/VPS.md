# Running meme-agents on your VPS

Step by step on a fresh server, copy and paste. Ubuntu 24.04 is the easiest choice because it
ships with Python 3.12. 1 vCPU, 1 GB of RAM and a few GB of disk are enough. The bot opens no
ports and runs in **paper mode**: nothing here enables real trading.

## 1. Connect to the server

Your VPS provider's dashboard shows the server's **IP address** and the **root password**,
or lets you add an SSH key.

- **Windows:** open PowerShell and run `ssh root@YOUR_SERVER_IP`.
- **Mac or Linux:** open Terminal and run the same command.
- Type `yes` the first time, then the password. Nothing appears on screen while you type it;
  that is normal.
- You can also use the dashboard's "Console" or "Web terminal" button.

**Every command below runs on the server, not on your own computer.** Once you're
connected, the prompt changes from something like `PS C:\Users\you>` (Windows) to
`root@ubuntu:~#`. If you still see `PS C:\...`, you are not on the server yet: Windows
PowerShell rejects `&&` and has no `nano`.

## 2. Create a user for the bot (don't run it as root)

```bash
adduser bot             # choose a password; press Enter for the other questions
usermod -aG sudo bot
su - bot                # you are now "bot"; run every step below as this user
```

## 3. Install the basics and close the firewall

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git python3.12 python3.12-venv
sudo ufw allow OpenSSH && sudo ufw --force enable    # the bot needs no open ports
```

If apt says **`Unable to locate package python3.12`**, the server is not Ubuntu 24.04. Run
`cat /etc/os-release` to see which version it is.

- **Ubuntu 22.04:** add Python 3.12 from the deadsnakes PPA, then rerun the install line above:
  ```bash
  sudo apt install -y software-properties-common
  sudo add-apt-repository -y ppa:deadsnakes/ppa
  sudo apt update
  ```
- **Anything else:** reinstall the server as Ubuntu 24.04 from your provider's panel. On
  RackNerd, that is nerdvm.racknerd.com → your VPS → **Reinstall**.

Paste one line at a time. A command that asks questions, such as `adduser`, takes the next
pasted lines as its answers.

## 4. Get the code

```bash
git clone https://github.com/musab-creator/CRM-233.git
cd CRM-233
git checkout claude/solana-meme-trading-agents-lfzoer   # until PR #9 is merged, then use main
cd meme-agents
```

If git asks for a username and password, the repository is private:

- **Username:** your GitHub username.
- **Password:** a token, not your GitHub password. To make one, go to GitHub → **Settings**
  → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** →
  **Generate new token**:
  - **Repository access:** *Only select repositories*, then `CRM-233`.
  - **Permissions:** *Contents*, *Read-only*.
  - Generate it, copy it, and paste it as the password.

## 5. Install

```bash
bash deploy/install.sh
```

This creates `.venv`, installs the dependencies, creates `.env` (readable only by you) and
runs the tests, which should all pass. Stop the service before rerunning this installer;
use `bash deploy/update.sh` to update a running installation.

## 6. Put your keys in `.env`

```bash
nano .env
```

Find these two lines and paste each key straight after the `=`, with no quotes or spaces:

```
ANTHROPIC_API_KEY=sk-ant-...
HELIUS_API_KEY=...
```

For Telegram alerts, fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` too
([KEYS.md](../KEYS.md) shows how). Save with **Ctrl+O**, then **Enter**, and exit with
**Ctrl+X**.

## 7. Check everything

```bash
.venv/bin/python -m bot preflight
```

Every row marked *(required)* must say **PASS**. If one fails, the line says why, for
example a mistyped key.

## 8. Start it for good

```bash
deploy/install.sh --systemd --cron
sudo systemctl start meme-agents
```

The bot now:
- starts again after a reboot;
- restarts if it crashes or hangs;
- gets a health check every 5 minutes, with a Telegram message if it goes down (when
  Telegram is set up);
- with Telegram set up, also messages you on every entry and exit, sends an hourly digest of
  trades and open positions, and the daily summary at midnight UTC.
- gives you a control panel in the Telegram chat: `/panel` shows buttons for status, digest,
  report, trades, log, settings, pause, resume and stop, so you can run it from your phone
  without PowerShell. With the ops service from the next section, the panel also updates,
  restarts and changes bounded settings. Keys and the live-mode locks still change here, in `.env`.

## Control from your phone

The bot runs with its code and `.env` read-only and no privileges, so by itself it can only
read, pause and stop. A small companion service, running as the same user outside that
sandbox, carries out the rest. Install it once (this works while the bot is running):

```bash
bash deploy/install.sh --ops
```

Then let it restart the bot without a password. Run `sudo visudo -f /etc/sudoers.d/meme-agents-deploy`
and make sure this line is there (it is the same line the automatic GitHub deploy uses; replace
`bot` if your user is called something else, and confirm the path with `command -v systemctl`):

```sudoers
bot ALL=(root) NOPASSWD: /usr/bin/systemctl stop meme-agents, /usr/bin/systemctl restart meme-agents, /usr/bin/systemctl start meme-agents
```

If the repository is private and `git fetch` asks for a password, store the token once so
`/update` can fetch on its own:

```bash
git config credential.helper store && git fetch     # paste the token when asked; it is saved in ~/.git-credentials
```

Send `/ops` in the chat: the first line must say `ops service: running`. From then on:

| In the chat | What happens on the server |
|---|---|
| `/update` (or the Update button) | `bash deploy/update.sh`: fetches the branch the server tracks, builds and tests it in a separate environment (a few minutes), then restarts the bot. Nothing changes if the tests fail. The result, including "already on the latest code", comes back as a message. |
| `/restart` | `sudo -n systemctl restart meme-agents`. Open positions are kept and resumed. A daily-loss pause survives a restart from the phone; `/restart reset` is the one that ends it and starts a new loss window. |
| `/set KEY=VALUE` | `bash deploy/set-env.sh KEY=VALUE`, then a **Restart now** button (it asks to confirm) to apply it. `/set` alone lists every key you can change, its running value, its limits, and a value already waiting in `.env`; for example `POSITION_MAX_USD` 1 to 20, `BANKROLL_USD` 1 to 100, `LLM_DAILY_BUDGET_USD` 0 to 50, `CONSENSUS_MIN_MEAN_CONFIDENCE` 0.65 to 1. A value the bot's own rules reject (a minimum above its maximum) is refused before anything is written. |
| `/dryrun on` | Writes `LIVE_DRY_RUN=true` and restarts: live mode keeps running but sends nothing. One way only. It is refused while live positions are open, because after the restart they would be closed in paper with the tokens still in the wallet: `/stop`, wait until `/status` shows no open positions, then `/dryrun on`. `/dryrun on force` switches anyway. |
| `/ops` | Is the service running, what is queued, the last five results. |

What stays on the server, on purpose: `MODE`, `LIVE_CONFIRM`, `LIVE_MAX_WALLET_SOL`, every key
and token, the wallet, `TELEGRAM_CHAT_ID`, paths and URLs, and `LIVE_DRY_RUN=false`. Whoever
holds the phone can deploy tested code from GitHub, restart, pause and stop, and move the
operational numbers inside their limits; they cannot turn real sends on, raise the wallet cap
or read a key. The service checks every request again before acting, runs nothing but the
three commands above, and reports instead of re-running anything it finds half-done after its
own restart. Requests run one at a time, so one sent during an update waits for it; a request
the service only finds 10 minutes or more after it was made (it was not running) is refused.
Before a `/set` the service keeps a copy of `.env`; if the bot then refuses to start on the new
value, the copy is put back and the bot restarted again, so a setting can never lock the phone
out. Run the installer as the bot's own user: as root it would install the service as root,
and a `/set` would then leave `.env` unreadable for the bot.

```bash
sudo systemctl status meme-agents-ops     # is it running?
journalctl -u meme-agents-ops -f          # what it ran and what each run printed
.venv/bin/python -m bot ops               # the same as /ops, from the shell
```

After an `/update` that changed the code, the service exits and systemd starts it again on
the new version; `/ops` shows it running within a few seconds.

## 9. Watch it

```bash
.venv/bin/python -m bot status     # what it is doing right now
.venv/bin/python -m bot report     # results so far (also written to reports/)
journalctl -u meme-agents -f       # the live log; Ctrl+C stops watching, not the bot
```

## Automatic updates from GitHub

`.github/workflows/meme-agents-deploy.yml` can update the server after every push to the
branch it tracks (the test suite itself runs on every push in `ci.yml`). The workflow runs
the tests again, then connects over SSH and runs `deploy/update.sh`, which first builds and
tests the candidate code in a separate checkout and Python environment while the old bot
keeps running. Only then does it stop the service, promote the code and dependencies,
and restart. A failed restart or health check restores the previous code and environment.

Your `.env`, `STOP`, database, logs and reports stay in place. A service you intentionally
stopped stays stopped after an update. Code rollback does not undo database records or
schema migrations written by a newly started version: back up the database before updates
that change its schema.

For automatic deployment, add these repository secrets under GitHub → **Settings** →
**Secrets and variables** → **Actions**: `VPS_HOST`, `VPS_PORT`, `VPS_USER`,
`VPS_KNOWN_HOSTS` and `VPS_SSH_KEY`. The SSH key must have a forced command pointing to
this installation's `deploy/update.sh`; do not use a general login key. Obtain the host
key fingerprint from your VPS console and verify it before setting `VPS_KNOWN_HOSTS`.

The bot user needs passwordless permission only for these service commands, including
the stop/start needed during promotion and rollback. Run `sudo visudo -f
/etc/sudoers.d/meme-agents-deploy` and add the following (replace `bot` if needed, and
confirm the systemctl path with `command -v systemctl`):

```sudoers
bot ALL=(root) NOPASSWD: /usr/bin/systemctl stop meme-agents, /usr/bin/systemctl restart meme-agents, /usr/bin/systemctl start meme-agents
```

Without VPS secrets, GitHub still runs the tests but skips deployment. By hand:

```bash
bash deploy/update.sh            # validate, promote and restart if already running
bash deploy/update.sh --force    # rebuild even when the branch is already current
```

Updates are serialized and fast-forward only. Local tracked edits or commits are
preserved and stop deployment with an error. If the systemd template changes, stop the
service, run `bash deploy/install.sh --systemd`, then start it to install the new unit.

A daily-loss pause survives an unclean crash or watchdog restart. To deliberately reset
its baseline, stop the service cleanly and start it again.

## Everyday commands

Run these from `~/CRM-233/meme-agents`.

| What | Command |
|---|---|
| Stop the bot | `sudo systemctl stop meme-agents` |
| Start it | `sudo systemctl start meme-agents` |
| Is it running? | `sudo systemctl status meme-agents` |
| Kill switch: no new entries, close all positions | `touch STOP`. Remove it (`rm STOP`) to resume entries. |
| Update to the latest code | `bash deploy/update.sh` (validate, promote, restart if running) |
| Change a setting without nano | `bash deploy/set-env.sh KEY=VALUE` for non-secret settings, then restart; use `nano .env` for keys |
| The same from your phone | `/update`, `/restart`, `/set KEY=VALUE`, `/dryrun on`, `/ops` in the Telegram chat, once `bash deploy/install.sh --ops` has run (section above) |
| Health in one line | `.venv/bin/python -m bot status --check` |

Don't also run `python -m bot` by hand while the service runs: the bot refuses to start a
second copy on the same database, because two bots would trade the same bankroll.
