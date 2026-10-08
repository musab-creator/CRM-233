import { promises as fs } from "node:fs";
import path from "node:path";
import { measureManual, measureRoof } from "./measure";
import { renderReportPdf, type ReportInput } from "./pdf";
import { measurePolygonModel } from "./polygon";
import { lookupProperty } from "./property";
import { SAMPLE_PROPERTY, sampleRoofModel } from "./sampleModel";
import { fetchAerialImage, fetchBuildingInsights, geocode } from "./solar";
import { readFile, saveFile } from "./store";
import type { Order, RoofMeasurements } from "./types";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const isSampleAddress = (address: string) => norm(address).startsWith(norm("3436 State Rd 13 N"));

export function sampleMeasurements(): RoofMeasurements {
  return measurePolygonModel(sampleRoofModel());
}

export async function sampleAerial(): Promise<Uint8Array> {
  return fs.readFile(path.join(process.cwd(), "public", "sample-aerial.jpg"));
}

/** Locate + measure + fetch imagery and property records for an order. */
export async function measureOrder(order: Order, onStep: (msg: string) => Promise<void>) {
  if (isSampleAddress(order.address)) {
    const m = sampleMeasurements();
    await onStep(`Matched the supplied professional roof model (${m.facetCount} facets)`);
    return {
      location: { lat: SAMPLE_PROPERTY.lat, lng: SAMPLE_PROPERTY.lng, formattedAddress: SAMPLE_PROPERTY.address, county: SAMPLE_PROPERTY.county },
      source: { provider: "model" as const, label: "Supplied professional roof model · Google imagery", imageryDate: SAMPLE_PROPERTY.imageryDate },
      measurements: m,
      aerial: { bytes: await sampleAerial(), kind: "jpg" as const },
      property: {
        yearBuilt: SAMPLE_PROPERTY.builtYear,
        effectiveYearBuilt: SAMPLE_PROPERTY.builtYear,
        parcelId: SAMPLE_PROPERTY.parcel,
        county: SAMPLE_PROPERTY.county,
        source: "Supplied sample report (St. Johns County parcel record)",
        checkedAt: new Date().toISOString(),
        permitsChecked: false,
      },
    };
  }

  const loc = await geocode(order.address);
  await onStep(`Located ${loc.formattedAddress}`);
  const insights = await fetchBuildingInsights(loc.lat, loc.lng, order.address);
  const live = Boolean(process.env.GOOGLE_MAPS_API_KEY);
  const d = insights.imageryDate;
  const imageryDate = d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : undefined;
  const m = measureRoof(insights);
  const [png, property] = await Promise.all([fetchAerialImage(loc.lat, loc.lng), live ? lookupProperty(loc.lat, loc.lng, loc.county) : Promise.resolve(null)]);
  return {
    location: loc,
    source: live
      ? { provider: "google-solar" as const, label: `Google aerial imagery (${insights.imageryQuality ?? "?"} quality) · Google Solar API roof planes`, imageryDate, imageryQuality: insights.imageryQuality }
      : { provider: "demo" as const, label: "DEMO DATA — synthetic roof (no Google Maps key configured)", imageryDate },
    measurements: m,
    aerial: png ? { bytes: png, kind: "png" as const } : null,
    property,
  };
}

export function manualMeasurements(order: Order): RoofMeasurements {
  const i = order.manual!;
  return measureManual({ areaSqFt: i.areaSqFt, facets: i.facets, pitch: i.pitch, lengths: i.lengths });
}

/** Load stored measurements for a finished order. */
export async function loadMeasurements(order: Order): Promise<RoofMeasurements | null> {
  if (order.kind === "manual" && order.manual) return manualMeasurements(order);
  if (!order.files?.data) return null;
  return JSON.parse((await readFile(order.files.data)).toString("utf8"));
}

/** (Re)render the PDF from stored data with the order's current branding and permit info. */
export async function renderOrderPdf(order: Order, m?: RoofMeasurements): Promise<Uint8Array> {
  const measurements = m ?? (await loadMeasurements(order));
  if (!measurements) throw new Error("No measurements stored for this report");
  let aerial: ReportInput["aerial"] = null;
  if (order.files?.photo) aerial = { bytes: await readFile(order.files.photo), kind: order.files.photoKind ?? "jpg", credit: "Photo supplied ·" };
  else if (order.files?.aerial) aerial = { bytes: await readFile(order.files.aerial), kind: order.files.aerialKind ?? "png", credit: "Google" };
  return renderReportPdf({
    orderId: order.id,
    address: order.location?.formattedAddress ?? order.address,
    preparedBy: { company: order.customer.company || order.customer.name, phone: order.customer.phone },
    createdAt: new Date(order.createdAt),
    source: order.source ?? { provider: "manual", label: "Manually entered quantities" },
    measurements,
    aerial,
    property: order.property,
  } as ReportInput);
}

export async function storeMeasurements(order: Order, m: RoofMeasurements) {
  return saveFile(`${order.id}.json`, JSON.stringify(m));
}

export async function storePdf(order: Order, pdf: Uint8Array) {
  return saveFile(`${order.id}.pdf`, pdf);
}
