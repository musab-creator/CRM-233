import { NextRequest, NextResponse } from "next/server";
import { accessOrder, json } from "@/lib/access";
import { EDGE_LABEL, EDGE_ORDER } from "@/lib/edges";
import { loadMeasurements } from "@/lib/reports";

const cell = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;

/** Quantity takeoff as CSV (not an Xactimate ESX file). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await accessOrder(id, req.nextUrl.searchParams.get("t"));
  if (!a) return json({ error: "Not found" }, 404);
  const m = await loadMeasurements(a.order);
  if (!m) return json({ error: "Report not ready" }, 409);
  const w = m.wasteTable.find((x) => x.pct === m.suggestedWastePct)!;
  const rows: (string | number)[][] = [
    ["Category", "Quantity", "Unit"],
    ["Total roof area", m.totalAreaSqFt, "SQFT"],
    ["Pitched area", m.pitchedAreaSqFt, "SQFT"],
    ["Flat area", m.flatAreaSqFt, "SQFT"],
    ["Roof squares", (m.totalAreaSqFt / 100).toFixed(2), "SQ"],
    [`Squares with ${w.pct}% waste`, w.squares, "SQ"],
    ["Facets", m.facetCount, "EA"],
    ["Predominant pitch", `${m.predominantPitch}/12`, ""],
    ...EDGE_ORDER.map((k) => [EDGE_LABEL[k], m.unmeasured.includes(k) ? "not measured" : m.exactLengths[k].toFixed(2), "LF"]),
    ...m.pitchBreakdown.map((p) => [`Area at ${p.pitch}/12`, Math.round(p.areaSqFt), "SQFT"]),
    ...m.brandMaterials.flatMap((g) => g.rows.map((r) => [`${r.product} (${m.suggestedWastePct}% waste)`, r.qty[Math.min(2, r.qty.length - 1)], r.unit])),
  ];
  return new NextResponse(rows.map((r) => r.map(cell).join(",")).join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="xtract-quantities-${id}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
