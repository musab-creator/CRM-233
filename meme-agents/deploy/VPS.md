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
runs the tests, which should all pass. It is safe to run again at any time.

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
  without PowerShell. Changing a setting or a key still happens here, in `.env`.

## 9. Watch it

```bash
.venv/bin/python -m bot status     # what it is doing right now
.venv/bin/python -m bot report     # results so far (also written to reports/)
journalctl -u meme-agents -f       # the live log; Ctrl+C stops watching, not the bot
```

## Automatic updates from GitHub

`.github/workflows/meme-agents-deploy.yml` can update the server for you after every push to
the branch it tracks. The workflow runs the unit tests on GitHub first, then connects to the
server over SSH and runs `deploy/update.sh` there, which pulls, reinstalls and restarts the
service. It needs five repository secrets (GitHub → the repo → **Settings** → **Secrets and
variables** → **Actions**): `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `VPS_KNOWN_HOSTS` and
`VPS_SSH_KEY`. On the server side, the deploy key must be limited to `deploy/update.sh` and the
bot user needs a passwordless sudo rule for the one command `systemctl restart meme-agents`.
Until the secrets exist the workflow does nothing, and `deploy/update.sh` works by hand:

```bash
deploy/update.sh            # pull, reinstall, restart (does nothing when already up to date)
deploy/update.sh --force    # reinstall and restart anyway
```

It only ever fast-forwards: a server with local edits or commits stops with an error instead
of losing them.

## Everyday commands

Run these from `~/CRM-233/meme-agents`.

| What | Command |
|---|---|
| Stop the bot | `sudo systemctl stop meme-agents` |
| Start it | `sudo systemctl start meme-agents` |
| Is it running? | `sudo systemctl status meme-agents` |
| Kill switch: no new entries, close all positions | `touch STOP`. Remove it (`rm STOP`) to resume entries. |
| Update to the latest code | `deploy/update.sh` (pull, reinstall, restart) |
| Change a setting without nano | `deploy/set-env.sh KEY=VALUE` (several at once is fine), then restart |
| Health in one line | `.venv/bin/python -m bot status --check` |

Don't also run `python -m bot` by hand while the service runs: the bot refuses to start a
second copy on the same database, because two bots would trade the same bankroll.
