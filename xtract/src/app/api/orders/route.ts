import { NextRequest, after } from "next/server";
import { sameOrigin, currentUser } from "@/lib/auth";
import { json } from "@/lib/access";
import { appUrl, formatPrice, integrations, tierFor } from "@/lib/config";
import { markPaid, runOrder } from "@/lib/pipeline";
import { createOrder, monthlyCount, newOrderId, newToken, updateOrder, upsertUser } from "@/lib/store";
import { stripe } from "@/lib/stripe";
import type { Order } from "@/lib/types";

export const maxDuration = 60;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json({ error: "Request rejected" }, 403);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  const user = await currentUser();
  const address = clean(body.address, 300);
  const name = clean(body.name, 120);
  const email = (user?.email ?? clean(body.email, 200)).toLowerCase();
  const errors: Record<string, string> = {};
  if (address.length < 8 || !/\d/.test(address)) errors.address = "Enter the full street address, including the number";
  if (!name) errors.name = "Enter your name";
  if (!EMAIL.test(email)) errors.email = "Enter a valid email — the report is delivered there";
  if (Object.keys(errors).length) return json({ errors }, 422);

  const company = clean(body.company, 120) || user?.company || undefined;
  const phone = clean(body.phone, 40) || user?.phone || undefined;
  if (user && (company !== user.company || phone !== user.phone)) await upsertUser(user.email, { company, phone });

  // Volume pricing: rate for this report's position in the month.
  const tier = tierFor((await monthlyCount(email)) + 1);
  const live = integrations();
  const now = new Date().toISOString();
  const order: Order = {
    id: newOrderId(),
    token: newToken(),
    createdAt: now,
    updatedAt: now,
    kind: "auto",
    priceCents: tier.cents,
    priceTier: tier.name,
    address,
    customer: { name, email, company, phone },
    notes: clean(body.notes, 1000) || undefined,
    status: "awaiting_payment",
    events: [{ at: now, status: "awaiting_payment", message: `Order placed (${tier.name} · ${formatPrice(tier.cents)})` }],
    payment: { provider: live.stripe ? "stripe" : "demo" },
  };
  await createOrder(order);

  const statusUrl = `${appUrl()}/order/${order.id}?t=${order.token}`;
  if (!live.stripe) {
    await markPaid(order.id);
    after(() => runOrder(order.id));
    return json({ id: order.id, redirectUrl: statusUrl });
  }

  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: email,
    client_reference_id: order.id,
    metadata: { orderId: order.id },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: tier.cents,
          product_data: { name: "Xtract Roof Report (8 pages)", description: address },
        },
      },
    ],
    success_url: statusUrl,
    cancel_url: `${appUrl()}/order?address=${encodeURIComponent(address)}&canceled=1`,
  });
  await updateOrder(order.id, (o) => ({ ...o, payment: { ...o.payment, sessionId: session.id } }));
  return json({ id: order.id, redirectUrl: session.url });
}
