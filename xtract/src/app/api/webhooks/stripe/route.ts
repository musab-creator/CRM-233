import { NextRequest, NextResponse, after } from "next/server";
import type Stripe from "stripe";
import { markPaid, runOrder } from "@/lib/pipeline";
import { stripe } from "@/lib/stripe";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 501 });

  let event: Stripe.Event;
  try {
    // Signature is computed over the raw body — read it as text.
    event = stripe().webhooks.constructEvent(await req.text(), req.headers.get("stripe-signature") ?? "", secret);
  } catch (err) {
    return NextResponse.json({ error: `Bad signature: ${(err as Error).message}` }, { status: 400 });
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.orderId;
    if (orderId && session.payment_status === "paid") {
      // markPaid is idempotent, so Stripe retries never double-run an order.
      if (await markPaid(orderId, session.id)) after(() => runOrder(orderId));
    }
  }
  return NextResponse.json({ received: true });
}
