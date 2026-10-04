import type { Metadata } from "next";
import { OrderTracker } from "@/components/OrderTracker";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = { title: "Order status", robots: { index: false } };

export default async function OrderStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { id } = await params;
  const { t } = await searchParams;
  return (
    <>
      <SiteHeader />
      <main className="min-h-[70vh] bg-panel">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <p className="font-mono text-sm text-muted">Order {id}</p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight">Your roof report</h1>
          <p className="mt-2 text-slate">This page updates live. You can close it — the report will be emailed when it&apos;s ready.</p>
          <div className="mt-8">
            <OrderTracker id={id} token={t ?? ""} />
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
