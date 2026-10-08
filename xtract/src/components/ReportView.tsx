"use client";

import { useEffect, useState } from "react";
import { Download, Eye, FileSpreadsheet } from "lucide-react";
import type { Roof3D } from "@/lib/model3d";
import type { RoofMeasurements } from "@/lib/types";
import { DiagramTabs } from "./DiagramTabs";
import { PropertyMap } from "./PropertyMap";
import { RoofExplorer } from "./RoofExplorer";

interface ModelResponse {
  roof: Roof3D | null;
  diagram: Pick<RoofMeasurements, "facets" | "edges" | "exactLengths" | "unmeasured"> | null;
  stats: { area: number; facets: number; pitch: number };
}

/** Delivered report: downloads, 3D model, diagrams and live satellite map. */
export function ReportView({ id, token, address, location }: { id: string; token: string; address: string; location: { lat: number; lng: number } | null }) {
  const [data, setData] = useState<ModelResponse | null>(null);
  const q = token ? `?t=${encodeURIComponent(token)}` : "";
  useEffect(() => {
    fetch(`/api/reports/${id}/model${q}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, [id, q]);
  const sep = q ? "&" : "?";
  const link = "inline-flex h-12 items-center gap-2 rounded-xl px-5 font-bold transition-colors duration-200";
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-3">
        <a href={`/api/reports/${id}${q}`} className={`${link} bg-amber text-ink hover:bg-amber-400`}>
          <Download className="h-4 w-4" aria-hidden="true" /> Download PDF
        </a>
        <a href={`/api/reports/${id}${q}${sep}view=1`} target="_blank" rel="noopener" className={`${link} border border-line bg-white text-ink hover:border-slate-400`}>
          <Eye className="h-4 w-4" aria-hidden="true" /> View PDF
        </a>
        <a href={`/api/reports/${id}/csv${q}`} className={`${link} border border-line bg-white text-ink hover:border-slate-400`}>
          <FileSpreadsheet className="h-4 w-4" aria-hidden="true" /> Quantity CSV
        </a>
      </div>
      {data?.roof && (
        <div className="grid gap-6 lg:grid-cols-2">
          <RoofExplorer roof={data.roof} dark={false} title={address.split(",")[0]} subtitle={`${data.stats.facets} facets · click any surface`} stats={data.stats} note="Facet outlines, areas and pitches are measured. Wall heights are illustrative." />
          {data.diagram && <DiagramTabs m={data.diagram} />}
        </div>
      )}
      <PropertyMap query={location ? `${location.lat},${location.lng}` : address} label={address} />
    </div>
  );
}
