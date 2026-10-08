import type { Metadata } from "next";
import { Mail, Phone } from "lucide-react";
import { ContactForm } from "@/components/ContactForm";
import { PageHero } from "@/components/PageHero";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { currentUser } from "@/lib/auth";
import { BRAND } from "@/lib/config";

export const metadata: Metadata = { title: "Contact & support" };

export default async function ContactPage() {
  const user = await currentUser();
  return (
    <>
      <SiteHeader />
      <main>
        <PageHero eyebrow="Support" title="Talk to a person." text="Questions about a report, a quantity, or volume pricing — we answer by email or phone." />
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_1.6fr]">
          <div className="space-y-4">
            <a href={BRAND.phoneHref} className="flex items-center gap-3 rounded-2xl border border-line p-5 hover:border-brand">
              <Phone className="h-5 w-5 text-brand" aria-hidden="true" />
              <span>
                <b className="block">{BRAND.phone}</b>
                <small className="text-muted">Call or text</small>
              </span>
            </a>
            <a href={`mailto:${BRAND.supportEmail}`} className="flex items-center gap-3 rounded-2xl border border-line p-5 hover:border-brand">
              <Mail className="h-5 w-5 text-brand" aria-hidden="true" />
              <span>
                <b className="block break-all">{BRAND.supportEmail}</b>
                <small className="text-muted">Email</small>
              </span>
            </a>
            <div className="rounded-2xl bg-panel p-5 text-sm leading-6 text-slate">
              <b className="text-ink">For a report issue</b>, include the order number (XR-…), the quantity in question and what you compared it with. Don&apos;t send passwords or card numbers.
            </div>
          </div>
          <ContactForm email={user?.email} />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
