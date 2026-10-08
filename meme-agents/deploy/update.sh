#!/usr/bin/env bash
# Validate an update in an isolated checkout/environment, then stop, promote and restart.
#   bash deploy/update.sh          update the checked-out branch
#   bash deploy/update.sh --force  rebuild even when the branch is already current
# A forced SSH deploy key accepts only: deploy <branch> <sha>.
# MEME_AGENTS_NONINTERACTIVE=1 (the ops service behind Telegram /update) never waits for a password.
# .env, STOP, data, logs and reports stay in place. Failed activation restores code/deps.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
FORCE=0
want_branch=""
want_sha=""
SUDO=(sudo)
[ "${MEME_AGENTS_NONINTERACTIVE:-0}" != 1 ] || SUDO=(sudo -n)
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  SUDO=(sudo -n)
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
      -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
      *) echo "unknown option (see --help)" >&2; exit 2 ;;
    esac
  done
fi
TOP="$(git rev-parse --show-toplevel)"
GIT_DIR="$(git rev-parse --absolute-git-dir)"
APP_REL="${APP_DIR#"$TOP"/}"
[ "$APP_DIR" != "$TOP" ] || APP_REL=.
command -v flock >/dev/null || { echo "flock is required (Ubuntu: sudo apt install util-linux)" >&2; exit 2; }
exec 9>"$GIT_DIR/meme-agents-deploy.lock"
flock -n 9 || { echo "another deployment is running; try again after it finishes" >&2; exit 1; }
branch="$(git symbolic-ref --quiet --short HEAD)" || { echo "checkout is detached; switch to a branch first" >&2; exit 2; }
if [ -n "$want_branch" ] && [ "$want_branch" != "$branch" ]; then
  echo "server tracks $branch; the push was to $want_branch: nothing to deploy"
  exit 0
fi
git diff --quiet && git diff --cached --quiet || { echo "tracked files have local edits; commit or restore them first" >&2; exit 1; }
before="$(git rev-parse HEAD)"
git fetch --quiet origin "$branch"
after="$(git rev-parse "origin/$branch")"
git merge-base --is-ancestor "$before" "$after" || { echo "refused: update is not a fast-forward; local commits are preserved" >&2; exit 1; }
if [ -n "$want_sha" ] && [[ "$after" != "$want_sha"* ]]; then
  echo "note: branch HEAD is ${after:0:12}; push was ${want_sha:0:12}"
fi
if [ "$before" = "$after" ] && [ "$FORCE" = 0 ]; then
  echo "already at ${after:0:12} on $branch; nothing to do (--force rebuilds)"
  exit 0
fi
# Never promote a commit containing local secrets or mutable state.
protected_files="$(git -C "$TOP" ls-tree -r --name-only "$after" -- "$APP_REL/.env" "$APP_REL/STOP" "$APP_REL/.venv" "$APP_REL/data" "$APP_REL/logs")"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    */.gitkeep|.gitkeep) ;;
    *) echo "refused: commit tracks protected runtime file $file" >&2; exit 1 ;;
  esac
done <<< "$protected_files"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/meme-agents-stage.XXXXXXXX")"
CANDIDATE_VENV="$(mktemp -d "$APP_DIR/.venv-deploy.XXXXXXXX")"
BACKUP_VENV="$APP_DIR/.venv-before.$(basename "$CANDIDATE_VENV")"
SERVICE_STOPPED=0
VENV_SWAPPED=0
PROMOTED=0
KEEP_CANDIDATE=0
cleanup() {
  git worktree remove --force "$STAGE" >/dev/null 2>&1 || rm -rf "$STAGE"
  [ "$KEEP_CANDIDATE" = 1 ] || rm -rf "$CANDIDATE_VENV"
}
rollback() {
  code=$?
  trap - ERR
  set +e
  echo "deployment failed; restoring the previous code and environment" >&2
  restore_failed=0
  if [ "$PROMOTED" = 1 ]; then
    git reset --merge "$before" || restore_failed=1
  fi
  if [ "$VENV_SWAPPED" = 1 ]; then
    rm -f "$APP_DIR/.venv" || restore_failed=1
    if [ -e "$BACKUP_VENV" ] || [ -L "$BACKUP_VENV" ]; then
      mv "$BACKUP_VENV" "$APP_DIR/.venv" || restore_failed=1
    fi
  fi
  if [ "$restore_failed" = 1 ]; then
    echo "rollback incomplete; service remains stopped. Inspect code and environment before starting" >&2
  elif [ "$SERVICE_STOPPED" = 1 ]; then
    "${SUDO[@]}" systemctl start meme-agents || echo "previous service could not start; inspect journalctl -u meme-agents" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap rollback ERR
git worktree add --quiet --detach "$STAGE" "$after"
echo "validating $branch: ${before:0:12} -> ${after:0:12}"
git log --oneline --no-decorate --max-count=20 "$before..$after"
MEME_AGENTS_VENV_DIR="$CANDIDATE_VENV" bash "$STAGE/$APP_REL/deploy/install.sh"
[ -x "$CANDIDATE_VENV/bin/python" ] || { echo "candidate installation did not produce a Python environment" >&2; false; }
# Recheck after tests: preserve operator edits made while staging.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "local edits appeared during validation; deployment stopped without overwriting them" >&2
  false
fi
was_active=0
if systemctl is-active --quiet meme-agents; then
  was_active=1
  "${SUDO[@]}" systemctl stop meme-agents
  SERVICE_STOPPED=1
fi
echo "updating $branch: ${before:0:12} -> ${after:0:12}"
if [ -e "$APP_DIR/.venv" ] || [ -L "$APP_DIR/.venv" ]; then
  mv "$APP_DIR/.venv" "$BACKUP_VENV"
fi
VENV_SWAPPED=1
ln -s "$CANDIDATE_VENV" "$APP_DIR/.venv"
git merge --ff-only --quiet "$after"
PROMOTED=1
if [ "$was_active" = 1 ]; then
  "${SUDO[@]}" systemctl restart meme-agents
  sleep 5
  systemctl is-active --quiet meme-agents
  .venv/bin/python -m bot status --check
  echo "service: active"
else
  echo "service was stopped; left stopped (start it when ready)"
fi
KEEP_CANDIDATE=1
if [ -L "$BACKUP_VENV" ]; then
  old_target="$(readlink "$BACKUP_VENV")"
  rm "$BACKUP_VENV"
  case "$old_target" in "$APP_DIR"/.venv-deploy.*) rm -rf "$old_target" ;; esac
elif [ -d "$BACKUP_VENV" ]; then
  rm -rf "$BACKUP_VENV"
fi
trap - ERR
echo "deployed ${after:0:12}"
