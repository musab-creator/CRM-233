# Xtract Roof Reports

Order-by-address aerial roof measurement reports. A customer enters an
address, pays, and the report is **generated and emailed automatically** —
no one touches the order.

```
order form ─▶ Stripe Checkout ─▶ webhook (checkout.session.completed)
                                     │
                                     ▼  runOrder()  (src/lib/pipeline.ts)
   geocode address ─▶ Google Solar API roof planes ─▶ measureRoof()
        ─▶ renderReportPdf() ─▶ save PDF ─▶ email PDF + download link
```

The customer watches each step live on `/order/<id>`. If the address can't
be matched or imagery is poor, the order goes to **needs review** (operator is
emailed) instead of sending a bad report.

## Run it

```bash
cd xtract
npm install
npm run dev        # http://localhost:3001
```

With no environment variables it runs in **demo mode**: no payment is taken,
roofs are generated synthetically per address, and the PDF is downloaded from
the order page. Copy `.env.example` to `.env.local` and fill in keys to go live
— each integration switches on independently.

| Integration | Env | Without it |
|---|---|---|
| Stripe Checkout | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Orders skip payment |
| Google Geocoding + Solar + Static Maps | `GOOGLE_MAPS_API_KEY` | Synthetic demo roof |
| SMTP email | `SMTP_*` | Report is download-only |
| Admin page | `XTRACT_ADMIN_KEY` | `/admin` disabled |

Test Stripe locally with `stripe listen --forward-to localhost:3001/api/webhooks/stripe`.

## What's measured vs estimated

- **From imagery (Solar API):** sloped area, footprint, pitch and azimuth of
  every roof plane → roof area, squares, facets, pitch breakdown, waste table.
- **Derived (labelled as estimates in the PDF):** each plane's width and run
  are solved from its bounding box; neighbouring planes are classified as
  ridge / hip / valley pairs → eaves, rakes, ridges, hips, valleys, drip edge,
  starter, ridge cap, materials. Step flashing is not measured.

`npm test` checks the engine against hand-built gable, hip and L-shaped roofs
with known dimensions.

## Report tiers

Prices live in `src/lib/config.ts` (single source for site, checkout and PDF).

| Tier | Price | Pages |
|---|---|---|
| Quick Measure | $12 | Overview, Summary (area, pitch, waste table) |
| Full Report | $19 | + Lengths, Pitch & Area diagrams, Materials |
| Claims Pro | $29 | + Aerial imagery page, facet table, squares by pitch |

## Routes

| Route | Purpose |
|---|---|
| `/` | Marketing site with live sample-roof diagrams |
| `/order` | Order form |
| `/order/[id]?t=` | Live order status + download |
| `/admin?key=` | Order list, re-run failed orders |
| `POST /api/orders` | Create order → Stripe URL (or start demo run) |
| `POST /api/webhooks/stripe` | Payment confirmed → run pipeline |
| `GET /api/reports/[id]?t=` | PDF download (token-protected) |
| `GET /api/sample?tier=` | Sample PDF from the same renderer |

## Hosting note

Orders and PDFs are stored on disk (`XTRACT_DATA_DIR`, default `./.data`).
That works on a single server (Replit, a VPS, `next start`). On serverless
hosts with an ephemeral filesystem, mount a volume or replace
`src/lib/store.ts` with a database + object storage. The pipeline runs via
Next's `after()` with `maxDuration = 60`.
