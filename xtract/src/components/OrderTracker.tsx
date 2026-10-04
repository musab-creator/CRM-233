"use client";

import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Download, Eye, LoaderCircle } from "lucide-react";
import type { OrderEvent, OrderStatus } from "@/lib/types";

interface View {
  id: string;
  tier: string;
  status: OrderStatus;
  address: string;
  email: string;
  events: OrderEvent[];
  summary: { totalAreaSqFt: number; squares: number; predominantPitch: number; facetCount: number; suggestedWastePct: number } | null;
  source: { provider: string; imageryDate?: string } | null;
  hasReport: boolean;
  delivery: { method: "email" | "demo"; to: string } | null;
}

const STEPS: { key: OrderStatus; label: string }[] = [
  { key: "queued", label: "Payment confirmed" },
  { key: "locating", label: "Locating property" },
  { key: "measuring", label: "Measuring roof planes" },
  { key: "rendering", label: "Rendering PDF" },
  { key: "delivering", label: "Delivering" },
  { key: "delivered", label: "Delivered" },
];
const ORDER: OrderStatus[] = ["awaiting_payment", ...STEPS.map((s) => s.key)];
const TERMINAL: OrderStatus[] = ["delivered", "needs_review", "failed"];

export function OrderTracker({ id, token }: { id: string; token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/orders/${id}?t=${encodeURIComponent(token)}`, { cache: "no-store" });
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

  if (missing) return <p className="rounded-xl bg-red-50 p-4 text-red-700">Order not found. Check the link in your email.</p>;
  if (!view) return <LoaderCircle className="h-6 w-6 animate-spin text-brand" aria-label="Loading order" />;

  const failed = view.status === "needs_review" || view.status === "failed";
  const reached = ORDER.indexOf(view.status);
  const lastStepIdx = failed ? Math.max(...view.events.filter((e) => ORDER.includes(e.status)).map((e) => ORDER.indexOf(e.status))) : reached;
  const link = (dl: boolean) => `/api/reports/${view.id}?t=${encodeURIComponent(token)}${dl ? "" : "&view=1"}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <section aria-live="polite" className="rounded-2xl border border-line bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wider text-muted">Progress</h2>
        {view.status === "awaiting_payment" && (
          <p className="mt-4 flex items-center gap-2 text-slate">
            <LoaderCircle className="h-5 w-5 animate-spin text-brand" aria-hidden="true" /> Waiting for payment confirmation…
          </p>
        )}
        <ol className="mt-4 space-y-1">
          {STEPS.map((s) => {
            const idx = ORDER.indexOf(s.key);
            const done = idx < lastStepIdx || view.status === "delivered";
            const active = !failed && idx === reached && view.status !== "delivered";
            const broke = failed && idx === lastStepIdx + 1;
            const ev = view.events.findLast((e) => e.status === s.key);
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
            <strong>We&apos;re taking a closer look.</strong> {view.events.at(-1)?.message}. Our team has been notified and will follow up at {view.email} — you won&apos;t be charged for a report we can&apos;t deliver.
          </div>
        )}
      </section>

      <section className="rounded-2xl bg-ink p-6 text-white">
        <h2 className="text-sm font-bold uppercase tracking-wider text-sky">Result</h2>
        {view.summary ? (
          <>
            <div className="mt-3 font-mono text-4xl font-semibold">
              {view.summary.totalAreaSqFt.toLocaleString()}
              <span className="ml-1 text-lg text-slate-400">sq ft</span>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-white/10 pt-4 text-sm sm:grid-cols-4">
              <div><dt className="text-slate-400">Squares</dt><dd className="font-mono text-lg">{view.summary.squares}</dd></div>
              <div><dt className="text-slate-400">Pitch</dt><dd className="font-mono text-lg">{view.summary.predominantPitch}/12</dd></div>
              <div><dt className="text-slate-400">Facets</dt><dd className="font-mono text-lg">{view.summary.facetCount}</dd></div>
              <div><dt className="text-slate-400">Waste</dt><dd className="font-mono text-lg">{view.summary.suggestedWastePct}%</dd></div>
            </dl>
          </>
        ) : (
          <p className="mt-3 text-slate-400">Measurements appear here as soon as the roof is measured.</p>
        )}
        {view.hasReport && (
          <div className="mt-6 flex flex-wrap gap-3">
            <a href={link(true)} className="inline-flex h-12 items-center gap-2 rounded-xl bg-amber px-5 font-bold text-ink transition-colors duration-200 hover:bg-amber-400">
              <Download className="h-4 w-4" aria-hidden="true" /> Download PDF
            </a>
            <a href={link(false)} target="_blank" rel="noopener" className="inline-flex h-12 items-center gap-2 rounded-xl bg-white/10 px-5 font-bold text-white transition-colors duration-200 hover:bg-white/20">
              <Eye className="h-4 w-4" aria-hidden="true" /> View
            </a>
          </div>
        )}
        {view.delivery && (
          <p className="mt-4 text-sm text-slate-300">
            {view.delivery.method === "email" ? `Emailed to ${view.delivery.to}.` : "Email delivery isn't configured on this server — download the report above."}
          </p>
        )}
        {view.source?.provider === "demo" && (
          <p className="mt-4 rounded-lg bg-amber/15 p-3 text-xs text-amber-200">Demo data: this roof was generated synthetically because no Google Maps key is configured.</p>
        )}
      </section>
    </div>
  );
}
