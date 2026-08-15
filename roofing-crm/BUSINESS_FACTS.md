# Diversity Roofing — Verified Business Facts

Pulled from `diversityroofinglovableplaybook.md` in the company Google Drive.
These are **real** and supersede the invented placeholder data currently in the
CRM. Do not change them without checking with Musab.

> The CRM as built uses fabricated identity and geography ("Apex Roofing" /
> "StormShield", Dallas–Fort Worth TX, State Farm/USAA Texas adjusters). All of
> that is wrong and needs replacing with the below.

---

## Identity

| Field | Value |
|---|---|
| Company | Diversity Roofing |
| Phone | (904) 979-0556 → `tel:+19049790556` |
| Tagline | "We Fight for Your Home So You Don't Have To" |
| Owner contact | musab@diversity-roofing.com |
| FL contractor license | **[MISSING — required in all advertising]** |
| Physical address | **[MISSING]** |
| Public email | **[MISSING]** |
| Hours | **[MISSING]** |

## Service area

Jacksonville, Orange Park, Middleburg, St. Augustine — plus surrounding
**Duval / Clay / St. Johns County** communities.

Named target cities: Jacksonville, Orange Park, Middleburg, St. Augustine,
Fleming Island, Ponte Vedra, Jacksonville Beach, Nocatee.

---

## Florida claim deadlines (drives CRM alerting)

Per **Fla. Stat. 627.70132**, as amended by SB 2-A (Dec 2022):

- **1 year** from date of loss to file a new or reopened claim
- **18 months** from date of loss for a supplemental claim

This is the single biggest functional gap in the current CRM — it tracks date of
loss but has no deadline clock. Every claim needs both countdowns visible, with
escalating warnings as they approach.

> Deadlines change. Confirm against the current statute before relying on these
> in production.

## Fla. Stat. 489.147 — required disclosures

Must appear on anything mentioning insurance claims, at ≥12pt and ≥half the size
of the largest font on the page. These belong in the **contingency generator**
output:

1. "The consumer is responsible for payment of any insurance deductible."
2. "It is insurance fraud punishable as a felony of the third degree for a
   contractor to knowingly or willfully, and with intent to injure, defraud, or
   deceive, pay, waive, or rebate all or part of an insurance deductible
   applicable to payment to the contractor for repairs to a property covered by
   a property insurance policy."
3. "It is insurance fraud punishable as a felony of the third degree to
   intentionally file an insurance claim containing any false, incomplete, or
   misleading information."

Fines run to **$10,000 per violation**. FL Admin Code Rule 61G4-12.011
separately requires the license number in all advertising.

## Scope-of-practice limit

Diversity Roofing is **not** a public adjuster. The company documents damage and
meets the adjuster on the roof. It does **not** interpret policy or negotiate
claims. No CRM copy, email template, or contingency clause may imply otherwise.

Also prohibited: any language offering to waive, absorb, cover, or "handle" the
deductible, or offering gift cards / cash / rebates in exchange for an
inspection or claim.

---

## Real process artifacts in Drive

The company's actual workflow is already documented in these files. They are a
better source of truth for the CRM's data model than anything invented:

| Artifact | What it captures |
|---|---|
| Green Sheet (per job) | Job financial summary |
| Job Breakdown (per job) | Line-item scope |
| Job Closeout (per job) | Completion record |
| Depreciation Tracking | RCV holdback release |
| AR Tracking | Receivables |
| Claims-Unresponsive | Carriers/adjusters gone quiet |
| Zip Codes - Leads | Territory targeting |
| Adjuster Appointment Set up | Adjuster scheduling |
| Payment Ledger - Daily Money Sweep | Daily cash |
| Contingency - <address>.pdf | Signed contingencies, one per job |
| Waiver of Lien | Lien release |
| Contractor Supplement | Supplement submissions |

Drive folder structure is `Jobs / OPEN JOBS / <Customer> / <Property Address>`,
which implies the CRM should be **property-centric under a customer**, not
flat-per-lead as currently built.

---

## Still needed

- The **Obsidian mind map** — the requested rebuild reference, not in Drive
- Company logos — referenced as "embedded logos in the Drive", not yet located
- The blank contingency template — referenced but not yet located
