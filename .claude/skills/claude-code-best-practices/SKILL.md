---
name: claude-code-best-practices
description: Best practices for configuring and using Claude Code — skills, subagents, commands, hooks, MCP servers, settings, memory/CLAUDE.md, CLI flags, and power-ups. Use when setting up a repo for Claude Code, writing or reviewing .claude/ configuration (SKILL.md, agents, commands, settings.json, .mcp.json), tuning permissions, or answering "how should I structure/configure Claude Code" questions.
---

# Claude Code Best Practices

Curated from [shanraisshan/claude-code-best-practice](https://github.com/shanraisshan/claude-code-best-practice) (MIT, © 2025-2026 Shayan Rais). Read the matching reference before advising on or writing Claude Code configuration:

| Topic | Reference |
|---|---|
| Skills (`SKILL.md` frontmatter, triggering, agent-preloaded vs invoked) | `references/claude-skills.md` |
| Subagents (`.claude/agents/*.md`) | `references/claude-subagents.md` |
| Slash commands (`.claude/commands/*.md`) | `references/claude-commands.md` |
| MCP servers (`.mcp.json`, scopes) | `references/claude-mcp.md` |
| Settings & permissions (`.claude/settings.json`) | `references/claude-settings.md` |
| Memory (`CLAUDE.md`, rules, auto memory) | `references/claude-memory.md` |
| CLI startup flags | `references/claude-cli-startup-flags.md` |
| Power-ups | `references/claude-power-ups.md` |

## Core principles (summary)

1. **CLAUDE.md is for what Claude can't infer**: build/test commands, project conventions, warnings. Keep it short; link out for detail.
2. **Skills** encode repeatable procedures. Frontmatter `description` decides auto-triggering — write it as "Use when…" with concrete trigger phrases. One skill = one job.
3. **Subagents** isolate context-heavy work (search, review). Give each a tight tool allowlist and a clear return contract.
4. **Commands** are user-initiated entry points; keep orchestration in the command, work in agents/skills (Command → Agent → Skill).
5. **Permissions**: prefer allowlisting specific safe commands in `settings.json` over broad modes; keep dangerous flags out of shared config.
6. **MCP**: project-scope `.mcp.json` for team-shared servers; user scope for personal ones. Never commit secrets — use env expansion.
7. **Iterate with evidence**: when config misbehaves, reproduce with `--debug`, fix the config, and re-test rather than piling on instructions.
