"use client";

import { useState } from "react";
import { formatPrice, monthlyEstimate } from "@/lib/config";

export function PricingCalculator({ dark = false }: { dark?: boolean }) {
  const [n, setN] = useState(20);
  const e = monthlyEstimate(n);
  return (
    <div className={`grid gap-6 rounded-2xl p-6 sm:grid-cols-2 sm:p-8 ${dark ? "border border-white/15 bg-white/5" : "border border-line bg-white"}`}>
      <div>
        <p className={`text-xs font-bold uppercase tracking-wider ${dark ? "text-sky" : "text-brand"}`}>Monthly cost estimate</p>
        <label htmlFor="monthly-count" className="mt-3 block text-sm font-semibold">
          Reports per month
        </label>
        <input
          id="monthly-count"
          type="range"
          min={1}
          max={200}
          value={n}
          onChange={(ev) => setN(Number(ev.target.value))}
          className="mt-3 w-full accent-amber"
        />
        <div className="mt-2 flex items-center gap-3">
          <input
            type="number"
            min={0}
            max={10000}
            value={n}
            aria-label="Reports per month (number)"
            onChange={(ev) => setN(Math.min(10000, Math.max(0, Number(ev.target.value) || 0)))}
            className={`h-11 w-28 rounded-lg border px-3 font-mono text-base ${dark ? "border-white/20 bg-white/10 text-white" : "border-line bg-white text-ink"}`}
          />
          <span className={dark ? "text-slate-300" : "text-muted"}>reports</span>
        </div>
      </div>
      <div className={`rounded-xl p-5 ${dark ? "bg-black/20" : "bg-panel"}`}>
        <p className="text-sm font-semibold">
          You reach <span className="text-amber">{e.tier.name}</span> · {formatPrice(e.tier.cents)}/report
        </p>
        <p className="mt-2 font-mono text-4xl font-semibold">{formatPrice(e.totalCents)}</p>
        <p className={`text-sm ${dark ? "text-slate-300" : "text-muted"}`}>estimated monthly total · avg {formatPrice(e.avgCents)}/report</p>
        <p className={`mt-3 text-xs ${dark ? "text-slate-400" : "text-muted"}`}>Reports 1–24 at $12, 25–99 at $10, 100+ at $8. No subscription.</p>
      </div>
    </div>
  );
}
