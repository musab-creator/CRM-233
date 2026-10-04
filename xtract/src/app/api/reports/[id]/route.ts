import { NextRequest, NextResponse } from "next/server";
import { getOrder, readReport, safeEqual } from "@/lib/store";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order?.reportFile || !safeEqual(req.nextUrl.searchParams.get("t"), order.token)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const pdf = await readReport(order.reportFile);
  const inline = req.nextUrl.searchParams.get("view") === "1";
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="Xtract-${order.id}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
