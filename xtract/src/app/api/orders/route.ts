import { NextRequest, NextResponse, after } from "next/server";
import { PRODUCTS, TIERS, appUrl, integrations } from "@/lib/config";
import { markPaid, runOrder } from "@/lib/pipeline";
import { createOrder, newOrderId, newToken, updateOrder } from "@/lib/store";
import { stripe } from "@/lib/stripe";
import type { Order, ReportTier } from "@/lib/types";

export const maxDuration = 60;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const tier = clean(body.tier) as ReportTier;
  const address = clean(body.address, 300);
  const name = clean(body.name, 120);
  const email = clean(body.email, 200).toLowerCase();
  const errors: Record<string, string> = {};
  if (!TIERS.includes(tier)) errors.tier = "Choose a report type";
  if (address.length < 8 || !/\d/.test(address)) errors.address = "Enter the full street address, including the number";
  if (!name) errors.name = "Enter your name";
  if (!EMAIL.test(email)) errors.email = "Enter a valid email — the report is delivered there";
  if (Object.keys(errors).length) return NextResponse.json({ errors }, { status: 422 });

  const product = PRODUCTS[tier];
  const live = integrations();
  const now = new Date().toISOString();
  const order: Order = {
    id: newOrderId(),
    token: newToken(),
    createdAt: now,
    updatedAt: now,
    tier,
    priceCents: product.priceCents,
    address,
    customer: {
      name,
      email,
      company: clean(body.company, 120) || undefined,
      phone: clean(body.phone, 40) || undefined,
    },
    notes: clean(body.notes, 1000) || undefined,
    status: "awaiting_payment",
    events: [{ at: now, status: "awaiting_payment", message: "Order placed" }],
    payment: { provider: live.stripe ? "stripe" : "demo" },
  };
  await createOrder(order);

  const statusUrl = `${appUrl()}/order/${order.id}?t=${order.token}`;

  if (!live.stripe) {
    // Demo mode: no payment, start processing right after responding.
    await markPaid(order.id);
    after(() => runOrder(order.id));
    return NextResponse.json({ id: order.id, redirectUrl: statusUrl });
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
          unit_amount: product.priceCents,
          product_data: { name: `Xtract ${product.name}`, description: address },
        },
      },
    ],
    success_url: statusUrl,
    cancel_url: `${appUrl()}/order?tier=${tier}&address=${encodeURIComponent(address)}&canceled=1`,
  });
  await updateOrder(order.id, (o) => ({ ...o, payment: { ...o.payment, sessionId: session.id } }));
  return NextResponse.json({ id: order.id, redirectUrl: session.url });
}
