import type { Metadata } from "next";
import { Legal } from "@/components/Legal";
import { PageHero } from "@/components/PageHero";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { BRAND } from "@/lib/config";

export const metadata: Metadata = { title: "Privacy" };

export default function Privacy() {
  return (
    <>
      <SiteHeader />
      <main>
        <PageHero eyebrow="Privacy" title="Your reports and your data." />
        <Legal>
          <h2>What we collect</h2>
          <ul>
            <li>Order details: property address, your name, email, company and phone.</li>
            <li>Report data: measurements, the aerial image, parcel facts and anything you add (permit year, notes, photos).</li>
            <li>Account: your email and a sign-in cookie. We don&apos;t use advertising trackers.</li>
          </ul>
          <h2>Who processes it</h2>
          <ul>
            <li>Stripe processes card payments — we never see or store card numbers.</li>
            <li>Google Maps Platform receives the address to locate the building and return roof imagery and geometry.</li>
            <li>The Florida Department of Revenue parcel service receives the property&apos;s coordinates to look up year built and parcel.</li>
            <li>Our email provider delivers your report and sign-in links.</li>
          </ul>
          <h2>Who can see your reports</h2>
          <p>Reports are visible to the account that ordered them and to anyone holding the private link in the delivery email. Treat that link like the report itself.</p>
          <h2>Your controls</h2>
          <p>Signed in, you can download, edit and delete your reports; deleting removes the PDF, measurements and photos. To delete your account, contact us.</p>
          <h2>Contact</h2>
          <p>
            {BRAND.full}, operated by {BRAND.operator}, {BRAND.city}. {BRAND.supportEmail} · {BRAND.phone}.
          </p>
        </Legal>
      </main>
      <SiteFooter />
    </>
  );
}
