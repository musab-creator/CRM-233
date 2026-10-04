import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, CalendarDays, FileText, Plus } from "lucide-react";
import { ManualReportForm, ProfileForm, ReportList } from "@/components/Dashboard";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { currentUser } from "@/lib/auth";
import { formatPrice, tierFor } from "@/lib/config";
import { listOrders, monthlyCount } from "@/lib/store";

export const metadata: Metadata = { title: "My reports", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect("/signin?next=/dashboard");
  const [orders, month] = await Promise.all([listOrders((o) => o.customer.email === user.email), monthlyCount(user.email)]);
  const next = tierFor(month + 1);
  const rows = orders.map((o) => ({
    id: o.id,
    kind: o.kind,
    address: o.location?.formattedAddress ?? o.address,
    created: o.createdAt,
    status: o.status,
    area: o.summary?.totalAreaSqFt ?? null,
  }));
  return (
    <>
      <SiteHeader />
      <main className="min-h-[70vh] bg-panel">
        <div className="mx-auto max-w-6xl space-y-8 px-4 py-12 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm font-bold uppercase tracking-wider text-brand">Your report workspace</p>
              <h1 className="mt-1 text-3xl font-extrabold tracking-tight">My reports</h1>
              <p className="mt-1 text-sm text-muted">Signed in as {user.email}</p>
            </div>
            <div className="flex gap-2">
              <Link href="/order" className="inline-flex h-11 items-center gap-2 rounded-xl bg-amber px-5 font-bold text-ink hover:bg-amber-400">
                <Plus className="h-4 w-4" aria-hidden="true" /> Order a report
              </Link>
              <form action="/api/auth/signout" method="post">
                <button className="h-11 cursor-pointer rounded-xl border border-line bg-white px-4 text-sm font-semibold hover:border-slate-400">Sign out</button>
              </form>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              [FileText, String(orders.length), "Saved reports"],
              [CalendarDays, `${month} this month`, `Next report: ${formatPrice(next.cents)} (${next.name})`],
              [AlertTriangle, String(orders.filter((o) => o.status === "needs_review" || o.status === "failed").length), "In review"],
            ].map(([Icon, v, k]) => {
              const I = Icon as typeof FileText;
              return (
                <div key={k as string} className="flex items-center gap-4 rounded-2xl border border-line bg-white p-5">
                  <I className="h-6 w-6 text-brand" aria-hidden="true" />
                  <div>
                    <p className="font-mono text-xl font-semibold">{v as string}</p>
                    <p className="text-sm text-muted">{k as string}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <ReportList rows={rows} />
          <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <ManualReportForm />
            <ProfileForm company={user.company ?? ""} phone={user.phone ?? ""} />
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
