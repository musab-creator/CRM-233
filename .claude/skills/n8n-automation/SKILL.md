---
name: n8n-automation
description: Run and build automations with n8n (n8n-io/n8n) — self-hosted workflow automation with 400+ integrations. Use when the user wants to automate a business process (leads, invoices, email, CRM sync, webhooks, scheduled jobs), run n8n locally or on a server, or import/export n8n workflow JSON. Fits Diversity Roofing workflows: lead intake → CRM, invoice reminders, photo uploads → job folders.
---

# n8n (workflow automation)

Source: [n8n-io/n8n](https://github.com/n8n-io/n8n) (Sustainable Use License — free to self-host for internal business use; don't resell it as a service). Node-based automation: triggers (webhook, cron, app events) → transforms → actions across 400+ apps, with built-in AI nodes.

## Run it (verified v2.34.6)

```bash
npm install -g n8n         # or: npx n8n / docker run -it --rm -p 5678:5678 n8nio/n8n
n8n start                  # UI + API → http://localhost:5678  (healthz: /healthz)
```

- If it dies with `address '::' is not available` (IPv6-less containers): set `N8N_LISTEN_ADDRESS=127.0.0.1` (or `0.0.0.0` for LAN).
- Data (SQLite DB, encryption key) lives in `~/.n8n` — back that folder up; the encryption key is unrecoverable.
- Useful env: `N8N_PORT`, `N8N_SECURE_COOKIE=false` for plain-HTTP LAN use, `WEBHOOK_URL=https://your-domain` behind a reverse proxy.
- Production: run behind TLS with Postgres (`DB_TYPE=postgresdb ...`) instead of SQLite.

## Workflow craft

- Export/import workflows as JSON: `n8n export:workflow --all --output=backup/` and `n8n import:workflow --input=file.json` — keep them in git.
- Webhook trigger pattern: Webhook node (POST) → validate/branch (IF) → act (HTTP Request / app node) → respond. Test URLs are per-execution in the editor; production URLs activate with the workflow.
- Credentials are stored encrypted in n8n, referenced by nodes — never hardcode secrets in nodes or exported JSON.
- Roofing-CRM starters: (1) web-form lead webhook → dedupe → CRM + SMS notify; (2) cron weekly → query unpaid invoices → email past-due letters; (3) inbound email attachment → save to job folder → notify crew chat.

## Sandbox finding (2026-08-16)

Verified in the Claude cloud container: npm global install works, server boots with `N8N_LISTEN_ADDRESS=127.0.0.1`, `/healthz` returns `{"status":"ok"}`, UI serves HTTP 200. External integrations from that sandbox are proxy-limited — build/test workflows locally or on a server.
