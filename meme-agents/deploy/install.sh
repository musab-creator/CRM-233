#!/usr/bin/env bash
# Set up meme-agents on a Debian/Ubuntu VPS. Safe to run again, for example after `git pull`.
#   deploy/install.sh              virtualenv, dependencies, .env from the template, tests
#   deploy/install.sh --systemd    also install and enable the systemd service (uses sudo)
#   deploy/install.sh --cron       also add the 5-minute health check to your crontab
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON:-python3.12}"
SYSTEMD=0
CRON=0
for arg in "$@"; do
  case "$arg" in
    --systemd) SYSTEMD=1 ;;
    --cron) CRON=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done
cd "$APP_DIR"

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "$PY not found. On Ubuntu 24.04: sudo apt install python3.12 python3.12-venv" >&2
  exit 1
fi
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt
mkdir -p data logs reports
if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example: add your keys (KEYS.md says where to get each one)"
fi
chmod 600 .env
.venv/bin/python -m pytest -q

if [ "$SYSTEMD" = 1 ]; then
  unit=/etc/systemd/system/meme-agents.service
  sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@USER@|$(id -un)|g" deploy/meme-agents.service | sudo tee "$unit" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable meme-agents >/dev/null
  echo "installed $unit (enabled at boot). Start it with: sudo systemctl start meme-agents"
fi

if [ "$CRON" = 1 ]; then
  chmod +x deploy/healthcheck.sh
  entry="*/5 * * * * $APP_DIR/deploy/healthcheck.sh >/dev/null 2>&1 # meme-agents healthcheck"
  current="$(crontab -l 2>/dev/null || true)"
  { printf '%s\n' "$current" | grep -v -e '# meme-agents healthcheck' -e '^$' || true; echo "$entry"; } | crontab -
  echo "health check added to crontab (every 5 minutes, results in logs/health.log)"
fi

echo
echo "next: put your keys in .env, then run: .venv/bin/python -m bot preflight"
