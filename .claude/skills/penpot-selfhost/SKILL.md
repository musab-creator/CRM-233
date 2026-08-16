---
name: penpot-selfhost
description: Self-host and operate Penpot (penpot/penpot), the open-source Figma-style design platform — docker compose setup, ports, accounts, backups, MCP server. Use when the user wants to run Penpot, set up a design tool for the team, troubleshoot a Penpot instance, or export/import Penpot files.
---

# Penpot (self-hosted design platform)

Source: [penpot/penpot](https://github.com/penpot/penpot) (MPL-2.0). Figma-alternative: UI design, prototyping, SVG-native, multiplayer. Self-host with Docker, or skip hosting entirely with the free SaaS at design.penpot.app.

## Quickstart (any machine with Docker)

```bash
git clone --depth 1 https://github.com/penpot/penpot
cd penpot/docker/images
docker compose -p penpot -f docker-compose.yaml up -d
# UI → http://localhost:9001
```

The stack (compose v2.16): `penpot-frontend` (:9001→8080), `penpot-backend`, `penpot-exporter`, `postgres:15`, `valkey` (redis), `mailcatcher` (:1080 — emails land here in dev, so registration "verification" mails are read there), and `penpotapp/mcp` — Penpot ships its own MCP server image for AI-driven design access.

## Operating it

- First user: register in the UI; confirmation email appears in mailcatcher at `http://localhost:1080`. To skip email entirely add `disable-email-verification` to `PENPOT_FLAGS` in the compose file.
- Data lives in the `penpot_postgres_v15` and `penpot_assets` volumes — back up with `docker compose -p penpot exec penpot-postgres pg_dump -U penpot penpot > backup.sql` plus an assets volume copy.
- Upgrade: `docker compose pull && docker compose -p penpot up -d`.
- Real deployment: put it behind TLS (the compose file has a commented Traefik example) and set `PENPOT_PUBLIC_URI`.

## Sandbox finding (2026-08-16)

Docker daemon runs in the Claude cloud container, and registry metadata resolves, but image blob downloads (`production.cloudfront.docker.com`) are proxy-blocked — so the stack can't pull there. The compose config validates; run it on a machine/VPS with normal egress. For quick design work without hosting, design.penpot.app is the zero-setup path.
