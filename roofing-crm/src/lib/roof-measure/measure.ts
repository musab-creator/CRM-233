import type { RoofMeasurements } from '@/types';
import { centroid, computeArea, computeLength, containsLocation, coveredByEdge, FT_PER_M, midpoint, pointSegM, segFt, SQFT_PER_M2, type LatLng } from './geo';
import { csvCell, degToPitch, esc, fmt, ftIn, pitchLabel } from './format';
import type { BuildingInsights, Edge, EdgeType, Facet, MaterialAssumptions, Project } from './model';
import { solarSummaryOf } from './solar';

// Roof Measure's measurement engine (app.js): facet and line metrics,
// structures, totals in the tool's own output shape, the Roofr-method waste
// recommendation and the sidebar's quick materials list.

export { fmt, ftIn, ftInR, esc, pitchLabel, degToPitch } from './format';

export const SNAP_PX = 12;
export const TOUCH_M = 0.75; // facets closer than this are the same structure
export const FACET_COLOR = '#00d8ff';

export interface EdgeTypeInfo { label: string; plural: string; color: string; slope: 'flat' | 'hip' | 'rake'; dashed?: boolean }
// Line types, named and colored like Roofr's length report.
export const EDGE_TYPES: Record<EdgeType, EdgeTypeInfo> = {
  eave: { label: 'Eave', plural: 'Eaves', color: '#4caf50', slope: 'flat' },
  valley: { label: 'Valley', plural: 'Valleys', color: '#e5533d', slope: 'hip' },
  hip: { label: 'Hip', plural: 'Hips', color: '#8e5bd6', slope: 'hip' },
  ridge: { label: 'Ridge', plural: 'Ridges', color: '#b5d46a', slope: 'flat' },
  rake: { label: 'Rake', plural: 'Rakes', color: '#f5c242', slope: 'rake' },
  wall: { label: 'Wall flashing', plural: 'Wall flashing', color: '#3b8be6', slope: 'flat', dashed: true },
  step: { label: 'Step flashing', plural: 'Step flashing', color: '#e0902a', slope: 'rake', dashed: true },
  transition: { label: 'Transition', plural: 'Transitions', color: '#e26ee6', slope: 'flat' },
  parapet: { label: 'Parapet wall', plural: 'Parapet wall', color: '#f0a030', slope: 'flat' },
  unspecified: { label: 'Unspecified', plural: 'Unspecified', color: '#4fc3f7', slope: 'flat' },
};
export const PITCH_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 24];
// Keyboard shortcuts of the drawing tools (S select, F facet, E eave, ...).
export type Tool = 'select' | 'facet' | EdgeType;
export const TOOL_KEYS: Record<string, Tool> = { s: 'select', f: 'facet', e: 'eave', v: 'valley', h: 'hip', r: 'ridge', k: 'rake', w: 'wall', t: 'step', n: 'transition', p: 'parapet', u: 'unspecified' };
export const WASTE_OPTIONS = [0, 5, 10, 12, 15, 18, 20];

export const pitchFactor = (p: number) => Math.sqrt(144 + p * p) / 12; // rake / slope factor
export const hipFactor = (p: number) => Math.sqrt(1 + (p * p) / 288); // hip & valley (equal pitch, 90 deg corner)
export const edgeFactor = (type: EdgeType, pitch: number) => {
  const s = EDGE_TYPES[type].slope;
  return s === 'flat' ? 1 : s === 'rake' ? pitchFactor(pitch) : hipFactor(pitch);
};

// ------------------------------------------------------------------ metrics

export interface FacetMetrics { path: LatLng[]; plan: number; sloped: number; perimeterFt: number }
export interface EdgeMetrics { path: LatLng[]; planFt: number; trueFt: number; factor: number; pitch: number }
export interface FacetEntry { f: Facet; m: FacetMetrics }
export interface EdgeEntry { e: Edge; m: EdgeMetrics }

export function facetMetrics(f: Facet): FacetMetrics {
  const path = f.path;
  const plan = computeArea(path) * SQFT_PER_M2;
  const sloped = plan * pitchFactor(f.pitch);
  const perimeterFt = computeLength([...path, path[0]]) * FT_PER_M;
  return { path, plan, sloped, perimeterFt };
}

// Pitch of the facet this line runs along (so rakes and hips on a 4/12 shed use 4/12, not the default).
export function adjoiningPitch(path: LatLng[], facets: Facet[]): number | null {
  if (path.length < 2) return null;
  const mid = midpoint(path[0], path[1]);
  let best: number | null = null, bestD = 0.6;
  for (const f of facets) {
    if (f.excluded) continue;
    const fp = f.path;
    for (let i = 0; i < fp.length; i++) { const d = pointSegM(mid, fp[i], fp[(i + 1) % fp.length]); if (d < bestD) { bestD = d; best = f.pitch; } }
  }
  return best;
}

export function edgeMetrics(e: Edge, facets: Facet[], defaultPitch: number): EdgeMetrics {
  const path = e.path;
  const planFt = computeLength(path) * FT_PER_M;
  const adj = e.pitch == null ? adjoiningPitch(path, facets) : null;
  const pitch = e.pitch != null ? e.pitch : adj != null ? adj : defaultPitch;
  const factor = edgeFactor(e.type, pitch);
  return { path, planFt, trueFt: planFt * factor, factor, pitch };
}

// ------------------------------------------------------------------ structures and totals

export function polysTouch(A: FacetEntry, B: FacetEntry): boolean {
  const pa = A.m.path, pb = B.m.path;
  for (const p of pa) {
    if (containsLocation(p, pb)) return true;
    for (let i = 0; i < pb.length; i++) if (pointSegM(p, pb[i], pb[(i + 1) % pb.length]) < TOUCH_M) return true;
  }
  for (const p of pb) if (containsLocation(p, pa)) return true;
  return false;
}

export interface StructureGroup { facets: FacetEntry[]; cutouts: FacetEntry[]; edges: EdgeEntry[] }

// Facets that touch form one structure (connected components); lines join the nearest structure.
export function groupStructures(facetsAll: FacetEntry[], edges: EdgeEntry[]): StructureGroup[] {
  const n = facetsAll.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (polysTouch(facetsAll[i], facetsAll[j])) parent[find(i)] = find(j);
  const groups = new Map<number, StructureGroup>();
  facetsAll.forEach((x, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { facets: [], cutouts: [], edges: [] });
    (x.f.excluded ? groups.get(r)!.cutouts : groups.get(r)!.facets).push(x);
  });
  const list = [...groups.values()];
  for (const ed of edges) {
    let best: StructureGroup | null = null, bestD = Infinity;
    for (const g of list) for (const x of [...g.facets, ...g.cutouts]) for (const p of ed.m.path) {
      const path = x.m.path;
      for (let i = 0; i < path.length; i++) { const d = pointSegM(p, path[i], path[(i + 1) % path.length]); if (d < bestD) { bestD = d; best = g; } }
    }
    if (best) best.edges.push(ed); else if (list.length) list[0].edges.push(ed);
  }
  return list;
}

export interface LineTotal { plan: number; true: number; count: number }
export interface Summary {
  facets: FacetEntry[];
  cutouts: FacetEntry[];
  edges: EdgeEntry[];
  plan: number;
  sloped: number;
  pitched: number;
  flat: number;
  twoStory: number;
  twoLayer: number;
  byType: Record<EdgeType, LineTotal>;
  pitchGroups: Record<number, number>; // pitch -> roof sqft
  pitches: number[];
  predominant: number | null;
  predArea: number;
  facetCount: number;
  weightedPitch: number;
  squares: number;
  squaresWaste: number;
  index?: number; // structure number (structures only)
  recWaste?: number;
}
export interface Totals extends Summary {
  structures: Summary[];
  recWaste: number;
  facetsAll: FacetEntry[];
}

export function summarize(fs: FacetEntry[], cs: FacetEntry[], es: EdgeEntry[], waste: number, defaultPitch: number): Summary {
  const byType = {} as Record<EdgeType, LineTotal>;
  for (const t of Object.keys(EDGE_TYPES) as EdgeType[]) byType[t] = { plan: 0, true: 0, count: 0 };
  for (const { e, m } of es) { byType[e.type].plan += m.planFt; byType[e.type].true += m.trueFt; byType[e.type].count++; }
  const sum = (arr: FacetEntry[], k: 'plan' | 'sloped') => arr.reduce((s, x) => s + x.m[k], 0);
  const plan = sum(fs, 'plan') - sum(cs, 'plan');
  const sloped = sum(fs, 'sloped') - sum(cs, 'sloped');
  const pitchGroups: Record<number, number> = {};
  for (const x of fs) pitchGroups[x.f.pitch] = (pitchGroups[x.f.pitch] || 0) + x.m.sloped;
  for (const x of cs) if (pitchGroups[x.f.pitch] != null) pitchGroups[x.f.pitch] -= x.m.sloped;
  const pitches = Object.keys(pitchGroups).map(Number).sort((a, b) => a - b);
  let predominant: number | null = null, predArea = -1;
  for (const p of pitches) if (pitchGroups[p] > predArea) { predArea = pitchGroups[p]; predominant = p; }
  const flat = pitchGroups[0] || 0;
  const twoStory = fs.filter((x) => x.f.twoStory).reduce((s, x) => s + x.m.sloped, 0);
  const twoLayer = fs.filter((x) => x.f.twoLayer).reduce((s, x) => s + x.m.sloped, 0);
  const wp = sloped > 0 ? fs.reduce((s, x) => s + x.m.sloped * x.f.pitch, 0) / sum(fs, 'sloped') : defaultPitch;
  return {
    facets: fs, cutouts: cs, edges: es, plan, sloped, pitched: sloped - flat, flat, twoStory, twoLayer, byType, pitchGroups, pitches, predominant,
    predArea: Math.max(predArea, 0), facetCount: fs.length, weightedPitch: wp, squares: sloped / 100, squaresWaste: (sloped / 100) * (1 + waste / 100),
  };
}

// Roofr-style recommended waste, fitted to Roofr reports: cut edges (hips + valleys + rakes + step flashing) per square.
export function roofrWaste(S: Pick<Summary, 'sloped' | 'pitched' | 'byType'> | null | undefined): number {
  if (!S || !S.sloped || S.pitched <= 0) return 10;
  const cut = S.byType.hip.true + S.byType.valley.true + S.byType.rake.true + S.byType.step.true;
  const perSq = cut / (S.sloped / 100);
  return Math.max(1, Math.round(1 + 1.18 * perSq));
}

export function computeTotals(p: Pick<Project, 'facets' | 'edges' | 'waste' | 'defaultPitch'>): Totals {
  const facetsAll = p.facets.map((f) => ({ f, m: facetMetrics(f) }));
  const edges = p.edges.map((e) => ({ e, m: edgeMetrics(e, p.facets, p.defaultPitch) }));
  const groups = groupStructures(facetsAll, edges).map((g) => summarize(g.facets, g.cutouts, g.edges, p.waste, p.defaultPitch)).sort((a, b) => b.sloped - a.sloped);
  groups.forEach((g, i) => { g.index = i + 1; });
  const all = summarize(facetsAll.filter((x) => !x.f.excluded), facetsAll.filter((x) => x.f.excluded), edges, p.waste, p.defaultPitch) as Totals;
  all.structures = groups;
  all.recWaste = roofrWaste(all);
  for (const g of groups) g.recWaste = roofrWaste(g);
  all.facetsAll = facetsAll;
  return all;
}

export function structureOf(t: Totals, facetId: number): number | null {
  for (const s of t.structures) if ([...s.facets, ...s.cutouts].some((x) => x.f.id === facetId)) return s.index ?? null;
  return null;
}

// ------------------------------------------------------------------ quick materials (sidebar list)

export interface MaterialItem { name: string; qty: number; unit: string; basis: string }

export function computeMaterials(t: Pick<Summary, 'byType' | 'squares' | 'squaresWaste'>, m: MaterialAssumptions, waste: number): MaterialItem[] {
  const bt = t.byType;
  const eaveRake = bt.eave.true + bt.rake.true;
  const ridgeHip = bt.ridge.true + bt.hip.true;
  const items: MaterialItem[] = [];
  const add = (name: string, qty: number, unit: string, basis: string) => items.push({ name, qty, unit, basis });
  add('Shingles', Math.ceil(t.squaresWaste * 3), 'bundles', `${fmt(t.squares, 2)} sq + ${waste}% waste = ${fmt(t.squaresWaste, 2)} sq, 3 bundles/sq`);
  add('Synthetic underlayment', Math.ceil((t.squares * 1.1) / m.underlaySq), 'rolls', `${fmt(t.squares, 2)} sq + 10% laps, ${m.underlaySq} sq/roll`);
  add('Ice & water shield', Math.ceil((bt.eave.true + bt.valley.true) / m.iwLF), 'rolls', `eaves ${fmt(bt.eave.true)} LF + valleys ${fmt(bt.valley.true)} LF, ${m.iwLF} LF/roll`);
  add('Starter strip', Math.ceil(eaveRake / m.starterLF), 'bundles', `eaves + rakes ${fmt(eaveRake)} LF, ${m.starterLF} LF/bundle`);
  add('Ridge cap', Math.ceil(ridgeHip / m.ridgeCapLF), 'bundles', `ridges + hips ${fmt(ridgeHip)} LF, ${m.ridgeCapLF} LF/bundle`);
  add('Drip edge', Math.ceil((eaveRake * 1.05) / m.dripStick), 'sticks', `eaves + rakes ${fmt(eaveRake)} LF + 5%, ${m.dripStick}' sticks`);
  if (bt.valley.true > 0) add('Valley metal (if open valley)', Math.ceil(bt.valley.true / m.valleyStick), 'sticks', `${fmt(bt.valley.true)} LF, ${m.valleyStick}' sticks`);
  if (bt.step.true > 0) add('Step flashing', Math.ceil(bt.step.true * 2.2), 'pieces', `${fmt(bt.step.true)} LF at 5 5/8" exposure`);
  if (bt.wall.true > 0) add('Wall / apron flashing', Math.ceil(bt.wall.true / 10), 'sticks', `${fmt(bt.wall.true)} LF, 10' sticks`);
  if (bt.ridge.true > 0) add('Ridge vent (if vented ridge)', Math.ceil(bt.ridge.true / 4), 'pieces', `${fmt(bt.ridge.true)} LF ridge, 4' pieces`);
  add('Coil nails', Math.ceil((t.squaresWaste * m.nailsPerSq) / m.nailsPerBox), 'boxes', `${m.nailsPerSq} nails/sq, ${m.nailsPerBox}/box`);
  return items;
}

// ------------------------------------------------------------------ CRM mapping

const round2 = (n: number) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// The "Report summary" numbers in the CRM's RoofMeasurements field names (same mapping as roof-measure-bridge.ts).
export function toRoofMeasurements(t: Pick<Summary, 'sloped' | 'pitched' | 'flat' | 'twoStory' | 'predominant' | 'facetCount' | 'byType'> & { recWaste: number }, defaultPitch = 6): RoofMeasurements {
  const bt = t.byType;
  return {
    totalSqFt: round2(t.sloped),
    pitchedSqFt: round2(t.pitched),
    flatSqFt: round2(t.flat),
    twoStorySqFt: round2(t.twoStory),
    pitch: t.predominant ?? defaultPitch,
    facets: t.facetCount,
    eaves: round2(bt.eave.true),
    rakes: round2(bt.rake.true),
    valleys: round2(bt.valley.true),
    hipsRidges: round2(bt.hip.true + bt.ridge.true),
    eavesRakes: round2(bt.eave.true + bt.rake.true),
    flashing: round2(bt.wall.true + bt.step.true),
    penetrations: null, // Roof Measure does not count pipes or vents
    wastePct: t.recWaste,
  };
}

// ------------------------------------------------------------------ drawing support (snapping, labels)

export interface PixelPoint { x: number; y: number }
export type ToPixel = (p: LatLng) => PixelPoint | null;

// Every corner on the map (facets, lines, the shape being drawn): the snap targets.
export function allVertices(p: Pick<Project, 'facets' | 'edges'>, draftPoints: LatLng[] = []): LatLng[] {
  const v: LatLng[] = [];
  for (const f of p.facets) v.push(...f.path);
  for (const e of p.edges) v.push(...e.path);
  v.push(...draftPoints);
  return v;
}

// The tool's snap(): the nearest vertex within SNAP_PX screen pixels, else the point itself.
export function snapToVertex(point: LatLng, vertices: LatLng[], toPixel: ToPixel, snapPx = SNAP_PX): LatLng {
  let best: LatLng | null = null, bestD = snapPx + 1;
  const p0 = toPixel(point);
  if (!p0) return point;
  for (const v of vertices) {
    const q = toPixel(v);
    if (!q) continue;
    const d = Math.hypot(q.x - p0.x, q.y - p0.y);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best || point;
}

export function nearPx(a: LatLng, b: LatLng, px: number, toPixel: ToPixel): boolean {
  const pa = toPixel(a), pb = toPixel(b);
  if (!pa || !pb) return false;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) <= px;
}

// What a click does while drawing (the tool's onMapClick after snapping): ignore the second click of a
// double-click, close a facet on its first corner, or add the point.
export function draftClickAction(tool: 'facet' | EdgeType, points: LatLng[], snapped: LatLng, toPixel: ToPixel): 'ignore' | 'finish' | 'add' {
  if (points.length && nearPx(snapped, points[points.length - 1], 4, toPixel)) return 'ignore';
  if (tool === 'facet' && points.length >= 3 && points[0].lat === snapped.lat && points[0].lng === snapped.lng) return 'finish';
  return 'add';
}

export interface MapLabel { lat: number; lng: number; cls: string; html: string }

// The tool's label overlay: facet names / areas at centroids, facet edge lengths, line lengths, Solar planes.
export function mapLabels(p: Pick<Project, 'facets' | 'edges' | 'defaultPitch' | 'solar' | 'otherSolar'>, opts: { showFacetEdges?: boolean; showSolar?: boolean } = {}): MapLabel[] {
  const showFacetEdges = opts.showFacetEdges ?? true, showSolar = opts.showSolar ?? true;
  const items: MapLabel[] = [];
  const edgePaths = p.edges.map((e) => e.path);
  for (const f of p.facets) {
    const m = facetMetrics(f);
    if (f.excluded) items.push({ ...centroid(m.path), cls: 'facet cut', html: `${esc(f.name)} excluded<small>&minus;${fmt(m.sloped)} sf</small>` });
    else items.push({ ...centroid(m.path), cls: 'facet', html: `${esc(f.name)} &middot; ${pitchLabel(f.pitch)}${f.twoStory ? ' &middot; 2-story' : ''}${f.twoLayer ? ' &middot; 2-layer' : ''}<small>${fmt(m.sloped)} sf</small>` });
    if (showFacetEdges && !f.excluded) for (let i = 0; i < m.path.length; i++) {
      const a = m.path[i], b = m.path[(i + 1) % m.path.length];
      if (coveredByEdge(a, b, edgePaths)) continue;
      items.push({ ...midpoint(a, b), cls: 'fe', html: ftIn(segFt(a, b)) });
    }
  }
  for (const e of p.edges) {
    const m = edgeMetrics(e, p.facets, p.defaultPitch);
    for (let i = 1; i < m.path.length; i++) {
      const a = m.path[i - 1], b = m.path[i];
      items.push({ ...midpoint(a, b), cls: '', html: `<span style="color:${EDGE_TYPES[e.type].color}">&#9632;</span> ${ftIn(segFt(a, b) * m.factor)}` });
    }
  }
  if (showSolar) {
    const segs = p.solar && p.solar.solarPotential ? p.solar.solarPotential.roofSegmentStats || [] : [];
    for (const s of segs) items.push({ lat: s.center.latitude, lng: s.center.longitude, cls: 'solar', html: `${pitchLabel(Math.round(degToPitch(s.pitchDegrees)))} &middot; ${fmt(s.stats.areaMeters2 * SQFT_PER_M2)} sf` });
    p.otherSolar.forEach((o: BuildingInsights, i) => {
      const q = solarSummaryOf(o);
      if (q && o.center) items.push({ lat: o.center.latitude, lng: o.center.longitude, cls: 'solar other', html: `Structure #${i + 2}<small>${fmt(q.total)} sf &middot; ${pitchLabel(Math.round(q.predominant))}</small>` });
    });
  }
  return items;
}

// Live labels while drawing: segment lengths, the rubber-band length to the cursor, and the facet's area so far.
export function draftLabels(tool: 'facet' | EdgeType, points: LatLng[], cursor: LatLng | null, defaultPitch: number): MapLabel[] {
  const items: MapLabel[] = [];
  if (points.length && cursor) {
    const last = points[points.length - 1];
    items.push({ ...midpoint(last, cursor), cls: 'draft', html: ftIn(segFt(last, cursor)) });
  }
  for (let i = 1; i < points.length; i++) items.push({ ...midpoint(points[i - 1], points[i]), cls: 'draft', html: ftIn(segFt(points[i - 1], points[i])) });
  if (tool === 'facet' && points.length >= 3) {
    const plan = computeArea(points) * SQFT_PER_M2;
    items.push({ ...centroid(points), cls: 'facet', html: `${fmt(plan)} sf plan<small>${pitchLabel(defaultPitch)} &rarr; ${fmt(plan * pitchFactor(defaultPitch))} sf</small>` });
  }
  return items;
}

// Hint line under the map (the tool's updateHint).
export function drawingHint(tool: Tool, draftPoints: LatLng[] | null, hasShapes: boolean): string {
  if (draftPoints) {
    const n = draftPoints.length;
    if (tool === 'facet') return n < 3 ? `Facet: ${n} point${n === 1 ? '' : 's'} - click corners of this roof plane` : `Facet: ${n} points - double-click, press Enter, or click the first point to close`;
    if (tool !== 'select') return `${EDGE_TYPES[tool].label}: ${n} point${n === 1 ? '' : 's'} - double-click or Enter to finish`;
  }
  if (tool === 'select') return hasShapes ? 'Select: click a shape to edit it. Drag corners, right-click a corner to remove it.' : 'Enter an address, then pick Facet and click the corners of each roof plane.';
  if (tool === 'facet') return 'Facet: click the corners of one roof plane';
  return `${EDGE_TYPES[tool].label}: click the start point`;
}

// ------------------------------------------------------------------ CSV export

export function fileBase(p: Pick<Project, 'jobName' | 'address'>) {
  return (p.jobName || p.address || 'roof').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'roof';
}

// The tool's "Export CSV" file contents.
export function buildCSV(p: Project, now: Date = new Date()): string {
  const t = computeTotals(p);
  const L: string[] = [];
  L.push(['Roof Measure export', p.jobName, p.address, now.toLocaleString('en-US')].map(csvCell).join(','));
  L.push('');
  L.push('Facet,Structure,Pitch,Plan sq ft,Roof sq ft,Perimeter ft,Corners,Two story,Two layer,Excluded');
  for (const { f, m } of t.facetsAll) L.push([f.name, structureOf(t, f.id), pitchLabel(f.pitch), m.plan.toFixed(1), m.sloped.toFixed(1), m.perimeterFt.toFixed(1), m.path.length, f.twoStory ? 'yes' : '', f.twoLayer ? 'yes' : '', f.excluded ? 'yes' : ''].map(csvCell).join(','));
  L.push(['TOTAL', '', `${t.weightedPitch.toFixed(1)}/12 avg`, t.plan.toFixed(1), t.sloped.toFixed(1), '', '', '', '', ''].join(','));
  L.push('');
  L.push('Line,Type,Pitch used,Plan ft,Actual ft,Segments');
  t.edges.forEach(({ e, m }, i) => L.push([i + 1, EDGE_TYPES[e.type].label, pitchLabel(m.pitch), m.planFt.toFixed(1), m.trueFt.toFixed(1), m.path.length - 1].map(csvCell).join(',')));
  L.push('');
  L.push('Line type,Total plan ft,Total actual ft');
  for (const [k, v] of Object.entries(EDGE_TYPES) as [EdgeType, EdgeTypeInfo][]) if (t.byType[k].count) L.push([v.plural, t.byType[k].plan.toFixed(1), t.byType[k].true.toFixed(1)].join(','));
  L.push('');
  L.push('Structure,Facets,Roof sq ft,Predominant pitch');
  for (const s of t.structures) L.push([`Structure #${s.index}`, s.facetCount, s.sloped.toFixed(1), s.predominant == null ? '' : pitchLabel(s.predominant)].join(','));
  L.push('');
  L.push(`Squares,${t.squares.toFixed(2)}`); L.push(`Waste %,${p.waste}`); L.push(`Squares with waste,${t.squaresWaste.toFixed(2)}`);
  L.push('');
  L.push('Material,Qty,Unit,Basis');
  for (const i of computeMaterials(t, p.mat, p.waste)) L.push([i.name, i.qty, i.unit, i.basis].map(csvCell).join(','));
  return L.join('\r\n');
}
