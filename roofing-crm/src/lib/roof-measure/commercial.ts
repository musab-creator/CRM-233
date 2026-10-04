import type { LatLng } from './geo';
import { fmt } from './format';
import type { BuildingInsights, SolarDate } from './model';
import { downloadLayer, fetchCommercialDataLayers, solarDateString, SolarApiError, type FetchBuilding } from './solar';
import { dominantAngle, dpSimplify, loadTiff, regionOuterLoop, type Pt, type Raster } from './autotrace/raster';
import { angleBetween, fillHoles, growRegions, intersect2, lineFromPts, lineWithDir, localPlanes, mergeRegions, PlaneAcc, topology, type GeoFrame, type Line2, type Plane } from './autotrace/v2';

// Commercial (low-slope / flat) roof measuring (the tool's commercial.js):
// outline squared to the building, roof sections by elevation, parapets and
// open edges, walls between levels, rooftop equipment, ASCE 7-22 wind zones,
// drains / scuppers and the material estimate per roof system. Coordinates
// in the model are metres east / north of the request centre; model.toLL()
// converts a point to lat/lng.

export const COM = {
  maxRadius: 250, // data layers radius limit at 0.25 m pixels (m)
  sectionMinM2: 25, // smaller planar pieces are not roof sections
  sectionMinFrac: 0.01,
  levelMergeM: 0.2, // adjacent flat pieces closer than this in height are one roof level
  wallMinM: 0.3, // height step that counts as a wall between levels
  parapetMinM: 0.3, // raised perimeter that counts as a parapet wall (12")
  parapetMaxM: 2.45, // taller perimeter walls are walls of a higher roof part / screen walls (8 ft)
  objMinH: 0.3, // rooftop object: at least this high above the roof surface
  objMinM2: 0.12,
  bandM: 1.0, // parapet band excluded from rooftop object search
  steepSlope: 2 / 12, // ASTM / FBC: low-slope roofs are below 2:12
};
const SQFT = 10.7639104, FT = 3.28084;

// Typical manufacturer coverage data; see the tool's README for sources.
export const COM_RULES = {
  rollSqft: { tpo: 1000, pvc: 1000, epdm: 1000 } as Record<string, number>, // single-ply rolls 10' x 100'
  rollNetWidthFt: { tpo: 9.54, pvc: 9.54, epdm: 9.75 } as Record<string, number>, // net width after side laps
  halfSheetFt: 5, // perimeter half-sheets
  boardSqft: 32, // 4' x 8' polyiso / cover board
  insulFastPerBoard: { field: 8, perimeter: 12, corner: 14 },
  cover: { name: '1/2" HD polyiso cover board 4\' x 8\' (R-2.5)', r: 2.5 },
  seamFastSpacingIn: { field: 12, perimeter: 6 },
  adhesiveSqftPerGal: 60,
  adhesivePail: 5,
  wallFlashExtraFt: 1.0, // membrane up the parapet and over the top under the coping
  curbFlashFt: 1.5, // 8"-14" curb + 6" base flange
  wallStepFlashMaxFt: 3,
  tJointPerRoll: 2, cutEdgeLfPerBottle: 225, epdmPrimerSqftPerGal: 250, seamTapeRollFt: 100,
  termBarFt: 10, copingFt: 12, edgeMetalFt: 10,
  walkPadsPerRtu: 4,
  drainSqft: 5600, // drains ~75 ft apart
  rainInHr: 4.3, // Jacksonville 100-yr 1-hr
  modbit: { baseSqftPerRoll: 150, capSqftPerRoll: 96, primerSqftPerGal: 100, flashSqftPerRoll: 96 },
  silicone: { galPerSq: 1.5, galPerSqGranulated: 2.0, primerGalPerSq: 0.5, fabricRollFt: 300, pail: 5 },
  polyisoR: [[1.0, 5.6], [1.5, 8.6], [2.0, 11.4], [2.2, 12.6], [2.5, 14.4], [2.6, 15.0], [3.0, 17.4], [3.5, 20.5], [4.0, 23.6]],
  energyR: 25, // FBC-EC 2023, climate zone 2A: R-25ci above deck
  wasteDefault: { tpo: 10, pvc: 10, epdm: 10, modbit: 12, silicone: 10, insulation: 5 } as Record<string, number>,
};
export type CommercialSystem = 'tpo_ma' | 'tpo_fa' | 'pvc_ma' | 'epdm_fa' | 'modbit' | 'silicone';
export const COM_SYSTEMS: Record<CommercialSystem, { name: string; mem: string; attach?: string }> = {
  tpo_ma: { name: 'TPO 60 mil, mechanically attached', mem: 'tpo', attach: 'ma' },
  tpo_fa: { name: 'TPO 60 mil, fully adhered', mem: 'tpo', attach: 'fa' },
  pvc_ma: { name: 'PVC 60 mil, mechanically attached', mem: 'pvc', attach: 'ma' },
  epdm_fa: { name: 'EPDM 60 mil, fully adhered', mem: 'epdm', attach: 'fa' },
  modbit: { name: 'SBS modified bitumen, 2-ply (base + granulated cap)', mem: 'modbit' },
  silicone: { name: 'Silicone roof coating (restoration over existing)', mem: 'silicone' },
};

// The commercial panel's settings (site counts are strings: '' = use the estimate).
export interface CommercialOptions {
  system: CommercialSystem | string; waste: number; rTarget: number; cover: boolean; taper: boolean;
  drains: string; scuppers: string; skylights: string; hatches: string; heightFt: string; windMph: number;
}
export const COMMERCIAL_DEFAULTS: CommercialOptions = { system: 'tpo_ma', waste: 10, rTarget: 25, cover: true, taper: false, drains: '', scuppers: '', skylights: '', hatches: '', heightFt: '', windMph: 130 };
export const COMMERCIAL_OPTIONS_KEY = 'rm.comOpts';

// ------------------------------------------------------------------ data

export interface CommercialRasters { mT: Raster; dT: Raster; px: number; radius: number; imageryDate?: SolarDate; quality?: string }

// Solar API: any radius up to 100 m at 0.1 m pixels; above 100 m the radius must be <= pixelSize x 1000.
export const pxFor = (radius: number) => (radius <= 100 ? 0.1 : radius <= 250 ? 0.25 : 0.5);

// Downloads the mask and height model, stepping to coarser pixels when the API refuses the size.
export async function loadCommercialRasters(lat: number, lng: number, radius: number, apiKey: string, fetchImpl: typeof fetch = fetch, cache?: Map<string, CommercialRasters>): Promise<CommercialRasters> {
  const px = pxFor(radius); let lastErr: unknown = null;
  for (const tryPx of [px, 0.25, 0.5, 1].filter((v, i, a) => v >= px && a.indexOf(v) === i)) {
    const tag = `${lat.toFixed(6)}_${lng.toFixed(6)}_${radius}_${tryPx}`;
    const hit = cache && cache.get(tag); if (hit) return hit;
    try {
      const layers = await fetchCommercialDataLayers(lat, lng, radius, tryPx, apiKey, fetchImpl);
      if (!layers.maskUrl || !layers.dsmUrl) throw new Error('No roof mask / surface model here');
      const [mB, dB] = await Promise.all([downloadLayer(layers.maskUrl, apiKey, fetchImpl), downloadLayer(layers.dsmUrl, apiKey, fetchImpl)]);
      const [mT, dT] = await Promise.all([loadTiff(mB), loadTiff(dB)]);
      const out = { mT, dT, px: tryPx, radius, imageryDate: layers.imageryDate, quality: layers.imageryQuality };
      if (cache) cache.set(tag, out);
      return out;
    } catch (e) { lastErr = e; if (e instanceof SolarApiError && e.status !== 400) throw e; }
  }
  throw lastErr || new Error('Data layers unavailable');
}
export type LoadCommercialRasters = (lat: number, lng: number, radius: number) => Promise<CommercialRasters>;

// ------------------------------------------------------------------ model

export interface CommercialSection {
  sid: number; plane: Plane | null; slope: number; areaM2: number; elevM: number | null; z: number | null; steep: boolean; azimuth: number | null;
  letter: string; slopedM2: number; label: Pt | null; labelRoomM: number; poly: Pt[];
}
export interface CommercialWall { a: string; b: string; higher: string; heightM: number; lenM: number; kind: 'wall' | 'joint' | 'transition'; segs: Pt[][]; mid: Pt }
export interface CommercialObject { id: number; type: string; areaM2: number; lenM: number; widM: number; hM: number; curbM: number; center: Pt; corners: Pt[] }
export interface CommercialEdge { a: Pt; b: Pt; lenM: number; kind: 'parapet' | 'tallwall' | 'edge'; parapetM: number; parapetFrac: number; dropM: number; court: boolean }
export interface CommercialModel {
  touchesBorder: boolean; theta: number; toLL: (p: Pt) => LatLng; geo: { cLat: number; cLng: number; kx: number; ky: number }; pxM: number; groundZ: number | null;
  outline: Pt[]; courtyards: Pt[][]; planM2: number; sections: CommercialSection[]; walls: CommercialWall[]; objects: CommercialObject[]; edges: CommercialEdge[];
  convex: number; reflex: number; roofHeightM: number | null | undefined; maxElevM: number; pixelAreaM2: number; cellM: number;
  radius?: number; px?: number; imageryDate?: string | null; quality?: string | null; solarName?: string | null; ms?: number; address?: string; buildingName?: string;
}

// target: the pin; opts.footprint (batch testing only) sizes the request from a known outline [[lat, lng], ...].
export async function measureCommercial(target: LatLng, deps: { fetchBuilding: FetchBuilding; loadRasters: LoadCommercialRasters }, opts: { footprint?: number[][] } = {}): Promise<CommercialModel> {
  const t0 = Date.now();
  let lat = target.lat, lng = target.lng, half = 35;
  let bi: BuildingInsights | null = null;
  try { bi = await deps.fetchBuilding(lat, lng); } catch { bi = null; }
  const kx0 = 111320 * Math.cos((lat * Math.PI) / 180), ky0 = 110540;
  if (bi && bi.boundingBox) {
    const bb = bi.boundingBox; const cLat = (bb.sw.latitude + bb.ne.latitude) / 2, cLng = (bb.sw.longitude + bb.ne.longitude) / 2;
    const off = Math.hypot((cLng - lng) * kx0, (cLat - lat) * ky0);
    const hd = Math.hypot((bb.ne.longitude - bb.sw.longitude) * kx0, (bb.ne.latitude - bb.sw.latitude) * ky0) / 2;
    if (off < hd + 25) { lat = cLat; lng = cLng; half = Math.max(half, hd); }
  }
  if (opts.footprint && opts.footprint.length) {
    const la = opts.footprint.map((p) => p[0]), lo = opts.footprint.map((p) => p[1]);
    lat = (Math.min(...la) + Math.max(...la)) / 2; lng = (Math.min(...lo) + Math.max(...lo)) / 2;
    half = Math.hypot((Math.max(...lo) - Math.min(...lo)) * kx0, (Math.max(...la) - Math.min(...la)) * ky0) / 2;
  }
  let radius = Math.min(COM.maxRadius, Math.max(25, Math.ceil(half + 12)));
  let R: CommercialRasters | null = null, M: CommercialModel | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    R = await deps.loadRasters(lat, lng, radius);
    M = analyseCommercial(R, lat, lng, bi, target);
    if (!M.touchesBorder || radius >= COM.maxRadius) break;
    // the roof runs off the downloaded area: re-centre on what we found and ask for a bigger area
    const xs = M.outline.map((p) => p[0]), ys = M.outline.map((p) => p[1]); const c = M.toLL([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
    lat = c.lat; lng = c.lng; radius = Math.min(COM.maxRadius, Math.ceil(radius * 1.7));
  }
  const m = M!, r = R!;
  m.radius = radius; m.px = r.px; m.imageryDate = solarDateString(r.imageryDate) || (bi && solarDateString(bi.imageryDate)); m.quality = r.quality || (bi && bi.imageryQuality);
  m.solarName = bi ? bi.name : null; m.ms = Date.now() - t0;
  return m;
}

export function analyseCommercial(R: Pick<CommercialRasters, 'mT' | 'dT' | 'quality'>, cLat: number, cLng: number, bi: BuildingInsights | null, target: LatLng): CommercialModel {
  const { mT, dT } = R; const w = mT.w, h = mT.h, N = w * h; const dsm = dT.data;
  const kx = 111320 * Math.cos((cLat * Math.PI) / 180), ky = 110540;
  const Ecol = new Float64Array(w + 1), Nrow = new Float64Array(h + 1);
  for (let x = 0; x <= w; x++) Ecol[x] = (mT.toLL(x, 0).lng - cLng) * kx;
  for (let y = 0; y <= h; y++) Nrow[y] = (mT.toLL(0, y).lat - cLat) * ky;
  const geo: GeoFrame = {
    ref: { lat: cLat, lng: cLng, kx, ky },
    E: (x) => { const i = Math.max(0, Math.min(w - 1, Math.floor(x))); const f = x - i; return Ecol[i] + f * (Ecol[i + 1] - Ecol[i]); },
    N: (y) => { const i = Math.max(0, Math.min(h - 1, Math.floor(y))); const f = y - i; return Nrow[i] + f * (Nrow[i + 1] - Nrow[i]); },
    X: (E) => ((E - Ecol[0]) / (Ecol[w] - Ecol[0])) * w, Y: (Nm) => ((Nm - Nrow[0]) / (Nrow[h] - Nrow[0])) * h,
    pxM2: Math.abs((Ecol[1] - Ecol[0]) * (Nrow[1] - Nrow[0])),
  };
  const pxM = Math.sqrt(geo.pxM2);
  const toLL = (p: Pt): LatLng => ({ lat: cLat + p[1] / ky, lng: cLng + p[0] / kx });
  const mask = new Uint8Array(N); for (let i = 0; i < N; i++) mask[i] = mT.data[i] > 0 ? 1 : 0;
  // ---- connected roof pieces
  const lab = new Int32Array(N).fill(-1); const comps: { id: number; n: number; bbox: number[]; inBox: number; dPin: number }[] = []; const q = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i] || lab[i] >= 0) continue; const id = comps.length; let hd = 0, tl = 0; q[tl++] = i; lab[i] = id; let x0 = w, x1 = 0, y0 = h, y1 = 0;
    while (hd < tl) {
      const j = q[hd++]; const x = j % w, y = (j - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[j - 1] && lab[j - 1] < 0) { lab[j - 1] = id; q[tl++] = j - 1; } if (x < w - 1 && mask[j + 1] && lab[j + 1] < 0) { lab[j + 1] = id; q[tl++] = j + 1; }
      if (y > 0 && mask[j - w] && lab[j - w] < 0) { lab[j - w] = id; q[tl++] = j - w; } if (y < h - 1 && mask[j + w] && lab[j + w] < 0) { lab[j + w] = id; q[tl++] = j + w; }
    }
    comps.push({ id, n: tl, bbox: [x0, y0, x1, y1], inBox: 0, dPin: Infinity });
  }
  if (!comps.length) throw new Error('Google has no roof data at this spot (the building may be newer than the imagery). Measure it by hand on the Residential tab.');
  // ---- pick the building: overlap with Google's building box, else the piece under / nearest the pin
  const pin = [(target.lng - cLng) * kx, (target.lat - cLat) * ky];
  let box: number[] | null = null;
  if (bi && bi.boundingBox) { const bb = bi.boundingBox; box = [(bb.sw.longitude - cLng) * kx - 2, (bb.ne.longitude - cLng) * kx + 2, (bb.sw.latitude - cLat) * ky - 2, (bb.ne.latitude - cLat) * ky + 2]; }
  const step = Math.max(1, Math.round(0.5 / pxM));
  for (let y = 0; y < h; y += step) {
    const Nm = geo.N(y + 0.5);
    for (let x = 0; x < w; x += step) {
      const i = y * w + x; if (lab[i] < 0) continue; const c = comps[lab[i]]; const Em = geo.E(x + 0.5);
      if (box && Em >= box[0] && Em <= box[1] && Nm >= box[2] && Nm <= box[3]) c.inBox++; const d = Math.hypot(Em - pin[0], Nm - pin[1]); if (d < c.dPin) c.dPin = d;
    }
  }
  const minN = 40 / geo.pxM2;
  let main: (typeof comps)[number] | null | undefined = null;
  const underPin = comps.filter((c) => c.dPin < 1.5 && c.n >= minN).sort((a, b) => b.n - a.n)[0];
  if (underPin) main = underPin;
  else if (box) main = comps.filter((c) => c.inBox > 0).sort((a, b) => b.inBox - a.inBox)[0] || null;
  if (!main) main = comps.filter((c) => c.n >= minN && c.dPin < 40).sort((a, b) => a.dPin - b.dPin)[0];
  if (!main) throw new Error('No commercial-size roof near this location');
  const touchesBorder = main.bbox[0] <= 1 || main.bbox[1] <= 1 || main.bbox[2] >= w - 2 || main.bbox[3] >= h - 2;
  const member = new Uint8Array(N); for (let i = 0; i < N; i++) if (lab[i] === main.id) member[i] = 1;
  // ---- ground and holes (courtyards stay open, unmasked equipment / skylights inside the roof are filled)
  const outside = new Uint8Array(N);
  {
    let hd = 0, tl = 0;
    for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = y * w + x; if (!member[i] && !outside[i]) { outside[i] = 1; q[tl++] = i; } }
    for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const i = y * w + x; if (!member[i] && !outside[i]) { outside[i] = 1; q[tl++] = i; } }
    while (hd < tl) { const j = q[hd++]; const x = j % w; for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) { if (k < 0 || k >= N || member[k] || outside[k]) continue; outside[k] = 1; q[tl++] = k; } }
  }
  const gv: number[] = []; for (let i = 0; i < N; i += 11) if (outside[i] && !mask[i] && dsm[i] > -1000) gv.push(dsm[i]); gv.sort((a, b) => a - b);
  const groundZ = gv.length ? gv[Math.floor(gv.length * 0.1)] : null;
  const holeLab = new Int32Array(N).fill(-1); const holes: { id: number; n: number; z: number | null }[] = [];
  for (let i = 0; i < N; i++) {
    if (member[i] || outside[i] || holeLab[i] >= 0) continue; const id = holes.length; let hd = 0, tl = 0; q[tl++] = i; holeLab[i] = id; const zs: number[] = [];
    while (hd < tl) { const j = q[hd++]; if (dsm[j] > -1000) zs.push(dsm[j]); const x = j % w; for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) { if (k < 0 || k >= N || member[k] || outside[k] || holeLab[k] >= 0) continue; holeLab[k] = id; q[tl++] = k; } }
    zs.sort((a, b) => a - b); holes.push({ id, n: tl, z: zs.length ? zs[zs.length >> 1] : null });
  }
  const openHole = new Set(holes.filter((hl) => hl.n * geo.pxM2 >= 12 && groundZ != null && hl.z != null && hl.z < groundZ + 1.5).map((hl) => hl.id));
  for (let i = 0; i < N; i++) if (holeLab[i] >= 0 && !openHole.has(holeLab[i])) member[i] = 1;
  let memberN = 0; for (let i = 0; i < N; i++) memberN += member[i];
  // ---- outline: trace, simplify, square to the building axes
  const reg = new Int32Array(N).fill(-1); for (let i = 0; i < N; i++) if (member[i]) reg[i] = 0;
  const loop = regionOuterLoop(reg, w, h, 0);
  const P = loop.map((e) => [geo.E(e.a[0]), geo.N(e.a[1])]);
  const simp = comDpRing(P, Math.max(0.3, pxM * 3));
  const theta = (() => { const a = dominantAngle([simp.concat([simp[0]])]); return Number.isFinite(a) ? a : 0; })();
  const outline = comSquare(P, simp, theta);
  if (comArea(outline) < 0) outline.reverse();
  const courtyards: Pt[][] = [];
  for (const hl of holes) if (openHole.has(hl.id)) {
    const hreg = new Int32Array(N).fill(-1); for (let i = 0; i < N; i++) if (holeLab[i] === hl.id) hreg[i] = 0;
    const lp2 = regionOuterLoop(hreg, w, h, 0); if (lp2.length < 8) continue;
    const pts = comDpRing(lp2.map((e) => [geo.E(e.a[0]), geo.N(e.a[1])]), Math.max(0.3, pxM * 3)); if (pts.length >= 3) courtyards.push(pts);
  }
  const planM2 = Math.abs(comArea(outline)) - courtyards.reduce((s, c) => s + Math.abs(comArea(c)), 0);
  // ---- roof sections on a coarse grid (plane fits + region growing from auto-trace)
  const cellM = Math.max(0.3, Math.sqrt((memberN * geo.pxM2) / 220000)); const k = Math.max(1, Math.round(cellM / pxM));
  const cw = Math.ceil(w / k), chh = Math.ceil(h / k), CN = cw * chh;
  const cmem = new Uint8Array(CN), cz = new Float32Array(CN).fill(-9999);
  {
    const buf: number[] = [];
    for (let cy = 0; cy < chh; cy++) for (let cx = 0; cx < cw; cx++) {
      buf.length = 0; let n = 0;
      for (let y = cy * k; y < Math.min(h, cy * k + k); y++) for (let x = cx * k; x < Math.min(w, cx * k + k); x++) { const i = y * w + x; if (!member[i]) continue; n++; if (dsm[i] > -1000) buf.push(dsm[i]); }
      if (n * 2 >= k * k && buf.length) { buf.sort((a, b) => a - b); const ci = cy * cw + cx; cmem[ci] = 1; cz[ci] = buf[Math.floor(buf.length * 0.3)]; }
    }
  }
  const cgeo: GeoFrame = { ref: geo.ref, E: (x) => geo.E(Math.min(w, x * k)), N: (y) => geo.N(Math.min(h, y * k)), X: (E) => geo.X(E) / k, Y: (Nm) => geo.Y(Nm) / k, pxM2: geo.pxM2 * k * k };
  const lp = localPlanes(cz, cmem, cw, chh, cgeo);
  const grown = growRegions(cz, cmem, cw, chh, lp);
  const regions = grown.regions;
  let clab = mergeRegions(cz, grown.label, regions, cw, chh, lp, cgeo);
  clab = fillHoles(cz, clab, cmem, cw, chh, regions, lp);
  const cellM2 = cgeo.pxM2;
  const cnt = new Map<number, number>(); for (let i = 0; i < CN; i++) if (cmem[i] && clab[i] >= 0) cnt.set(clab[i], (cnt.get(clab[i]) || 0) + 1);
  const minSec = Math.max(COM.sectionMinM2, COM.sectionMinFrac * memberN * geo.pxM2);
  let secIds = [...cnt.entries()].filter(([, n]) => n * cellM2 >= minSec).map(([l]) => l);
  if (!secIds.length && cnt.size) secIds = [[...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0]];
  if (!secIds.length) { // no planar region at all (very noisy surface): treat the whole roof as one section
    const id = regions.length; const acc = new PlaneAcc();
    for (let i = 0; i < CN; i++) if (cmem[i] && cz[i] > -1000) { clab[i] = id; acc.add(cgeo.E((i % cw) + 0.5), cgeo.N(Math.floor(i / cw) + 0.5), cz[i]); }
    const pl = acc.solve(); if (!pl) throw new Error('The roof surface could not be read from Google\'s height model here.');
    regions.push({ id, n: CN, plane: pl, acc }); secIds = [id];
  }
  // every roof cell belongs to the nearest section
  const sec = new Int32Array(CN).fill(-1);
  {
    const set = new Set(secIds); let hd = 0, tl = 0; const cq = new Int32Array(CN);
    for (let i = 0; i < CN; i++) if (cmem[i] && set.has(clab[i])) { sec[i] = clab[i]; cq[tl++] = i; }
    while (hd < tl) { const j = cq[hd++]; const x = j % cw; for (const kk of [x > 0 ? j - 1 : -1, x < cw - 1 ? j + 1 : -1, j - cw, j + cw]) { if (kk < 0 || kk >= CN || !cmem[kk] || sec[kk] >= 0) continue; sec[kk] = sec[j]; cq[tl++] = kk; } }
  }
  const ccx = (i: number) => cgeo.E((i % cw) + 0.5), ccy = (i: number) => cgeo.N(Math.floor(i / cw) + 0.5);
  const fitPlane = (ids: number[]) => {
    const set = new Set(ids); let pl: Plane | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const acc = new PlaneAcc();
      for (let i = 0; i < CN; i++) { if (!set.has(sec[i]) || cz[i] < -1000) continue; const E = ccx(i), Nm = ccy(i); if (pl && Math.abs(cz[i] - (pl.a * E + pl.b * Nm + pl.c)) > 0.25) continue; acc.add(E, Nm, cz[i]); }
      pl = acc.solve() || pl;
    }
    return pl;
  };
  // merge neighbouring sections that are really one roof level
  interface PairStat { a: number; b: number; n: number; d: number[]; pts: number[] }
  const pairStats = () => {
    const m = new Map<string, PairStat>();
    const add = (i: number, j: number) => {
      const a = sec[i], b = sec[j]; if (a < 0 || b < 0 || a === b || cz[i] < -1000 || cz[j] < -1000) return;
      const key = a < b ? a + ',' + b : b + ',' + a; let s = m.get(key); if (!s) { s = { a: Math.min(a, b), b: Math.max(a, b), n: 0, d: [], pts: [] }; m.set(key, s); }
      s.n++; if (s.d.length < 3000) s.d.push(a < b ? cz[i] - cz[j] : cz[j] - cz[i]); if (s.pts.length < 3000) s.pts.push(i);
    };
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) { const i = y * cw + x; if (x < cw - 1) add(i, i + 1); if (y < chh - 1) add(i, i + cw); }
    return m;
  };
  const planes = new Map<number, Plane | null>(secIds.map((s) => [s, fitPlane([s])]));
  for (let it = 0; it < 40; it++) {
    const ps = pairStats(); let merged = false;
    for (const s of ps.values()) {
      const A = planes.get(s.a), B = planes.get(s.b); if (!A || !B) continue; const d = s.d.slice().sort((p, r) => p - r); const med = d[d.length >> 1];
      const flat = Math.hypot(A.a, A.b) < COM.steepSlope && Math.hypot(B.a, B.b) < COM.steepSlope;
      if (flat && Math.abs(med) < COM.levelMergeM && angleBetween(A.a, A.b, B.a, B.b) < 3) { for (let i = 0; i < CN; i++) if (sec[i] === s.b) sec[i] = s.a; planes.delete(s.b); planes.set(s.a, fitPlane([s.a])); merged = true; break; }
    }
    if (!merged) break;
  }
  // ---- section records
  const sids = [...planes.keys()];
  const fullCount = new Map<number, number>();
  for (let y = 0; y < h; y++) { const cy = Math.floor(y / k); for (let x = 0; x < w; x++) { const i = y * w + x; if (!member[i]) continue; const s = sec[cy * cw + Math.floor(x / k)]; fullCount.set(s, (fullCount.get(s) || 0) + 1); } }
  // pixels whose cell has no section (thin edges) go to the largest section
  const unassigned = fullCount.get(-1) || 0; fullCount.delete(-1);
  const sections = sids.map((s) => {
    const pl = planes.get(s); const slope = pl ? Math.hypot(pl.a, pl.b) : 0; const zs: number[] = []; for (let i = 0; i < CN; i++) if (sec[i] === s && cz[i] > -1000 && zs.length < 20000) zs.push(cz[i]); zs.sort((a, b) => a - b);
    return { sid: s, plane: pl ?? null, slope, areaM2: (fullCount.get(s) || 0) * geo.pxM2, elevM: groundZ != null && zs.length ? zs[zs.length >> 1] - groundZ : null, z: zs.length ? zs[zs.length >> 1] : null, steep: slope >= COM.steepSlope, azimuth: slope > 0.005 ? (((Math.atan2(-pl!.a, -pl!.b) * 180) / Math.PI) + 360) % 360 : null } as CommercialSection;
  }).filter((s) => s.areaM2 > 0).sort((a, b) => b.areaM2 - a.areaM2);
  if (sections.length && unassigned) sections[0].areaM2 += unassigned * geo.pxM2;
  // scale pixel areas to the squared outline area so the sections add up to the measured roof
  const pixArea = sections.reduce((s, x) => s + x.areaM2, 0); const scale = pixArea > 0 ? planM2 / pixArea : 1;
  sections.forEach((s, i) => { s.areaM2 *= scale; s.letter = String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''); s.slopedM2 = s.areaM2 * Math.sqrt(1 + s.slope * s.slope); });
  const letterOf = new Map(sections.map((s) => [s.sid, s.letter]));
  // label point (deepest cell) and outline for each section
  {
    const dist = new Int32Array(CN).fill(-1); let hd = 0, tl = 0; const cq = new Int32Array(CN);
    for (let i = 0; i < CN; i++) { if (sec[i] < 0) continue; const x = i % cw; const nb = [x > 0 ? i - 1 : -1, x < cw - 1 ? i + 1 : -1, i - cw, i + cw]; if (nb.some((kk) => kk < 0 || kk >= CN || sec[kk] !== sec[i])) { dist[i] = 0; cq[tl++] = i; } }
    while (hd < tl) { const j = cq[hd++]; const x = j % cw; for (const kk of [x > 0 ? j - 1 : -1, x < cw - 1 ? j + 1 : -1, j - cw, j + cw]) { if (kk < 0 || kk >= CN || sec[kk] !== sec[j] || dist[kk] >= 0) continue; dist[kk] = dist[j] + 1; cq[tl++] = kk; } }
    const best = new Map<number, { d: number; i: number }>(); for (let i = 0; i < CN; i++) { if (sec[i] < 0) continue; const b = best.get(sec[i]); if (!b || dist[i] > b.d) best.set(sec[i], { d: dist[i], i }); }
    for (const s of sections) {
      const b = best.get(s.sid); s.label = b ? [ccx(b.i), ccy(b.i)] : null; s.labelRoomM = b ? b.d * Math.sqrt(cellM2) : 0;
      const lp3 = regionOuterLoop(sec, cw, chh, s.sid); s.poly = lp3.length >= 4 ? comDpRing(lp3.map((e) => [cgeo.E(e.a[0]), cgeo.N(e.a[1])]), Math.max(0.5, Math.sqrt(cellM2) * 1.5)) : [];
    }
  }
  // ---- walls / joints between sections: boundary chains from the section raster, simplified to straight lines
  const walls: CommercialWall[] = [];
  const lines = new Map<string, Pt[][]>();
  {
    const topo = topology(sec, cw, chh); const W1 = topo.W1;
    for (const ch of topo.chains) {
      const [p, r] = ch.pair; if (p < 0 || r < 0) continue; const key = p < r ? p + ',' + r : r + ',' + p;
      const pts = ch.corners.map((c) => { const x = c % W1, y = (c - x) / W1; return [cgeo.E(x), cgeo.N(y)]; });
      const sp = dpSimplify(pts, Math.max(0.5, Math.sqrt(cellM2) * 1.5)); if (!lines.has(key)) lines.set(key, []); lines.get(key)!.push(sp);
    }
  }
  for (const s of pairStats().values()) {
    const A = sections.find((x) => x.sid === s.a), B = sections.find((x) => x.sid === s.b); if (!A || !B) continue;
    const d = s.d.slice().sort((p, r) => p - r); const med = d[d.length >> 1];
    const polys = lines.get(s.a + ',' + s.b) || []; const segs: Pt[][] = []; let lenM = 0;
    for (const pl of polys) for (let i = 1; i < pl.length; i++) { segs.push([pl[i - 1], pl[i]]); lenM += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]); }
    if (lenM < 1) continue;
    const kind = A.steep || B.steep ? 'transition' : Math.abs(med) >= COM.wallMinM ? 'wall' : 'joint';
    const mid = s.pts[s.pts.length >> 1];
    walls.push({ a: letterOf.get(s.a)!, b: letterOf.get(s.b)!, higher: (med > 0 ? letterOf.get(s.a) : letterOf.get(s.b))!, heightM: Math.abs(med), lenM, kind, segs, mid: [ccx(mid), ccy(mid)] });
  }
  // ---- per-pixel roof surface (section plane), parapet band, rooftop objects
  const planeOfPx = (i: number) => { const x = i % w, y = (i - x) / w; const s = sec[Math.floor(y / k) * cw + Math.floor(x / k)]; return s >= 0 ? planes.get(s) : null; };
  const band = new Uint8Array(N);
  {
    const D = Math.max(1, Math.round(COM.bandM / pxM)); const dist = new Int16Array(N).fill(-1); let hd = 0, tl = 0;
    for (let i = 0; i < N; i++) { if (!member[i]) continue; const x = i % w; const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]; if (nb.some((kk) => kk < 0 || kk >= N || !member[kk])) { dist[i] = 0; q[tl++] = i; band[i] = 1; } }
    while (hd < tl) { const j = q[hd++]; if (dist[j] >= D) continue; const x = j % w; for (const kk of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) { if (kk < 0 || kk >= N || !member[kk] || dist[kk] >= 0) continue; dist[kk] = dist[j] + 1; band[kk] = 1; q[tl++] = kk; } }
  }
  // local roof surface: morphological opening (~4 m) of the coarse roof heights. Tapered insulation makes a 4-16"
  // sawtooth between drains, so one plane per section is not enough; the opening follows it but removes units up to ~3.5 m across.
  const base = (() => {
    const r = Math.max(1, Math.round(2.0 / Math.sqrt(cellM2))); const A = new Float32Array(CN), B = new Float32Array(CN);
    const pass = (src: Float32Array, dst: Float32Array, horiz: boolean, isMin: boolean) => {
      const fillV = isMin ? Infinity : -Infinity;
      for (let o = 0; o < (horiz ? chh : cw); o++) for (let t = 0; t < (horiz ? cw : chh); t++) {
        let m = fillV;
        for (let d = -r; d <= r; d++) { const tt = t + d; if (tt < 0 || tt >= (horiz ? cw : chh)) continue; const v = src[horiz ? o * cw + tt : tt * cw + o]; if (isMin ? v < m : v > m) m = v; }
        dst[horiz ? o * cw + t : t * cw + o] = m;
      }
    };
    const src = new Float32Array(CN); for (let i = 0; i < CN; i++) src[i] = cmem[i] && cz[i] > -1000 ? cz[i] : Infinity;
    pass(src, A, true, true); pass(A, B, false, true); // erosion
    for (let i = 0; i < CN; i++) if (!cmem[i] || !Number.isFinite(B[i])) B[i] = -Infinity;
    pass(B, A, true, false); pass(A, B, false, false); // dilation
    return B;
  })();
  const objMin = /HIGH/i.test(R.quality || 'HIGH') ? COM.objMinM2 : 0.3; // MEDIUM / BASE imagery is ~0.25 m effective
  // keep the object search ~1 m away from steps between roof levels too (cells straddling a step read low)
  const stepBand = new Uint8Array(N);
  {
    const stepCell = new Uint8Array(CN);
    // only boundaries between roof sections at different heights (a height jump alone is also what a rooftop unit looks like)
    const zOf = (sid: number, i: number) => { const pl = planes.get(sid); return pl ? pl.a * ccx(i) + pl.b * ccy(i) + pl.c : NaN; };
    for (let i = 0; i < CN; i++) { if (!cmem[i] || sec[i] < 0) continue; const x = i % cw; for (const j of [x > 0 ? i - 1 : -1, x < cw - 1 ? i + 1 : -1, i - cw, i + cw]) { if (j < 0 || j >= CN || !cmem[j] || sec[j] < 0 || sec[j] === sec[i]) continue; if (Math.abs(zOf(sec[i], i) - zOf(sec[j], i)) >= COM.wallMinM) { stepCell[i] = 1; break; } } }
    const D = Math.max(1, Math.round(COM.bandM / pxM)); const dist = new Int16Array(N).fill(-1); let hd = 0, tl = 0;
    for (let i = 0; i < N; i++) { if (!member[i]) continue; const x = i % w, y = (i - x) / w; if (stepCell[Math.floor(y / k) * cw + Math.floor(x / k)]) { dist[i] = 0; stepBand[i] = 1; q[tl++] = i; } }
    while (hd < tl) { const j = q[hd++]; if (dist[j] >= D) continue; const x = j % w; for (const kk of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) { if (kk < 0 || kk >= N || !member[kk] || dist[kk] >= 0) continue; dist[kk] = dist[j] + 1; stepBand[kk] = 1; q[tl++] = kk; } }
  }
  const hAbove = new Float32Array(N); const cand = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!member[i] || band[i] || stepBand[i] || !(dsm[i] > -1000)) continue; const pl = planeOfPx(i); if (!pl || Math.hypot(pl.a, pl.b) >= COM.steepSlope) continue;
    const x = i % w, y = (i - x) / w; const ci = Math.floor(y / k) * cw + Math.floor(x / k); let b0 = base[ci];
    const zPl = pl.a * geo.E(x + 0.5) + pl.b * geo.N(y + 0.5) + pl.c;
    if (!Number.isFinite(b0)) b0 = zPl;
    // a narrow raised roof part that the opening erased sits on its own section plane: roof, not equipment
    const v = dsm[i] - b0; hAbove[i] = v; if (v > COM.objMinH && dsm[i] - Math.max(b0, zPl) > COM.objMinH * 0.5) cand[i] = 1;
  }
  const th = (theta * Math.PI) / 180, ct = Math.cos(th), st = Math.sin(th);
  const objects: CommercialObject[] = [];
  {
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!cand[i] || seen[i]) continue; let hd = 0, tl = 0; q[tl++] = i; seen[i] = 1; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity; const hs: number[] = [];
      while (hd < tl) {
        const j = q[hd++]; const x = j % w, y = (j - x) / w; const E = geo.E(x + 0.5), Nm = geo.N(y + 0.5); const u = E * ct + Nm * st, v = -E * st + Nm * ct; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; if (hs.length < 5000) hs.push(hAbove[j]);
        for (const kk of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) { if (kk < 0 || kk >= N || !cand[kk] || seen[kk]) continue; seen[kk] = 1; q[tl++] = kk; }
      }
      const areaM2 = tl * geo.pxM2; if (areaM2 < objMin) continue;
      hs.sort((a, b) => a - b); const hM = hs[Math.floor(hs.length * 0.85)];
      const L = u1 - u0 + pxM, W = v1 - v0 + pxM; const fill = areaM2 / Math.max(1e-6, L * W); const lo = Math.max(L, W), sh = Math.min(L, W);
      let type;
      if (hM > 6 || (areaM2 > 25 && fill < 0.35 && hM > 1.5)) type = 'Obstruction / tree overhang';
      else if (areaM2 > 4 && fill < 0.35) type = 'Expansion joint / divider'; // long low raised lines between roof areas
      else if (lo / sh >= 4 && sh < 0.7 && areaM2 >= 0.3) type = 'Duct / pipe run';
      else if (areaM2 < 0.2) type = 'Vent / pipe';
      else if (areaM2 < 1.0) type = 'Exhaust fan / small curb';
      else if (areaM2 <= 15) type = hM >= 0.5 ? 'Rooftop unit (HVAC)' : 'Curb / skylight / hatch';
      else if (areaM2 <= 60 || hM < 2) type = 'Large equipment / platform';
      else type = 'Penthouse / mechanical enclosure';
      const cU = (u0 + u1) / 2, cV = (v0 + v1) / 2; const back = (u: number, v: number) => [u * ct - v * st, u * st + v * ct];
      objects.push({ id: 0, type, areaM2, lenM: lo, widM: sh, hM, curbM: 2 * (L + W), center: back(cU, cV), corners: [back(u0, v0), back(u1, v0), back(u1, v1), back(u0, v1)] });
    }
  }
  objects.sort((a, b) => b.areaM2 - a.areaM2); objects.forEach((o, i) => { o.id = i + 1; });
  // ---- perimeter: parapet walls vs open edges
  const zAt = (E: number, Nm: number) => { const x = Math.floor(geo.X(E)), y = Math.floor(geo.Y(Nm)); if (x < 0 || y < 0 || x >= w || y >= h) return NaN; const z = dsm[y * w + x]; return z > -1000 ? z : NaN; };
  const med = (a: number[]) => { const b = a.filter(Number.isFinite).sort((p, r) => p - r); return b.length ? b[b.length >> 1] : NaN; };
  const edges: CommercialEdge[] = [];
  // ring must have the roof on its left: the outline is counter-clockwise, courtyards clockwise
  const sampleRing = (ring: Pt[], court: boolean) => {
    const m = ring.length;
    for (let e = 0; e < m; e++) {
      const a = ring[e], b = ring[(e + 1) % m]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.05) continue;
      const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], nin = [-d[1], d[0]];
      const hs: number[] = [], drops: number[] = []; const stn = Math.max(1, Math.floor((L - 0.6) / 0.5));
      for (let s = 0; s < stn; s++) {
        const t = stn === 1 ? L / 2 : 0.3 + ((L - 0.6) * s) / (stn - 1); const p = [a[0] + d[0] * t, a[1] + d[1] * t];
        let top = -Infinity; for (let o = -0.2; o <= 1.0; o += pxM) { const z = zAt(p[0] + nin[0] * o, p[1] + nin[1] * o); if (z > top) top = z; }
        const surf: number[] = []; for (let o = 1.6; o <= 3.6; o += pxM) surf.push(zAt(p[0] + nin[0] * o, p[1] + nin[1] * o));
        const out: number[] = []; for (let o = -2.5; o <= -0.8; o += pxM) out.push(zAt(p[0] + nin[0] * o, p[1] + nin[1] * o));
        const sf = med(surf), of = med(out);
        if (Number.isFinite(top) && Number.isFinite(sf)) hs.push(top - sf); if (Number.isFinite(sf) && Number.isFinite(of)) drops.push(sf - of);
      }
      const par = hs.filter((v) => v >= COM.parapetMinM); const frac = hs.length ? par.length / hs.length : 0;
      const ph = frac >= 0.5 ? med(par) : Math.max(0, med(hs) || 0);
      // over ~8 ft it is the wall of a taller roof part or a screen wall, not a parapet
      edges.push({ a, b, lenM: L, kind: frac >= 0.5 ? (ph > COM.parapetMaxM ? 'tallwall' : 'parapet') : 'edge', parapetM: ph, parapetFrac: frac, dropM: med(drops), court: !!court });
    }
  };
  const n = outline.length;
  sampleRing(outline, false);
  for (const c of courtyards) { const ring = comArea(c) > 0 ? c.slice().reverse() : c; sampleRing(ring, true); }
  // corners of the outline: convex = outside corner of the building, reflex = inside corner
  let convex = 0, reflex = 0;
  for (let e = 0; e < n; e++) { const p0 = outline[(e - 1 + n) % n], p1 = outline[e], p2 = outline[(e + 1) % n]; const cr = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]); if (cr > 1e-6) convex++; else if (cr < -1e-6) reflex++; }
  const main0: Partial<CommercialSection> = sections[0] || {};
  return {
    touchesBorder, theta, toLL, geo: { cLat, cLng, kx, ky }, pxM, groundZ, outline, courtyards, planM2, sections, walls, objects, edges, convex, reflex,
    roofHeightM: main0.elevM, maxElevM: Math.max(...sections.map((s) => s.elevM || 0)), pixelAreaM2: memberN * geo.pxM2, cellM: Math.sqrt(cellM2),
  };
}

export function comArea(p: Pt[]) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
export function comDpRing(P: Pt[], eps: number): Pt[] {
  if (P.length < 4) return P.slice();
  let i1 = 0, far = -1; for (let i = 0; i < P.length; i++) { const d = Math.hypot(P[i][0] - P[0][0], P[i][1] - P[0][1]); if (d > far) { far = d; i1 = i; } }
  return dpSimplify(P.slice(0, i1 + 1), eps).slice(0, -1).concat(dpSimplify(P.slice(i1).concat([P[0]]), eps).slice(0, -1));
}
// Square the traced outline: snap runs to the two building axes, drop jogs, intersect consecutive runs.
export function comSquare(P: Pt[], simp: Pt[], thetaDeg: number): Pt[] {
  const th = (thetaDeg * Math.PI) / 180; const ax = [[Math.cos(th), Math.sin(th)], [-Math.sin(th), Math.cos(th)]];
  const idx = simp.map((p) => P.indexOf(p));
  interface Run { cls: number; line: Line2; pts: Pt[]; len: number; a: Pt; b: Pt }
  let runs: Run[] = [];
  for (let kk = 0; kk < simp.length; kk++) {
    const a = simp[kk], b = simp[(kk + 1) % simp.length]; const ia = idx[kk], ib = idx[(kk + 1) % simp.length];
    const pts: Pt[] = []; if (ia >= 0 && ib >= 0) for (let i = ia; ; i = (i + 1) % P.length) { pts.push(P[i]); if (i === ib || pts.length > P.length) break; }
    if (pts.length < 2) { pts.length = 0; pts.push(a, b); }
    const d = [b[0] - a[0], b[1] - a[1]]; const L = Math.hypot(d[0], d[1]) || 1e-9; const du = [d[0] / L, d[1] / L];
    let cls = -1, best = Math.cos(((L > 6 ? 12 : 20) * Math.PI) / 180); for (let c = 0; c < 2; c++) { const cs = Math.abs(du[0] * ax[c][0] + du[1] * ax[c][1]); if (cs > best) { best = cs; cls = c; } }
    runs.push({ cls, line: cls >= 0 ? lineWithDir(pts, ax[cls]) : lineFromPts(pts), pts, len: L, a, b });
  }
  const off = (r: Run, p: Pt) => r.line.n[0] * p[0] + r.line.n[1] * p[1] - r.line.c;
  const join = (p: Run, r: Run, mid?: Run): Run => { const pts = p.pts.concat(mid ? mid.pts : [], r.pts); return { cls: p.cls, pts, len: p.len + r.len + (mid ? mid.len : 0), a: p.a, b: r.b, line: p.cls >= 0 ? lineWithDir(pts, ax[p.cls]) : lineFromPts(pts) }; };
  for (let it = 0; it < 8; it++) {
    let changed = false; const out: Run[] = [];
    for (let kk = 0; kk < runs.length; kk++) {
      const r = runs[kk], p = out[out.length - 1], nx = runs[kk + 1];
      if (p && r.cls >= 0 && p.cls === r.cls && Math.abs(off(p, r.line.m)) < 0.5) { out[out.length - 1] = join(p, r); changed = true; continue; }
      if (p && nx && r.len < 1.2 && p.cls >= 0 && p.cls === nx.cls && Math.abs(off(p, nx.line.m)) < 0.8) { out[out.length - 1] = join(p, nx, r); kk++; changed = true; continue; }
      out.push(r);
    }
    runs = out; if (!changed || runs.length < 4) break;
  }
  if (runs.length < 3) return simp.slice();
  const poly: Pt[] = [];
  for (let kk = 0; kk < runs.length; kk++) { const a = runs[kk], b = runs[(kk + 1) % runs.length]; const c = intersect2(a.line, b.line); poly.push(c && Math.hypot(c[0] - a.b[0], c[1] - a.b[1]) < 4 ? c : a.b); }
  return poly;
}

// ------------------------------------------------------------------ derived quantities

const intOrNull = (v: unknown) => { const x = parseInt(String(v), 10); return Number.isFinite(x) && x >= 0 ? x : null; };

export function commercialHeightFt(M: CommercialModel, opts: Pick<CommercialOptions, 'heightFt'>) { const o = parseFloat(String(opts.heightFt)); return o > 0 ? o : M.roofHeightM != null ? M.roofHeightM * FT : null; }

export type CommercialTotals = ReturnType<typeof commercialTotals>;
export function commercialTotals(M: CommercialModel, opts: CommercialOptions = COMMERCIAL_DEFAULTS) {
  const ftv = (m: number) => m * FT;
  const low = M.sections.filter((s) => !s.steep), steep = M.sections.filter((s) => s.steep);
  const par = M.edges.filter((e) => e.kind === 'parapet'), open = M.edges.filter((e) => e.kind === 'edge'), tall = M.edges.filter((e) => e.kind === 'tallwall');
  const parLF = ftv(par.reduce((s, e) => s + e.lenM, 0)), edgeLF = ftv(open.reduce((s, e) => s + e.lenM, 0));
  const parAvgFt = parLF ? ftv(par.reduce((s, e) => s + e.lenM * (e.parapetM || 0), 0) / par.reduce((s, e) => s + e.lenM, 0)) : 0;
  const wallList = M.walls.filter((wl) => wl.kind === 'wall');
  const tallLF = ftv(tall.reduce((s, e) => s + e.lenM, 0));
  const wallLF = ftv(wallList.reduce((s, wl) => s + wl.lenM, 0)) + tallLF;
  // flash up and over parapets up to 4 ft; taller walls get 3 ft of flashing with termination bar and counter-flashing
  const flashH = (hFt: number) => (hFt <= 4 ? hFt + COM_RULES.wallFlashExtraFt : COM_RULES.wallStepFlashMaxFt);
  const parFlashSF = par.reduce((s, e) => s + ftv(e.lenM) * flashH(ftv(e.parapetM || 0)), 0);
  const wallFlashSF = wallList.reduce((s, wl) => s + ftv(wl.lenM) * Math.min(COM_RULES.wallStepFlashMaxFt, ftv(wl.heightM)), 0) + tallLF * COM_RULES.wallStepFlashMaxFt;
  const units = M.objects.filter((o) => /Rooftop unit|Penthouse|equipment|Curb|Exhaust fan/i.test(o.type)); // everything on a curb
  const rtus = M.objects.filter((o) => /Rooftop unit/.test(o.type));
  const vents = M.objects.filter((o) => /Vent/i.test(o.type));
  const ducts = M.objects.filter((o) => /Duct/.test(o.type));
  const pens = M.objects.filter((o) => !/Obstruction|Expansion/.test(o.type));
  const penAreaSF = pens.reduce((s, o) => s + o.areaM2, 0) * SQFT, penPerimLF = pens.reduce((s, o) => s + o.curbM, 0) * FT;
  const obstr = M.objects.filter((o) => /Obstruction/.test(o.type));
  const curbLF = ftv(units.reduce((s, o) => s + o.curbM, 0));
  const lowSF = low.reduce((s, x) => s + x.areaM2, 0) * SQFT, steepSF = steep.reduce((s, x) => s + x.slopedM2, 0) * SQFT;
  const totalSF = lowSF + steepSF;
  const drainsEst = low.length ? Math.max(1, low.reduce((s, x) => s + Math.ceil((x.areaM2 * SQFT) / COM_RULES.drainSqft), 0)) : 0;
  const drainsEntered = intOrNull(opts.drains) != null; const drains = drainsEntered ? intOrNull(opts.drains)! : drainsEst;
  const parFrac = parLF + edgeLF > 0 ? parLF / (parLF + edgeLF) : 0;
  const scuppers = intOrNull(opts.scuppers) != null ? intOrNull(opts.scuppers)! : parFrac >= 0.5 ? drains : 0; // FBC-P 1108: parapet roofs need overflow drainage
  const predSlope = low.length ? low.slice().sort((a, b) => b.areaM2 - a.areaM2)[0].slope * 12 : null;
  return {
    lowSF, steepSF, totalSF, squares: totalSF / 100, perimLF: parLF + edgeLF, parLF, edgeLF, parAvgFt, wallLF, parFlashSF, wallFlashSF, curbLF, units, rtus, tallLF, drainsEntered, parFrac,
    vents, ducts, pens, penAreaSF, penPerimLF, obstr, drains, drainsEst, scuppers, skylights: intOrNull(opts.skylights) || 0, hatches: intOrNull(opts.hatches) || 0, predSlope,
    heightFt: commercialHeightFt(M, opts), levels: M.sections.length, convex: M.convex, reflex: M.reflex,
  };
}

// ASCE 7-22 components & cladding roof zones for roofs of 7 degrees or less (h <= 60 ft): zone 3 corner squares,
// zone 2 perimeter band, zone 1 field band and zone 1' interior. Widths from mean roof height h.
export const COM_WIND = {
  z3: (h: number) => 0.6 * h, z3d: (h: number) => 0.2 * h, z2: (h: number) => 0.6 * h, z1: (h: number) => 1.2 * h,
  note: 'ASCE 7-16/7-22 (low-slope coefficients unchanged in 7-22): zone 2 perimeter band 0.6h, zone 1 band to 1.2h, zone 1\' beyond; zone 3 is an L at each outside corner, 0.6h long and 0.2h deep. With a parapet of 3 ft or more, zone 3 is treated as zone 2.',
};
export function comCornerSquares(poly: Pt[], a: number, dep: number | null): Pt[][] {
  const n = poly.length, out: Pt[][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
    if ((p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]) <= 0) continue; // convex corners only (CCW outline)
    const d1 = [p0[0] - p1[0], p0[1] - p1[1]], d2 = [p2[0] - p1[0], p2[1] - p1[1]]; const l1 = Math.hypot(d1[0], d1[1]), l2 = Math.hypot(d2[0], d2[1]);
    const u1 = [(d1[0] / l1) * Math.min(a, l1), (d1[1] / l1) * Math.min(a, l1)], u2 = [(d2[0] / l2) * Math.min(a, l2), (d2[1] / l2) * Math.min(a, l2)];
    if (dep == null || dep >= a) { out.push([p1, [p1[0] + u1[0], p1[1] + u1[1]], [p1[0] + u1[0] + u2[0], p1[1] + u1[1] + u2[1]], [p1[0] + u2[0], p1[1] + u2[1]]]); continue; }
    const f1 = Math.min(dep, l1) / Math.max(1e-9, Math.min(a, l1)), f2 = Math.min(dep, l2) / Math.max(1e-9, Math.min(a, l2)); const v1 = [u1[0] * f1, u1[1] * f1], v2 = [u2[0] * f2, u2[1] * f2];
    out.push([p1, [p1[0] + u1[0], p1[1] + u1[1]], [p1[0] + u1[0] + v2[0], p1[1] + u1[1] + v2[1]], [p1[0] + v1[0] + v2[0], p1[1] + v1[1] + v2[1]], [p1[0] + v1[0] + u2[0], p1[1] + v1[1] + u2[1]], [p1[0] + u2[0], p1[1] + u2[1]]]); // L-shape
  }
  return out;
}
export interface WindZones { hFt: number; zones: { z1p: number; z1: number; z2: number; z3: number } | null; note: string; tallParapet?: boolean; corners?: Pt[][]; widthsFt?: { z3: number; z3d: number; z2: number; z1: number | null } }
export function commercialWindZones(M: CommercialModel, T: Pick<CommercialTotals, 'heightFt' | 'parLF' | 'parAvgFt' | 'perimLF' | 'lowSF'>): WindZones {
  const hFt = T.heightFt || 20; const hM = hFt / FT; const out: WindZones = { hFt, zones: null, note: COM_WIND.note };
  const poly = M.outline; if (poly.length < 3) return out;
  let a3 = COM_WIND.z3(hM), a2 = COM_WIND.z2(hM), a1 = COM_WIND.z1(hM), dep3 = COM_WIND.z3d(hM);
  if (hFt > 60) { // h > 60 ft: zones 1-3 with a = min(0.1 x least dimension, 0.4h), not less than 0.04 x least dimension or 3 ft; no zone 1'
    const th = (M.theta * Math.PI) / 180; const us = poly.map((p) => p[0] * Math.cos(th) + p[1] * Math.sin(th)), vs = poly.map((p) => -p[0] * Math.sin(th) + p[1] * Math.cos(th));
    const least = Math.min(Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs));
    const a = Math.max(0.04 * least, 0.9144, Math.min(0.1 * least, 0.4 * hM)); a3 = a; a2 = a; a1 = Infinity; dep3 = a;
    out.note = `Mean roof height over 60 ft: ASCE 7-22 Fig. 30.5-1 layout; zone 2 band and zone 3 corners are a = ${fmt(a * FT, 1)} ft wide (10% of the least dimension or 0.4h).`;
  }
  const tallParapet = T.parLF > 0 && T.parAvgFt >= 3 && T.parLF >= 0.8 * T.perimLF; out.tallParapet = tallParapet;
  const sq = tallParapet ? [] : comCornerSquares(poly, a3, dep3); out.corners = sq;
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const res = Math.max(0.25, Math.sqrt(((x1 - x0) * (y1 - y0)) / 160000));
  const W = Math.ceil((x1 - x0) / res) + 1, H = Math.ceil((y1 - y0) / res) + 1;
  const inP = (pts: Pt[], px: number, py: number) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if (a[1] > py !== b[1] > py && px < ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const segD = (px: number, py: number, a: Pt, b: Pt) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy; let t = L2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy); };
  const sums = { z1p: 0, z1: 0, z2: 0, z3: 0 }; const cell = res * res;
  for (let yy = 0; yy < H; yy++) {
    const py = y0 + (yy + 0.5) * res;
    for (let xx = 0; xx < W; xx++) {
      const px = x0 + (xx + 0.5) * res; if (!inP(poly, px, py) || M.courtyards.some((c) => inP(c, px, py))) continue;
      if (sq.some((s) => inP(s, px, py))) { sums.z3 += cell; continue; }
      let d = Infinity; for (let i = 0; i < poly.length && d > a2; i++) { const v = segD(px, py, poly[i], poly[(i + 1) % poly.length]); if (v < d) d = v; }
      if (d <= a2) sums.z2 += cell; else if (d <= a1) sums.z1 += cell; else sums.z1p += cell;
    }
  }
  // scale to the measured low-slope area
  const tot = sums.z1p + sums.z1 + sums.z2 + sums.z3; const k = tot > 0 ? T.lowSF / SQFT / tot : 1;
  out.widthsFt = { z3: a3 * FT, z3d: dep3 * FT, z2: a2 * FT, z1: Number.isFinite(a1) ? a1 * FT : null };
  out.zones = Object.fromEntries(Object.entries(sums).map(([kk, v]) => [kk, v * k * SQFT])) as WindZones['zones'];
  return out;
}

export const rFor = (thkIn: number) => { const tb = COM_RULES.polyisoR; for (let i = tb.length - 1; i >= 0; i--) if (thkIn >= tb[i][0] - 1e-9) return tb[i][1] + (thkIn - tb[i][0]) * 5.7; return thkIn * 5.7; };
// Fewest layers of standard polyiso (max 2.6" per layer for staggered joints) that reach the target LTTR R-value.
export function commercialInsulationPlan(rTarget: number): number[] {
  if (!(rTarget > 0)) return [];
  const sizes = [1.5, 2.0, 2.2, 2.5, 2.6, 3.0];
  for (let layers = 1; layers <= 3; layers++) {
    let best: number[] | null = null;
    const rec = (k: number, acc: number[]) => {
      if (k === layers) { const r = acc.reduce((s, t) => s + rFor(t), 0); if (r >= rTarget && (!best || acc.reduce((s, t) => s + t, 0) < best.reduce((s, t) => s + t, 0))) best = acc.slice(); return; }
      for (const sz of sizes) { if (layers > 1 && sz > 2.6) continue; acc.push(sz); rec(k + 1, acc); acc.pop(); }
    };
    rec(0, []); if (best) return (best as number[]).sort((a, b) => b - a);
  }
  return [2.6, 2.6, 2.6];
}

export interface MaterialRow { group: string; name: string; qty: number; unit: string; note: string }
export interface CommercialMaterials { system: string; sysKey: CommercialSystem; wastePct: number; rows: MaterialRow[]; insul: number[]; rTotal: number }

export function commercialMaterials(M: CommercialModel, T: CommercialTotals, sysKey: CommercialSystem, wastePct: number | null, opts: CommercialOptions = COMMERCIAL_DEFAULTS): CommercialMaterials {
  const S = COM_SYSTEMS[sysKey]; const r = COM_RULES; const wp = wastePct != null ? wastePct : r.wasteDefault[S.mem] || 10; const wf = 1 + wp / 100;
  const Z = commercialWindZones(M, T).zones || { z1p: T.lowSF, z1: 0, z2: 0, z3: 0 };
  const zTot = Z.z1p + Z.z1 + Z.z2 + Z.z3 || 1; const fieldFrac = (Z.z1p + Z.z1) / zTot, perimFrac = Z.z2 / zTot, cornerFrac = Z.z3 / zTot;
  const roofSF = T.lowSF; const curbSF = T.curbLF * r.curbFlashFt; const flashSF = T.parFlashSF + T.wallFlashSF + curbSF;
  const rows: MaterialRow[] = []; const add = (group: string, name: string, qty: number, unit: string, note?: string) => rows.push({ group, name, qty, unit, note: note || '' });
  const ceil = (v: number) => Math.max(0, Math.ceil(v - 1e-9));
  const nUnits = T.units.length, nVents = T.vents.length, nRtu = T.rtus.length;
  const insul = sysKey === 'silicone' ? [] : commercialInsulationPlan((opts.rTarget || 0) - (opts.cover ? r.cover.r : 0));
  const boards = ceil((roofSF / r.boardSqft) * (1 + r.wasteDefault.insulation / 100));
  const perBoard = fieldFrac * r.insulFastPerBoard.field + perimFrac * r.insulFastPerBoard.perimeter + cornerFrac * r.insulFastPerBoard.corner;
  const fmtN = (v: number) => fmt(v);
  if (S.mem === 'tpo' || S.mem === 'pvc' || S.mem === 'epdm') {
    const roll = r.rollSqft[S.mem], netW = r.rollNetWidthFt[S.mem], netRoll = netW * 100;
    const memName = ({ tpo: 'TPO 60 mil reinforced membrane', pvc: 'PVC 60 mil reinforced membrane', epdm: 'EPDM 60 mil membrane' } as Record<string, string>)[S.mem];
    const seamLF = roofSF / netW; // side-lap seam length
    if (S.attach === 'ma') {
      const edgeSF = roofSF * (perimFrac + cornerFrac);
      add('Membrane', `${memName}, field sheets 10' x 100'`, ceil(((roofSF - edgeSF) * wf) / netRoll), 'roll', `${fmtN(roofSF - edgeSF)} sqft zones 1/1'; ${fmt(netRoll)} sqft net per roll after 5.5" laps`);
      if (edgeSF > 0) add('Membrane', `${memName}, perimeter half-sheets ${r.halfSheetFt}' x 100'`, ceil((edgeSF * wf) / ((r.halfSheetFt - 0.46) * 100)), 'roll', `${fmtN(edgeSF)} sqft zones 2/3`);
      const fieldSeam = (roofSF - edgeSF) / netW, edgeSeam = edgeSF / (r.halfSheetFt - 0.46);
      add('Attachment', 'Membrane fasteners + 2-3/8" seam plates', ceil(((fieldSeam * 12) / r.seamFastSpacingIn.field + (edgeSeam * 12) / r.seamFastSpacingIn.perimeter) * 1.05), 'each', `in the seams, ${r.seamFastSpacingIn.field}" o.c. field / ${r.seamFastSpacingIn.perimeter}" o.c. perimeter (final spacing per uplift design)`);
      add('Attachment', 'Bonding adhesive (walls and curbs)', ceil(flashSF / r.adhesiveSqftPerGal / r.adhesivePail), '5-gal pail', `${fmtN(flashSF)} sqft vertical flashing at ${r.adhesiveSqftPerGal} sqft/gal`);
    } else {
      add('Membrane', `${memName} 10' x 100'`, ceil((roofSF * wf) / netRoll), 'roll', `${fmtN(roofSF)} sqft field; ${fmt(netRoll)} sqft net per roll`);
      add('Attachment', 'Bonding adhesive (field + flashings)', ceil((roofSF + flashSF) / r.adhesiveSqftPerGal / r.adhesivePail), '5-gal pail', `${r.adhesiveSqftPerGal} sqft per gallon of finished surface`);
    }
    add('Membrane', `${memName}, wall / curb flashing`, ceil((flashSF * wf) / roll), "10' x 100' roll", `${fmtN(T.parFlashSF)} sqft parapets + ${fmtN(T.wallFlashSF)} sqft walls + ${fmtN(curbSF)} sqft curbs`);
    if (S.mem === 'epdm') {
      add('Seams', 'Seam tape 3" x 100\'', ceil((seamLF * 1.1) / r.seamTapeRollFt), 'roll', `${fmtN(seamLF)} LF of seams`);
      add('Seams', 'Seam primer', ceil((seamLF * 0.5 + flashSF * 0.15) / r.epdmPrimerSqftPerGal), 'gallon');
      add('Seams', 'Pressure-sensitive cover strip 6" x 100\'', ceil(((T.edgeLF + T.parLF) * 1.1) / 100), 'roll', 'metal flanges and terminations');
    } else {
      add('Seams', 'T-joint covers', ceil(((roofSF * wf) / roll) * r.tJointPerRoll), 'each', '60 mil and thicker: every T-joint overlaid (100 per box)');
      const cutLF = T.perimLF + T.wallLF + T.curbLF + seamLF * 0.1; // cut edges at terminations, curbs and end laps (factory edges need none)
      add('Seams', 'Cut-edge sealant 16 oz', ceil(cutLF / r.cutEdgeLfPerBottle), 'bottle', `${fmt(cutLF)} LF of cut edges, ${r.cutEdgeLfPerBottle} LF per bottle`);
      add('Seams', 'Pressure-sensitive cover strip 6" x 100\'', ceil((T.edgeLF * 1.1) / 100), 'roll', 'edge metal flanges');
    }
    add('Details', 'Molded pipe boots', nVents, 'each', 'one per detected vent / pipe');
    add('Details', 'Curb wrap corners', nUnits * 4, 'each', '4 per curbed unit');
    add('Details', 'Inside / outside corners (parapets)', Math.round((T.convex + T.reflex) * T.parFrac), 'each', 'parapet corners');
    add('Details', 'Sealant pockets / pitch pans', nRtu, 'each', 'gas / electrical lines at HVAC units');
  } else if (S.mem === 'modbit') {
    add('Membrane', 'SBS base sheet (Ruberoid 20 class, 1.5 sq roll)', ceil((roofSF * wf) / r.modbit.baseSqftPerRoll), 'roll', `${r.modbit.baseSqftPerRoll} sqft net per roll`);
    add('Membrane', 'SBS granulated FR cap sheet (1 sq roll)', ceil((roofSF * wf) / r.modbit.capSqftPerRoll), 'roll', `${r.modbit.capSqftPerRoll} sqft net per roll after laps`);
    add('Membrane', 'SBS flashing, base + cap plies', ceil((flashSF * 2 * wf) / r.modbit.flashSqftPerRoll), 'roll', `${fmtN(flashSF)} sqft of walls and curbs, two plies`);
    add('Attachment', 'Asphalt primer', ceil(flashSF / r.modbit.primerSqftPerGal), 'gallon', 'walls and metal flanges (FBC 1511.6)');
    add('Details', 'Pipe flashings (lead or pre-formed)', nVents, 'each');
    add('Details', 'Pitch pans + pourable sealer', nRtu, 'each');
  } else if (S.mem === 'silicone') {
    const sq = (roofSF + flashSF) / 100;
    add('Coating', 'Silicone roof coating (e.g. GacoFlex S20, 95% solids)', ceil((sq * r.silicone.galPerSq * wf) / r.silicone.pail), '5-gal pail', `${r.silicone.galPerSq} gal/sq smooth (~22 dry mils); granulated surfaces need ${r.silicone.galPerSqGranulated} gal/sq`);
    add('Coating', 'Primer / bleed-blocker base coat', ceil((sq * r.silicone.primerGalPerSq) / r.silicone.pail), '5-gal pail', 'required over SBS / asphalt (BleedTrap class); confirm by adhesion test');
    add('Coating', 'Polyester reinforcing fabric 6"', ceil(((T.perimLF + T.wallLF + T.curbLF + nVents * 3) * 1.1) / r.silicone.fabricRollFt), 'roll', 'seams, flashings, penetrations');
    add('Coating', 'Silicone flashing-grade sealant', ceil((nVents + nUnits * 4) / 10) + 1, 'case');
  }
  if (insul.length) {
    insul.forEach((th, i) => add('Insulation', `Polyiso ${th}" 4' x 8' (LTTR R-${rFor(th).toFixed(1)})${i ? ', joints staggered' : ''}`, boards, 'board'));
    add('Insulation', 'Insulation fasteners + 3" plates (base layer)', ceil(boards * perBoard), 'each', `${r.insulFastPerBoard.field}/${r.insulFastPerBoard.perimeter}/${r.insulFastPerBoard.corner} per board field/perimeter/corner`);
    const adhLayers = insul.length - 1 + (opts.cover ? 1 : 0);
    if (adhLayers > 0) add('Insulation', 'Low-rise foam insulation adhesive (upper layers)', ceil((roofSF * adhLayers) / 1500), 'twin pack', 'about 1,500 sqft per pack in ribbons');
  }
  if (opts.cover && sysKey !== 'silicone') add('Insulation', r.cover.name, boards, 'board');
  if (opts.taper && sysKey !== 'silicone') add('Insulation', 'Tapered polyiso 1/4" per ft (X/Y/Z panels 4\' x 4\') + crickets', ceil((roofSF / 16) * 1.08), 'panel', 'engineered taper layout required; crickets at 2x field slope');
  add('Metal', "Coping 12' (parapets, ES-1 tested)", ceil(T.parLF / r.copingFt), 'piece', `${fmtN(T.parLF)} LF; width at least the wall thickness (FBC 1503.3)`);
  add('Metal', "Edge metal / gravel stop 10' (ES-1 tested)", ceil(T.edgeLF / r.edgeMetalFt), 'piece', `${fmtN(T.edgeLF)} LF open edges (FBC 1504.5)`);
  add('Metal', "Termination bar 1\" x 10'", ceil((T.parLF + T.wallLF) / r.termBarFt), 'piece', 'parapets + walls between levels (500 LF per box)');
  if (T.wallLF) add('Metal', "Counter-flashing / reglet 10'", ceil(T.wallLF / 10), 'piece', `${fmtN(T.wallLF)} LF walls between levels`);
  if (T.drains) add('Drainage', 'Roof drains (replace / retrofit)', T.drains, 'each', !T.drainsEntered ? `estimate, 1 per ${fmt(r.drainSqft)} sqft (about 75 ft apart); verify on site` : 'entered');
  if (T.scuppers) add('Drainage', 'Overflow scuppers / secondary drains', T.scuppers, 'each', 'FBC-P 1108: required on parapet roofs; scupper at least 4" high');
  add('Accessories', 'Walkway pads 30" x 30"', nRtu * r.walkPadsPerRtu, 'each', `${r.walkPadsPerRtu} per HVAC unit, service side`);
  if (T.skylights) add('Accessories', 'Skylight curb flashing', T.skylights, 'each');
  if (T.hatches) add('Accessories', 'Roof hatch curb flashing', T.hatches, 'each');
  add('Accessories', 'Lap sealant / water cut-off mastic', ceil((T.perimLF + T.curbLF) / 250) + 1, 'case', '25 tubes per case');
  return { system: S.name, sysKey, wastePct: wp, rows, insul, rTotal: insul.reduce((s, th) => s + rFor(th), 0) + (opts.cover && sysKey !== 'silicone' ? r.cover.r : 0) };
}
