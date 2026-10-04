import type { Metadata } from "next";
import { PRODUCTS, formatPrice, integrations } from "@/lib/config";
import { listOrders, safeEqual } from "@/lib/store";

export const metadata: Metadata = { title: "Orders", robots: { index: false } };
export const dynamic = "force-dynamic";

const tone: Record<string, string> = {
  delivered: "bg-emerald-100 text-emerald-800",
  needs_review: "bg-amber-100 text-amber-900",
  failed: "bg-red-100 text-red-800",
  awaiting_payment: "bg-slate-100 text-slate-700",
};

export default async function Admin({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { key } = await searchParams;
  const adminKey = process.env.XTRACT_ADMIN_KEY;
  if (!adminKey || !safeEqual(key, adminKey)) {
    return (
      <main className="mx-auto max-w-xl px-4 py-24 text-center">
        <h1 className="text-2xl font-bold">Orders admin</h1>
        <p className="mt-2 text-slate">{adminKey ? "Add ?key=… to the URL." : "Set XTRACT_ADMIN_KEY to enable this page."}</p>
      </main>
    );
  }
  const orders = await listOrders();
  const live = integrations();
  const revenue = orders.filter((o) => o.payment.paidAt && o.payment.provider === "stripe").reduce((s, o) => s + o.priceCents, 0);

  return (
    <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">Orders</h1>
          <p className="text-sm text-muted">
            {orders.length} total · {formatPrice(revenue)} paid via Stripe · Stripe {live.stripe ? "live" : "demo"} · Google {live.google ? "live" : "demo"} · Email {live.email ? "live" : "off"}
          </p>
        </div>
      </div>
      <div className="mt-6 overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-left text-sm">
          <thead className="bg-panel text-xs uppercase tracking-wider text-muted">
            <tr>
              {["Order", "Placed", "Report", "Address", "Customer", "Status", "Result", ""].map((h) => (
                <th key={h} className="px-4 py-3 font-bold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {orders.map((o) => (
              <tr key={o.id} className="align-top">
                <td className="px-4 py-3 font-mono">
                  <a className="text-brand hover:underline" href={`/order/${o.id}?t=${o.token}`}>{o.id}</a>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">{new Date(o.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3">{PRODUCTS[o.tier].name}<div className="text-muted">{formatPrice(o.priceCents)}</div></td>
                <td className="max-w-56 px-4 py-3">{o.location?.formattedAddress ?? o.address}</td>
                <td className="px-4 py-3">{o.customer.name}<div className="text-muted">{o.customer.email}</div></td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-1 text-xs font-semibold ${tone[o.status] ?? "bg-sky-100 text-sky-800"}`}>{o.status.replace("_", " ")}</span>
                  {o.error && <div className="mt-1 max-w-48 text-xs text-red-700">{o.error}</div>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">
                  {o.summary ? `${o.summary.totalAreaSqFt.toLocaleString()} sf · ${o.summary.predominantPitch}/12` : "—"}
                </td>
                <td className="px-4 py-3">
                  {["failed", "needs_review", "delivered"].includes(o.status) && (
                    <form action="/api/admin/requeue" method="post">
                      <input type="hidden" name="id" value={o.id} />
                      <input type="hidden" name="key" value={key} />
                      <button className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-xs font-semibold hover:bg-panel">Re-run</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-muted">No orders yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
