import Link from "next/link";
import {
  ArrowRight,
  Building2,
  Calculator,
  Check,
  ChevronDown,
  Clock,
  FileCheck,
  Layers,
  Mail,
  MapPin,
  Package,
  Receipt,
  Ruler,
  Satellite,
  ScanLine,
  ShieldCheck,
} from "lucide-react";
import { AddressStart } from "@/components/AddressStart";
import { PricingCalculator } from "@/components/PricingCalculator";
import { PropertyMap } from "@/components/PropertyMap";
import { RoofExplorer } from "@/components/RoofExplorer";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { PRICE_TIERS, REPORT_PAGES, formatPrice } from "@/lib/config";
import { buildRoof3D } from "@/lib/model3d";
import { sampleMeasurements } from "@/lib/reports";
import { SAMPLE_PROPERTY } from "@/lib/sampleModel";

const steps = [
  { icon: MapPin, title: "Order by address", body: "Type the property address and check out. No subscription, no account required." },
  { icon: Satellite, title: "We extract the roof", body: "The pipeline locates the building, pulls aerial roof geometry, measures every facet and edge, and looks up the parcel record." },
  { icon: Mail, title: "Report lands in your inbox", body: "An 8-page PDF is generated and emailed automatically, with a link to the interactive 3D model and quantity CSV." },
];

const uses = [
  { icon: Calculator, title: "Bids without the ladder", body: "Quote retail jobs from the truck with squares, pitch and a waste table." },
  { icon: Receipt, title: "Insurance supplements", body: "Attach a full measurement report when the adjuster's squares come in short." },
  { icon: Package, title: "Material orders", body: "Bundles and rolls for five major brands at four waste levels — ready to send to your supplier." },
  { icon: Building2, title: "Roof age at a glance", body: "Year built and parcel from the county roll, with permit status stated plainly." },
];

const faqs = [
  ["How does the report get made?", "When your payment clears, an automated pipeline geocodes the address, requests the building's roof geometry from Google's aerial imagery (Solar API), measures each facet and edge, checks the Florida parcel roll for year built, renders the 8-page PDF and emails it. Nobody has to touch the order."],
  ["How long does it take?", "Usually a few minutes. If the address can't be matched to a building or the imagery isn't good enough, the order is flagged for review and we contact you instead of sending a bad report — and you're not charged for a report we can't deliver."],
  ["How accurate is it?", "Roof area, pitch and facet count come from the roof geometry. Linear measurements are derived from it and labelled clearly; anything the imagery can't show (like parapet walls) is marked 'not measured' rather than guessed. See the Accuracy page for our validation against a professional report."],
  ["What's on the materials page?", "Shingles, starter, ice & water, synthetic underlayment and hip & ridge caps for IKO, CertainTeed, GAF, Owens Corning and Atlas at 0%, 10%, the recommended waste and 15%, plus valley metal and drip edge pieces. The math reproduces a professional report to the bundle."],
  ["Can I put my company on the report?", "Yes. Every page says 'Prepared by' your company with your phone number. Sign in to edit branding, add the last roof permit year or upload your own cover photo — the PDF regenerates instantly."],
  ["Is it an Xactimate ESX file?", "No. You get the PDF plus a quantity CSV (areas, edge lengths, squares by pitch, materials). Xactimate line-item mapping and ESX export are not included."],
];

export default function Home() {
  const m = sampleMeasurements();
  const roof = buildRoof3D(m)!;
  const waste = m.wasteTable.find((w) => w.pct === m.suggestedWastePct)!;

  return (
    <>
      <SiteHeader />
      <main>
        {/* Hero */}
        <section className="blueprint relative overflow-hidden text-white">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-12 sm:px-6 lg:grid-cols-[1fr_1.05fr] lg:pb-24 lg:pt-16">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-sky/25 bg-sky/10 px-3 py-1 text-xs font-semibold text-sky">
                <ScanLine className="h-3.5 w-3.5" aria-hidden="true" /> Roof intelligence, clearly presented
              </p>
              <h1 className="mt-5 text-4xl font-extrabold leading-[1.06] tracking-tight sm:text-5xl lg:text-[3.35rem]">
                See the roof.
                <br />
                <span className="text-amber">Get every number.</span>
              </h1>
              <p className="mt-5 max-w-lg text-lg leading-8 text-slate-300">
                Order by address. An 8-page roof report — diagrams, edge lengths, pitch, waste table, brand-by-brand materials and roof age — is measured from aerial imagery and emailed to you automatically.
              </p>
              <div className="mt-8">
                <AddressStart />
              </div>
              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-300">
                {[`From ${formatPrice(PRICE_TIERS[2].cents)}–${formatPrice(PRICE_TIERS[0].cents)}`, "8-page PDF + 3D model", "Delivered automatically"].map((t) => (
                  <li key={t} className="flex items-center gap-1.5">
                    <Check className="h-4 w-4 text-amber" aria-hidden="true" /> {t}
                  </li>
                ))}
              </ul>
            </div>
            <RoofExplorer
              roof={roof}
              title="3436 State Rd 13 N"
              subtitle="Jacksonville, FL · sample report"
              stats={{ area: m.totalAreaSqFt, facets: m.facetCount, pitch: m.predominantPitch }}
              note="Facets, areas and pitches from the measured roof model. Wall heights are illustrative."
            />
          </div>
          <div className="border-t border-white/10 bg-black/20">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-4 text-sm sm:px-6">
              <span className="font-mono text-[11px] uppercase tracking-widest text-sky">Every report</span>
              {["Geometry & lengths", "Area & pitch", "Waste & materials", "Permit & roof age"].map((t) => (
                <span key={t} className="flex items-center gap-2 font-semibold text-slate-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber" aria-hidden="true" /> {t}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* The report */}
        <section className="bg-panel">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="text-sm font-bold uppercase tracking-wider text-brand">The Xtract report</p>
                <h2 className="mt-2 max-w-2xl text-3xl font-extrabold tracking-tight sm:text-4xl">Eight pages. Everything you order from.</h2>
                <p className="mt-3 max-w-2xl text-slate">These are real pages from the sample report, rendered by the same code that produces every paid report.</p>
              </div>
              <Link href="/sample" className="inline-flex h-11 items-center gap-2 rounded-lg bg-ink px-5 text-sm font-bold text-white transition-colors duration-200 hover:bg-ink-2">
                Explore the sample <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
            <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {REPORT_PAGES.map(([title, desc], i) => (
                <Link key={title} href="/sample" className="group">
                  <div className="overflow-hidden rounded-xl border border-line bg-white shadow-sm transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-lg">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/report/page-${i + 1}.webp`} alt={`Sample page ${i + 1}: ${title}`} width={935} height={1210} loading="lazy" className="h-auto w-full" />
                  </div>
                  <p className="mt-2 text-sm font-bold">
                    <span className="mr-1.5 font-mono text-xs text-brand">{String(i + 1).padStart(2, "0")}</span>
                    {title}
                  </p>
                  <p className="text-xs leading-5 text-muted">{desc}</p>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Real property */}
        <section className="bg-white">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
            <div>
              <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-brand">
                <Satellite className="h-4 w-4" aria-hidden="true" /> The house in its real setting
              </p>
              <h2 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">From roof geometry to the real property.</h2>
              <p className="mt-4 text-slate">Every report page links to live satellite imagery of the address, next to the aerial captured for the report, so you can check trees, access and neighbours before you drive out.</p>
              <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
                {[
                  ["Imagery date", "Feb 11, 2016"],
                  ["Year built", String(SAMPLE_PROPERTY.builtYear)],
                  ["County", `${SAMPLE_PROPERTY.county}`],
                  ["Parcel", SAMPLE_PROPERTY.parcel],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl bg-panel p-3">
                    <dt className="text-xs font-bold uppercase tracking-wider text-muted">{k}</dt>
                    <dd className="mt-0.5 font-mono font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <PropertyMap query={`${SAMPLE_PROPERTY.lat},${SAMPLE_PROPERTY.lng}`} label={SAMPLE_PROPERTY.address} aerialSrc="/sample-aerial.jpg" aerialCaption="Report aerial · Google, Feb 11, 2016" />
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="blueprint scroll-mt-28 text-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <p className="text-sm font-bold uppercase tracking-wider text-sky">How it works</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-extrabold tracking-tight sm:text-4xl">Order to inbox with no one in the loop.</h2>
            <ol className="mt-12 grid gap-5 md:grid-cols-3">
              {steps.map((s, i) => (
                <li key={s.title} className="rounded-2xl border border-white/10 bg-white/5 p-6">
                  <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber text-ink">
                      <s.icon className="h-6 w-6" aria-hidden="true" />
                    </span>
                    <span className="font-mono text-sm font-semibold text-slate-400">0{i + 1}</span>
                  </div>
                  <h3 className="mt-5 text-lg font-bold">{s.title}</h3>
                  <p className="mt-2 leading-7 text-slate-300">{s.body}</p>
                </li>
              ))}
            </ol>
            <div className="mt-8 flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-black/20 p-4 font-mono text-xs text-slate-300 sm:text-sm">
              <Clock className="h-4 w-4 text-amber" aria-hidden="true" />
              {["paid", "locating", "measuring", "rendering", "delivering", "delivered"].map((s, i, a) => (
                <span key={s} className="flex items-center gap-2">
                  <span className={i === a.length - 1 ? "font-semibold text-emerald-400" : ""}>{s}</span>
                  {i < a.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />}
                </span>
              ))}
              <span className="ml-auto text-slate-400">tracked live on your order page</span>
            </div>
          </div>
        </section>

        {/* Accuracy */}
        <section className="bg-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
              <div>
                <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-brand">
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Checked against a professional report
                </p>
                <h2 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">Clarity extends to the limitations.</h2>
                <p className="mt-4 text-slate">We ran the measurement engine on the sample property and compared it, line by line, with the professional report prepared for that roof. What matched, and what the imagery can&apos;t show, is published — not hidden.</p>
                <Link href="/quality" className="mt-6 inline-flex items-center gap-2 font-bold text-brand hover:underline">
                  Read the full validation <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  [Ruler, "Roof area", `${m.totalAreaSqFt.toLocaleString()} sq ft`, "reference 8,150 — within 0.02%"],
                  [Layers, "Facets & pitch", `${m.facetCount} · ${m.predominantPitch}/12`, "reference 35 · 5/12 — exact"],
                  [Package, "Material quantities", "24 of 24", "brand quantities match the reference to the bundle"],
                  [FileCheck, "Recommended waste", `${m.suggestedWastePct}% · ${waste.squares} SQ`, "reference 14% — exact"],
                ].map(([Icon, k, v, note]) => {
                  const I = Icon as typeof Ruler;
                  return (
                    <div key={k as string} className="rounded-2xl border border-line p-5">
                      <I className="h-5 w-5 text-brand" aria-hidden="true" />
                      <p className="mt-3 text-xs font-bold uppercase tracking-wider text-muted">{k as string}</p>
                      <p className="font-mono text-2xl font-semibold">{v as string}</p>
                      <p className="mt-1 text-sm text-slate">{note as string}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Uses */}
        <section className="bg-panel">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <h2 className="max-w-2xl text-3xl font-extrabold tracking-tight sm:text-4xl">Built for how roofers work.</h2>
            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {uses.map((u) => (
                <div key={u.title} className="rounded-2xl border border-line bg-white p-6 transition-shadow duration-200 hover:shadow-md">
                  <u.icon className="h-6 w-6 text-brand" aria-hidden="true" />
                  <h3 className="mt-4 font-bold">{u.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate">{u.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section className="blueprint text-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="text-sm font-bold uppercase tracking-wider text-sky">Pricing</p>
                <h2 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">Pay per report. Volume pricing is automatic.</h2>
              </div>
              <Link href="/pricing" className="font-bold text-sky hover:underline">
                Pricing details
              </Link>
            </div>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {PRICE_TIERS.map((t, i) => (
                <div key={t.name} className={`rounded-2xl p-6 ${i === 1 ? "bg-white text-ink ring-2 ring-amber" : "border border-white/15 bg-white/5"}`}>
                  <p className="font-bold">{t.name}</p>
                  <p className="mt-2 font-mono text-4xl font-semibold">
                    {formatPrice(t.cents)}
                    <span className={`ml-1 text-sm font-normal ${i === 1 ? "text-muted" : "text-slate-400"}`}>/ report</span>
                  </p>
                  <p className={`mt-2 text-sm ${i === 1 ? "text-slate" : "text-slate-300"}`}>
                    {t.max ? `Reports ${t.min}–${t.max}` : `Report ${t.min}+`} each month
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-6">
              <PricingCalculator dark />
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="bg-white">
          <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
            <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Questions</h2>
            <div className="mt-8 divide-y divide-line border-y border-line">
              {faqs.map(([q, a]) => (
                <details key={q} className="group py-1">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-3 text-left font-semibold [&::-webkit-details-marker]:hidden">
                    {q}
                    <ChevronDown className="h-5 w-5 shrink-0 text-muted transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
                  </summary>
                  <p className="pb-5 leading-7 text-slate">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="bg-panel">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <div className="flex flex-col items-start justify-between gap-6 rounded-3xl bg-gradient-to-br from-brand to-bright p-8 text-white sm:p-12 md:flex-row md:items-center">
              <div>
                <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Your next roof, measured before you get there.</h2>
                <p className="mt-2 text-sky-100">Order now and the report is on its way in minutes.</p>
              </div>
              <Link href="/order" className="inline-flex h-12 shrink-0 items-center gap-2 rounded-xl bg-amber px-6 font-bold text-ink transition-colors duration-200 hover:bg-amber-400">
                Order a report <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
