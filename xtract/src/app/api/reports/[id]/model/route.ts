import { NextRequest } from "next/server";
import { accessOrder, json } from "@/lib/access";
import { buildRoof3D } from "@/lib/model3d";
import { loadMeasurements } from "@/lib/reports";

/** 3D roof for the viewer + the 2D facts shown next to it. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await accessOrder(id, req.nextUrl.searchParams.get("t"));
  if (!a) return json({ error: "Not found" }, 404);
  const m = await loadMeasurements(a.order);
  if (!m) return json({ error: "Report not ready" }, 409);
  return json({
    roof: buildRoof3D(m),
    diagram: m.facets.length ? { facets: m.facets, edges: m.edges, exactLengths: m.exactLengths, unmeasured: m.unmeasured } : null,
    stats: { area: m.totalAreaSqFt, facets: m.facetCount, pitch: m.predominantPitch },
  });
}
