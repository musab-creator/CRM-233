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

export type EdgeType = "eave" | "rake" | "ridge" | "hip" | "valley" | "flash";

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
  footprintSqFt: number;
  facetCount: number;
  predominantPitch: number;
  pitchBreakdown: { pitch: number; areaSqFt: number; percent: number }[];
  facets: Facet[];
  edges: Edge[];
  lengths: Record<EdgeType, number>;
  derived: { dripEdge: number; starter: number; ridgeCap: number; leakBarrier: number };
  complexity: "Simple" | "Moderate" | "Complex";
  suggestedWastePct: number;
  wasteTable: WasteRow[];
  materials: MaterialLine[];
}

export type ReportTier = "quick" | "full" | "claims";

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

export interface Order {
  id: string;
  token: string; // secret for customer-facing status/download links
  createdAt: string;
  updatedAt: string;
  tier: ReportTier;
  priceCents: number;
  address: string;
  customer: { name: string; email: string; company?: string; phone?: string };
  notes?: string;
  status: OrderStatus;
  events: OrderEvent[];
  payment: { provider: "stripe" | "demo"; sessionId?: string; paidAt?: string };
  location?: { lat: number; lng: number; formattedAddress: string };
  source?: { provider: "google-solar" | "demo"; imageryDate?: string; imageryQuality?: string };
  summary?: {
    totalAreaSqFt: number;
    squares: number;
    predominantPitch: number;
    facetCount: number;
    suggestedWastePct: number;
  };
  reportFile?: string;
  delivery?: { method: "email" | "demo"; to: string; sentAt: string };
  error?: string;
}
