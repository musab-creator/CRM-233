import { NextRequest, NextResponse } from "next/server";
import { getOrder, safeEqual } from "@/lib/store";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order || !safeEqual(req.nextUrl.searchParams.get("t"), order.token)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Customer-safe view: no token echo, no internal error text.
  return NextResponse.json({
    id: order.id,
    tier: order.tier,
    status: order.status,
    address: order.location?.formattedAddress ?? order.address,
    email: order.customer.email,
    events: order.events,
    summary: order.summary ?? null,
    source: order.source ?? null,
    hasReport: Boolean(order.reportFile),
    delivery: order.delivery ?? null,
  });
}
