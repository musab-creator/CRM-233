import type { Metadata } from "next";
import { Legal } from "@/components/Legal";
import { PageHero } from "@/components/PageHero";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { BRAND } from "@/lib/config";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  return (
    <>
      <SiteHeader />
      <main>
        <PageHero eyebrow="Terms" title="Service terms." />
        <Legal>
          <h2>The service</h2>
          <p>Xtract produces roof measurement reports from aerial imagery and public records, priced per report with automatic monthly volume tiers. Manual reports built from your own quantities are free.</p>
          <h2>Measurements are estimates</h2>
          <p>Reports are prepared from imagery that may be out of date and from geometry that cannot show every detail (for example parapet walls, hidden valleys or recent alterations). Verify critical dimensions, current conditions, product coverage and quantities before estimating, ordering materials or submitting a claim. Material quantities are estimates and are not guaranteed.</p>
          <h2>Roof age and permits</h2>
          <p>Year built comes from county parcel records. Unless a roofing permit is on file, roof age is unverified, and unavailable permit records do not prove no permit exists.</p>
          <h2>Undeliverable reports</h2>
          <p>If we can&apos;t locate the building or the imagery isn&apos;t usable, the order goes to review. If we can&apos;t deliver a usable report, you won&apos;t be charged for it (or it&apos;s refunded).</p>
          <h2>Exports</h2>
          <p>The CSV export contains quantities only. It is not an Xactimate ESX file or a priced estimate.</p>
          <h2>Contact</h2>
          <p>
            {BRAND.supportEmail} · {BRAND.phone}
          </p>
        </Legal>
      </main>
      <SiteFooter />
    </>
  );
}
