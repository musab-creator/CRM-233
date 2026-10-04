import type { Metadata } from "next";
import { DiagramTabs } from "@/components/DiagramTabs";
import { Notice, PageHero } from "@/components/PageHero";
import { PropertyMap } from "@/components/PropertyMap";
import { ReportPages } from "@/components/ReportPages";
import { RoofExplorer } from "@/components/RoofExplorer";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { buildRoof3D } from "@/lib/model3d";
import { sampleMeasurements } from "@/lib/reports";
import { SAMPLE_PROPERTY } from "@/lib/sampleModel";

export const metadata: Metadata = { title: "Sample report", description: "All eight pages of a real Xtract roof report, plus the interactive 3D model and diagrams." };

export default function SamplePage() {
  const m = sampleMeasurements();
  const roof = buildRoof3D(m)!;
  return (
    <>
      <SiteHeader />
      <main>
        <PageHero eyebrow="The full sample" title="The Xtract sample report." text={`Every page of the report for ${SAMPLE_PROPERTY.address} — diagrams, measurements, roof age and brand-by-brand materials.`} />
        <div className="mx-auto max-w-6xl space-y-14 px-4 py-14 sm:px-6">
          <Notice tone="warn">
            Sample imagery is from February 11, 2016 and the roof replacement date is unverified. This historical sample shows the report format — review it before estimating a current job.
          </Notice>
          <ReportPages />
          <section>
            <h2 className="text-2xl font-extrabold tracking-tight">Inspect the roof yourself</h2>
            <p className="mt-2 text-slate">Every delivered report includes this interactive model and diagram set.</p>
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <RoofExplorer
                roof={roof}
                dark={false}
                title="3436 State Rd 13 N"
                subtitle="35 facets · click any surface"
                stats={{ area: m.totalAreaSqFt, facets: m.facetCount, pitch: m.predominantPitch }}
                note="Facet outlines, areas and pitches are measured. Wall heights are illustrative."
              />
              <DiagramTabs m={{ facets: m.facets, edges: m.edges, exactLengths: m.exactLengths, unmeasured: m.unmeasured }} />
            </div>
          </section>
          <section>
            <h2 className="text-2xl font-extrabold tracking-tight">The property</h2>
            <div className="mt-6">
              <PropertyMap query={`${SAMPLE_PROPERTY.lat},${SAMPLE_PROPERTY.lng}`} label={SAMPLE_PROPERTY.address} aerialSrc="/sample-aerial.jpg" aerialCaption="Report aerial · Google, Feb 11, 2016" />
            </div>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
