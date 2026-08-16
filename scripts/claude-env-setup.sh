#!/usr/bin/env bash
# Global Claude tooling bootstrap — safe to run on any machine or as the
# "setup script" of a Claude Code web environment (claude.ai/code →
# Environments → your environment → Setup script). Idempotent; re-runs fast.
#
# Installs, for EVERY session in the environment (not one repo):
#   1. shanraisshan/claude-code-best-practice  → reference clone + user-level skill
#   2. ahujasid/blender-mcp                    → MCP server tool (Blender itself must
#                                                run on the machine with a GUI)
#   3. virattt/ai-hedge-fund                   → aihf CLI (educational)
#   4. coleam00/Archon                         → CLI + user-level Claude skills
#
# User-level skills land in ~/.claude/skills, which Claude Code loads for
# every project on this machine/environment.

set -uo pipefail   # no -e: one tool failing shouldn't kill the rest

TOOLS_DIR="${CLAUDE_TOOLS_DIR:-$HOME/claude-tools}"
SKILLS_DIR="$HOME/.claude/skills"
mkdir -p "$TOOLS_DIR" "$SKILLS_DIR"

log() { printf '\n==> %s\n' "$*"; }

clone_or_update() { # clone_or_update <url> <dir>
    if [ -d "$2/.git" ]; then
        git -C "$2" pull --ff-only 2>/dev/null || true
    else
        GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 "$1" "$2" || return 1
    fi
}

# --- prerequisites ---------------------------------------------------------
if ! command -v uv >/dev/null 2>&1; then
    log "installing uv"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi
if ! command -v bun >/dev/null 2>&1; then
    log "installing bun"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi

# --- 1. claude-code-best-practice ------------------------------------------
log "claude-code-best-practice"
clone_or_update https://github.com/shanraisshan/claude-code-best-practice \
    "$TOOLS_DIR/claude-code-best-practice"
# user-level skill: curated guides available in every session
if [ -d "$TOOLS_DIR/claude-code-best-practice/best-practice" ]; then
    mkdir -p "$SKILLS_DIR/claude-code-best-practices/references"
    cp "$TOOLS_DIR/claude-code-best-practice/best-practice/"*.md \
       "$SKILLS_DIR/claude-code-best-practices/references/" 2>/dev/null || true
fi

# --- 2. blender-mcp --------------------------------------------------------
log "blender-mcp"
clone_or_update https://github.com/ahujasid/blender-mcp "$TOOLS_DIR/blender-mcp"
uv tool install --force blender-mcp >/dev/null 2>&1 \
    && echo "blender-mcp CLI: $(command -v blender-mcp || echo "$HOME/.local/bin/blender-mcp")" \
    || echo "warn: blender-mcp tool install failed (PyPI unreachable?)"
# NOTE: controlling Blender needs Blender + the addon on a GUI machine:
#   blender-mcp install-addon        (then enable BlenderMCP in Blender prefs)
# Claude Code MCP registration (run once per machine where Blender lives):
#   claude mcp add --scope user blender -- uvx blender-mcp

# --- 3. ai-hedge-fund ------------------------------------------------------
log "ai-hedge-fund (educational only — not investment advice)"
clone_or_update https://github.com/virattt/ai-hedge-fund "$TOOLS_DIR/ai-hedge-fund"
uv tool install --force aihf >/dev/null 2>&1 \
    && echo "aihf CLI: $(command -v aihf || echo "$HOME/.local/bin/aihf")" \
    || echo "warn: aihf tool install failed"
# keys live in ~/.hedge-fund/.env (FINANCIAL_DATASETS_API_KEY + one LLM key)

# --- 4. Archon --------------------------------------------------------------
log "Archon"
clone_or_update https://github.com/coleam00/Archon "$TOOLS_DIR/archon"
if [ -d "$TOOLS_DIR/archon" ]; then
    (cd "$TOOLS_DIR/archon" && bun install --silent 2>/dev/null || bun install)
    # install archon + manage-run skills at USER level → every project
    (cd "$TOOLS_DIR/archon" && bun run cli -- skill install "$HOME" >/dev/null 2>&1) \
        && echo "Archon skills installed into $SKILLS_DIR" \
        || echo "warn: archon skill install failed"
    # convenience launcher
    mkdir -p "$HOME/.local/bin"
    printf '#!/usr/bin/env bash\nexec bun --cwd "%s/packages/cli" src/cli.ts "$@"\n' \
        "$TOOLS_DIR/archon" > "$HOME/.local/bin/archon"
    chmod +x "$HOME/.local/bin/archon"
fi

# --- 5. media & automation CLIs (fast installs, on by default) --------------
log "yt-dlp"
clone_or_update https://github.com/yt-dlp/yt-dlp "$TOOLS_DIR/yt-dlp"
uv tool install --force yt-dlp >/dev/null 2>&1 \
    && echo "yt-dlp: $($HOME/.local/bin/yt-dlp --version 2>/dev/null || echo installed)" \
    || echo "warn: yt-dlp install failed"
command -v ffmpeg >/dev/null 2>&1 || echo "note: install ffmpeg for merging/conversion (apt-get install -y ffmpeg)"

log "n8n"
clone_or_update https://github.com/n8n-io/n8n "$TOOLS_DIR/n8n"
if command -v npm >/dev/null 2>&1; then
    npm install -g n8n >/dev/null 2>&1 \
        && echo "n8n: $(n8n --version 2>/dev/null | tail -1)" \
        || echo "warn: n8n npm install failed"
    # IPv6-less containers need: N8N_LISTEN_ADDRESS=127.0.0.1 n8n start
fi

log "penpot (clone only; stack runs via docker on a machine with open egress)"
clone_or_update https://github.com/penpot/penpot "$TOOLS_DIR/penpot"
echo "start with: cd $TOOLS_DIR/penpot/docker/images && docker compose -p penpot up -d  (UI :9001)"

# --- 6. heavy ML tools (torch + model weights) — opt-in ---------------------
# Set CLAUDE_SETUP_HEAVY=1 to install whisper (pulls torch, ~2 GB) and
# Fooocus python deps. Model weights additionally need open egress to
# openaipublic.azureedge.net / huggingface.co (blocked in some sandboxes).
if [ "${CLAUDE_SETUP_HEAVY:-0}" = "1" ]; then
    log "whisper (heavy)"
    clone_or_update https://github.com/openai/whisper "$TOOLS_DIR/whisper"
    uv tool install --force openai-whisper >/dev/null 2>&1 \
        && echo "whisper: $($HOME/.local/bin/whisper --help >/dev/null 2>&1 && echo ok)" \
        || echo "warn: whisper install failed"

    log "Fooocus (heavy; GPU strongly recommended to actually generate)"
    clone_or_update https://github.com/lllyasviel/Fooocus "$TOOLS_DIR/fooocus"
    (cd "$TOOLS_DIR/fooocus" && uv venv .venv >/dev/null 2>&1 && \
        VIRTUAL_ENV="$PWD/.venv" uv pip install -r requirements_versions.txt >/dev/null 2>&1) \
        && echo "Fooocus deps ready: $TOOLS_DIR/fooocus (.venv/bin/python launch.py)" \
        || echo "warn: Fooocus dep install failed"
else
    log "skipping heavy ML tools (whisper, Fooocus) — set CLAUDE_SETUP_HEAVY=1 to include"
fi

log "done"
echo "repos:   $TOOLS_DIR"
echo "skills:  $SKILLS_DIR ($(ls "$SKILLS_DIR" 2>/dev/null | tr '\n' ' '))"
echo "restart Claude Code (or start the session) to load user-level skills"
