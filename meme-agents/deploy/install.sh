#!/usr/bin/env bash
# Set up meme-agents on a Debian/Ubuntu VPS. Safe to run again, for example after `git pull`.
#   deploy/install.sh              virtualenv, dependencies, .env from the template, tests
#   deploy/install.sh --systemd    also install and enable the systemd service (uses sudo)
#   deploy/install.sh --cron       also add the 5-minute health check to your crontab
#   deploy/install.sh --ops        also install the ops service behind Telegram /update /restart /set
#                                  (works while the bot runs: then only that service is installed)
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON:-}"
VENV_DIR="${MEME_AGENTS_VENV_DIR:-$APP_DIR/.venv}"
SYSTEMD=0
CRON=0
OPS=0
UNITS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --systemd) SYSTEMD=1 ;;
    --cron) CRON=1 ;;
    --ops) OPS=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done
cd "$APP_DIR"
# update.sh builds an isolated environment first; a direct reinstall must not change a running bot.
if [ -z "${MEME_AGENTS_VENV_DIR:-}" ] && command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet meme-agents; then
  if [ "$OPS" = 1 ] && [ "$SYSTEMD" = 0 ] && [ "$CRON" = 0 ]; then
    UNITS_ONLY=1
    echo "meme-agents is running: installing only the ops service (the bot and its environment are left alone)"
  else
    echo "meme-agents is running: use bash deploy/update.sh, or stop the service before reinstalling." >&2
    exit 1
  fi
fi
if [ "$UNITS_ONLY" = 0 ]; then

if [ -z "$PY" ]; then  # the first Python that is 3.12 or newer
  for c in python3.12 python3.13 python3.14 python3; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
      PY="$c"
      break
    fi
  done
fi
if [ -z "$PY" ]; then
  echo "Python 3.12 or newer not found." >&2
  os="$( (. /etc/os-release 2>/dev/null && echo "${ID:-}:${VERSION_ID:-}") || true)"
  case "$os" in
    ubuntu:24.*|ubuntu:2[5-9].*)   # 24.04 and 24.10 both package python3.12
      echo "Install it with: sudo apt install -y python3.12 python3.12-venv" >&2 ;;
    ubuntu:22.04)
      echo "Ubuntu 22.04 ships Python 3.10. Add 3.12 from the deadsnakes PPA, then run this again:" >&2
      echo "  sudo apt install -y software-properties-common" >&2
      echo "  sudo add-apt-repository -y ppa:deadsnakes/ppa" >&2
      echo "  sudo apt update && sudo apt install -y python3.12 python3.12-venv" >&2 ;;
    *)
      echo "This system (${os:-unknown}) has no Python 3.12 package. Easiest: reinstall the server as" >&2
      echo "Ubuntu 24.04, or install Python 3.12+ yourself and run: PYTHON=/path/to/python3 bash deploy/install.sh" >&2 ;;
  esac
  exit 1
fi
if ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
  echo "PYTHON must point to Python 3.12 or newer." >&2
  exit 1
fi
if [ ! -x "$VENV_DIR/bin/python" ] && ! "$PY" -m venv "$VENV_DIR"; then
  echo "could not create the virtualenv. On Ubuntu/Debian: sudo apt install $(basename "$PY")-venv" >&2
  rm -rf "$VENV_DIR"
  exit 1
fi
if ! "$VENV_DIR/bin/python" -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
  echo "existing virtualenv uses an older Python; recreate it with Python 3.12 or newer." >&2
  exit 1
fi
"$VENV_DIR/bin/python" -m pip install --quiet --upgrade pip
"$VENV_DIR/bin/python" -m pip install --quiet -r requirements.txt
mkdir -p data logs reports
if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example: add your keys (KEYS.md says where to get each one)"
fi
chmod 600 .env
"$VENV_DIR/bin/python" -m pytest -q
fi

if [ "$SYSTEMD" = 1 ]; then
  unit=/etc/systemd/system/meme-agents.service
  sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@USER@|$(id -un)|g" deploy/meme-agents.service | sudo tee "$unit" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable meme-agents >/dev/null
  echo "installed $unit (enabled at boot). Start it with: sudo systemctl start meme-agents"
fi

if [ "$OPS" = 1 ]; then
  # The companion behind Telegram /update, /restart, /set and /dryrun (bot/ops.py). It restarts
  # the bot with `sudo -n systemctl restart meme-agents`: the sudoers line in deploy/VPS.md.
  unit=/etc/systemd/system/meme-agents-ops.service
  sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@USER@|$(id -un)|g" deploy/meme-agents-ops.service | sudo tee "$unit" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable meme-agents-ops >/dev/null
  sudo systemctl restart meme-agents-ops
  echo "installed $unit (running, enabled at boot): Telegram /update, /restart, /set and /dryrun now reach this server"
  if ! sudo -n systemctl --version >/dev/null 2>&1; then
    echo "note: restarts from the phone need the sudoers line from deploy/VPS.md, 'Control from your phone'"
  fi
fi

if [ "$CRON" = 1 ]; then
  chmod +x deploy/healthcheck.sh
  entry="*/5 * * * * $APP_DIR/deploy/healthcheck.sh >/dev/null 2>&1 # meme-agents healthcheck"
  current="$(crontab -l 2>/dev/null || true)"
  { printf '%s\n' "$current" | grep -v -e '# meme-agents healthcheck' -e '^$' || true; echo "$entry"; } | crontab -
  echo "health check added to crontab (every 5 minutes, results in logs/health.log)"
fi

if [ "$UNITS_ONLY" = 0 ]; then
  echo
  echo "next: put your keys in .env, then run: .venv/bin/python -m bot preflight"
fi
