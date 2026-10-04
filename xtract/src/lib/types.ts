// Shapes mirror the Google Solar API `buildingInsights:findClosest` response
// (only the fields the measurement engine reads).
export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface LatLngBox {
  sw: LatLng;
  ne: LatLng;
}

export interface SolarRoofSegment {
  pitchDegrees: number;
  azimuthDegrees: number;
  stats: { areaMeters2: number; groundAreaMeters2: number };
  center: LatLng;
  boundingBox: LatLngBox;
  planeHeightAtCenterMeters?: number;
}

export type ImageryQuality = "HIGH" | "MEDIUM" | "LOW" | "BASE";

export interface BuildingInsights {
  name?: string;
  center: LatLng;
  boundingBox?: LatLngBox;
  imageryDate?: { year: number; month: number; day: number };
  imageryQuality?: ImageryQuality;
  solarPotential: {
    wholeRoofStats: { areaMeters2: number; groundAreaMeters2: number };
    roofSegmentStats: SolarRoofSegment[];
  };
}

export type EdgeType =
  | "eave"
  | "rake"
  | "ridge"
  | "hip"
  | "valley"
  | "flash" // wall / headwall flashing
  | "step" // step flashing
  | "transition"
  | "parapet"
  | "unspecified";

/** Plan-view facet outline + slope: the format real roof measurement models use. */
export interface PolygonFacetInput {
  id: number;
  polygon: Pt[]; // plan view, feet
  pitch: number; // rise per 12
  azimuth: number; // downslope compass direction, degrees
}

export interface PolygonRoofModel {
  facets: PolygonFacetInput[];
}

/** Plan-view point in feet, x = east, y = north, origin at building center. */
export type Pt = [number, number];

export interface Facet {
  id: number;
  pitch: number; // rise per 12
  pitchDegrees: number;
  azimuth: number;
  direction: string;
  areaSqFt: number;
  polygon: Pt[];
  label: Pt;
}

export interface Edge {
  type: EdgeType;
  a: Pt;
  b: Pt;
  lengthFt: number;
}

export interface WasteRow {
  pct: number;
  areaSqFt: number;
  squares: number;
}

export interface MaterialLine {
  item: string;
  qty: number;
  unit: string;
  basis: string;
}

export interface RoofMeasurements {
  totalAreaSqFt: number;
  pitchedAreaSqFt: number;
  flatAreaSqFt: number;
  predominantPitchAreaSqFt: number;
  footprintSqFt: number;
  /** Edge categories the data source cannot detect (shown as "not measured"). */
  unmeasured: EdgeType[];
  facetCount: number;
  predominantPitch: number;
  pitchBreakdown: { pitch: number; areaSqFt: number; percent: number; squares: number }[];
  facets: Facet[];
  edges: Edge[];
  lengths: Record<EdgeType, number>;
  exactLengths: Record<EdgeType, number>;
  derived: { dripEdge: number; starter: number; ridgeCap: number; leakBarrier: number; iceWater: number };
  complexity: "Simple" | "Moderate" | "Complex";
  suggestedWastePct: number;
  wasteTable: WasteRow[];
  materials: MaterialLine[];
  brandMaterials: BrandMaterialGroup[];
}

export interface BrandMaterialGroup {
  label: string; // e.g. "Starter (eaves + rakes)"
  base: number; // quantity at 0% waste
  baseUnit: string; // "sqft" | "ft"
  rows: { product: string; unit: string; qty: number[] }[]; // qty per waste column
}

export type OrderStatus =
  | "awaiting_payment"
  | "queued"
  | "locating"
  | "measuring"
  | "rendering"
  | "delivering"
  | "delivered"
  | "needs_review"
  | "failed";

export interface OrderEvent {
  at: string;
  status: OrderStatus;
  message: string;
}

/** Manually entered quantities for a report without roof geometry. */
export interface ManualInputs {
  areaSqFt: number;
  facets: number;
  pitch: number;
  lengths: Partial<Record<EdgeType, number>>;
}

export interface Order {
  id: string;
  token: string; // secret for customer-facing status/download links
  createdAt: string;
  updatedAt: string;
  kind: "auto" | "manual";
  priceCents: number;
  priceTier: string;
  address: string;
  customer: { name: string; email: string; company?: string; phone?: string };
  notes?: string;
  status: OrderStatus;
  events: OrderEvent[];
  payment: { provider: "stripe" | "demo" | "none"; sessionId?: string; paidAt?: string };
  location?: { lat: number; lng: number; formattedAddress: string; county?: string };
  source?: { provider: "google-solar" | "demo" | "model" | "manual"; label: string; imageryDate?: string; imageryQuality?: string };
  property?: import("./property").PropertyRecord | null;
  manual?: ManualInputs;
  summary?: {
    totalAreaSqFt: number;
    squares: number;
    predominantPitch: number;
    facetCount: number;
    suggestedWastePct: number;
  };
  /** Files under the reports dir: PDF, measurement JSON, cover image. */
  files?: { pdf?: string; data?: string; aerial?: string; aerialKind?: "png" | "jpg"; photo?: string; photoKind?: "png" | "jpg" };
  delivery?: { method: "email" | "demo"; to: string; sentAt: string };
  error?: string;
}

export interface User {
  id: string;
  email: string;
  createdAt: string;
  company?: string;
  phone?: string;
}

export interface Message {
  id: string;
  at: string;
  name: string;
  email: string;
  message: string;
  userId?: string;
}
