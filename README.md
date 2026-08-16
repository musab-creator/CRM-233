# CRM-233

The application lives in [`roofing-crm/`](./roofing-crm) — see its
[README](./roofing-crm/README.md) to run it.

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
