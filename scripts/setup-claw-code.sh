#!/usr/bin/env bash
# Set up claw-code (https://github.com/ultraworkers/claw-code) on a dev machine
# or remote session: clone, build from source, and run the health check.
#
# Usage:
#   ./scripts/setup-claw-code.sh [TARGET_DIR]
#
# TARGET_DIR defaults to ./claw-code (created if missing). Requires the Rust
# toolchain (rustc + cargo); everything else is handled by the repo's own
# install.sh.

set -euo pipefail

REPO_URL="https://github.com/ultraworkers/claw-code"
TARGET_DIR="${1:-claw-code}"

if ! command -v cargo >/dev/null 2>&1; then
    echo "error: cargo not found. Install Rust first: https://rustup.rs" >&2
    exit 1
fi

if [ -d "${TARGET_DIR}/.git" ]; then
    echo "==> Using existing clone at ${TARGET_DIR}"
else
    echo "==> Cloning ${REPO_URL} into ${TARGET_DIR}"
    GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 "${REPO_URL}" "${TARGET_DIR}"
fi

echo "==> Building via the repo installer (debug profile)"
(cd "${TARGET_DIR}" && ./install.sh)

CLAW_BIN="${TARGET_DIR}/rust/target/debug/claw"

echo "==> Running health check"
"${CLAW_BIN}" doctor || true

cat <<EOF

claw is built at: ${CLAW_BIN}

Next steps:
  ${CLAW_BIN}                 # interactive REPL (run /doctor first)
  ${CLAW_BIN} prompt "hi"     # one-shot prompt
  export ANTHROPIC_API_KEY=…  # required for real API calls

Known gotcha on containers whose /bin/sh is dash: claw's bash tool runs
commands with 'sh -lc', so anything /etc/profile.d prints (e.g. nvm's stray
"nvm" line under dash) leaks into tool stdout and can break exact-output
assertions in the mock parity test suite. See docs/claw-code.md.
EOF
