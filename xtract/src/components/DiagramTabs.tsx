"use client";

import { useState } from "react";
import { EDGE_DASHED, EDGE_HEX, EDGE_LABEL, EDGE_ORDER } from "@/lib/edges";
import type { RoofMeasurements } from "@/lib/types";
import { RoofDiagram, type DiagramMode } from "./RoofDiagram";

const TABS: { id: DiagramMode; label: string }[] = [
  { id: "lengths", label: "Lengths" },
  { id: "pitch", label: "Pitch" },
  { id: "area", label: "Area" },
];

const ftIn = (ft: number) => {
  const f = Math.floor(ft);
  const i = Math.round((ft - f) * 12);
  return i === 12 ? `${f + 1}' 0"` : `${f}' ${i}"`;
};

type Data = Pick<RoofMeasurements, "facets" | "edges" | "exactLengths" | "unmeasured">;

/** Interactive diagram with legend — same geometry as the PDF pages. */
export function DiagramTabs({ m }: { m: Data }) {
  const [mode, setMode] = useState<DiagramMode>("lengths");
  return (
    <div className="rounded-2xl border border-line bg-white p-4 sm:p-6">
      <div role="tablist" aria-label="Diagram" className="mb-4 inline-flex rounded-lg bg-panel p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={mode === t.id}
            onClick={() => setMode(t.id)}
            className={`min-h-10 cursor-pointer rounded-md px-4 text-sm font-semibold transition-colors duration-200 ${mode === t.id ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <RoofDiagram m={m} mode={mode} className="mx-auto h-auto max-h-[560px] w-full" title={`${mode} diagram`} />
      {mode === "lengths" ? (
        <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          {EDGE_ORDER.map((t) => (
            <li key={t} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-slate">
                <span
                  className="h-1 w-5 rounded-full"
                  style={{ background: EDGE_DASHED[t] ? `repeating-linear-gradient(90deg, ${EDGE_HEX[t]} 0 4px, transparent 4px 7px)` : EDGE_HEX[t] }}
                  aria-hidden="true"
                />
                {EDGE_LABEL[t]}
              </span>
              <span className="font-mono font-semibold">{m.unmeasured.includes(t) ? <span className="font-sans text-xs font-normal text-muted">not measured</span> : ftIn(m.exactLengths[t])}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted">{mode === "pitch" ? "Rise per 12 inches of run, per facet. Darker = steeper." : "Sloped area of each facet in square feet."}</p>
      )}
    </div>
  );
}
