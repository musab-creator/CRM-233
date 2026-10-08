import { NextResponse } from "next/server";
import { renderReportPdf } from "@/lib/pdf";
import { sampleAerial, sampleMeasurements } from "@/lib/reports";
import { SAMPLE_PROPERTY } from "@/lib/sampleModel";

// The sample report, rendered live by the same code as paid orders.
export async function GET() {
  const pdf = await renderReportPdf({
    orderId: "XR-SAMPLE",
    address: SAMPLE_PROPERTY.address,
    preparedBy: { company: "Diversity Roofing", phone: "(904) 979-0556" },
    createdAt: new Date(),
    source: { provider: "model", label: "Supplied professional roof model · Google imagery", imageryDate: SAMPLE_PROPERTY.imageryDate },
    measurements: sampleMeasurements(),
    aerial: { bytes: await sampleAerial(), kind: "jpg", credit: "Google" },
    property: {
      yearBuilt: SAMPLE_PROPERTY.builtYear,
      effectiveYearBuilt: SAMPLE_PROPERTY.builtYear,
      parcelId: SAMPLE_PROPERTY.parcel,
      county: SAMPLE_PROPERTY.county,
      source: "Supplied sample report (St. Johns County parcel record)",
      checkedAt: new Date().toISOString(),
      permitsChecked: false,
    },
  });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="Xtract-Sample-Roof-Report.pdf"',
      "Cache-Control": "public, max-age=3600",
    },
  });
}
