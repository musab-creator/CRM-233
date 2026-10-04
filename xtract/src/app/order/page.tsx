import type { Metadata } from "next";
import { OrderForm } from "@/components/OrderForm";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { currentUser } from "@/lib/auth";
import { formatPrice, integrations, tierFor } from "@/lib/config";
import { monthlyCount } from "@/lib/store";

export const metadata: Metadata = { title: "Order a report" };

export default async function OrderPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const user = await currentUser();
  const tier = tierFor(user ? (await monthlyCount(user.email)) + 1 : 1);
  return (
    <>
      <SiteHeader />
      <main className="bg-panel">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Order a roof report</h1>
          <p className="mt-2 text-slate">Measured from aerial imagery and emailed to you automatically, usually within minutes.</p>
          <div className="mt-10">
            <OrderForm
              initialAddress={one(sp.address)}
              liveStripe={integrations().stripe}
              canceled={one(sp.canceled) === "1"}
              priceLabel={`${formatPrice(tier.cents)} · ${tier.name}`}
              user={user ? { email: user.email, company: user.company, phone: user.phone } : null}
            />
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
