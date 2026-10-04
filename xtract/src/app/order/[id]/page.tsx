import type { Metadata } from "next";
import Link from "next/link";
import { OrderTracker } from "@/components/OrderTracker";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { currentUser } from "@/lib/auth";
import { getOrder } from "@/lib/store";

export const metadata: Metadata = { title: "Roof report", robots: { index: false } };

export default async function OrderStatusPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const { id } = await params;
  const { t } = await searchParams;
  const [order, user] = await Promise.all([getOrder(id), currentUser()]);
  const owner = Boolean(order && user && user.email === order.customer.email);
  return (
    <>
      <SiteHeader />
      <main className="min-h-[70vh] bg-panel">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          {owner && (
            <Link href="/dashboard" className="text-sm font-semibold text-brand hover:underline">
              ← My reports
            </Link>
          )}
          <p className="mt-2 font-mono text-sm text-muted">{order?.kind === "manual" ? "Manual report" : "Order"} {id}</p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight">{order?.location?.formattedAddress ?? order?.address ?? "Your roof report"}</h1>
          <p className="mt-2 text-slate">{order?.kind === "manual" ? "Built from quantities you entered." : "This page updates live. You can close it — the report is emailed when it's ready."}</p>
          <div className="mt-8">
            <OrderTracker
              id={id}
              token={t ?? ""}
              editable={
                owner && order
                  ? { company: order.customer.company, phone: order.customer.phone, notes: order.notes, lastRoofPermitYear: order.property?.lastRoofPermitYear }
                  : undefined
              }
            />
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
