import Link from "next/link";
import {
  ArrowRight,
  Calculator,
  Check,
  ChevronDown,
  Clock,
  Download,
  FileCheck,
  Mail,
  MapPin,
  Package,
  Receipt,
  Satellite,
  ScanLine,
} from "lucide-react";
import { AddressStart } from "@/components/AddressStart";
import { HeroScan } from "@/components/HeroScan";
import { ReportExplorer } from "@/components/ReportExplorer";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { PRODUCTS, TIERS, formatPrice } from "@/lib/config";
import { measureRoof } from "@/lib/measure";
import { sampleInsights } from "@/lib/sample";

const steps = [
  {
    icon: MapPin,
    title: "Enter the address",
    body: "Pick a report type and check out. No subscription, no account to set up.",
  },
  {
    icon: Satellite,
    title: "We extract the roof",
    body: "Our pipeline locates the building, pulls aerial roof geometry and measures every plane — pitch, area, edges.",
  },
  {
    icon: Mail,
    title: "Report hits your inbox",
    body: "A branded PDF is generated and emailed automatically. Track every step live on your order page.",
  },
];

const uses = [
  { icon: Calculator, title: "Bids without the ladder", body: "Quote retail jobs from the truck with squares and a waste table." },
  { icon: Receipt, title: "Insurance supplements", body: "Attach measurements to estimates when the adjuster's squares come in short." },
  { icon: Package, title: "Material orders", body: "Bundles, rolls and drip-edge pieces calculated from the measured lengths." },
  { icon: FileCheck, title: "Consistent documentation", body: "Same layout every job: overview, lengths, pitch, area, summary, materials." },
];

const faqs = [
  {
    q: "How does the report get made?",
    a: "When your payment clears, an automated pipeline geocodes the address, requests the building's roof geometry from Google's aerial-imagery Solar API, measures each roof plane, renders the PDF and emails it to you. No one has to touch the order.",
  },
  {
    q: "How long does it take?",
    a: "Usually a few minutes. If the address can't be matched to a building or the imagery isn't good enough, the order is flagged for manual review and we contact you instead of sending a bad report.",
  },
  {
    q: "How accurate are the measurements?",
    a: "Roof area, pitch and facet count come straight from the plane geometry in the imagery. Linear measurements (eaves, rakes, ridges, hips, valleys) are derived from that geometry and are labelled as estimates — verify critical lengths on site before ordering custom materials.",
  },
  {
    q: "What's in the materials list?",
    a: "Shingle bundles, underlayment rolls, starter, hip & ridge cap, drip edge and valley leak barrier, calculated at the suggested waste factor using standard coverage rates. Confirm quantities with your supplier.",
  },
  {
    q: "Does it work for any roof?",
    a: "It works best on pitched residential roofs with recent aerial coverage. Very new construction, heavy tree cover, or flat commercial roofs may be routed to manual review.",
  },
  {
    q: "What if I'm not happy with a report?",
    a: "Reply to the delivery email with your order number. We'll re-run it or refund it.",
  },
];

export default function Home() {
  const m = measureRoof(sampleInsights());

  return (
    <>
      <SiteHeader />
      <main>
        {/* Hero */}
        <section className="blueprint relative overflow-hidden text-white">
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 pb-20 pt-14 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pb-28 lg:pt-20">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-sky/25 bg-sky/10 px-3 py-1 text-xs font-semibold text-sky">
                <ScanLine className="h-3.5 w-3.5" aria-hidden="true" /> Aerial roof measurements · automated delivery
              </p>
              <h1 className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-[3.4rem]">
                Roof reports,
                <br />
                <span className="text-amber">extracted</span> in minutes.
              </h1>
              <p className="mt-5 max-w-lg text-lg leading-8 text-slate-300">
                Type an address. Get roof area, pitch, every edge length, a waste table and a materials list — measured from aerial imagery and emailed to you automatically.
              </p>
              <div className="mt-8">
                <AddressStart />
              </div>
              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-300">
                {[`From ${formatPrice(PRODUCTS.quick.priceCents)}`, "No subscription", "PDF + email delivery"].map((t) => (
                  <li key={t} className="flex items-center gap-1.5">
                    <Check className="h-4 w-4 text-amber" aria-hidden="true" /> {t}
                  </li>
                ))}
              </ul>
            </div>
            <HeroScan m={m} />
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="scroll-mt-16 border-b border-line bg-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <p className="text-sm font-bold uppercase tracking-wider text-brand">How it works</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-extrabold tracking-tight sm:text-4xl">Order to inbox with no one in the loop.</h2>
            <div className="relative mt-12">
            <div aria-hidden="true" className="absolute left-0 right-0 top-[3.25rem] hidden h-px bg-gradient-to-r from-brand/0 via-brand/40 to-brand/0 md:block" />
            <ol className="relative grid gap-6 md:grid-cols-3">
              {steps.map((s, i) => (
                <li key={s.title} className="relative rounded-2xl border border-line bg-white p-6">
                  <div className="flex items-center gap-3">
                    <span className="relative z-10 flex h-14 w-14 items-center justify-center rounded-2xl bg-ink text-amber shadow-lg shadow-ink/20">
                      <s.icon className="h-6 w-6" aria-hidden="true" />
                    </span>
                    <span className="font-mono text-sm font-semibold text-muted">0{i + 1}</span>
                  </div>
                  <h3 className="mt-5 text-lg font-bold">{s.title}</h3>
                  <p className="mt-2 leading-7 text-slate">{s.body}</p>
                </li>
              ))}
            </ol>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-2 rounded-2xl bg-panel p-4 font-mono text-xs text-slate sm:text-sm">
              <Clock className="h-4 w-4 text-brand" aria-hidden="true" />
              {["paid", "locating", "measuring", "rendering", "delivering", "delivered"].map((s, i, a) => (
                <span key={s} className="flex items-center gap-2">
                  <span className={i === a.length - 1 ? "font-semibold text-emerald-700" : ""}>{s}</span>
                  {i < a.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* The report */}
        <section id="report" className="scroll-mt-16 bg-panel">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="text-sm font-bold uppercase tracking-wider text-brand">Inside every report</p>
                <h2 className="mt-2 max-w-2xl text-3xl font-extrabold tracking-tight sm:text-4xl">The numbers you actually order from.</h2>
                <p className="mt-3 max-w-2xl text-slate">
                  This is a live sample roof run through the same measurement engine as paid orders. Switch diagrams to see what lands in your PDF.
                </p>
              </div>
              <a
                href="/api/sample?tier=full"
                target="_blank"
                rel="noopener"
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-ink/15 bg-white px-4 text-sm font-bold text-ink transition-colors duration-200 hover:border-ink/40"
              >
                <Download className="h-4 w-4" aria-hidden="true" /> Sample PDF
              </a>
            </div>
            <div className="mt-10">
              <ReportExplorer m={m} />
            </div>
          </div>
        </section>

        {/* Use cases */}
        <section className="bg-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <h2 className="max-w-2xl text-3xl font-extrabold tracking-tight sm:text-4xl">Built for how roofers work.</h2>
            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {uses.map((u) => (
                <div key={u.title} className="rounded-2xl border border-line p-6 transition-shadow duration-200 hover:shadow-md">
                  <u.icon className="h-6 w-6 text-brand" aria-hidden="true" />
                  <h3 className="mt-4 font-bold">{u.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate">{u.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="blueprint scroll-mt-16 text-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <p className="text-sm font-bold uppercase tracking-wider text-sky">Pricing</p>
            <h2 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">Pay per report. That&apos;s it.</h2>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {TIERS.map((t) => {
                const p = PRODUCTS[t];
                return (
                  <div
                    key={t}
                    className={`relative flex flex-col rounded-2xl p-7 ${
                      p.popular ? "bg-white text-ink shadow-2xl shadow-black/40 ring-2 ring-amber" : "border border-white/15 bg-white/5"
                    }`}
                  >
                    {p.popular && (
                      <span className="absolute -top-3 left-7 rounded-full bg-amber px-3 py-1 text-xs font-bold text-ink">Most ordered</span>
                    )}
                    <h3 className="text-lg font-bold">{p.name}</h3>
                    <p className={`mt-1 text-sm ${p.popular ? "text-muted" : "text-slate-400"}`}>{p.tagline}</p>
                    <div className="mt-5 flex items-baseline gap-1">
                      <span className="font-mono text-5xl font-semibold">{formatPrice(p.priceCents)}</span>
                      <span className={p.popular ? "text-muted" : "text-slate-400"}>/ report</span>
                    </div>
                    <ul className="mt-6 flex-1 space-y-3 text-sm">
                      {p.includes.map((i) => (
                        <li key={i} className="flex gap-2.5">
                          <Check className={`mt-0.5 h-4 w-4 shrink-0 ${p.popular ? "text-brand" : "text-amber"}`} aria-hidden="true" />
                          <span className={p.popular ? "text-slate" : "text-slate-200"}>{i}</span>
                        </li>
                      ))}
                    </ul>
                    <Link
                      href={`/order?tier=${t}`}
                      className={`mt-8 inline-flex h-12 items-center justify-center gap-2 rounded-xl text-sm font-bold transition-colors duration-200 ${
                        p.popular ? "bg-brand text-white hover:bg-brand-600" : "bg-white/10 text-white hover:bg-white/20"
                      }`}
                    >
                      Order {p.name} <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
            <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Questions</h2>
            <div className="mt-8 divide-y divide-line border-y border-line">
              {faqs.map((f) => (
                <details key={f.q} className="group py-1">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-3 text-left font-semibold [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <ChevronDown className="h-5 w-5 shrink-0 text-muted transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
                  </summary>
                  <p className="pb-5 leading-7 text-slate">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="bg-panel">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <div className="flex flex-col items-start justify-between gap-6 rounded-3xl bg-brand p-8 text-white sm:p-12 md:flex-row md:items-center">
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
