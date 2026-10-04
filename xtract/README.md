# Xtract Roof Reports

Order-by-address aerial roof measurement reports. A customer enters an
address, pays, and an **8-page roof report is generated and emailed
automatically** — no one touches the order.

```
order form ─▶ Stripe Checkout ─▶ webhook (checkout.session.completed)
                                     │
                                     ▼  runOrder()  (src/lib/pipeline.ts)
   geocode ─▶ roof geometry ─▶ measure ─▶ parcel record ─▶ 8-page PDF ─▶ email
```

The customer watches each step live on `/order/<id>`, then gets the PDF, a
quantity CSV, an interactive 3D model, diagrams and a live satellite map on the
same page. If the address can't be matched or imagery is poor, the order goes
to **needs review** (operator emailed) instead of sending a bad report.

## The report (matches the reference Diversity Roofing format)

1. **Cover** — aerial image with capture date, totals, roof-age sentence
2. **Diagram** — every facet to scale
3. **Lengths** — color-coded eaves, valleys, hips, ridges, rakes, wall & step flashing, transitions, parapet, unspecified (ft-in)
4. **Area** — per-facet areas, pitched / flat / predominant-pitch area
5. **Pitch & direction** — pitch and downslope arrow per facet
6. **Summary** — all totals, area & squares by pitch, waste table with recommendation
7. **Permit history & roof age** — year built and parcel from the Florida DOR parcel roll; permits stated as not checked unless entered
8. **Material calculations** — IKO, CertainTeed, GAF, Owens Corning, Atlas: shingles, starter, ice & water, synthetic, capping at 0% / 10% / recommended / 15%, plus valley metal and drip edge

Anything the source can't see is printed as **"not measured"**, never 0.

## Measurement engines

| Source | When | Module |
|---|---|---|
| Professional roof model (plan outlines + pitch per facet) | Sample property, or any model you import | `src/lib/polygon.ts` — exact geometry: shared edges classified as ridge / hip / valley / transition from slope directions; stacked roofs split into eave/rake + flashing |
| Google Solar API roof planes | Live orders with `GOOGLE_MAPS_API_KEY` | `src/lib/measure.ts` — plane width/run from bounding boxes, neighbour classification |
| Synthetic demo roofs | No Google key | `src/lib/solar.ts` |
| Manual quantities | Signed-in "manual report" | `measureManual()` — summary, permit & materials pages |

All share `summarize()` → waste table, pitch table, materials.

**Validation** (`npm test`, and live on `/quality`):

- Engine vs. the professional report for 3436 State Rd 13 N: area 8,151 vs 8,150 sq ft, 35/35 facets, 5/12, 14% waste — exact; total linear feet within 6%.
- Material calculator reproduces all 24 brand quantities of the reference report (1912 Grove Bluff Rd) exactly.
- Exact eaves / ridges / hips / valleys / transitions on hand-built gable, hip, porch and cross-gable roofs.

## Run it

```bash
cd xtract
npm install
npm run dev        # http://localhost:3001
npm test           # measurement + materials tests
```

With no environment variables it runs in **demo mode**: no payment, synthetic
roofs (except the sample address, which uses the real model), PDF downloaded
from the order page, sign-in link shown on screen. Copy `.env.example` to
`.env.local` to go live — each integration switches on independently.

| Integration | Env | Without it |
|---|---|---|
| Stripe Checkout | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Orders skip payment |
| Google Geocoding + Solar + Static Maps | `GOOGLE_MAPS_API_KEY` | Synthetic demo roof |
| SMTP email (reports, sign-in links, support) | `SMTP_*`, `XTRACT_OPS_EMAIL` | Download-only; sign-in needs `XTRACT_DEMO_LOGIN=1` |
| Sessions | `XTRACT_SECRET` | Random secret stored in the data dir |
| Admin page | `XTRACT_ADMIN_KEY` | `/admin` disabled |

Test Stripe locally with `stripe listen --forward-to localhost:3001/api/webhooks/stripe`.

## Pricing

Per report, by the report's position in the account's calendar month:
reports 1–24 **$12**, 25–99 **$10**, 100+ **$8** (`src/lib/config.ts`). Manual
reports are free. The rate is shown on the order form and charged at checkout.

## Site map

| Route | Purpose |
|---|---|
| `/` | Home: live 3D roof, real report pages, satellite map, accuracy, pricing calculator |
| `/sample` | All 8 sample pages, 3D model, diagrams, map |
| `/pricing`, `/quality`, `/contact`, `/privacy`, `/terms` | Info pages (`/quality` shows the live validation table) |
| `/order` → `/order/[id]` | Order, live tracking, then the full report view |
| `/signin`, `/dashboard` | Passwordless sign-in, saved reports, manual reports, branding |
| `/admin?key=` | All orders, re-run failed ones |

API: `POST /api/orders`, `POST /api/webhooks/stripe`, `GET|PATCH|DELETE /api/reports/[id]`,
`GET /api/reports/[id]/csv`, `GET /api/reports/[id]/model`, `POST /api/reports/[id]/photo`,
`POST /api/reports/manual`, `GET /api/sample`, `POST /api/auth/request`, `GET /api/auth/verify`.

Reports are visible only to the ordering account or with the private link token
from the delivery email; all writes check same-origin.

## Hosting note

Orders, users and files are stored on disk (`XTRACT_DATA_DIR`, default
`./.data`). That works on a single server (Replit, a VPS, `next start`). On
serverless hosts with an ephemeral filesystem, mount a volume or replace
`src/lib/store.ts` with a database + object storage. The pipeline runs via
Next's `after()` with `maxDuration = 60`.
