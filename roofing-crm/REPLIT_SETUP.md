# Running StormShield Roofing CRM on Replit

Everything is pre-configured. The app runs with **zero setup** — all
integrations return realistic mock data until you plug in real API keys.

---

## Option A — Import from GitHub (recommended)

1. Go to [replit.com](https://replit.com) → **Create Repl** → **Import from GitHub**
2. Paste the repo URL and pick the `roofing-crm` folder as the root
3. Replit reads `.replit` + `replit.nix` and sets everything up
4. Press **Run**

First boot installs dependencies and takes 1–2 minutes. After that it's instant.

## Option B — Upload a ZIP

1. **Create Repl** → **Node.js** → name it
2. Delete the starter `index.js`
3. Drag the contents of the `roofing-crm` folder into the file tree
   (make sure `.replit` and `replit.nix` come along — they're hidden files,
   so enable "Show hidden files" in the file panel if you don't see them)
4. Press **Run**

> Upload the **contents** of `roofing-crm`, not the folder itself.
> `package.json` must sit at the repl's root or the Run button won't find it.

---

## What the Run button does

`.replit` defines two workflows:

| Workflow | What it does | Use it for |
|---|---|---|
| **Dev Server** (default) | `npm install` → `npm run dev` | Day-to-day work. Hot reload on save. |
| **Production Build** | `npm install` → `npm run build` → `npm run start` | Checking real production performance before deploying. |

Switch between them from the dropdown next to the Run button.

---

## Adding your real API keys

Use **Tools → Secrets** in the Replit sidebar (the padlock icon). Do **not**
create a `.env` file — Replit Secrets are encrypted and won't leak into git.

Add keys one at a time using the names in `.env.example`. Each integration
switches from mock to live independently, so you can start with just email
and add the rest later.

Suggested order — cheapest and most useful first:

1. **SMTP** — turns on real adjuster follow-up emails
2. **Twilio** — turns on homeowner text messages
3. **CompanyCam** — pulls in real inspection photos
4. **DocuSign** — real e-signatures on contingencies
5. **HailTrace** — real address-level storm history

After adding secrets, hit **Stop** then **Run** so the new values load.

---

## Deploying (making it public)

1. Click **Deploy** in the top right
2. Choose **Autoscale** (already set as the target in `.replit`)
3. Build command and run command are pre-filled from `.replit` — leave them
4. Deploy

Add your production secrets under the deployment's own Secrets tab —
deployments do **not** inherit secrets from the development repl.

Once live, set `NEXT_PUBLIC_APP_URL` to your real deployment URL so DocuSign
callbacks and emailed links point to the right place.

---

## Troubleshooting

**Blank page or "connection refused"**
Next.js must bind to `0.0.0.0`, not localhost. This is already handled in
`package.json`, so if you edited the `dev` or `start` scripts, restore the
`-H 0.0.0.0 -p ${PORT:-3000}` flags.

**"Cannot find module" after import**
Dependencies didn't finish installing. Open the Shell tab and run `npm install`.

**Port already in use**
Stop the repl, wait five seconds, and press Run again. Replit sometimes holds
the old process briefly.

**Changes not appearing**
Hard refresh the preview pane (Ctrl/Cmd + Shift + R). If that fails, stop and
re-run — the Next.js dev cache occasionally goes stale in the Replit webview.

**Slow first load**
Normal. The free tier sleeps idle repls; the first request wakes it. Paid
plans ("Always On") remove this.
