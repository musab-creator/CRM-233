import { NextRequest } from "next/server";
import { accessOrder, json } from "@/lib/access";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await accessOrder(id, req.nextUrl.searchParams.get("t"));
  if (!a) return json({ error: "Not found" }, 404);
  const o = a.order;
  // Customer-safe view: no token echo, no internal error text.
  return json({
    id: o.id,
    kind: o.kind,
    status: o.status,
    address: o.location?.formattedAddress ?? o.address,
    location: o.location ?? null,
    email: o.customer.email,
    events: o.events,
    summary: o.summary ?? null,
    source: o.source ?? null,
    hasReport: Boolean(o.files?.pdf),
    delivery: o.delivery ?? null,
    owner: a.owner,
  });
}
