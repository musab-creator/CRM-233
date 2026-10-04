# StormShield Roofing CRM

A complete CRM for roofing contractors running both **insurance restoration**
(~80% of the business) and **retail** jobs.

Built with Next.js 16, React 19, TypeScript, Tailwind CSS v4, and Zustand.

---

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000

**Deploying to Replit?** See [REPLIT_SETUP.md](./REPLIT_SETUP.md) — the repo is
already configured, you just press Run.

---

## What's in it

| Module | What it does |
|---|---|
| **Dashboard** | Revenue, close rate, pipeline value, rep leaderboard, claim aging |
| **Leads** | Kanban pipeline with drag-and-drop; separate insurance and retail stages |
| **Policy Analyzer** | Drop in a homeowner's policy PDF → extracts ACV vs RCV, deductible, coverage dates, then recommends the best date of loss |
| **Contingency** | Generates a filled contingency from policy data after three rep questions, with an admin-use box, then sends for e-signature |
| **Claims** | Full claim lifecycle plus one-click follow-up emails to adjusters |
| **Inspections** | CompanyCam photo sync and inspection reports texted to homeowners |
| **Roof Measure** | Measure a roof on satellite imagery: Google Solar roof data, auto-trace, hand tracing of facets and lines, permits and roof age, a Roofr-format report, and a commercial (flat-roof) mode. **Use these measurements** saves a roof report and can build the estimate straight away |
| **Roof Reports** | Every roof report in one list — from Roof Measure, an uploaded Roofr / GAF QuickMeasure / EagleView / Roof Measure PDF, or typed in — with one-click **Build estimate** |
| **Estimator** | The Diversity Roofing Estimator, rebuilt in the CRM: dashboard, roof / gutter / combined calculators, saved estimates, customer proposal, job cost, historical pricing, market benchmark and admin pricing (the last four manager-only) |
| **Marketing** | Campaign tracking, ROI, cost-per-lead, lead source performance |
| **Settings** | Company config, team, integration keys, notification preferences |

### The insurance workflow it models

```
Lead → Inspection → Contingency signed → Claim filed → Adjuster meeting
  → Estimate → Supplement → Approved → Work → ACV collected
  → Depreciation released → Closed
```

ACV, RCV, depreciation holdback, supplements, and deductible are tracked as
separate figures throughout, so you always know which check is outstanding.

---

## Integrations

Every integration is **mocked by default** and returns realistic data, so the
app is fully usable before you sign up for anything. Add real credentials one
at a time to switch each one live — see `.env.example` for the variable names.

| Integration | Used for | Status without a key |
|---|---|---|
| CompanyCam | Inspection photos | Mock photo sets |
| DocuSign | Contingency e-signatures | Simulated envelopes |
| HailTrace / NOAA | Storm date-of-loss lookup | Mock storm history |
| SMTP | Adjuster follow-up emails | Logged, not sent |
| Twilio | Homeowner texts | Logged, not sent |
| Google Drive | Contingency templates | Local template |
| EagleView | Roof measurement orders | Simulated measurements, flagged "Simulated" everywhere |

### Roof Measure and the estimator

Both used to be standalone single-file apps; they are now native CRM pages.

- **Roof Measure** (`/roof-measure`, `src/components/roof-measure/`) is a port
  of [musab-creator/roof-measure](https://github.com/musab-creator/roof-measure)
  (commit 3a11299). Its engine (`src/lib/roof-measure/`) reproduces the original's
  numbers and report HTML; `node src/lib/roof-measure/__tests__/run.mjs` runs the
  parity tests. It needs a Google Maps Platform key — set
  `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, or paste one into its Property panel once per
  browser. Roofs saved in the standalone tool (`rm.projects`) show up here.
- **Permits**: the published permit index is served from the standalone site via
  a rewrite in `next.config.ts` (`/roof-measure-data/permits/*`); the city/county
  lookups go through the server relays in `src/app/relay/` (`pao`, `clay`,
  `jaxepics`).
- **Estimator** (`/estimator`, `src/components/estimator/`): engine in
  `src/lib/estimator/`, data in `src/store/estimator.ts` (saved in the browser,
  `crm-estimator-v1`). Estimates made in the old embedded estimator
  (`dr_estimator_v1`) are imported automatically on first open. Parity tests:
  `node --experimental-strip-types src/lib/estimator/__tests__/parity.test.ts`
  (and the other files in that folder).
- **Roof report → estimate**: `createEstimateFromRoofReport` in
  `src/store/estimator.ts` applies the measurements the same way the estimator's
  own "Apply to this estimate" does, with the manager's saved pricing.

Estimates and roof reports are kept in the browser's storage, so they survive a
reload but are per-device until a database is added.

---

## Project layout

```
src/
├── app/
│   ├── api/            Integration endpoints (mocked, documented inline)
│   ├── dashboard/      KPIs and charts
│   ├── leads/          Pipeline + lead detail
│   ├── policies/       Policy analyzer
│   ├── contingency/    Contingency generator
│   ├── claims/         Claims tracker
│   ├── inspections/    CompanyCam
│   ├── roof-measure/   Satellite roof measuring
│   ├── roof-reports/   Roof measurement reports (Roof Measure, PDFs, manual)
│   ├── relay/          Public-record relays for permit lookups
│   ├── estimator/      Estimator: calculators, proposal, job cost, pricing
│   ├── marketing/      Campaigns
│   └── settings/       Config
├── components/         Shared UI
├── lib/                Utilities and mock data
├── store/              Zustand state
└── types/              TypeScript definitions
```

---

## Notes

State currently lives in Zustand in the browser, so **data resets on refresh** —
that's expected for the prototype. Wiring a real database (Postgres, Supabase)
is the natural next step once the workflows feel right.
