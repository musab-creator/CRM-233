import type { RoofMeasurements } from "@/lib/types";
import { RoofDiagram } from "./RoofDiagram";

/** Animated "extraction" graphic: aerial plan → measured edges → numbers. */
export function HeroScan({ m }: { m: RoofMeasurements }) {
  const chips = [
    { k: "Roof area", v: `${m.totalAreaSqFt.toLocaleString()} sq ft`, pos: "left-3 -top-4 sm:top-16 sm:-left-6", delay: 2300 },
    { k: "Pitch", v: `${m.predominantPitch}/12`, pos: "hidden sm:block right-3 top-24 sm:-right-5", delay: 2600 },
    { k: "Ridges + hips", v: `${(m.lengths.ridge + m.lengths.hip).toLocaleString()} ft`, pos: "hidden sm:block left-3 bottom-20 sm:-left-8", delay: 2900 },
    { k: "Squares @ " + m.suggestedWastePct + "%", v: String(m.wasteTable.find((w) => w.pct === m.suggestedWastePct)?.squares), pos: "right-3 -bottom-4 sm:bottom-6 sm:-right-4", delay: 3200 },
  ];
  return (
    <div className="relative mx-auto w-full max-w-[520px]">
      <div className="relative overflow-hidden rounded-3xl border border-sky/20 bg-gradient-to-br from-slate-800 via-ink-2 to-ink p-6 shadow-2xl shadow-black/40">
        {/* faux aerial texture */}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(circle at 18% 22%, rgba(34,197,94,.25), transparent 30%), radial-gradient(circle at 85% 80%, rgba(34,197,94,.18), transparent 35%), radial-gradient(circle at 80% 15%, rgba(148,163,184,.15), transparent 25%)",
          }}
        />
        <div className="relative flex items-center justify-between pb-3 font-mono text-[11px] uppercase tracking-widest text-sky/80">
          <span className="flex items-center gap-2">
            <span className="pulse-dot h-2 w-2 rounded-full bg-amber" aria-hidden="true" /> Extracting
          </span>
          <span>{m.facetCount} planes</span>
        </div>
        <div className="relative">
          <RoofDiagram m={m} mode="scan" className="h-auto w-full" title="Roof planes being measured from aerial imagery" />
          <div aria-hidden="true" className="scanline pointer-events-none absolute inset-x-0 top-0 h-full">
            <div className="h-0.5 w-full bg-gradient-to-r from-transparent via-amber to-transparent shadow-[0_0_24px_4px_rgba(245,158,11,.45)]" />
          </div>
        </div>
      </div>
      {chips.map((c) => (
        <div
          key={c.k}
          className={`fade-pop absolute ${c.pos} rounded-xl border border-white/10 bg-white/95 px-3 py-2 shadow-xl backdrop-blur`}
          style={{ "--delay": `${c.delay}ms` } as React.CSSProperties}
        >
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted">{c.k}</div>
          <div className="font-mono text-base font-semibold text-ink">{c.v}</div>
        </div>
      ))}
    </div>
  );
}
