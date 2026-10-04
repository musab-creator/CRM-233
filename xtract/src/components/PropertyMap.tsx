"use client";

import { useState } from "react";
import { Globe, Image as ImageIcon, Satellite } from "lucide-react";

interface Props {
  query: string; // "lat,lng" or an address
  label: string;
  aerialSrc?: string; // optional supplied aerial photo
  aerialCaption?: string;
}

/** Real satellite imagery of the property (Google Maps embed, no key needed). */
export function PropertyMap({ query, label, aerialSrc, aerialCaption }: Props) {
  const [mode, setMode] = useState<"map" | "aerial">("map");
  const src = `https://maps.google.com/maps?q=${encodeURIComponent(query)}&t=k&z=20&ie=UTF8&iwloc=&output=embed`;
  const open = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  const tab = (on: boolean) =>
    `inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors duration-150 ${on ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"}`;
  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-2">
        <div className="flex rounded-xl bg-panel p-1" role="group" aria-label="Imagery view">
          <button className={tab(mode === "map")} aria-pressed={mode === "map"} onClick={() => setMode("map")}>
            <Satellite className="h-4 w-4" aria-hidden="true" /> Satellite map
          </button>
          {aerialSrc && (
            <button className={tab(mode === "aerial")} aria-pressed={mode === "aerial"} onClick={() => setMode("aerial")}>
              <ImageIcon className="h-4 w-4" aria-hidden="true" /> Report aerial
            </button>
          )}
        </div>
        <span className="mr-2 rounded-full bg-emerald-50 px-2.5 py-1 font-mono text-[10px] font-bold text-emerald-700">REAL IMAGERY</span>
      </div>
      <div className="relative aspect-[16/10] w-full bg-panel">
        {mode === "map" ? (
          <iframe src={src} title={`Satellite map of ${label}`} loading="lazy" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen className="absolute inset-0 h-full w-full border-0" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={aerialSrc} alt={aerialCaption ?? `Aerial photo of ${label}`} className="absolute inset-0 h-full w-full object-cover" />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
        <span className="text-muted">{mode === "aerial" && aerialCaption ? aerialCaption : "Drag to explore · use + and − to zoom"}</span>
        <a href={open} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 font-semibold text-brand hover:underline">
          <Globe className="h-4 w-4" aria-hidden="true" /> Open in Google Maps
        </a>
      </div>
    </div>
  );
}
