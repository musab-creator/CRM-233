import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { PricingCalculator } from "@/components/PricingCalculator";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { PRICE_TIERS, REPORT_PAGES, formatPrice } from "@/lib/config";

export const metadata: Metadata = { title: "Pricing" };

const faqs = [
  ["How do volume tiers work?", "Each report is priced by its position in your calendar month, per account email: reports 1–24 cost $12, the 25th through 99th cost $10, and from the 100th on they cost $8. The rate you'll pay is shown at checkout."],
  ["What if a roof can't be measured?", "If an address can't be matched to a building or the imagery isn't good enough, the order goes to review instead of producing a bad report. We contact you, and you aren't charged for a report we can't deliver."],
  ["Are manual reports free?", "Yes. Signed-in users can build a report from quantities they already have — it produces the summary, permit and materials pages. Diagrams require a measured report."],
  ["Is there a subscription?", "No. Pay per report by card through Stripe. No monthly fee and nothing to cancel."],
];

export default function PricingPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <PageHero eyebrow="Report pricing" title="Pay per report. Volume pricing is automatic." text="Every report is the full eight pages. The more you order in a month, the less each one costs." />
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <div className="grid gap-6 md:grid-cols-3">
            {PRICE_TIERS.map((t, i) => (
              <div key={t.name} className={`relative flex flex-col rounded-2xl p-7 ${i === 1 ? "bg-ink text-white shadow-2xl ring-2 ring-amber" : "border border-line bg-white"}`}>
                {i === 1 && <span className="absolute -top-3 left-7 rounded-full bg-amber px-3 py-1 text-xs font-bold text-ink">Volume pricing</span>}
                <h2 className="text-lg font-bold">{t.name}</h2>
                <p className={`text-sm ${i === 1 ? "text-slate-300" : "text-muted"}`}>{t.blurb}</p>
                <p className="mt-5 font-mono text-5xl font-semibold">
                  {formatPrice(t.cents)}
                  <span className={`ml-1 text-base font-normal ${i === 1 ? "text-slate-400" : "text-muted"}`}>/ report</span>
                </p>
                <p className="mt-2 font-semibold">{t.max ? `Reports ${t.min}–${t.max} per month` : `Report ${t.min}+ per month`}</p>
                <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                  {["Full 8-page PDF", "Interactive 3D model", "Quantity CSV export", "Emailed automatically"].map((x) => (
                    <li key={x} className="flex gap-2">
                      <Check className={`mt-0.5 h-4 w-4 shrink-0 ${i === 1 ? "text-amber" : "text-brand"}`} aria-hidden="true" /> {x}
                    </li>
                  ))}
                </ul>
                <Link href="/order" className={`mt-8 inline-flex h-12 items-center justify-center rounded-xl font-bold transition-colors duration-200 ${i === 1 ? "bg-amber text-ink hover:bg-amber-400" : "bg-brand text-white hover:bg-brand-600"}`}>
                  Order a report
                </Link>
              </div>
            ))}
          </div>
          <div className="mt-8">
            <PricingCalculator />
          </div>
          <div className="mt-14 grid gap-10 lg:grid-cols-2">
            <div>
              <h2 className="text-2xl font-extrabold tracking-tight">What every report includes</h2>
              <ol className="mt-5 space-y-3">
                {REPORT_PAGES.map(([t, d], i) => (
                  <li key={t} className="flex gap-3">
                    <span className="font-mono text-sm font-semibold text-brand">{String(i + 1).padStart(2, "0")}</span>
                    <span>
                      <b>{t}</b> <span className="text-slate">— {d}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="divide-y divide-line border-y border-line">
              {faqs.map(([q, a]) => (
                <details key={q} className="group py-1">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center py-3 font-semibold [&::-webkit-details-marker]:hidden">{q}</summary>
                  <p className="pb-5 leading-7 text-slate">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
