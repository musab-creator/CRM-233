import { deliverReport, notifyOperator } from "./email";
import { measureOrder, renderOrderPdf, storeMeasurements, storePdf } from "./reports";
import { NeedsReviewError } from "./solar";
import { getOrder, saveFile, updateOrder, withEvent } from "./store";
import type { Order, OrderStatus } from "./types";

const step = (id: string, status: OrderStatus, message: string, patch: Partial<Order> = {}) =>
  updateOrder(id, (o) => withEvent(Object.assign(o, patch), status, message));

/**
 * Mark an order paid and queue it. Idempotent: returns false if the order
 * was already past payment (e.g. a Stripe webhook retry).
 */
export async function markPaid(id: string, sessionId?: string): Promise<boolean> {
  const updated = await updateOrder(id, (o) => {
    if (o.status !== "awaiting_payment") return null;
    o.payment = { ...o.payment, sessionId: sessionId ?? o.payment.sessionId, paidAt: new Date().toISOString() };
    return withEvent(o, "queued", o.payment.provider === "demo" ? "Demo order — payment skipped" : "Payment received");
  });
  return updated !== null;
}

/**
 * Run a queued order end to end. Claims the order atomically so concurrent
 * triggers (webhook retry + manual rerun) can't double-process it.
 */
export async function runOrder(id: string): Promise<Order | null> {
  const claimed = await updateOrder(id, (o) => (o.status === "queued" ? withEvent(o, "locating", "Locating property") : null));
  if (!claimed) return getOrder(id);

  try {
    const r = await measureOrder(claimed, async (msg) => {
      await step(id, "locating", msg);
    });
    const m = r.measurements;
    const files: Order["files"] = { ...claimed.files, data: await storeMeasurements(claimed, m) };
    if (r.aerial) {
      files.aerial = await saveFile(`${id}-aerial.${r.aerial.kind}`, r.aerial.bytes);
      files.aerialKind = r.aerial.kind;
    }
    const suggested = m.wasteTable.find((w) => w.pct === m.suggestedWastePct)!;
    const measured = await step(id, "rendering", `Measured ${m.totalAreaSqFt.toLocaleString()} sq ft across ${m.facetCount} facets`, {
      location: r.location,
      source: r.source,
      property: r.property ?? claimed.property ?? null,
      files,
      summary: {
        totalAreaSqFt: m.totalAreaSqFt,
        squares: suggested.squares,
        predominantPitch: m.predominantPitch,
        facetCount: m.facetCount,
        suggestedWastePct: m.suggestedWastePct,
      },
    });

    const pdf = await renderOrderPdf(measured!, m);
    const withPdf = await step(id, "delivering", "8-page report generated", { files: { ...files, pdf: await storePdf(measured!, pdf) } });

    const method = await deliverReport(withPdf!, pdf);
    return step(id, "delivered", method === "email" ? `Emailed to ${claimed.customer.email}` : "Ready to download (email not configured)", {
      delivery: { method, to: claimed.customer.email, sentAt: new Date().toISOString() },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const review = err instanceof NeedsReviewError;
    console.error(`[xtract] order ${id} ${review ? "needs review" : "failed"}:`, err);
    const o = await step(id, review ? "needs_review" : "failed", review ? message : "Processing error — our team has been notified", { error: message });
    if (o) await notifyOperator(o, message).catch((e) => console.error("[xtract] notify failed", e));
    return o;
  }
}

/** Re-render an existing report after its branding / permit info / photo changed. */
export async function regenerate(id: string): Promise<Order | null> {
  const o = await getOrder(id);
  if (!o) return null;
  const pdf = await renderOrderPdf(o);
  const file = await storePdf(o, pdf);
  return updateOrder(id, (x) => ({ ...x, files: { ...x.files, pdf: file } }));
}

/** Put a failed / needs-review order back in the queue (admin action). */
export async function requeue(id: string): Promise<boolean> {
  const o = await updateOrder(id, (x) =>
    x.kind === "auto" && (x.status === "failed" || x.status === "needs_review" || x.status === "delivered") ? withEvent(x, "queued", "Re-queued by admin") : null,
  );
  return o !== null;
}
