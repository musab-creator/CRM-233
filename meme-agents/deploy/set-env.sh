#!/usr/bin/env bash
# Change non-secret settings, for example:
#   bash deploy/set-env.sh HELIUS_MONTHLY_CREDITS=200000000 HELIUS_RPC_RPS=200
# Replaces duplicate keys and writes .env in place (see the note below). Use nano .env for credentials: command
# arguments can appear in process listings and shell history. Restart afterwards.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
[ -f "$ENV_FILE" ] || { echo ".env not found: run deploy/install.sh first" >&2; exit 1; }
[ $# -gt 0 ] || { sed -n '2,5p' "$0"; exit 2; }
PY="$APP_DIR/.venv/bin/python"; [ -x "$PY" ] || PY=python3
"$PY" - "$ENV_FILE" "$@" <<'PY'
import os
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
updates = {}
for argument in sys.argv[2:]:
    key, separator, value = argument.partition("=")
    if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
        sys.exit("bad setting argument: use KEY=VALUE with an uppercase key")
    if "\n" in value or "\r" in value:
        sys.exit(f"{key}: multiline values are not supported")
    updates[key] = value

lines = path.read_text(encoding="utf-8").splitlines()
seen = set()
result = []
for line in lines:
    match = re.match(r"\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=", line)
    key = match.group(1) if match else None
    if key not in updates:
        result.append(line)
        continue
    if key in seen:
        continue
    seen.add(key)
    # Preserve the explanation as a separate comment so quoted values stay unambiguous.
    old_value = line[match.end():].strip()
    if old_value.startswith(('"', "'")):
        comment_text = old_value[old_value.rfind(old_value[0]) + 1:]
    else:
        comment_text = old_value
    comment = re.search(r"\s+#.*$", comment_text)
    if comment:
        result.append(comment.group(0).strip())
    result.append(f'{key}="{updates[key]}"')
for key, value in updates.items():
    if key not in seen:
        result.append(f'{key}="{value}"')

# Write into the existing file rather than renaming a new one over it: the running bot's
# unit keeps .env read-only with a bind mount on this very inode, and a rename would detach
# that mount (Linux renames over mountpoints since 3.18), leaving .env writable inside the
# sandbox until the next restart. The ops service keeps a copy in data/ops/env.backup.
data = ("\n".join(result) + "\n").encode("utf-8")
fd = os.open(path, os.O_WRONLY)
try:
    os.fchmod(fd, 0o600)
    os.ftruncate(fd, 0)
    os.write(fd, data)
    os.fsync(fd)
finally:
    os.close(fd)
for key in updates:
    print(f"updated {key}")
PY
printf '%s\n' "apply with: sudo systemctl restart meme-agents"
