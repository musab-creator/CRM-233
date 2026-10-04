import type { Metadata } from "next";
import { OrderForm } from "@/components/OrderForm";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { PRODUCTS, TIERS, integrations } from "@/lib/config";
import type { ReportTier } from "@/lib/types";

export const metadata: Metadata = { title: "Order a report" };

export default async function OrderPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const tier = (TIERS as string[]).includes(one(sp.tier)) ? (one(sp.tier) as ReportTier) : "full";
  return (
    <>
      <SiteHeader />
      <main className="bg-panel">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Order a roof report</h1>
          <p className="mt-2 text-slate">Delivered to your email automatically, usually within minutes.</p>
          <div className="mt-10">
            <OrderForm
              products={TIERS.map((t) => PRODUCTS[t])}
              initialTier={tier}
              initialAddress={one(sp.address)}
              liveStripe={integrations().stripe}
              canceled={one(sp.canceled) === "1"}
            />
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
