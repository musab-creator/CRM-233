# Global Claude tooling (works in every session, not just CRM)

Set up 2026-08-16. Four GitHub projects installed, verified, and wired for
cross-session use: [claude-code-best-practice](https://github.com/shanraisshan/claude-code-best-practice),
[blender-mcp](https://github.com/ahujasid/blender-mcp),
[ai-hedge-fund](https://github.com/virattt/ai-hedge-fund),
[Archon](https://github.com/coleam00/Archon).

## How availability actually works

A Claude session (chat or code) sees tools from four places:

| Layer | Where it lives | Reaches |
|---|---|---|
| Account skills | claude.ai → Settings → Capabilities → Skills | **Every** conversation + code session on your account |
| Environment setup script | claude.ai/code → Environments → Setup script | Every remote code session in that environment |
| User-level skills/tools | `~/.claude/skills`, `~/.local/bin` on a machine | Every project on that machine |
| Repo config | `.claude/skills/`, `.mcp.json` in a repo | Every session on that repo |

Anything installed only inside one remote session's container dies with it —
persistence requires one of the layers above.

## What is already done in this repo

- `.claude/skills/archon` + `.claude/skills/manage-run` — Archon's bundled
  skills (from `archon skill install`): delegate work to Archon workflows,
  inspect/approve/resume runs.
- `.claude/skills/claude-code-best-practices` — curated skill wrapping the
  best-practice guides (skills, subagents, commands, MCP, settings, memory,
  CLI flags, power-ups) from shanraisshan's repo (MIT).
- `.claude/skills/ai-hedge-fund-lab` — how to run `aihf` and the six
  architecture lessons worth reusing (educational only).
- `scripts/claude-env-setup.sh` — one idempotent bootstrap for all four
  tools. Verified end-to-end in a fresh remote container.

Any Claude Code session on this repo picks these up automatically.

## What only you can click (5 minutes total)

1. **Account-wide skills (every convo + every code session):**
   claude.ai → Settings → Capabilities → Skills → *Upload skill* → upload the
   four zips Claude sent in chat (`archon.zip`, `manage-run.zip`,
   `claude-code-best-practices.zip`, `ai-hedge-fund-lab.zip`).
2. **Every remote code session (all repos):** claude.ai/code → Environments →
   your environment → **Setup script** → paste the contents of
   `scripts/claude-env-setup.sh`.
3. **Blender control (your computer, where Blender runs):**
   - `uv tool install blender-mcp` (or rely on `uvx`)
   - `blender-mcp install-addon`, then in Blender: Edit → Preferences →
     Add-ons → enable *BlenderMCP*; sidebar (N) → BlenderMCP → *Connect*.
   - Register the MCP server for Claude Code: `claude mcp add --scope user blender -- uvx blender-mcp`
     — or for Claude Desktop add to `claude_desktop_config.json`:
     ```json
     {"mcpServers": {"blender": {"command": "uvx", "args": ["blender-mcp"]}}}
     ```
   Cloud sessions cannot reach a Blender running on your laptop; this pairing
   is local by design.
4. **ai-hedge-fund keys** (first `aihf` run prompts for them; saved to
   `~/.hedge-fund/.env`): a financialdatasets.ai key + one LLM key
   (Anthropic/OpenAI/Google/DeepSeek/xAI/Kimi). Educational only — not
   investment advice, makes no real trades.

## Verification record (this session, fresh container)

- **blender-mcp**: installed via uv; MCP `initialize` handshake over stdio
  returned `serverInfo: BlenderMCP 1.29.0`. (No Blender in a headless
  container, so scene commands were not exercisable — that half runs on your
  machine.)
- **ai-hedge-fund**: `poetry install` clean; `aihf --help` works; full test
  suite **175 passed, 38 skipped** (skips are API-key-gated), 9.4s.
- **Archon**: `bun install` (2607 packages); CLI runs from source
  (sqlite backend); `workflow list` shows bundled workflows;
  `skill install` produced the two skills now committed here. This session's
  harness live-loaded all four skills after install — trigger mechanism
  confirmed working.
- **claude-code-best-practice**: content repo (no build); guides packaged
  into the `claude-code-best-practices` skill.
- **Account skills check**: `ListSkills` returned ~50 enabled skills — these
  are account-scoped and load in every conversation automatically. Skills are
  *invoked* per-conversation when relevant (by description triggers or
  `/name`), which is by design, not a per-conversation enablement limit.
