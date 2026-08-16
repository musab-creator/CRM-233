# Diversity Roofing — social media automation

Five n8n workflows that run the company's Facebook page, Instagram account and
Google Business Profile, wired into the CRM in `roofing-crm/`.

| # | Workflow | Trigger | What it does |
|---|---|---|---|
| 01 | [Content Calendar Publisher](workflows/01-content-calendar-publisher.json) | Mon/Wed/Fri 9am ET, or called by 02 | Pulls due posts from the CRM, writes a caption per platform, runs the compliance gate, publishes to all three networks |
| 02 | [Job Completion Showcase](workflows/02-job-completion-showcase.json) | Webhook from the CRM | Turns a job closeout and its before/after photos into a post and hands it to 01 |
| 03 | [Google Review Manager](workflows/03-review-manager.json) | Every 2 hours | Replies to 4–5 star reviews, escalates everything else to a human |
| 04 | [Social Lead Capture](workflows/04-social-lead-capture.json) | Meta webhook | Classifies inbound comments and DMs, creates CRM leads, emails the team |
| 05 | [Weekly Report & Token Health](workflows/05-weekly-report.json) | Mondays 7am ET | Emails last week's numbers and warns before the Facebook token expires |

---

## The one thing to understand before touching this

**Nothing publishes without passing the Florida compliance gate**, and the gate
lives in the CRM, not in n8n:

```
n8n  ──POST /api/social/compliance-check──▶  roofing-crm
                                              src/lib/social/compliance.ts
```

One copy of the rules, one place to change them, and the CRM records why a post
was held. The gate **fails closed** — if the CRM is unreachable, returns a 500,
or returns anything other than `pass`, the post does not go out and the team is
emailed. A missed post costs one late post; a wrong one costs up to **$10,000
per violation** under Fla. Stat. 489.147.

What the gate enforces, from `roofing-crm/BUSINESS_FACTS.md`:

- **License number in all advertising** (FL Admin Code 61G4-12.011). If
  `DR_LICENSE_NUMBER` is unset, *every post is blocked*. Where it appears is
  configurable — see [Where the license number goes](#where-the-license-number-goes).
- **The three Fla. Stat. 489.147 disclosures** on anything mentioning insurance
  claims, appended verbatim, and the post is then held for a human by default.
- **No deductible language** — waive, cover, absorb, handle, rebate, "zero out
  of pocket", "free roof". All hard blocks.
- **No inducements** — gift cards, cash, rebates in exchange for an inspection.
- **Scope of practice** — Diversity Roofing documents damage and meets the
  adjuster on the roof. Copy implying it negotiates, settles, interprets policy,
  or guarantees an outcome is blocked.

The rules have an executable spec. Run it after any edit:

```bash
cd roofing-crm && npm run check:compliance
```

### Where the license number goes

Florida requires the contractor license number in advertising, but it does not
have to be stapled to the end of every caption. Two settings:

| `DR_LICENSE_PLACEMENT` | Effect |
|---|---|
| `caption` (default) | Appended to every post. The unambiguous reading of the rule. |
| `profile` | Carried in the Facebook **About** section, the Instagram **bio** and the Google Business Profile **description** instead. Routine captions stay clean. |

`profile` has two guards, both deliberate:

1. **It requires `DR_LICENSE_IN_PROFILES=true`** — your attestation that the
   number is genuinely in all three bios. Without it the gate falls back to
   appending, because a typo in a config value must not quietly turn a year of
   posts into unlicensed advertising.
2. **Claim-topic posts carry the number inline anyway.** Those are the posts a
   regulator reads first, and they already carry the 489.147 block, so one more
   line costs nothing.

Under `profile`, every post carries a `LICENSE_IN_PROFILE` advisory in its
findings. That is the audit trail: if someone later edits a bio and drops the
number, the posts published in between are the exposure. **Turn the attestation
off before editing a profile bio, not after.**

This is a judgement call about what counts as compliant advertising, and it is
the licence holder's to make — the code just makes both options explicit and
refuses to guess.

### A limit worth knowing

Fla. Stat. 489.147 also sets a **minimum font size** for the disclosures (≥12pt
and ≥half the largest font on the page). Text appended to a caption satisfies the
wording, not the typography, and nothing here can inspect text baked into an
image. Any graphic that mentions claims still needs a human to confirm the
disclosures are on it and legible. That is why claim-topic posts default to
`needs_review` rather than auto-publishing.

---

## Setup

### 1. The CRM side

```bash
cd roofing-crm
cp .env.example .env.local
```

Fill in at minimum:

```
SOCIAL_AUTOMATION_KEY=<openssl rand -hex 32>
DR_LICENSE_NUMBER=<the FL contractor licence number>
```

Then `npm run dev`. Sanity-check the gate before wiring anything up:

```bash
curl -s localhost:3000/api/social/compliance-check \
  -H 'content-type: application/json' \
  -H "x-automation-key: $SOCIAL_AUTOMATION_KEY" \
  -d '{"platform":"facebook","caption":"We waive your deductible!","hasImage":true}' | jq .status
# "blocked"
```

### 2. n8n

```bash
cd automation/n8n
cp .env.example .env      # then fill it in
docker compose up -d
```

Open `http://localhost:5678` and import each file in `workflows/`
(**Workflows → Import from File**). They are also mounted read-only inside the
container at `/workflows`.

Three things are deliberately *not* in the exported JSON and must be set after
import — `npm run check:workflows` lists them:

1. **SMTP credential.** Create one n8n SMTP credential named
   `Diversity Roofing SMTP`, then re-select it on every `Send Email` node
   (they carry the placeholder `REPLACE_WITH_SMTP_CREDENTIAL_ID`).
2. **Workflow 01's ID** in workflow 02's `Run Publisher Now` node.
3. **Activate** each workflow. Imported workflows arrive inactive.

### 3. Facebook and Instagram

Both are one Graph API. The Instagram account must be a Business or Creator
account **linked to the Facebook Page** — a personal IG account cannot publish
through the API at all.

In [developers.facebook.com](https://developers.facebook.com): create an app,
add **Facebook Login for Business** and the **Instagram Graph API** products,
then generate a token with these permissions:

```
pages_manage_posts        pages_read_engagement     pages_manage_engagement
instagram_basic           instagram_content_publish instagram_manage_comments
business_management
```

> **Use a System User token.** Business Manager → Business Settings → System
> Users → Add → assign the Page → Generate New Token → set the expiry to
> *Never*. A normal user token dies after 60 days and posting stops with no
> error anywhere you'd look. Workflow 05 checks the expiry weekly as a backstop
> either way.

Get the IDs:

```bash
# Page ID and the linked Instagram Business account ID, in one call
curl -s "https://graph.facebook.com/v23.0/me/accounts?fields=id,name,instagram_business_account&access_token=$TOKEN" | jq
```

Then subscribe the webhook for workflow 04: **App → Webhooks → Page**, callback
`https://<your-n8n-host>/webhook/dr-meta-events`, verify token = your
`META_VERIFY_TOKEN`, subscribed to `feed` and `messages`. Repeat under
**Instagram** for `comments` and `messages`. n8n must be publicly reachable over
HTTPS for this — use a tunnel in development.

### 4. Google Business Profile

In [Google Cloud Console](https://console.cloud.google.com): enable the
**Business Profile API**, **My Business Account Management API** and
**Business Profile Performance API**, then create an OAuth 2.0 Web client with
scope `https://www.googleapis.com/auth/business.manage`.

Get a refresh token once (`access_type=offline&prompt=consent`), then find the
numeric IDs — `.env` wants the digits only, not the `accounts/` prefix:

```bash
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  https://mybusinessaccountmanagement.googleapis.com/v1/accounts | jq '.accounts[].name'

curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/$ACCOUNT_ID/locations?readMask=name,title" | jq
```

> Local posts and review replies still live on the **v4** API
> (`mybusiness.googleapis.com/v4/...`). The newer split APIs do not cover them,
> which is why the workflows mix hostnames.

### 5. Wire the CRM's job closeout to workflow 02

Signed with the same shared secret:

```bash
BODY='{"jobId":"job-1042","city":"Orange Park","roofType":"architectural shingle",
"damageCause":"wind","crewDays":1,"customerConsented":true,
"photos":{"before":["https://.../before.jpg"],"after":["https://.../after.jpg"]}}'

curl -X POST "$N8N_URL/webhook/dr-job-completed" \
  -H 'content-type: application/json' \
  -H "X-DR-Signature: $(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$CRM_AUTOMATION_KEY" -hex | awk '{print $2}')" \
  -d "$BODY"
```

`customerConsented: true` is mandatory. No homeowner's roof goes on social
without it, and the workflow rejects the payload outright if it is missing.

---

## How it fits together

```
                       ┌──────────────────────────────┐
   schedule ──────────▶│  01 Content Calendar         │
   02 (job closeout) ─▶│  Publisher                   │
                       └───┬──────────────────────────┘
                           │ 1. GET  /api/social/queue          (brief + prompt)
                           │ 2. POST api.anthropic.com          (caption)
                           │ 3. POST /api/social/compliance-check ◀── the gate
                           │ 4. publish ─▶ Facebook / Instagram / Google
                           │ 5. POST /api/social/publish-result
                           ▼
                        roofing-crm
                           ▲
   Meta webhook ─▶ 04 ─────┤ POST /api/social/leads
   every 2h ─────▶ 03 ─────┤ POST /api/social/reviews
   Mondays ──────▶ 05 ─────┘ GET  /api/social/queue?all=true
```

**Workflow 01 is the only place that talks to a platform publishing API.**
Producers (02, and anything added later) enqueue content and call it. That is
why 02 is nine nodes instead of thirty.

### CRM endpoints

| Endpoint | Used by | Purpose |
|---|---|---|
| `GET /api/social/queue` | 01, 05 | Due posts, expanded per platform, with the caption prompt built |
| `POST /api/social/queue` | 02, CRM UI | Enqueue a post |
| `POST /api/social/compliance-check` | 01 | The gate |
| `POST /api/social/publish-result` | 01 | Record what actually went out |
| `POST /api/social/leads` | 04 | Inbound comment/DM |
| `POST /api/social/reviews` | 03 | Review + reply history |

All authenticate with `x-automation-key`.

---

## Design decisions worth knowing about

**Nothing replies publicly on its own.** Workflow 04 classifies inbound comments
and drafts a reply, then emails it to a person. A public comment thread under a
roofing post is exactly where a homeowner asks about their deductible, and a
wrong sentence there is a compliance problem with an audience. Classification is
automated; the reply is not.

**Reviews at 3 stars or below never get an automated reply.** They are escalated
and emailed. An unhappy customer is a phone call, not a template. A drafted reply
that mentions insurance is also escalated rather than posted — the 489.147
disclosures do not belong in a two-sentence thank-you, so the reply doesn't
belong to a robot.

**The caption prompt lives in the CRM** (`src/lib/social/prompt.ts`), not in the
workflows. Brand voice and the legal rules are edited in one file rather than
five JSON blobs.

**Claude is called over raw HTTP** with structured outputs, so the workflows
parse a schema-validated object rather than scraping prose. The Code nodes
handle the three real failure modes — a safety refusal (`stop_reason:
"refusal"`, HTTP 200), a truncated response (`max_tokens`), and an API error —
and route all of them to a human instead of publishing something half-written.

---

## Running the checks

```bash
cd roofing-crm
npm run check:compliance   # 19 cases against the Florida rules
npm run check:workflows    # workflow JSON: dangling connections, unparseable
                           # Code nodes, undocumented env vars
```

Both run in CI on every push.

---

## Known gaps

- **`DR_LICENSE_NUMBER` must be set locally on every host that runs this** — the
  CRM and n8n each read it from their own gitignored `.env`. It is deliberately
  not in any tracked file, and `BUSINESS_FACTS.md` still lists it as `[MISSING]`
  rather than recording the value.
- **Social leads do not reach the main lead pipeline.** They land in a separate
  inbox at `/api/social/leads`. The CRM's lead list is client-side Zustand state
  with no database behind it, so there is nowhere for a server route to write.
  This resolves itself when the CRM gets persistence.
- **Point n8n at a CRM you run as one long-lived process — not at the Vercel
  deployment.** The queue is in-memory, like the rest of the CRM's data layer.
  On a single `npm start` that just means a restart resets it to the seed
  calendar in `src/lib/social/queue.ts`, which is survivable. On Vercel it is
  worse than that: serverless invocations do not share memory, so a post
  enqueued on one instance is invisible to the next request, and `claim=true`
  cannot stop a double-publish because the two polls may not be talking to the
  same process. The compliance gate is unaffected — it is a pure function of
  its input and works correctly anywhere — but the queue needs real storage
  before anything but a single persistent process can serve it.

- **Set `SOCIAL_AUTOMATION_KEY` on every deployment**, not just locally. Without
  it the automation routes return `503` in production rather than running
  unauthenticated; that is a safe failure, not a working one.
- **No UI yet.** Queued posts, held posts and reviews are readable over the API
  but do not appear on the Marketing page. That is the obvious next piece.
- **Statutes change.** The deadlines and disclosure text encoded here were taken
  from `BUSINESS_FACTS.md`. Re-verify them against the current statute before
  relying on this in production.
