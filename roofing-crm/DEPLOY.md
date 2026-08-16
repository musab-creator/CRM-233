# Deploying to Vercel

This app (the CRM, including the `/visualizer` shingle color tool) deploys as
its **own Vercel project on its own domain**. It is separate from the main
Diversity Roofing website — nothing here touches that site.

The one setting that matters: **Root Directory must be `roofing-crm`**, because
the Next.js app lives in a subfolder of this repo.

---

## Quickstart — get it live in about 5 minutes

1. <https://vercel.com/new> → import `musab-creator/CRM-233`.
2. **Root Directory** → *Edit* → `roofing-crm`. (Framework auto-detects as
   Next.js. Leave the build settings alone.)
3. Name it something clearly separate from the main site, e.g.
   `diversity-roofing-crm`.
4. Expand **Environment Variables** and add, before the first deploy:
   - Name `SITE_PASSWORD`, Value = whatever password the crew should type.
5. **Deploy.** You get a `*.vercel.app` URL.
6. **Settings → Git → Production Branch** →
   `claude/roof-color-visualizer-tool-ho37jc`, then **Deployments → Redeploy**.

   Step 6 is only needed while PR #2 is open: Vercel publishes `main` by
   default, and the visualizer is not on `main` yet. Once the PR merges, set
   Production Branch back to `main`.
7. Open the URL. The browser asks for a login — any username, the password from
   step 4. Then go to **Color Visualizer** in the sidebar.

Everything below is reference detail.

---

## Option A — Import the repo in the Vercel dashboard (recommended)

Two minutes, no secrets to manage, and you get automatic preview URLs for every
pull request.

1. Go to <https://vercel.com/new> and import `musab-creator/CRM-233`.
2. **Root Directory** → click *Edit* → choose `roofing-crm`.
   Framework preset should auto-detect as **Next.js**. Leave build and output
   settings alone.
3. Give the project a name that is clearly not the main site — e.g.
   `diversity-roofing-crm` or `roof-color-visualizer`.
4. Deploy. You get a `*.vercel.app` URL immediately.
5. Add the real domain: **Project → Settings → Domains → Add**, then create the
   DNS record Vercel shows you (a `CNAME` to `cname.vercel-dns.com` for a
   subdomain like `colors.diversity-roofing.com`, or the `A` record it gives you
   for an apex domain). Adding a **subdomain** does not affect the main site's
   DNS or its existing records.

### Which branch goes live

Vercel publishes the **production branch** (default: `main`) to the domain, and
gives every other branch a preview URL.

- The visualizer currently lives on `claude/roof-color-visualizer-tool-ho37jc`,
  so until that PR merges it will only have a *preview* URL.
- To put it on the domain before merging: **Settings → Git → Production Branch**
  and set it to that branch. Switch it back to `main` after the merge.

---

## Option B — Deploy from GitHub Actions

Use this if you'd rather deploy on demand from the Actions tab.

1. Create a token at <https://vercel.com/account/tokens>.
2. Create the Vercel project once (Option A steps 1–3) so it has an ID.
3. Add three repository secrets under **Settings → Secrets and variables →
   Actions**:
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID`

   The last two are in the project's **Settings → General**, or in
   `.vercel/project.json` after running `vercel link` locally.
4. **Actions → Deploy to Vercel → Run workflow**, and pick `preview` or
   `production`.

Without the secrets the workflow exits cleanly with a warning instead of failing.

---

## Environment variables

Set these in **Project → Settings → Environment Variables**.

| Variable | Needed? | What it does |
| --- | --- | --- |
| `SITE_PASSWORD` | Yes — set it | Puts the whole site behind a browser password prompt (any username + this password). The CRM has no login of its own, so without this anyone with the URL can read it. Unset = wide open. See `src/proxy.ts`. Changing it takes effect on the next deploy, so redeploy after editing. |
| `ANTHROPIC_API_KEY` | Only for `/api/policy-analyze` | Policy document analysis. |
| Twilio / SendGrid / DocuSign / CompanyCam keys | Only for those integrations | See the API routes under `src/app/api/`. Each route no-ops or errors without its keys — nothing sends by accident. |

## Images

The 21 shingle renders are served from the Higgsfield CDN and optimized by
Vercel's image pipeline (`images.remotePatterns` in `next.config.ts` allows that
host). This works as-is.

To stop depending on that CDN, vendor the renders into the repo:

```bash
cd roofing-crm
npm i -D sharp
npm run fetch:roof-images -- --rewrite
```

That downloads and downscales all 21 renders into `public/roof-colors/`, repoints
`src/lib/roof-colors.ts` at the local files, and then the `remotePatterns` entry
in `next.config.ts` can be removed.

## Troubleshooting

### The whole site 404s, homepage included

The build did not produce a Next.js app. Usually Root Directory was left at the
repo root, so Vercel looked at `CRM-233/` — which has no app in it — instead of
`CRM-233/roofing-crm/`.

There is now a `vercel.json` at the repo root that handles this case: it builds
the subfolder app from the root (`npm --prefix roofing-crm run build`, output at
`roofing-crm/.next`). So either configuration works —

- Root Directory = `roofing-crm` → Vercel reads `roofing-crm/vercel.json`
- Root Directory = repo root → Vercel reads the root `vercel.json`

— but the deploy that already failed will not fix itself. **Redeploy** after
pulling this commit.

If it still 404s, check **Deployments → the latest one → Building** log:

| What the log shows | What it means |
| --- | --- |
| "No Next.js version detected" | Root Directory is wrong and the root `vercel.json` was not picked up. Set Root Directory to `roofing-crm`. |
| Build succeeded, site still 404s | The domain is attached to a different project, or you are on a deleted deployment URL. Check **Settings → Domains**. |
| `404: NOT_FOUND / DEPLOYMENT_NOT_FOUND` in the browser | That is Vercel's own page, not the app's — nothing is deployed at that URL. |
| A styled 404 inside the CRM layout | The app *is* running; only the route is missing. See the branch note above. |

### /visualizer 404s but the rest of the CRM works

Production Branch is still `main`, which does not have the visualizer yet. See
step 6 of the quickstart.

## Checks before deploying

```bash
cd roofing-crm
npm ci
npm run build
```
