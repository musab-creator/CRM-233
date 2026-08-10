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
