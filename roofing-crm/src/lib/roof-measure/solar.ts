import { offsetLatLng, SQFT_PER_M2, type LatLng } from './geo';
import { degToPitch } from './format';
import type { BuildingInsights, SolarDate, SolarLatLng } from './model';

// Google Solar API: building insights (roof planes and pitch), the structure
// scan around the pin, and the data layers (roof mask + height model) that
// auto-trace and the commercial measure read. The API key is always a
// parameter; nothing here reads storage.

export const SOLAR_API = 'https://solar.googleapis.com/v1';

export class SolarApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function errorMessage(r: Response): Promise<string> {
  let msg = `HTTP ${r.status}`;
  try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch { /* not JSON */ }
  return msg;
}

// buildingInsights:findClosest for the building nearest a point.
export async function fetchBuildingInsights(lat: number, lng: number, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<BuildingInsights> {
  const url = `${SOLAR_API}/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${encodeURIComponent(apiKey)}`;
  const r = await fetchImpl(url);
  if (!r.ok) {
    let msg = await errorMessage(r);
    if (r.status === 404) msg = 'No Solar API coverage for this building. Trace the roof manually.';
    throw new SolarApiError(msg, r.status);
  }
  return r.json();
}
export type FetchBuilding = (lat: number, lng: number) => Promise<BuildingInsights>;

export interface SolarSegment { pitchDeg: number; pitch: number; az: number; area: number; ground: number; center: SolarLatLng }
export interface SolarSummary {
  segs: SolarSegment[]; // largest plane first
  total: number; // roof sqft
  ground: number; // footprint sqft
  predominant: number; // pitch (x/12, unrounded) of the largest plane
  center?: SolarLatLng;
  imageryDate: string | null; // YYYY-MM-DD
  quality?: string;
}

export const solarDateString = (d: SolarDate | undefined | null) => (d && d.year ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null);

export function solarSummaryOf(resp: BuildingInsights | null | undefined): SolarSummary | null {
  const sp = resp && resp.solarPotential;
  if (!sp || !resp) return null;
  const segs = (sp.roofSegmentStats || []).map((s) => ({
    pitchDeg: s.pitchDegrees, pitch: degToPitch(s.pitchDegrees), az: s.azimuthDegrees,
    area: s.stats.areaMeters2 * SQFT_PER_M2, ground: (s.stats.groundAreaMeters2 || 0) * SQFT_PER_M2, center: s.center,
  })).sort((a, b) => b.area - a.area);
  const total = sp.wholeRoofStats!.areaMeters2 * SQFT_PER_M2;
  const ground = (sp.wholeRoofStats!.groundAreaMeters2 || 0) * SQFT_PER_M2;
  const predominant = segs.length ? segs[0].pitch : 0;
  const d = resp.imageryDate;
  return { segs, total, ground, predominant, center: resp.center, imageryDate: d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null, quality: resp.imageryQuality };
}

// Compass direction of a plane azimuth.
export const compassDir = (az: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];

// The 24 probe points of "Scan for other structures": rings at 12, 24 and 36 m, every 45 degrees.
export function scanProbePoints(center: LatLng): LatLng[] {
  const pts: LatLng[] = [];
  for (const r of [12, 24, 36]) for (let a = 0; a < 360; a += 45) pts.push(offsetLatLng(center.lat, center.lng, r, a));
  return pts;
}

// Probes the ring around the pin, six requests at a time, and returns every other building Google knows
// about (detached garages, sheds, pool houses), keyed by building name.
export async function scanStructures(center: LatLng, mainName: string | null | undefined, fetchBuilding: FetchBuilding): Promise<BuildingInsights[]> {
  const pts = scanProbePoints(center);
  const found: Record<string, BuildingInsights> = {};
  for (let i = 0; i < pts.length; i += 6) {
    await Promise.all(pts.slice(i, i + 6).map(async (p) => {
      try { const j = await fetchBuilding(p.lat, p.lng); if (j.name && j.name !== mainName) found[j.name] = j; } catch { /* no building near this probe */ }
    }));
  }
  return Object.values(found);
}

export interface DataLayers { imageryDate?: SolarDate; imageryQuality?: string; maskUrl?: string; dsmUrl?: string; rgbUrl?: string; [k: string]: unknown }

// Residential data layers (auto-trace): 0.1 m pixels, LOW quality allowed.
export async function fetchDataLayers(lat: number, lng: number, radius: number, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<DataLayers> {
  const url = `${SOLAR_API}/dataLayers:get?location.latitude=${lat}&location.longitude=${lng}&radiusMeters=${radius}&view=IMAGERY_LAYERS&requiredQuality=LOW&pixelSizeMeters=0.1&key=${encodeURIComponent(apiKey)}`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error('Data layers: ' + (await errorMessage(r)));
  return r.json();
}

// Commercial data layers: any radius up to 100 m at 0.1 m pixels; above that the radius must be <= pixel size x 1000.
export async function fetchCommercialDataLayers(lat: number, lng: number, radius: number, px: number, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<DataLayers> {
  const url = `${SOLAR_API}/dataLayers:get?location.latitude=${lat.toFixed(7)}&location.longitude=${lng.toFixed(7)}&radiusMeters=${radius}&view=IMAGERY_LAYERS&requiredQuality=BASE&exactQualityRequired=false&pixelSizeMeters=${px}&key=${encodeURIComponent(apiKey)}`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new SolarApiError('Data layers: ' + (await errorMessage(r)), r.status);
  return r.json();
}

// Downloads a data-layer GeoTIFF (the layer URLs need the key appended).
export async function downloadLayer(url: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  const r = await fetchImpl(url + '&key=' + encodeURIComponent(apiKey));
  if (!r.ok) throw new Error('GeoTIFF download failed (' + r.status + ')');
  return r.arrayBuffer();
}
