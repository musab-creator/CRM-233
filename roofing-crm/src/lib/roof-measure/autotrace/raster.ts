import { fromArrayBuffer } from 'geotiff';
import proj4 from 'proj4';
import type { LatLng } from '../geo';

// GeoTIFF loading and the raster / vector helpers of the tool's autotrace.js
// (connected components, label filters, crack-edge outlines, Douglas-Peucker,
// building-axis snapping). Ported line for line: the auto-trace output must
// match the original's.

export type Pt = number[]; // [x, y]
export type NumArray = ArrayLike<number> & { [i: number]: number; length: number };

export interface Raster {
  data: NumArray;
  w: number;
  h: number;
  toLL: (x: number, y: number) => LatLng; // pixel corner coordinates -> lat/lng
  rx: number;
  ry: number;
  epsg: number;
}

// Reads a Solar API data-layer GeoTIFF (UTM, Web Mercator or lat/lng).
export async function loadTiff(buf: ArrayBuffer): Promise<Raster> {
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const data = (await img.readRasters())[0] as unknown as NumArray;
  const w = img.getWidth(), h = img.getHeight();
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution();
  const keys = (img.getGeoKeys ? img.getGeoKeys() || {} : {}) as Record<string, number>;
  const epsg = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey || 4326;
  const sy = ry > 0 ? -ry : ry; // rows run southward: model y decreases as the row index grows
  let toLL: Raster['toLL'];
  if (epsg === 4326 || Math.abs(ox) <= 360) toLL = (x, y) => ({ lng: ox + x * rx, lat: oy + y * sy });
  else {
    let def: string | null = null;
    if (epsg >= 32601 && epsg <= 32660) def = `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
    else if (epsg >= 32701 && epsg <= 32760) def = `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
    else if (epsg === 3857) def = 'EPSG:3857';
    if (!def) throw new Error('Unsupported GeoTIFF projection EPSG:' + epsg);
    const d = def;
    toLL = (x, y) => { const p = proj4(d, 'EPSG:4326', [ox + x * rx, oy + y * sy]); return { lng: p[0], lat: p[1] }; };
  }
  return { data, w, h, toLL, rx, ry, epsg };
}

// ------------------------------------------------------------------ raster helpers

export interface Component { member: Uint8Array; n: number; cx: number; cy: number; bbox: number[] }

// Connected component (4-neighbour) of mask pixels containing (sx, sy).
export function floodComponent(mask: NumArray, w: number, h: number, sx: number, sy: number) {
  const out = new Uint8Array(w * h); const stack = [sy * w + sx]; let n = 0;
  if (!mask[sy * w + sx]) return { out, n: 0 };
  out[sy * w + sx] = 1;
  while (stack.length) {
    const i = stack.pop()!; n++;
    const x = i % w, y = (i - x) / w;
    if (x > 0 && mask[i - 1] && !out[i - 1]) { out[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && mask[i + 1] && !out[i + 1]) { out[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && mask[i - w] && !out[i - w]) { out[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && mask[i + w] && !out[i + w]) { out[i + w] = 1; stack.push(i + w); }
  }
  return { out, n };
}

export function allComponents(mask: NumArray, w: number, h: number): Component[] {
  const seen = new Uint8Array(w * h); const comps: Component[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    const x = i % w, y = (i - x) / w;
    const { out, n } = floodComponent(mask, w, h, x, y);
    let sx = 0, sy = 0, minx = w, maxx = 0, miny = h, maxy = 0;
    for (let j = 0; j < w * h; j++) if (out[j]) { seen[j] = 1; const px = j % w, py = (j - px) / w; sx += px; sy += py; if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; }
    comps.push({ member: out, n, cx: sx / n, cy: sy / n, bbox: [minx, miny, maxx, maxy] });
  }
  return comps;
}

export function majorityFilter(label: Int16Array, w: number, h: number, member: NumArray, passes: number, rad = 2): Int16Array {
  let cur = label;
  for (let p = 0; p < passes; p++) {
    const next = new Int16Array(cur);
    for (let y = rad; y < h - rad; y++) for (let x = rad; x < w - rad; x++) {
      const i = y * w + x; if (!member[i]) continue;
      const counts = new Map<number, number>(); let best = cur[i], bestN = 0;
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) { const j = i + dy * w + dx; if (!member[j]) continue; const v = cur[j]; const c = (counts.get(v) || 0) + 1; counts.set(v, c); if (c > bestN || (c === bestN && v === cur[i])) { bestN = c; best = v; } }
      next[i] = best;
    }
    cur = next;
  }
  return cur;
}

const neighbours4 = (i: number, w: number, h: number) => {
  const x = i % w, y = (i - x) / w; const nb: number[] = [];
  if (x > 0) nb.push(i - 1); if (x < w - 1) nb.push(i + 1); if (y > 0) nb.push(i - w); if (y < h - 1) nb.push(i + w);
  return nb;
};

// Iterative nearest-neighbour fill of -2 pixels from labelled neighbours.
export function fillUnassigned(label: Int16Array, w: number, h: number, member: NumArray): Int16Array {
  for (let it = 0; it < 60; it++) {
    let changed = 0; const next = new Int16Array(label);
    for (let i = 0; i < w * h; i++) {
      if (!member[i] || label[i] !== -2) continue;
      const c = new Map<number, number>(); let best = -2, bestN = 0;
      for (const j of neighbours4(i, w, h)) { if (member[j] && label[j] >= 0) { const n = (c.get(label[j]) || 0) + 1; c.set(label[j], n); if (n > bestN) { bestN = n; best = label[j]; } } }
      if (best >= 0) { next[i] = best; changed++; }
    }
    label = next; if (!changed) break;
  }
  return label;
}

export interface Region { id: number; label: number; n: number }

function labelRegions(label: NumArray, w: number, h: number, member: NumArray) {
  const region = new Int32Array(w * h).fill(-1); const regions: Region[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!member[i] || region[i] >= 0) continue;
    const id = regions.length; const lab = label[i]; const stack = [i]; region[i] = id; let n = 0;
    while (stack.length) {
      const k = stack.pop()!; n++;
      for (const j of neighbours4(k, w, h)) if (member[j] && region[j] < 0 && label[j] === lab) { region[j] = id; stack.push(j); }
    }
    regions.push({ id, label: lab, n });
  }
  return { region, regions };
}

// Connected components of equal label -> region ids; tiny regions take their dominant neighbour's label.
export function regionize(label: NumArray, w: number, h: number, member: NumArray, pxM2: number, minM2: number) {
  for (let round = 0; round < 3; round++) {
    const { region, regions } = labelRegions(label, w, h, member);
    let merged = 0;
    for (const r of regions) {
      if (r.n * pxM2 >= minM2) continue;
      const counts = new Map<number, number>();
      for (let i = 0; i < w * h; i++) {
        if (region[i] !== r.id) continue;
        for (const j of neighbours4(i, w, h)) if (member[j] && region[j] !== r.id) counts.set(label[j], (counts.get(label[j]) || 0) + 1);
      }
      let best: number | null = null, bestN = 0; for (const [k, v] of counts) if (v > bestN) { bestN = v; best = k; }
      if (best != null) { for (let i = 0; i < w * h; i++) if (region[i] === r.id) label[i] = best; merged++; }
    }
    if (!merged) return { region, regions };
  }
  return labelRegions(label, w, h, member);
}

// ------------------------------------------------------------------ vectorising

export interface CrackEdge { a: Pt; b: Pt; inside: number; outside: number }

// Directed crack edges with the region on the right (clockwise in image coordinates); returns the longest closed loop.
export function regionOuterLoop(region: NumArray, w: number, h: number, id: number): CrackEdge[] {
  const edges = new Map<number, CrackEdge[]>();
  const key = (x: number, y: number) => y * (w + 1) + x;
  const add = (ax: number, ay: number, bx: number, by: number, inside: number, outside: number) => { const k = key(ax, ay); const e = { a: [ax, ay], b: [bx, by], inside, outside }; if (!edges.has(k)) edges.set(k, []); edges.get(k)!.push(e); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (region[i] !== id) continue;
    const up = y > 0 ? i - w : -1, dn = y < h - 1 ? i + w : -1, lf = x > 0 ? i - 1 : -1, rt = x < w - 1 ? i + 1 : -1;
    if (up < 0 || region[up] !== id) add(x, y, x + 1, y, i, up);
    if (rt < 0 || region[rt] !== id) add(x + 1, y, x + 1, y + 1, i, rt);
    if (dn < 0 || region[dn] !== id) add(x + 1, y + 1, x, y + 1, i, dn);
    if (lf < 0 || region[lf] !== id) add(x, y + 1, x, y, i, lf);
  }
  const loops: CrackEdge[][] = []; const used = new Set<CrackEdge>();
  for (const [, arr] of edges) for (const e0 of arr) {
    if (used.has(e0)) continue;
    const loop: CrackEdge[] = []; let e: CrackEdge | null = e0; let guard = 0;
    while (e && !used.has(e) && guard++ < 1e6) {
      used.add(e); loop.push(e);
      const nexts: CrackEdge[] = edges.get(key(e.b[0], e.b[1])) || [];
      // prefer the sharpest right turn to keep separate loops separate at diagonal touches
      const dirIn = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
      let best: CrackEdge | null = null, bestScore = -9;
      for (const c of nexts) { if (used.has(c)) continue; const d = [c.b[0] - c.a[0], c.b[1] - c.a[1]]; const cross = dirIn[0] * d[1] - dirIn[1] * d[0]; const dot = dirIn[0] * d[0] + dirIn[1] * d[1]; const score = cross > 0 ? 2 : dot > 0 ? 1 : 0; if (score > bestScore) { bestScore = score; best = c; } }
      e = best;
    }
    loops.push(loop);
  }
  loops.sort((a, b) => b.length - a.length);
  return loops[0] || [];
}

export function dpSimplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const L = Math.hypot(bx - ax, by - ay) || 1e-9;
  let maxD = -1, idx = -1;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > maxD) { maxD = d; idx = i; } }
  if (maxD > eps) { const l = dpSimplify(pts.slice(0, idx + 1), eps), r = dpSimplify(pts.slice(idx), eps); return l.slice(0, -1).concat(r); }
  return [pts[0], pts[pts.length - 1]];
}

export interface Chain { pts: Pt[]; outside: number; edges: CrackEdge[] }

// Split the loop where the neighbouring region changes.
export function splitChains(loop: CrackEdge[], region: NumArray): Chain[] {
  const nbr = (e: CrackEdge) => (e.outside < 0 ? -1 : region[e.outside]);
  if (!loop.length) return [];
  let start = 0;
  for (let i = 0; i < loop.length; i++) { const p = loop[(i - 1 + loop.length) % loop.length]; if (nbr(p) !== nbr(loop[i])) { start = i; break; } }
  const chains: Chain[] = []; let cur: Chain | null = null;
  for (let k = 0; k < loop.length; k++) {
    const e = loop[(start + k) % loop.length]; const nb = nbr(e);
    if (!cur || cur.outside !== nb) { cur = { pts: [e.a], outside: nb, edges: [] }; chains.push(cur); }
    cur.pts.push(e.b); cur.edges.push(e);
  }
  if (chains.length === 1) { // isolated region: split the ring in two at the farthest point
    const c = chains[0]; const half = Math.floor(c.pts.length / 2);
    return [{ pts: c.pts.slice(0, half + 1), outside: c.outside, edges: c.edges.slice(0, half) }, { pts: c.pts.slice(half), outside: c.outside, edges: c.edges.slice(half) }];
  }
  return chains;
}

// ------------------------------------------------------------------ regularisation (building axis and its 45-degree diagonals)

// Length-weighted direction histogram (mod 90 degrees) of the outside boundary segments.
export function dominantAngle(chainsPx: Pt[][]): number {
  const bins = new Float64Array(90);
  for (const pts of chainsPx) for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1]; const L = Math.hypot(dx, dy); if (L < 4) continue;
    let a = (Math.atan2(dy, dx) * 180) / Math.PI; a = ((a % 90) + 90) % 90; bins[Math.floor(a)] += L;
  }
  const score = (i: number) => bins[i] + bins[(i + 1) % 90] + bins[(i + 89) % 90];
  let best = 0; for (let i = 0; i < 90; i++) if (score(i) > score(best)) best = i;
  let sx = 0, sy = 0;
  for (let d = -6; d <= 6; d++) { const i = (best + d + 90) % 90; const ang = ((i + 0.5) * 4 * Math.PI) / 180; sx += bins[i] * Math.cos(ang); sy += bins[i] * Math.sin(ang); }
  const refined = (((Math.atan2(sy, sx) * 180) / Math.PI) / 4 + 90) % 90;
  return Number.isFinite(refined) ? refined : best;
}

// Snap each segment to theta + {0, 45, 90, 135}, merge runs of one direction into fitted lines, rebuild the
// vertices where consecutive lines intersect; chain end points stay fixed (shared with neighbours).
export function regularizeChain(pts: Pt[], theta: number): Pt[] {
  if (pts.length < 3) return pts;
  const dirs = [0, 45, 90, 135].map((d) => { const a = ((theta + d) * Math.PI) / 180; return [Math.cos(a), Math.sin(a)]; });
  const classOf = (a: Pt, b: Pt) => { const dx = b[0] - a[0], dy = b[1] - a[1]; let best = 0, bestV = -1; for (let k = 0; k < 4; k++) { const v = Math.abs(dx * dirs[k][0] + dy * dirs[k][1]); if (v > bestV) { bestV = v; best = k; } } return best; };
  const runs: { c: number; pts: Pt[]; len: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const c = classOf(pts[i - 1], pts[i]); const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const last = runs[runs.length - 1];
    if (last && last.c === c) { last.pts.push(pts[i]); last.len += L; } else runs.push({ c, pts: [pts[i - 1], pts[i]], len: L });
  }
  // a short run squeezed between two runs of the same direction is jitter: merge the three
  for (let i = 1; i < runs.length - 1; i++) {
    if (runs[i].len < 6 && runs[i - 1].c === runs[i + 1].c) {
      runs[i - 1].pts = runs[i - 1].pts.concat(runs[i].pts.slice(1), runs[i + 1].pts.slice(1));
      runs[i - 1].len += runs[i].len + runs[i + 1].len;
      runs.splice(i, 2); i = Math.max(0, i - 2);
    }
  }
  if (runs.length === 1) return [pts[0], pts[pts.length - 1]];
  const lines = runs.map((r) => {
    const d = dirs[r.c]; const n = [-d[1], d[0]]; let s = 0, wsum = 0;
    for (let i = 0; i < r.pts.length; i++) { const wgt = i === 0 || i === r.pts.length - 1 ? 0.5 : 1; s += wgt * (r.pts[i][0] * n[0] + r.pts[i][1] * n[1]); wsum += wgt; }
    return { d, n, c: s / wsum };
  });
  type Line = (typeof lines)[number];
  const intersect = (L1: Line, L2: Line): Pt | null => { const det = L1.n[0] * L2.n[1] - L1.n[1] * L2.n[0]; if (Math.abs(det) < 1e-6) return null; return [(L1.c * L2.n[1] - L2.c * L1.n[1]) / det, (L1.n[0] * L2.c - L2.n[0] * L1.c) / det]; };
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < lines.length - 1; i++) {
    const p = intersect(lines[i], lines[i + 1]); const orig = runs[i].pts[runs[i].pts.length - 1];
    out.push(p && Math.hypot(p[0] - orig[0], p[1] - orig[1]) <= 25 ? p : orig);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
