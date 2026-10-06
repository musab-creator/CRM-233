#!/usr/bin/env bash
# Health check for cron: appends one line to logs/health.log and sends a Telegram message
# (if configured in .env) when the state changes between OK, PAUSED, DOWN and BLIND.
#   */5 * * * * /path/to/meme-agents/deploy/healthcheck.sh
# deploy/install.sh --cron adds that line for you. Exit code 1 means down or blind.
set -uo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR" || exit 1
mkdir -p logs
line="$("$APP_DIR/.venv/bin/python" -m bot status --check --alert 2>&1 | tail -n 1)"
code=$?  # with pipefail, python's exit code
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $line" >> logs/health.log
exit "$code"
