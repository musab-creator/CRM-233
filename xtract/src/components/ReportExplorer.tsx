"use client";

import { useState } from "react";
import { EDGE_HEX, EDGE_LABEL, EDGE_ORDER } from "@/lib/edges";
import type { RoofMeasurements } from "@/lib/types";
import { RoofDiagram, type DiagramMode } from "./RoofDiagram";

const TABS: { id: DiagramMode; label: string }[] = [
  { id: "lengths", label: "Lengths" },
  { id: "pitch", label: "Pitch" },
  { id: "area", label: "Area" },
];

export function ReportExplorer({ m }: { m: RoofMeasurements }) {
  const [mode, setMode] = useState<DiagramMode>("lengths");
  const suggested = m.wasteTable.find((w) => w.pct === m.suggestedWastePct)!;
  return (
    <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
      <div className="rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-6">
        <div role="tablist" aria-label="Diagram" className="mb-4 inline-flex rounded-lg bg-panel p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={mode === t.id}
              onClick={() => setMode(t.id)}
              className={`min-h-11 cursor-pointer rounded-md px-4 text-sm font-semibold transition-colors duration-200 ${
                mode === t.id ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <RoofDiagram m={m} mode={mode} className="h-auto w-full" title={`${mode} diagram of the sample roof`} />
        {mode === "lengths" ? (
          <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {EDGE_ORDER.map((t) => (
              <li key={t} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-slate">
                  <span className="h-1 w-5 rounded-full" style={{ background: EDGE_HEX[t] }} aria-hidden="true" />
                  {EDGE_LABEL[t]}
                </span>
                <span className="font-mono font-semibold">{m.lengths[t]} ft</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted">
            {mode === "pitch" ? "Rise per 12 inches of run, per facet. Darker = steeper." : "Sloped area of each facet in square feet."}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <div className="rounded-2xl bg-ink p-6 text-white">
          <div className="text-xs font-bold uppercase tracking-wider text-sky">Roof area</div>
          <div className="mt-1 font-mono text-4xl font-semibold">{m.totalAreaSqFt.toLocaleString()}<span className="ml-1 text-lg text-slate-400">sq ft</span></div>
          <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-white/10 pt-4 text-sm">
            <div><dt className="text-slate-400">Facets</dt><dd className="font-mono text-lg font-semibold">{m.facetCount}</dd></div>
            <div><dt className="text-slate-400">Pitch</dt><dd className="font-mono text-lg font-semibold">{m.predominantPitch}/12</dd></div>
            <div><dt className="text-slate-400">Squares</dt><dd className="font-mono text-lg font-semibold">{suggested.squares}</dd></div>
          </dl>
        </div>
        <div className="rounded-2xl border border-line bg-white p-5">
          <div className="text-xs font-bold uppercase tracking-wider text-muted">Waste table</div>
          <div className="mt-3 grid grid-cols-7 gap-1 text-center">
            {m.wasteTable.map((w) => {
              const sel = w.pct === m.suggestedWastePct;
              return (
                <div key={w.pct} className={`rounded-md px-0.5 py-2 ${sel ? "bg-amber-soft ring-1 ring-amber" : ""}`}>
                  <div className="text-[11px] font-bold text-slate">{w.pct}%</div>
                  <div className="font-mono text-sm font-semibold text-brand">{w.squares}</div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">Squares at each waste %. Highlighted = suggested for this roof&apos;s complexity.</p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-5">
          <div className="text-xs font-bold uppercase tracking-wider text-muted">Materials list</div>
          <ul className="mt-3 divide-y divide-line text-sm">
            {m.materials.map((x) => (
              <li key={x.item} className="flex justify-between py-1.5">
                <span className="text-slate">{x.item}</span>
                <span className="font-mono font-semibold">{x.qty} {x.unit}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
