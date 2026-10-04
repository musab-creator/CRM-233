import type { BuildingInsights, LatLng, SolarRoofSegment } from "./types";

const FT_PER_M = 3.28084;

export class NeedsReviewError extends Error {}

export interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ---------------------------------------------------------------------------
// Live: Google Geocoding + Solar API
// ---------------------------------------------------------------------------

export async function geocode(address: string): Promise<GeocodeResult> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return demoGeocode(address);

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", key);
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  if (data.status !== "OK" || !data.results?.length) {
    throw new NeedsReviewError(`Address could not be located (${data.status})`);
  }
  const r = data.results[0];
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formattedAddress: r.formatted_address };
}

export async function fetchBuildingInsights(lat: number, lng: number, seed: string): Promise<BuildingInsights> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return demoBuildingInsights(lat, lng, seed);

  const url = new URL("https://solar.googleapis.com/v1/buildingInsights:findClosest");
  url.searchParams.set("location.latitude", String(lat));
  url.searchParams.set("location.longitude", String(lng));
  // MEDIUM is the minimum we accept; HIGH is returned when available.
  url.searchParams.set("requiredQuality", "MEDIUM");
  url.searchParams.set("key", key);
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) throw new NeedsReviewError("No building with usable roof imagery at this address");
  if (!res.ok) throw new Error(`Solar API error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as BuildingInsights;
  if (!data.solarPotential?.roofSegmentStats?.length) {
    throw new NeedsReviewError("Imagery found but no roof planes were detected");
  }
  return data;
}

/** Satellite tile for the Claims Pro imagery page (PNG bytes), or null. */
export async function fetchAerialImage(lat: number, lng: number): Promise<Uint8Array | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
  url.searchParams.set("center", `${lat},${lng}`);
  url.searchParams.set("zoom", "20");
  url.searchParams.set("size", "640x640");
  url.searchParams.set("scale", "2");
  url.searchParams.set("maptype", "satellite");
  url.searchParams.set("format", "png");
  url.searchParams.set("key", key);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Demo mode: deterministic, geometrically consistent roofs per address
// ---------------------------------------------------------------------------

function demoGeocode(address: string): GeocodeResult {
  const r = rng(hash(address.toLowerCase()));
  // Scatter around Jacksonville, FL.
  return { lat: 30.2 + r() * 0.25, lng: -81.75 + r() * 0.35, formattedAddress: address.trim() };
}

type PlanPt = [number, number]; // metres, x = east, y = north

interface PlaneSpec {
  poly: PlanPt[];
  azimuth: number;
  pitchDeg: number;
}

function hipBlock(cx: number, cy: number, L: number, D: number, pitchDeg: number, alongX: boolean): PlaneSpec[] {
  // Rectangle L (ridge direction) × D; hips at both ends.
  const R = D / 2;
  const half = L / 2;
  const top = Math.max(half - R, 0);
  const pts = (list: PlanPt[]): PlanPt[] =>
    list.map(([x, y]) => (alongX ? [cx + x, cy + y] : [cx + y, cy + x]) as PlanPt);
  const az = (a: number) => (alongX ? a : (450 - a) % 360);
  return [
    { poly: pts([[-half, -R], [half, -R], [top, 0], [-top, 0]]), azimuth: az(180), pitchDeg },
    { poly: pts([[half, R], [-half, R], [-top, 0], [top, 0]]), azimuth: az(0), pitchDeg },
    { poly: pts([[half, -R], [half, R], [top, 0]]), azimuth: az(90), pitchDeg },
    { poly: pts([[-half, R], [-half, -R], [-top, 0]]), azimuth: az(270), pitchDeg },
  ];
}

function gableBlock(cx: number, cy: number, L: number, D: number, pitchDeg: number): PlaneSpec[] {
  const R = D / 2;
  const h = L / 2;
  return [
    { poly: [[cx - h, cy - R], [cx + h, cy - R], [cx + h, cy], [cx - h, cy]], azimuth: 180, pitchDeg },
    { poly: [[cx + h, cy + R], [cx - h, cy + R], [cx - h, cy], [cx + h, cy]], azimuth: 0, pitchDeg },
  ];
}

function polyArea(poly: PlanPt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function demoBuildingInsights(lat: number, lng: number, seed: string): BuildingInsights {
  const r = rng(hash(seed.toLowerCase()) ^ 0x9e3779b9);
  const ft = (f: number) => f / FT_PER_M;
  const pitchDeg = (Math.atan((4 + Math.floor(r() * 5)) / 12) * 180) / Math.PI; // 4/12 – 8/12
  const L = ft(48 + r() * 30);
  const D = ft(28 + r() * 10);
  const kind = r();

  let planes: PlaneSpec[];
  if (kind < 0.25) {
    planes = gableBlock(0, 0, L, D, pitchDeg);
  } else if (kind < 0.6) {
    planes = hipBlock(0, 0, L, D, pitchDeg, true);
  } else {
    // L-shaped: main hip + a hip-ended wing running south, joined by two
    // valleys, plus an optional low-pitch porch.
    const wingW = Math.min(ft(22 + r() * 6), D - ft(8));
    const Rw = wingW / 2;
    const wingL = ft(18 + r() * 8);
    const wx = -L / 2 + Rw + ft(6);
    const y0 = -D / 2;
    const y1 = y0 - wingL;
    planes = [
      ...hipBlock(0, 0, L, D, pitchDeg, true),
      { poly: [[wx + Rw, y1], [wx + Rw, y0], [wx, y0 + Rw], [wx, y1 + Rw]], azimuth: 90, pitchDeg },
      { poly: [[wx - Rw, y0], [wx - Rw, y1], [wx, y1 + Rw], [wx, y0 + Rw]], azimuth: 270, pitchDeg },
      { poly: [[wx - Rw, y1], [wx + Rw, y1], [wx, y1 + Rw]], azimuth: 180, pitchDeg },
    ];
    if (r() > 0.4) {
      const porchPitch = (Math.atan(3 / 12) * 180) / Math.PI;
      planes.push({
        poly: [[L / 2 - ft(20), -D / 2 - ft(8)], [L / 2 - ft(2), -D / 2 - ft(8)], [L / 2 - ft(2), -D / 2], [L / 2 - ft(20), -D / 2]],
        azimuth: 180,
        pitchDeg: porchPitch,
      });
    }
  }

  const mPerDegLat = 110_540;
  const mPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  const toLatLng = ([x, y]: PlanPt): LatLng => ({ latitude: lat + y / mPerDegLat, longitude: lng + x / mPerDegLng });

  const segments: SolarRoofSegment[] = planes.map((p) => {
    const xs = p.poly.map((q) => q[0]);
    const ys = p.poly.map((q) => q[1]);
    const ground = polyArea(p.poly);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    return {
      pitchDegrees: p.pitchDeg,
      azimuthDegrees: p.azimuth,
      stats: { areaMeters2: ground / Math.cos((p.pitchDeg * Math.PI) / 180), groundAreaMeters2: ground },
      center: toLatLng([cx, cy]),
      boundingBox: {
        sw: toLatLng([Math.min(...xs), Math.min(...ys)]),
        ne: toLatLng([Math.max(...xs), Math.max(...ys)]),
      },
    };
  });

  const ground = segments.reduce((s, x) => s + x.stats.groundAreaMeters2, 0);
  const area = segments.reduce((s, x) => s + x.stats.areaMeters2, 0);
  const now = new Date();
  return {
    name: `demo/${hash(seed).toString(16)}`,
    center: { latitude: lat, longitude: lng },
    imageryDate: { year: now.getFullYear() - 1, month: 1 + Math.floor(r() * 12), day: 1 + Math.floor(r() * 27) },
    imageryQuality: "HIGH",
    solarPotential: {
      wholeRoofStats: { areaMeters2: area, groundAreaMeters2: ground },
      roofSegmentStats: segments,
    },
  };
}
