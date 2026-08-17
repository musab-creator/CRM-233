# CRM-233

The application lives in [`roofing-crm/`](./roofing-crm) — see its
[README](./roofing-crm/README.md) to run it.

---

## Chrome DevTools MCP

[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) is
Google's MCP server that gives a coding agent control of a live Chrome browser:
it can open pages, click through flows, read the console, inspect network
requests, and record performance traces. For this repo that means an agent can
drive the CRM at http://localhost:3000 and see the result of its changes
instead of inferring it from code.

It is configured repo-wide in [`.mcp.json`](./.mcp.json), so **Claude Code
picks it up automatically** when you open this repo — approve the server when
prompted and you're done. There is nothing to install by hand: `npx` downloads
the package on first use (currently v1.7.0) and caches it. Other MCP clients
(Cursor, Gemini CLI, Codex, …) use the same command:

```bash
npx -y chrome-devtools-mcp@latest
```

Worth knowing before you use it:

- **Requirements:** Node 20.19+ (or 22.12+) and a Chrome install. CI and
  `replit.nix` already run Node 20.
- **It opens a real browser window** with a persistent profile by default. Add
  `--headless` and `--isolated` to the args in `.mcp.json` for a throwaway
  headless browser (containers, CI), and `--executablePath <path>` when Chrome
  lives somewhere non-standard. Run
  `npx chrome-devtools-mcp@latest --help` for the full flag list.
- **Don't log into anything sensitive in the browser it controls.** The agent
  sees everything the page shows.

---

## Optional: claude-mem

[claude-mem](https://github.com/thedotmack/claude-mem) persists Claude Code's
context across sessions. It is **optional and per-developer** — it touches no
application code, and there is nothing about it checked into this repo.

```bash
npx claude-mem install
```

Then restart Claude Code so the plugin's hooks load. Memory injection begins on
your *second* session in a project.

Worth knowing before you run it:

- **It is user-scoped, not repo-scoped.** It installs into `~/.claude/plugins`
  and stores everything in `~/.claude-mem` on your own machine. There is no
  project-level config to commit and no shared team state — each developer
  installs it for themselves or doesn't.
- **It needs a background worker.** The installer starts one when it can;
  otherwise run `npx claude-mem start`. The UI is at http://127.0.0.1:37700.
- **A `tree-sitter` ERESOLVE warning during install is expected.** The installer
  retries with `--legacy-peer-deps` and reports the conflict as benign.

Because it is machine-local, installing it inside an ephemeral environment
(a cloud dev container, CI) has no lasting effect — install it on the machine
you actually work from.
