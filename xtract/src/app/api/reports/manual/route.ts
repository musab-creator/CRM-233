import { NextRequest } from "next/server";
import { currentUser, sameOrigin } from "@/lib/auth";
import { json } from "@/lib/access";
import { EDGE_ORDER } from "@/lib/edges";
import { manualMeasurements, renderOrderPdf, storePdf } from "@/lib/reports";
import { createOrder, newOrderId, newToken, updateOrder } from "@/lib/store";
import type { EdgeType, Order } from "@/lib/types";

/** Build a report from quantities the contractor already has (free, no imagery). */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json({ error: "Request rejected" }, 403);
  const user = await currentUser();
  if (!user) return json({ error: "Sign in to create manual reports" }, 401);
  const b = (await req.json()) as Record<string, unknown>;
  const num = (v: unknown, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new Error("Enter valid non-negative measurements");
    return n;
  };
  const address = typeof b.address === "string" ? b.address.trim().slice(0, 300) : "";
  if (address.length < 8) return json({ errors: { address: "Enter a complete property address" } }, 422);
  let manual: Order["manual"];
  try {
    const lengths = (b.lengths ?? {}) as Record<string, unknown>;
    manual = {
      areaSqFt: num(b.areaSqFt, 1_000_000),
      facets: Math.floor(num(b.facets, 10_000)),
      pitch: num(b.pitch, 48),
      lengths: Object.fromEntries(EDGE_ORDER.map((k) => [k, num(lengths[k] ?? 0, 1_000_000)])) as Record<EdgeType, number>,
    };
    if (manual.areaSqFt <= 0) throw new Error("Enter the total roof area");
  } catch (e) {
    return json({ error: (e as Error).message }, 422);
  }
  const now = new Date().toISOString();
  const order: Order = {
    id: newOrderId(),
    token: newToken(),
    createdAt: now,
    updatedAt: now,
    kind: "manual",
    priceCents: 0,
    priceTier: "Manual",
    address,
    customer: { name: user.company || user.email, email: user.email, company: user.company, phone: user.phone },
    status: "delivered",
    events: [{ at: now, status: "delivered", message: "Manual report created" }],
    payment: { provider: "none" },
    source: { provider: "manual", label: "Manually entered quantities (not measured from imagery)" },
    manual,
  };
  await createOrder(order);
  const m = manualMeasurements(order);
  const pdf = await storePdf(order, await renderOrderPdf(order, m));
  const w = m.wasteTable.find((x) => x.pct === m.suggestedWastePct)!;
  await updateOrder(order.id, (o) => ({
    ...o,
    files: { pdf },
    summary: { totalAreaSqFt: m.totalAreaSqFt, squares: w.squares, predominantPitch: m.predominantPitch, facetCount: m.facetCount, suggestedWastePct: m.suggestedWastePct },
  }));
  return json({ id: order.id }, 201);
}
