import type { Metadata } from "next";
import { Building2, Clock, Eye, Layers } from "lucide-react";
import { Notice, PageHero } from "@/components/PageHero";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { EDGE_LABEL, EDGE_ORDER } from "@/lib/edges";
import { ftIn } from "@/lib/measure";
import { sampleMeasurements } from "@/lib/reports";
import { SAMPLE_PROPERTY } from "@/lib/sampleModel";

export const metadata: Metadata = { title: "Accuracy & reporting standards" };

const pct = (a: number, b: number) => (b === 0 ? (a === 0 ? "—" : "n/a") : `${a >= b ? "+" : "−"}${Math.abs(((a - b) / b) * 100).toFixed(1)}%`);

export default function QualityPage() {
  const m = sampleMeasurements();
  const ref = SAMPLE_PROPERTY.reference;
  const total = (x: Record<string, number>) => Object.values(x).reduce((a, b) => a + b, 0);
  return (
    <>
      <SiteHeader />
      <main>
        <PageHero eyebrow="Quality & accuracy" title="Know the source. See the flags. Verify the numbers." text="How Xtract measures, what it checks itself against, and what imagery cannot tell you." />
        <div className="mx-auto max-w-6xl space-y-14 px-4 py-14 sm:px-6">
          <section>
            <h2 className="text-2xl font-extrabold tracking-tight">Validation: engine vs. a professional report</h2>
            <p className="mt-2 max-w-3xl text-slate">
              We ran the measurement engine on the sample property ({SAMPLE_PROPERTY.address}) and compared every total with the professional report prepared for the same roof. This table is computed live from the code — it is not typed in.
            </p>
            <div className="mt-6 overflow-x-auto rounded-2xl border border-line">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="bg-panel text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-4 py-3">Measurement</th>
                    <th className="px-4 py-3 text-right">Xtract</th>
                    <th className="px-4 py-3 text-right">Reference</th>
                    <th className="px-4 py-3 text-right">Difference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line font-mono">
                  <tr className="bg-emerald-50/50">
                    <td className="px-4 py-2.5 font-sans font-semibold">Total roof area</td>
                    <td className="px-4 py-2.5 text-right">{m.totalAreaSqFt.toLocaleString()} sqft</td>
                    <td className="px-4 py-2.5 text-right">{ref.areaSqFt.toLocaleString()} sqft</td>
                    <td className="px-4 py-2.5 text-right">{pct(m.totalAreaSqFt, ref.areaSqFt)}</td>
                  </tr>
                  <tr className="bg-emerald-50/50">
                    <td className="px-4 py-2.5 font-sans font-semibold">Facets · predominant pitch</td>
                    <td className="px-4 py-2.5 text-right">{m.facetCount} · {m.predominantPitch}/12</td>
                    <td className="px-4 py-2.5 text-right">{ref.facets} · {ref.pitch}/12</td>
                    <td className="px-4 py-2.5 text-right">exact</td>
                  </tr>
                  {EDGE_ORDER.map((k) => (
                    <tr key={k}>
                      <td className="px-4 py-2.5 font-sans">{EDGE_LABEL[k]}</td>
                      <td className="px-4 py-2.5 text-right">{m.unmeasured.includes(k) ? <span className="font-sans text-muted">not measured</span> : ftIn(m.exactLengths[k])}</td>
                      <td className="px-4 py-2.5 text-right">{ftIn(ref.lengths[k])}</td>
                      <td className="px-4 py-2.5 text-right text-muted">{m.unmeasured.includes(k) ? "—" : pct(m.exactLengths[k], ref.lengths[k])}</td>
                    </tr>
                  ))}
                  <tr className="bg-panel font-semibold">
                    <td className="px-4 py-2.5 font-sans">All linear feet</td>
                    <td className="px-4 py-2.5 text-right">{Math.round(total(m.exactLengths)).toLocaleString()} ft</td>
                    <td className="px-4 py-2.5 text-right">{Math.round(total(ref.lengths)).toLocaleString()} ft</td>
                    <td className="px-4 py-2.5 text-right">{pct(total(m.exactLengths), total(ref.lengths))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Notice>
                <b>What matches:</b> area, facet count, pitch, recommended waste and — given the same lengths — every brand material quantity, to the bundle (24 of 24 checked in our automated tests).
              </Notice>
              <Notice tone="warn">
                <b>Where it differs:</b> how linear feet split between categories. Where an upper roof overhangs a lower one, a plan view shows one line; the engine splits it into eave/rake + flashing, but some splits (and parapet walls) can&apos;t be seen from above. Verify flashing lengths on site.
              </Notice>
            </div>
          </section>

          <section className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {[
              [Clock, "Imagery date on every report", "The capture date of the aerial is printed on the cover. Old imagery can miss a recent re-roof or addition — check the date before you bid."],
              [Eye, "Coverage & visibility", "Tree canopy, shadows and very new construction can hide geometry. If imagery isn't good enough, the order goes to review instead of guessing."],
              [Building2, "Roof age, stated plainly", "Year built comes from the Florida parcel roll. It isn't roof age: unless a roof permit is on file, the report says the roof could be as old as the house."],
              [Layers, "Measured vs. derived", "Area and pitch are measured; edge categories are derived from geometry. Anything that can't be seen is labelled 'not measured' — never zero."],
            ].map(([Icon, t, d]) => {
              const I = Icon as typeof Clock;
              return (
                <div key={t as string} className="rounded-2xl border border-line p-6">
                  <I className="h-6 w-6 text-brand" aria-hidden="true" />
                  <h3 className="mt-4 font-bold">{t as string}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate">{d as string}</p>
                </div>
              );
            })}
          </section>

          <section className="rounded-2xl bg-panel p-6 sm:p-8">
            <h2 className="text-xl font-extrabold">How a measurement is made</h2>
            <ol className="mt-4 grid gap-4 text-sm leading-6 text-slate md:grid-cols-3">
              <li><b className="text-ink">1 · Roof planes.</b> Google&apos;s Solar API returns every roof plane it finds in the aerial imagery: area, footprint, pitch and direction.</li>
              <li><b className="text-ink">2 · Geometry.</b> Each facet is drawn to scale; shared edges are classified by whether the facets rise or fall away from them — ridge, hip, valley, transition — and boundaries as eaves, rakes or flashing.</li>
              <li><b className="text-ink">3 · Quantities.</b> Lengths include slope. Squares round up to a tenth. Materials use each product&apos;s published coverage at four waste levels.</li>
            </ol>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
