import { NextRequest, NextResponse } from "next/server";
import { TIERS } from "@/lib/config";
import { measureRoof } from "@/lib/measure";
import { renderReportPdf } from "@/lib/pdf";
import { SAMPLE_ADDRESS, sampleInsights } from "@/lib/sample";
import type { ReportTier } from "@/lib/types";

// Sample report rendered by the exact same pipeline code as paid orders.
export async function GET(req: NextRequest) {
  const t = req.nextUrl.searchParams.get("tier") as ReportTier;
  const tier = TIERS.includes(t) ? t : "full";
  const insights = sampleInsights();
  const d = insights.imageryDate!;
  const pdf = await renderReportPdf({
    orderId: "XR-SAMPLE",
    tier,
    address: SAMPLE_ADDRESS,
    preparedFor: "Sample Roofing Co.",
    createdAt: new Date(),
    source: { provider: "demo", imageryDate: `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`, imageryQuality: "HIGH" },
    measurements: measureRoof(insights),
  });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Xtract-sample-${tier}.pdf"`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
