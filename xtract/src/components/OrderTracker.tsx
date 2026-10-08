"use client";

import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import type { OrderEvent, OrderStatus } from "@/lib/types";
import { ReportEditor } from "./ReportEditor";
import { ReportView } from "./ReportView";

interface View {
  id: string;
  kind: "auto" | "manual";
  status: OrderStatus;
  address: string;
  location: { lat: number; lng: number } | null;
  email: string;
  events: OrderEvent[];
  summary: { totalAreaSqFt: number; squares: number; predominantPitch: number; facetCount: number; suggestedWastePct: number } | null;
  source: { provider: string; label: string; imageryDate?: string } | null;
  hasReport: boolean;
  delivery: { method: "email" | "demo"; to: string } | null;
  owner: boolean;
}

const STEPS: { key: OrderStatus; label: string }[] = [
  { key: "queued", label: "Payment confirmed" },
  { key: "locating", label: "Locating property & imagery" },
  { key: "rendering", label: "Measuring roof & rendering report" },
  { key: "delivering", label: "Delivering" },
  { key: "delivered", label: "Delivered" },
];
const ORDER: OrderStatus[] = ["awaiting_payment", "queued", "locating", "measuring", "rendering", "delivering", "delivered"];
const TERMINAL: OrderStatus[] = ["delivered", "needs_review", "failed"];

export function OrderTracker({ id, token, editable }: { id: string; token: string; editable?: { company?: string; phone?: string; notes?: string; lastRoofPermitYear?: number } }) {
  const [view, setView] = useState<View | null>(null);
  const [missing, setMissing] = useState(false);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/orders/${id}${token ? `?t=${encodeURIComponent(token)}` : ""}`, { cache: "no-store" });
        if (res.status === 404) return alive && setMissing(true);
        const v = (await res.json()) as View;
        if (!alive) return;
        setView(v);
        if (TERMINAL.includes(v.status)) return;
      } catch {
        /* retry below */
      }
      timer = setTimeout(poll, 1500);
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, token]);

  if (missing) return <p className="rounded-xl bg-red-50 p-4 text-red-700">Report not found. Use the link in your email, or sign in with the email you ordered with.</p>;
  if (!view) return <LoaderCircle className="h-6 w-6 animate-spin text-brand" aria-label="Loading report" />;

  const failed = view.status === "needs_review" || view.status === "failed";
  const idx = ORDER.indexOf(view.status);
  const lastIdx = failed ? Math.max(...view.events.map((e) => ORDER.indexOf(e.status))) : idx;
  const delivered = view.status === "delivered";

  return (
    <div className="space-y-8">
      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        {view.kind === "auto" && (
          <section aria-live="polite" className="rounded-2xl border border-line bg-white p-6">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted">Progress</h2>
            {view.status === "awaiting_payment" && (
              <p className="mt-4 flex items-center gap-2 text-slate">
                <LoaderCircle className="h-5 w-5 animate-spin text-brand" aria-hidden="true" /> Waiting for payment confirmation…
              </p>
            )}
            <ol className="mt-3">
              {STEPS.map((s) => {
                const k = ORDER.indexOf(s.key);
                const done = delivered || k < lastIdx;
                const active = !failed && !delivered && (k === idx || (s.key === "rendering" && view.status === "measuring"));
                const broke = failed && k === Math.min(lastIdx + 1, ORDER.length - 1);
                const ev = [...view.events].reverse().find((e) => e.status === s.key || (s.key === "rendering" && e.status === "measuring"));
                return (
                  <li key={s.key} className="flex gap-3 py-2">
                    <span className="mt-0.5">
                      {done ? (
                        <CircleCheck className="h-5 w-5 text-emerald-600" aria-hidden="true" />
                      ) : active ? (
                        <LoaderCircle className="h-5 w-5 animate-spin text-brand" aria-hidden="true" />
                      ) : broke ? (
                        <CircleAlert className="h-5 w-5 text-amber" aria-hidden="true" />
                      ) : (
                        <span className="block h-5 w-5 rounded-full border-2 border-line" aria-hidden="true" />
                      )}
                    </span>
                    <span>
                      <span className={`font-semibold ${done || active ? "text-ink" : "text-muted"}`}>{s.label}</span>
                      {ev && <span className="block text-sm text-muted">{ev.message}</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
            {failed && (
              <div role="alert" className="mt-4 rounded-xl bg-amber-soft p-4 text-sm text-amber-900">
                <strong>We&apos;re taking a closer look.</strong> {view.events.at(-1)?.message}. Our team has been notified and will follow up at {view.email}. You won&apos;t be charged for a report we can&apos;t deliver.
              </div>
            )}
          </section>
        )}

        <section className={`rounded-2xl bg-ink p-6 text-white ${view.kind === "manual" ? "lg:col-span-2" : ""}`}>
          <h2 className="text-sm font-bold uppercase tracking-wider text-sky">Result</h2>
          {view.summary ? (
            <>
              <div className="mt-3 font-mono text-4xl font-semibold">
                {view.summary.totalAreaSqFt.toLocaleString()}
                <span className="ml-1 text-lg text-slate-400">sq ft</span>
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-white/10 pt-4 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-slate-400">Squares @ {view.summary.suggestedWastePct}%</dt>
                  <dd className="font-mono text-lg">{view.summary.squares}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Pitch</dt>
                  <dd className="font-mono text-lg">{view.summary.predominantPitch}/12</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Facets</dt>
                  <dd className="font-mono text-lg">{view.summary.facetCount}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Waste</dt>
                  <dd className="font-mono text-lg">{view.summary.suggestedWastePct}%</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="mt-3 text-slate-400">Measurements appear here as soon as the roof is measured.</p>
          )}
          {view.delivery && (
            <p className="mt-4 text-sm text-slate-300">{view.delivery.method === "email" ? `Emailed to ${view.delivery.to}.` : "Email delivery isn't configured on this server — download the report below."}</p>
          )}
          {view.source && <p className={`mt-3 text-xs ${view.source.provider === "demo" ? "text-amber" : "text-slate-400"}`}>Source: {view.source.label}</p>}
        </section>
      </div>

      {delivered && view.hasReport && <ReportView key={rev} id={view.id} token={token} address={view.address} location={view.location} />}
      {delivered && view.owner && editable && <ReportEditor id={view.id} initial={editable} onSaved={() => setRev((r) => r + 1)} />}
    </div>
  );
}
