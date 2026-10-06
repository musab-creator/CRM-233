#!/usr/bin/env bash
# Update the bot on the server: pull the branch it already tracks, reinstall, restart the service.
#   deploy/update.sh            by hand, on the server
#   deploy/update.sh --force    reinstall and restart even when nothing new was pulled
# GitHub Actions can run it over SSH after every push (deploy/VPS.md, "Automatic updates").
# A deploy key locked to this script passes the workflow's "deploy <branch> <sha>" in
# SSH_ORIGINAL_COMMAND; a push to any branch other than the one checked out here is ignored.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
FORCE=0
want_branch=""
want_sha=""

if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  if [[ "$SSH_ORIGINAL_COMMAND" =~ ^deploy[[:space:]]+([A-Za-z0-9._/-]+)[[:space:]]+([0-9a-f]{7,40})$ ]]; then
    want_branch="${BASH_REMATCH[1]}"
    want_sha="${BASH_REMATCH[2]}"
  else
    echo "refused: this key only runs 'deploy <branch> <sha>'" >&2
    exit 2
  fi
else
  for arg in "$@"; do
    case "$arg" in
      --force) FORCE=1 ;;
      -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
      *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
    esac
  done
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ -n "$want_branch" ] && [ "$want_branch" != "$branch" ]; then
  echo "server tracks $branch; the push was to $want_branch: nothing to deploy"
  exit 0
fi

before="$(git rev-parse HEAD)"
git fetch --quiet origin "$branch"
# fast-forward only: a server with local commits or edits fails here instead of losing them
git merge --ff-only --quiet "origin/$branch"
after="$(git rev-parse HEAD)"
if [ -n "$want_sha" ] && [[ "$after" != "$want_sha"* ]]; then
  echo "note: HEAD is ${after:0:12}, the push was ${want_sha:0:12} (a newer push, or the branch moved)"
fi
if [ "$before" = "$after" ] && [ "$FORCE" = 0 ]; then
  echo "already at ${after:0:12} on $branch; nothing to do (--force reinstalls and restarts anyway)"
  exit 0
fi

echo "updating $branch: ${before:0:12} -> ${after:0:12}"
git log --oneline --no-decorate "$before..$after" | head -n 20
deploy/install.sh                       # venv, dependencies, tests
sudo -n systemctl restart meme-agents   # needs a passwordless sudo rule for this one command
sleep 5
echo "service: $(systemctl is-active meme-agents 2>/dev/null || echo unknown)"
.venv/bin/python -m bot status --check || true
echo "deployed ${after:0:12}"
