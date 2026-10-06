#!/usr/bin/env bash
# Change settings in meme-agents/.env without opening an editor, for example:
#   deploy/set-env.sh HELIUS_MONTHLY_CREDITS=200000000 HELIUS_RPC_RPS=200
# Each KEY=VALUE replaces that key's line (keeping its trailing comment) or is appended if the
# key is missing. Values are never printed. For secret keys, start the command with a space so
# it stays out of your shell history, or use nano. Restart the bot afterwards.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
[ -f "$ENV_FILE" ] || { echo ".env not found: run deploy/install.sh first" >&2; exit 1; }
[ $# -gt 0 ] || { sed -n '2,6p' "$0"; exit 2; }
PY="$APP_DIR/.venv/bin/python"; [ -x "$PY" ] || PY=python3
for kv in "$@"; do
  case "$kv" in
    [A-Z]*=*) ;;
    *) echo "bad argument: '$kv' (use KEY=VALUE)" >&2; exit 2 ;;
  esac
done
"$PY" - "$ENV_FILE" "$@" <<'EOF'
import re, sys
path, *pairs = sys.argv[1:]
lines = open(path, encoding="utf-8").read().split("\n")
for kv in pairs:
    key, val = kv.split("=", 1)
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
        sys.exit(f"bad key: {key}")
    for i, line in enumerate(lines):
        if line.startswith(key + "="):
            m = re.search(r"\s+#.*$", line[len(key) + 1:])  # keep an inline comment
            lines[i] = f"{key}={val}" + (m.group(0) if m else "")
            print(f"updated {key}")
            break
    else:
        if lines and lines[-1] == "":
            lines.insert(len(lines) - 1, f"{key}={val}")
        else:
            lines.append(f"{key}={val}")
        print(f"added {key}")
open(path, "w", encoding="utf-8").write("\n".join(lines))
EOF
chmod 600 "$ENV_FILE"
echo "apply with: sudo systemctl restart meme-agents"
