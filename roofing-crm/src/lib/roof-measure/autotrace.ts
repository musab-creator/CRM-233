import { degToPitch } from './format';
import { addEdge, addFacet, type BuildingInsights, type EdgeType, type Project, type RoofSegmentStats } from './model';
import { facetMetrics } from './measure';
import { downloadLayer, fetchDataLayers, type DataLayers, type FetchBuilding } from './solar';
import {
  allComponents, dominantAngle, dpSimplify, fillUnassigned, floodComponent, loadTiff, majorityFilter, regionize,
  regionOuterLoop, regularizeChain, splitChains, type Component, type Pt, type Raster,
} from './autotrace/raster';
import { traceBuildingV2, type GeoFrame, type TraceResult } from './autotrace/v2';

// Auto-trace (the tool's autotrace.js): from Google's building mask and
// height model to facets and classified lines, for the main building and
// small outbuildings in the frame. Returns data; applyAutoTrace() loads it
// into a project the way the tool loads it onto the map.

export { loadTiff, type Raster } from './autotrace/raster';
export { AT2, traceBuildingV2, type TraceResult, type TracedFacet, type TracedEdge } from './autotrace/v2';

export const AT = { v2: true, tolM: 0.75, minRegionM2: 3, dpEpsPx: 5, regularize: true, dropBlobM2: 10, maxOtherStructures: 3, minOtherM2: 4, maxOtherM2: 95, maxOtherDistM: 28 };

// ------------------------------------------------------------------ v1: Solar API planes painted onto the mask

interface PlaneModel { seg: Partial<RoofSegmentStats>; z0: number; tanP: number; ux: number; uy: number; e0: number; n0: number; pitch: number; az: number; h(e: number, n: number): number }

function planeModel(seg: Pick<RoofSegmentStats, 'pitchDegrees' | 'azimuthDegrees' | 'center' | 'planeHeightAtCenterMeters'>, ref: GeoFrame['ref']): PlaneModel {
  const az = (seg.azimuthDegrees * Math.PI) / 180, tanP = Math.tan((seg.pitchDegrees * Math.PI) / 180);
  const e0 = (seg.center.longitude - ref.lng) * ref.kx, n0 = (seg.center.latitude - ref.lat) * ref.ky;
  const ux = Math.sin(az), uy = Math.cos(az); // unit vector pointing down-slope (east, north)
  return {
    seg, z0: seg.planeHeightAtCenterMeters, tanP, ux, uy, e0, n0, pitch: Math.round(degToPitch(seg.pitchDegrees)), az: seg.azimuthDegrees,
    h(e, n) { return this.z0 - this.tanP * ((e - this.e0) * this.ux + (n - this.n0) * this.uy); },
  };
}

function classifyChain(chain: { pts: Pt[] }, A: PlaneModel, B: PlaneModel | null, geo: GeoFrame, insidePx: number, outsidePx: number): EdgeType {
  const p0 = chain.pts[0], p1 = chain.pts[chain.pts.length - 1];
  const e = [geo.E(p1[0]) - geo.E(p0[0]), geo.N(p1[1]) - geo.N(p0[1])]; const L = Math.hypot(e[0], e[1]) || 1e-9; e[0] /= L; e[1] /= L;
  const mid = chain.pts[Math.floor(chain.pts.length / 2)]; const me = geo.E(mid[0]), mn = geo.N(mid[1]);
  const cIn = geo.center!(insidePx), cOut = outsidePx >= 0 ? geo.center!(outsidePx) : null;
  if (!B) {
    if (A.pitch < 1) return 'eave';
    const c = Math.abs(e[0] * A.ux + e[1] * A.uy);
    if (c > 0.6) return 'rake';
    return A.h(me, mn) <= A.h(A.e0, A.n0) ? 'eave' : 'unspecified';
  }
  const gap = Math.abs(A.h(me, mn) - B.h(me, mn));
  if (gap > 0.6) { const low = A.h(me, mn) < B.h(me, mn) ? A : B; const c = Math.abs(e[0] * low.ux + e[1] * low.uy); return c > 0.6 ? 'step' : 'wall'; }
  const intoA = A.h(cIn.e, cIn.n) - A.h(cOut!.e, cOut!.n); // height change moving from the edge into A
  const intoB = cOut ? B.h(cOut.e, cOut.n) - B.h(cIn.e, cIn.n) : 0;
  const descA = intoA < -1e-4, descB = intoB < -1e-4;
  let azDiff = Math.abs(A.az - B.az) % 360; if (azDiff > 180) azDiff = 360 - azDiff;
  if (A.pitch < 1 || B.pitch < 1) return 'transition';
  if (descA && descB) return azDiff > 150 ? 'ridge' : 'hip';
  if (!descA && !descB) return 'valley';
  return azDiff < 30 ? 'transition' : 'unspecified';
}

export function traceBuildingV1(resp: BuildingInsights | null, tif: Raster, comp: { member: Uint8Array }, geo: GeoFrame, defaultPitch = 6): TraceResult {
  const { w, h } = tif;
  const segs = (resp && resp.solarPotential && resp.solarPotential.roofSegmentStats) || [];
  const planes = segs.map((s) => planeModel(s, geo.ref));
  const member = comp.member;
  const label = new Int16Array(w * h).fill(-1);
  let unassigned = 0, total = 0;
  let datum = 0;
  if (planes.length) {
    // plane bounding boxes (in metres, padded) limit which planes a pixel may join
    const boxes = segs.map((s) => ({ e0: (s.boundingBox.sw.longitude - geo.ref.lng) * geo.ref.kx - 1.2, e1: (s.boundingBox.ne.longitude - geo.ref.lng) * geo.ref.kx + 1.2, n0: (s.boundingBox.sw.latitude - geo.ref.lat) * geo.ref.ky - 1.2, n1: (s.boundingBox.ne.latitude - geo.ref.lat) * geo.ref.ky + 1.2 }));
    // the DSM and the plane heights can sit on different vertical datums (ellipsoid vs sea level): estimate the offset
    const perPlane: number[][] = planes.map(() => []);
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = y * w + x; if (!member[i]) continue; const z = tif.data[i]; if (!(z > -1000)) continue;
      const E = geo.E(x + 0.5), N = geo.N(y + 0.5);
      for (let k = 0; k < planes.length; k++) if (E >= boxes[k].e0 + 1.2 && E <= boxes[k].e1 - 1.2 && N >= boxes[k].n0 + 1.2 && N <= boxes[k].n1 - 1.2) perPlane[k].push(z - planes[k].h(E, N));
    }
    const med = (a: number[]) => { if (!a.length) return null; const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    const meds = perPlane.map(med).filter((v): v is number => v != null);
    datum = meds.length ? med(meds)! : 0;
    for (const p of planes) p.z0 += datum;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!member[i]) continue; total++;
      const z = tif.data[i]; const E = geo.E(x + 0.5), N = geo.N(y + 0.5);
      if (!(z > -1000)) { label[i] = -2; unassigned++; continue; }
      let best = -1, bestD = AT.tolM, bestAny = -1, bestAnyD = Infinity;
      for (let k = 0; k < planes.length; k++) {
        const d = Math.abs(planes[k].h(E, N) - z);
        const inBox = E >= boxes[k].e0 && E <= boxes[k].e1 && N >= boxes[k].n0 && N <= boxes[k].n1;
        if (inBox && d < bestD) { bestD = d; best = k; }
        if (d < bestAnyD) { bestAnyD = d; bestAny = k; }
      }
      if (best < 0 && bestAnyD < AT.tolM) { const k = bestAny; if (E >= boxes[k].e0 - 2 && E <= boxes[k].e1 + 2 && N >= boxes[k].n0 - 2 && N <= boxes[k].n1 + 2) best = k; }
      if (best < 0) { label[i] = -2; unassigned++; } else label[i] = best;
    }
    // a plane may not claim much more ground than Google measured for it (row houses and duplexes share planes with
    // the unit next door): keep the pixels nearest the plane centre, release the rest
    for (let k = 0; k < planes.length; k++) {
      const gA = segs[k].stats && segs[k].stats.groundAreaMeters2; if (!gA) continue;
      const budget = Math.round((gA / geo.pxM2) * 1.2);
      const idx: number[] = []; for (let i = 0; i < w * h; i++) if (label[i] === k) idx.push(i);
      if (idx.length <= budget) continue;
      const d2 = (i: number) => { const x = i % w, y = (i - x) / w; const dE = geo.E(x + 0.5) - planes[k].e0, dN = geo.N(y + 0.5) - planes[k].n0; return dE * dE + dN * dN; };
      idx.sort((a, b) => d2(a) - d2(b));
      for (let j = budget; j < idx.length; j++) { label[idx[j]] = -2; unassigned++; }
    }
    // large blobs that match none of the roof planes are not this roof (an attached neighbour, a carport, a tree over
    // the mask): drop them from the building; small gaps are filled from their neighbours below
    const un = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) un[i] = member[i] && label[i] === -2 ? 1 : 0;
    for (const blob of allComponents(un, w, h)) {
      if (blob.n * geo.pxM2 < AT.dropBlobM2) continue;
      for (let i = 0; i < w * h; i++) if (blob.member[i]) { member[i] = 0; label[i] = -1; }
    }
  } else {
    for (let i = 0; i < w * h; i++) if (member[i]) { label[i] = 0; total++; }
  }
  let lab = fillUnassigned(label, w, h, member);
  lab = majorityFilter(lab, w, h, member, 2, 2);
  lab = majorityFilter(lab, w, h, member, 1, 3);
  const { region, regions } = regionize(lab, w, h, member, geo.pxM2, AT.minRegionM2);
  const facets: TraceResult['facets'] = [], edges: TraceResult['edges'] = [];
  // dominant building axis from the outside boundary of the whole component
  const compRegion = new Int32Array(w * h).fill(-1); for (let i = 0; i < w * h; i++) if (member[i]) compRegion[i] = 0;
  const outerLoop = regionOuterLoop(compRegion, w, h, 0);
  const theta = dominantAngle([dpSimplify(outerLoop.map((e) => e.a), AT.dpEpsPx)]);
  for (const r of regions) {
    if (r.n * geo.pxM2 < AT.minRegionM2) continue;
    const loop = regionOuterLoop(region, w, h, r.id);
    if (loop.length < 4) continue;
    const chains = splitChains(loop, region);
    const poly: Pt[] = [];
    for (const ch of chains) {
      const simp = AT.regularize ? regularizeChain(dpSimplify(ch.pts, AT.dpEpsPx), theta) : dpSimplify(ch.pts, AT.dpEpsPx);
      for (let i = 0; i < simp.length - 1; i++) poly.push(simp[i]);
      const nbRegion = ch.outside;
      if (nbRegion >= 0 && nbRegion < r.id) continue; // shared chain emitted once, by the lower region id
      const A = planes[r.label] || planeModel({ pitchDegrees: 0, azimuthDegrees: 0, center: { latitude: geo.ref.lat, longitude: geo.ref.lng }, planeHeightAtCenterMeters: 0 }, geo.ref);
      const B = nbRegion >= 0 ? planes[regions[nbRegion].label] || null : null;
      const midE = ch.edges[Math.floor(ch.edges.length / 2)];
      const type = classifyChain({ pts: simp }, A, nbRegion >= 0 && !B ? A : B, geo, midE.inside, midE.outside);
      edges.push({ type: nbRegion >= 0 && !B ? 'transition' : type, path: simp.map((p) => tif.toLL(p[0], p[1])) });
    }
    if (poly.length < 3) continue;
    const pl = planes[r.label];
    facets.push({ path: poly.map((p) => tif.toLL(p[0], p[1])), pitch: pl ? pl.pitch : planes.length ? 0 : defaultPitch, azimuth: pl ? pl.az : null, areaM2: r.n * geo.pxM2 });
  }
  return { facets, edges, unassignedPct: total ? Math.round((unassigned / total) * 1000) / 10 : 0, planes: planes.length, datum: Math.round(datum * 100) / 100 };
}

// v2 (height-model planes) first; v1 (Solar API planes) when v2 fails or finds nothing.
export function traceBuilding(resp: BuildingInsights | null, tif: Raster, comp: { member: Uint8Array }, geo: GeoFrame, opts: { v1?: boolean; defaultPitch?: number } = {}): TraceResult {
  if (AT.v2 && !opts.v1) {
    try { const r = traceBuildingV2(tif, comp, geo); if (r && r.facets.length) return r; } catch { /* fall back to v1 */ }
  }
  return traceBuildingV1(resp, tif, comp, geo, opts.defaultPitch);
}

// ------------------------------------------------------------------ main

// Data-layer radius the tool requests for a building (m).
export function autoTraceRadius(main: BuildingInsights): number {
  const bb = main.boundingBox!;
  const cLat = main.center!.latitude;
  const kx = 111320 * Math.cos((cLat * Math.PI) / 180), ky = 110540;
  const halfDiag = Math.hypot((bb.ne.longitude - bb.sw.longitude) * kx, (bb.ne.latitude - bb.sw.latitude) * ky) / 2;
  return Math.min(100, Math.max(15, Math.ceil(halfDiag + 12)));
}

export interface AutoTraceLayers { layers: DataLayers; mask: Raster; dsm: Raster; radius: number }

// Downloads and decodes the mask and height model for a building (about 10 cents of Google API usage).
export async function loadAutoTraceLayers(main: BuildingInsights, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<AutoTraceLayers> {
  const radius = autoTraceRadius(main);
  const layers = await fetchDataLayers(main.center!.latitude, main.center!.longitude, radius, apiKey, fetchImpl);
  if (!layers.maskUrl || !layers.dsmUrl) throw new Error('Data layers did not include a mask and DSM');
  const [mBuf, dBuf] = await Promise.all([downloadLayer(layers.maskUrl, apiKey, fetchImpl), downloadLayer(layers.dsmUrl, apiKey, fetchImpl)]);
  const [mask, dsm] = await Promise.all([loadTiff(mBuf), loadTiff(dBuf)]);
  return { layers, mask, dsm, radius };
}

export interface TracedStructure { result: TraceResult; building: BuildingInsights | null; component: Component }
export interface AutoTraceResult {
  structures: TracedStructure[]; // main building first, then outbuildings
  size: string; // raster size "WxH"
}

export interface AutoTraceInput {
  building: BuildingInsights; // buildingInsights of the main building (Get roof data)
  mask: Raster;
  dsm: Raster;
  fetchBuilding?: FetchBuilding; // buildingInsights lookups for outbuildings; without it they trace from the height model alone
  defaultPitch?: number;
  v1?: boolean;
}

export async function autoTraceRoof(input: AutoTraceInput): Promise<AutoTraceResult> {
  const main = input.building;
  if (!main) throw new Error('Get roof data first');
  const bb = main.boundingBox!;
  const cLat = main.center!.latitude, cLng = main.center!.longitude;
  const kx = 111320 * Math.cos((cLat * Math.PI) / 180), ky = 110540;
  const maskT = input.mask, dsmT = input.dsm;
  if (maskT.w !== dsmT.w || maskT.h !== dsmT.h) throw new Error('Mask and DSM sizes differ');
  const w = maskT.w, h = maskT.h;
  const mask = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) mask[i] = maskT.data[i] > 0 ? 1 : 0;
  // metres frame relative to the building centre
  const ref = { lat: cLat, lng: cLng, kx, ky };
  const Ecol = new Float64Array(w + 1), Nrow = new Float64Array(h + 1);
  for (let x = 0; x <= w; x++) Ecol[x] = (maskT.toLL(x, 0).lng - cLng) * kx;
  for (let y = 0; y <= h; y++) Nrow[y] = (maskT.toLL(0, y).lat - cLat) * ky;
  const geo: GeoFrame = {
    ref,
    E: (x) => { const i = Math.floor(x); const f = x - i; return i >= w ? Ecol[w] : Ecol[i] + f * (Ecol[Math.min(i + 1, w)] - Ecol[i]); },
    N: (y) => { const i = Math.floor(y); const f = y - i; return i >= h ? Nrow[h] : Nrow[i] + f * (Nrow[Math.min(i + 1, h)] - Nrow[i]); },
    pxM2: Math.abs((Ecol[1] - Ecol[0]) * (Nrow[1] - Nrow[0])),
    center: (i) => { const x = i % w, y = (i - x) / w; return { e: (Ecol[x] + Ecol[x + 1]) / 2, n: (Nrow[y] + Nrow[y + 1]) / 2 }; },
    X: (E) => ((E - Ecol[0]) / (Ecol[w] - Ecol[0])) * w,
    Y: (N) => ((N - Nrow[0]) / (Nrow[h] - Nrow[0])) * h,
  };
  // keep only mask pixels inside the building's own bounding box (padded); attached neighbours and row houses otherwise merge in
  const padM = 2.5;
  const bE0 = (bb.sw.longitude - cLng) * kx - padM, bE1 = (bb.ne.longitude - cLng) * kx + padM, bN0 = (bb.sw.latitude - cLat) * ky - padM, bN1 = (bb.ne.latitude - cLat) * ky + padM;
  const clipped = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { const N = geo.N(y + 0.5); if (N < bN0 || N > bN1) continue; for (let x = 0; x < w; x++) { const i = y * w + x; if (!mask[i]) continue; const E = geo.E(x + 0.5); if (E >= bE0 && E <= bE1) clipped[i] = 1; } }
  // the main building is the mask piece that fills Google's building box best (the box centre can fall outside an L-shaped house)
  let sx = -1, sy = -1;
  {
    let pieces = allComponents(clipped, w, h);
    const cx0 = geo.X(0) || w / 2, cy0 = geo.Y(0) || h / 2;
    if (!pieces.length) {
      // Google's building box missed the mask (box from older imagery): take the nearest roof piece instead
      const near = allComponents(mask, w, h).filter((pc) => pc.n * geo.pxM2 >= 20 && Math.hypot(pc.cx - cx0, pc.cy - cy0) * Math.sqrt(geo.pxM2) < 20);
      for (const pc of near) for (let i = 0; i < w * h; i++) if (pc.member[i]) clipped[i] = 1;
      pieces = near;
    }
    if (!pieces.length) throw new Error('Building mask is empty at this location');
    let best: Component | null = null, bestScore = -Infinity;
    for (const pc of pieces) { const d = Math.hypot(pc.cx - cx0, pc.cy - cy0) * Math.sqrt(geo.pxM2); const score = pc.n * geo.pxM2 - d * 2; if (score > bestScore) { bestScore = score; best = pc; } }
    for (let i = 0; i < w * h; i++) if (best!.member[i]) { sx = i % w; sy = (i - sx) / w; break; }
  }
  const mainFlood = floodComponent(clipped, w, h, sx, sy);
  if (!mainFlood.n) throw new Error('Building mask is empty inside the building bounds');
  let msx = 0, msy = 0, mminx = w, mmaxx = 0, mminy = h, mmaxy = 0;
  for (let j = 0; j < w * h; j++) if (mainFlood.out[j]) { const px = j % w, py = (j - px) / w; msx += px; msy += py; if (px < mminx) mminx = px; if (px > mmaxx) mmaxx = px; if (py < mminy) mminy = py; if (py > mmaxy) mmaxy = py; }
  const mainComp: Component = { member: mainFlood.out, n: mainFlood.n, cx: msx / mainFlood.n, cy: msy / mainFlood.n, bbox: [mminx, mminy, mmaxx, mmaxy] };
  // everything else in the mask (minus the main building) is a candidate outbuilding
  const rest = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) rest[i] = mask[i] && !mainComp.member[i] ? 1 : 0;
  const comps = allComponents(rest, w, h);
  const opts = { v1: input.v1, defaultPitch: input.defaultPitch };
  const structures: TracedStructure[] = [];
  structures.push({ component: mainComp, result: traceBuilding(main, dsmT, mainComp, geo, opts), building: main });
  // candidate outbuildings: small, fully inside the frame, close to the main building (large components are neighbours)
  const mainDist = (c: Component) => Math.hypot(geo.E(c.cx) - geo.E(mainComp.cx), geo.N(c.cy) - geo.N(mainComp.cy));
  const others = comps.filter((c) => c !== mainComp && c.n * geo.pxM2 >= AT.minOtherM2 && c.n * geo.pxM2 <= AT.maxOtherM2 && c.bbox[0] > 0 && c.bbox[1] > 0 && c.bbox[2] < w - 1 && c.bbox[3] < h - 1 && mainDist(c) <= AT.maxOtherDistM).sort((a, b) => b.n - a.n).slice(0, AT.maxOtherStructures);
  const mainRoofM2 = (main.solarPotential && main.solarPotential.wholeRoofStats && main.solarPotential.wholeRoofStats.areaMeters2) || 0;
  for (const c of others) {
    if (c.n > mainComp.n * 0.45) continue; // too big for an outbuilding: a neighbour
    const ll = maskT.toLL(c.cx + 0.5, c.cy + 0.5);
    let resp: BuildingInsights | null = null;
    try {
      if (!input.fetchBuilding) throw new Error('no lookup');
      const r = await input.fetchBuilding(ll.lat, ll.lng);
      if (r.name === main.name) continue; // Google says this is part of the main building
      const area = r.solarPotential && r.solarPotential.wholeRoofStats ? r.solarPotential.wholeRoofStats.areaMeters2 : 0;
      if (mainRoofM2 && area > mainRoofM2 * 0.5) continue; // a neighbouring house, not a shed
      const inside = r.center && Math.abs((r.center.longitude - ll.lng) * kx) < 8 && Math.abs((r.center.latitude - ll.lat) * ky) < 8;
      resp = inside ? r : null;
    } catch { /* no model for this component */ }
    try { structures.push({ component: c, result: traceBuilding(resp, dsmT, c, geo, opts), building: resp }); } catch { /* skip */ }
  }
  return { structures, size: `${w}x${h}` };
}

export interface AutoTraceInfo { structures: number; facets: number; edges: number; mainSqft: number; unassignedPct: number; planes: number; datum: number; size: string }

// Replaces the project's facets and lines with the auto-trace (names F1, F2, ...; lines take their pitch from the
// facet they run along), and lists the outbuildings' Solar data as other structures.
export function applyAutoTrace(p: Project, r: AutoTraceResult): AutoTraceInfo {
  p.facets = []; p.edges = [];
  let fi = 0, mainSqft = 0;
  r.structures.forEach(({ result }, idx) => {
    for (const f of result.facets) {
      const added = addFacet(p, f.path, f.pitch, `F${++fi}`);
      added.azimuth = f.azimuth;
      if (idx === 0) mainSqft += facetMetrics(added).sloped;
    }
    for (const e of result.edges) addEdge(p, e.type, e.path, null);
  });
  p.otherSolar = r.structures.slice(1).map((s) => s.building).filter((b): b is BuildingInsights => !!b);
  const main = r.structures[0].result;
  return { structures: r.structures.length, facets: fi, edges: p.edges.length, mainSqft: Math.round(mainSqft), unassignedPct: main.unassignedPct, planes: main.planes, datum: main.datum, size: r.size };
}
