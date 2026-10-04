import { deliverReport, notifyOperator } from "./email";
import { measureRoof } from "./measure";
import { renderReportPdf } from "./pdf";
import { NeedsReviewError, fetchAerialImage, fetchBuildingInsights, geocode } from "./solar";
import { getOrder, saveReport, updateOrder, withEvent } from "./store";
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
  const claimed = await updateOrder(id, (o) =>
    o.status === "queued" ? withEvent(o, "locating", "Locating property") : null,
  );
  if (!claimed) return getOrder(id);

  try {
    const loc = await geocode(claimed.address);
    const insights = await fetchBuildingInsights(loc.lat, loc.lng, claimed.address);
    const live = Boolean(process.env.GOOGLE_MAPS_API_KEY);
    const d = insights.imageryDate;
    const source = {
      provider: live ? ("google-solar" as const) : ("demo" as const),
      imageryDate: d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : undefined,
      imageryQuality: insights.imageryQuality,
    };
    await step(id, "measuring", `Found roof (${insights.solarPotential.roofSegmentStats.length} planes, ${source.imageryQuality ?? "?"} imagery)`, {
      location: { lat: loc.lat, lng: loc.lng, formattedAddress: loc.formattedAddress },
      source,
    });

    const m = measureRoof(insights);
    const suggested = m.wasteTable.find((w) => w.pct === m.suggestedWastePct)!;
    await step(id, "rendering", `Measured ${m.totalAreaSqFt.toLocaleString()} sq ft across ${m.facetCount} facets`, {
      summary: {
        totalAreaSqFt: m.totalAreaSqFt,
        squares: suggested.squares,
        predominantPitch: m.predominantPitch,
        facetCount: m.facetCount,
        suggestedWastePct: m.suggestedWastePct,
      },
    });

    const aerialPng = claimed.tier === "claims" ? await fetchAerialImage(loc.lat, loc.lng) : null;
    const pdf = await renderReportPdf({
      orderId: id,
      tier: claimed.tier,
      address: loc.formattedAddress,
      preparedFor: claimed.customer.company || claimed.customer.name,
      createdAt: new Date(),
      source,
      measurements: m,
      aerialPng,
    });
    const reportFile = await saveReport(id, pdf);
    const withReport = await step(id, "delivering", "Report generated", { reportFile });

    const method = await deliverReport(withReport!, pdf);
    return step(
      id,
      "delivered",
      method === "email" ? `Emailed to ${claimed.customer.email}` : "Ready to download (email not configured)",
      { delivery: { method, to: claimed.customer.email, sentAt: new Date().toISOString() } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const review = err instanceof NeedsReviewError;
    console.error(`[xtract] order ${id} ${review ? "needs review" : "failed"}:`, err);
    const o = await step(id, review ? "needs_review" : "failed", review ? message : "Processing error — our team has been notified", {
      error: message,
    });
    if (o) await notifyOperator(o, message).catch((e) => console.error("[xtract] notify failed", e));
    return o;
  }
}

/** Put a failed / needs-review order back in the queue (admin action). */
export async function requeue(id: string): Promise<boolean> {
  const o = await updateOrder(id, (x) =>
    x.status === "failed" || x.status === "needs_review" || x.status === "delivered"
      ? withEvent(x, "queued", "Re-queued by admin")
      : null,
  );
  return o !== null;
}
