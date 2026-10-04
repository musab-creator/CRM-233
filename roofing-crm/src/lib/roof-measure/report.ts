import { centroid, coveredByEdge, FT_PER_M, segFt, segOnPolyline, type LatLng } from './geo';
import { esc, fmt, ftInR, pitchLabel } from './format';
import { computeTotals, EDGE_TYPES, type EdgeEntry, type FacetEntry, type Summary, type Totals } from './measure';
import type { EdgeType, Project } from './model';
import { solarSummaryOf, type SolarSummary } from './solar';
import { permitCoverLine, permitReportPage, type ManualPermit, type PermitData } from './permits';

// The Roofr-format roof report (the tool's report.js): cover, diagram,
// length, area, pitch, per-structure summaries, report summary, permit
// history and material calculations, as one HTML string of .rp-page
// sections. Wrap it with standaloneDoc() for a downloadable file, or render
// it inside an element with class "rp" next to a <style> of REPORT_CSS.

// ------------------------------------------------------------------ company details
export interface Company { name: string; phone: string; address: string; license: string; email: string; website: string; rep: string }
export const COMPANY_DEFAULT: Company = {
  name: 'Diversity Roofing', phone: '(904) 979-0556',
  address: '6620 Southpoint Dr. S., Suite 600, Jacksonville, FL 32216',
  license: 'CCC1337520', email: '', website: 'diversity-roofing.com', rep: '',
};
export const COMPANY_STORAGE_KEY = 'rm.company';
export const BLUE = '#2d9cdb';

// ------------------------------------------------------------------ material catalog (Roofr product list; coverage per unit)
// sqft per bundle/roll for shingles & synthetic, linear ft per bundle/roll for starter, ice & water and capping.
export interface CatalogGroup { group: string; base: 'pitched' | 'starter' | 'iw' | 'cap'; baseUnit: 'sqft' | 'ft'; unit: string; items: [string, number][] }
export const MATERIAL_CATALOG: CatalogGroup[] = [
  { group: 'Shingle (total sqft)', base: 'pitched', baseUnit: 'sqft', unit: 'bundle', items: [['IKO - Cambridge', 33.3], ['CertainTeed - Landmark', 32.8], ['GAF - Timberline', 32.8], ['Owens Corning - Duration', 32.8], ['Atlas - Pristine', 33.0]] },
  { group: 'Starter (eaves + rakes)', base: 'starter', baseUnit: 'ft', unit: 'bundle', items: [['IKO - Leading Edge Plus', 120], ['CertainTeed - SwiftStart', 116.25], ['GAF - Pro-Start', 120.33], ['Owens Corning - Starter Strip', 105], ['Atlas - Pro-Cut', 137]] },
  { group: 'Ice and Water (eaves + valleys + flashings)', base: 'iw', baseUnit: 'ft', unit: 'roll', items: [['IKO - StormShield', 65.6], ['CertainTeed - WinterGuard', 65.6], ['GAF - WeatherWatch', 66.7], ['Owens Corning - WeatherLock', 75], ['Atlas - Weathermaster', 65.6]] },
  { group: 'Synthetic (total sqft; no laps)', base: 'pitched', baseUnit: 'sqft', unit: 'roll', items: [['IKO - Stormtite', 1000], ['CertainTeed - RoofRunner', 1000], ['GAF - Deck-Armor', 1000], ['Owens Corning - RhinoRoof', 1000], ['Atlas - Summit', 1000]] },
  { group: 'Capping (hips + ridges)', base: 'cap', baseUnit: 'ft', unit: 'bundle', items: [['IKO - Hip and Ridge', 40], ['CertainTeed - Shadow Ridge', 30], ['GAF - Seal-A-Ridge', 25], ['Owens Corning - DecoRidge', 20], ['Atlas - Pro-Cut H&R', 31]] },
];

// ------------------------------------------------------------------ numbers the Roofr way
export const sqOf = (sf: number) => Math.ceil((sf / 100) * 10) / 10; // squares to 0.1, rounded up
export const sqftUp = (sf: number) => Math.ceil(sf - 1e-9); // whole sqft, rounded up
export const ftUp = (ft: number) => Math.ceil(ft - 1e-9);
const sq1 = (sf: number) => sqOf(sf).toFixed(1);

// Roofr shows seven waste columns: 0, 10, 12, 15, 17, 20, 22 with the recommended value inserted and the farthest column dropped.
export function wasteColumns(rec: number): number[] {
  const std = [0, 10, 12, 15, 17, 20, 22];
  if (std.includes(rec)) return std;
  const cols = [...std, rec].sort((a, b) => a - b);
  let far = -1, idx = -1; cols.forEach((c, i) => { const d = Math.abs(c - rec); if (d >= far) { far = d; idx = i; } });
  cols.splice(idx, 1);
  return cols;
}
// Material page shows 0%, 10%, recommended and 15%.
export function matColumns(rec: number): number[] { const s = new Set([0, 10, 15, rec]); if (s.size < 4) s.add(12); return [...s].sort((a, b) => a - b); }

export interface ReportData { t: Totals; s: SolarSummary | null; hasTrace: boolean; rec: number; wasteCols: number[]; matCols: number[] }
export function reportData(p: Project, totals?: Totals): ReportData {
  const t = totals || computeTotals(p);
  const rec = t.recWaste;
  return { t, s: solarSummaryOf(p.solar), hasTrace: p.facets.length > 0, rec, wasteCols: wasteColumns(rec), matCols: matColumns(rec) };
}

// ------------------------------------------------------------------ diagram (Roofr style)
export interface DiagramScope { facets: FacetEntry[]; cutouts: FacetEntry[]; edges: EdgeEntry[]; pitches: number[] }
export type DiagramMode = 'outline' | 'lengths' | 'areas' | 'pitch';
const FACET_SHADES = ['#eaf1fa', '#d9e6f5', '#c8daf0', '#b9cfeb', '#aac4e6'];

// Down-slope direction of a facet on the page (y down).
function facetDirection(x: FacetEntry, scope: DiagramScope): { dx: number; dy: number } | null {
  if (x.f.azimuth != null) { const a = (x.f.azimuth * Math.PI) / 180; return { dx: Math.sin(a), dy: -Math.cos(a) }; } // Solar API azimuth: compass direction the plane faces
  // toward the facet edge that lies on an eave line; else toward the longest edge no other facet shares
  const path = x.m.path;
  const c = centroid(path);
  const eavePaths = scope.edges.filter((e) => e.e.type === 'eave').map((e) => e.m.path);
  let best: { a: LatLng; b: LatLng } | null = null, bestLen = -1, bestEave = false;
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i + 1) % path.length];
    const onEave = coveredByEdge(a, b, eavePaths) || eavePaths.some((ep) => ep.length > 1 && segOnPolyline(a, b, ep));
    const shared = scope.facets.some((y) => y !== x && coveredByEdge(a, b, [[...y.m.path, y.m.path[0]]]));
    const len = segFt(a, b);
    const score = onEave ? 2 : shared ? 0 : 1;
    const bestScore = bestEave ? 2 : best ? 1 : 0;
    if (score > bestScore || (score === bestScore && len > bestLen)) { best = { a, b }; bestLen = len; bestEave = onEave; }
  }
  if (!best) return null;
  const mid = { lat: (best.a.lat + best.b.lat) / 2, lng: (best.a.lng + best.b.lng) / 2 };
  const dx = (mid.lng - c.lng) * Math.cos((c.lat * Math.PI) / 180), dy = mid.lat - c.lat;
  const L = Math.hypot(dx, dy) || 1;
  return { dx: dx / L, dy: -dy / L };
}

// SVG roof diagram: outline (facets shaded by pitch), lengths (every edge length), areas, or pitch with down-slope arrows.
export function roofrDiagram(scope: DiagramScope, mode: DiagramMode, W: number, H: number, allShades?: number[]): string {
  const facets = [...scope.facets, ...scope.cutouts];
  const all = [...facets.map((x) => x.m.path), ...scope.edges.map((x) => x.m.path)].flat();
  if (!all.length) return '';
  const o = all[0];
  const kx = 111320 * Math.cos((o.lat * Math.PI) / 180) * FT_PER_M, ky = 110540 * FT_PER_M;
  const xy = (p: LatLng) => ({ x: (p.lng - o.lng) * kx, y: -(p.lat - o.lat) * ky });
  const pts = all.map(xy);
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const pad = 50;
  const sc = Math.min((W - 2 * pad) / Math.max(maxX - minX, 1), (H - 2 * pad) / Math.max(maxY - minY, 1));
  const ox = pad + (W - 2 * pad - (maxX - minX) * sc) / 2, oy = pad + (H - 2 * pad - (maxY - minY) * sc) / 2;
  const P = (p: LatLng) => { const q = xy(p); return { x: ox + (q.x - minX) * sc, y: oy + (q.y - minY) * sc }; };
  const pitchRank: Record<number, number> = {}; (allShades || scope.pitches).forEach((p, i) => { pitchRank[p] = i; });
  const ptsStr = (path: LatLng[]) => path.map(P).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Inter, Segoe UI, Arial, sans-serif"><rect width="${W}" height="${H}" fill="#fff"/>`;
  for (const x of scope.facets) {
    const fill = mode === 'lengths' ? 'none' : FACET_SHADES[(pitchRank[x.f.pitch] || 0) % FACET_SHADES.length];
    s += `<polygon points="${ptsStr(x.m.path)}" fill="${fill}" stroke="${mode === 'lengths' ? '#9fb3c8' : '#4a9bd9'}" stroke-width="${mode === 'lengths' ? 0.6 : 1}" stroke-linejoin="round"/>`;
  }
  for (const x of scope.cutouts) s += `<polygon points="${ptsStr(x.m.path)}" fill="#fff" stroke="#4a9bd9" stroke-width="1" stroke-dasharray="4 3"/>`;
  const text = (x: number, y: number, str: string, size: number, fill: string, rot = 0, weight = 'normal') => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" text-anchor="middle" dominant-baseline="middle" fill="${fill}" font-weight="${weight}" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${esc(str)}</text>`;
  const cx = ox + ((maxX - minX) * sc) / 2, cy = oy + ((maxY - minY) * sc) / 2;
  if (mode === 'lengths') {
    for (const { e, m } of scope.edges) {
      const t = EDGE_TYPES[e.type];
      s += `<polyline points="${ptsStr(m.path)}" fill="none" stroke="${t.color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${t.dashed ? 'stroke-dasharray="3 3"' : ''}/>`;
    }
    const edgePaths = scope.edges.map((x) => x.m.path);
    const label = (a: LatLng, b: LatLng, ft: number, fill: string) => {
      if (ft < 3) return '';
      const A = P(a), B = P(b);
      let ang = (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      let nx = -(B.y - A.y), ny = B.x - A.x; const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
      return text(mx + nx * 8, my + ny * 8, String(ftUp(ft)), 8.5, fill, ang);
    };
    for (const { m } of scope.edges) for (let i = 1; i < m.path.length; i++) s += label(m.path[i - 1], m.path[i], segFt(m.path[i - 1], m.path[i]) * m.factor, '#333');
    for (const x of scope.facets) for (let i = 0; i < x.m.path.length; i++) {
      const a = x.m.path[i], b = x.m.path[(i + 1) % x.m.path.length];
      if (coveredByEdge(a, b, edgePaths)) continue;
      s += label(a, b, segFt(a, b), '#888');
    }
  } else {
    for (const { m } of scope.edges) s += `<polyline points="${ptsStr(m.path)}" fill="none" stroke="#4a9bd9" stroke-width="1" stroke-linejoin="round"/>`;
    for (const x of scope.facets) {
      const c = P(centroid(x.m.path));
      if (mode === 'areas') {
        if (x.f.pitch === 0) s += text(c.x, c.y - 7, 'Flat', 9, '#333') + text(c.x, c.y + 5, String(Math.round(x.m.sloped)), 9.5, '#333');
        else s += text(c.x, c.y, String(Math.round(x.m.sloped)), 9.5, '#333');
      } else if (mode === 'pitch') {
        s += text(c.x, c.y, x.f.pitch === 0 ? '0' : String(Number.isInteger(x.f.pitch) ? x.f.pitch : x.f.pitch.toFixed(1)), 10, '#333');
        const d = x.f.pitch === 0 ? null : facetDirection(x, scope);
        if (d) {
          const x1 = c.x + d.dx * 13, y1 = c.y + d.dy * 13, x2 = c.x + d.dx * 24, y2 = c.y + d.dy * 24;
          const ang = Math.atan2(d.dy, d.dx);
          const h1x = x2 - Math.cos(ang - 0.5) * 4, h1y = y2 - Math.sin(ang - 0.5) * 4, h2x = x2 - Math.cos(ang + 0.5) * 4, h2y = y2 - Math.sin(ang + 0.5) * 4;
          s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#333" stroke-width="1"/><polyline points="${h1x.toFixed(1)},${h1y.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)} ${h2x.toFixed(1)},${h2y.toFixed(1)}" fill="none" stroke="#333" stroke-width="1"/>`;
        }
      }
    }
  }
  // compass rose (Roofr draws a thin cross with a north tick at the bottom right)
  const rx = W - 30, ry = H - 32;
  s += `<g stroke="#555" stroke-width="0.8" fill="none"><line x1="${rx}" y1="${ry - 16}" x2="${rx}" y2="${ry + 16}"/><line x1="${rx - 16}" y1="${ry}" x2="${rx + 16}" y2="${ry}"/><circle cx="${rx}" cy="${ry}" r="3"/></g><polygon points="${rx},${ry - 20} ${rx - 3},${ry - 13} ${rx + 3},${ry - 13}" fill="#555"/><text x="${rx}" y="${ry - 24}" font-size="7" text-anchor="middle" fill="#555">N</text>`;
  return s + '</svg>';
}

// ------------------------------------------------------------------ satellite cover photo (clean, no overlays, like Roofr)

// Static Maps URL of the cover photo, centred on the traced roof (or the pin). Contains the API key: embed it as a
// data URL (imageToDataURL) before the report leaves the browser.
export function coverPhotoUrl(p: Project, t: Totals, apiKey: string): string {
  if (!apiKey || !p.location) return '';
  let lat = p.location.lat, lng = p.location.lng;
  if (p.facets.length > 0) {
    const pts = t.facetsAll.flatMap((x) => x.m.path);
    lat = (Math.min(...pts.map((q) => q.lat)) + Math.max(...pts.map((q) => q.lat))) / 2;
    lng = (Math.min(...pts.map((q) => q.lng)) + Math.max(...pts.map((q) => q.lng))) / 2;
  }
  return `https://maps.googleapis.com/maps/api/staticmap?center=${lat.toFixed(6)},${lng.toFixed(6)}&zoom=20&size=640x500&scale=2&maptype=satellite&key=${encodeURIComponent(apiKey)}`;
}

// Browser only: loads an image and returns it as a JPEG data URL (null on failure or timeout).
export function imageToDataURL(url: string, timeoutMs = 7000): Promise<string | null> {
  return new Promise((resolve) => {
    if (!url || typeof Image === 'undefined') { resolve(null); return; }
    const im = new Image(); im.crossOrigin = 'anonymous';
    const tm = setTimeout(() => resolve(null), timeoutMs);
    im.onload = () => {
      clearTimeout(tm);
      try { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d')!.drawImage(im, 0, 0); resolve(c.toDataURL('image/jpeg', 0.9)); } catch { resolve(null); }
    };
    im.onerror = () => { clearTimeout(tm); resolve(null); };
    im.src = url;
  });
}

// ------------------------------------------------------------------ CSS
export const REPORT_CSS = `
@page { size: letter; margin: 0; }
.rp { font-family: Inter, "Segoe UI", Arial, Helvetica, sans-serif; color: #222; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.rp * { box-sizing: border-box; }
.rp-page { width: 8.5in; height: 11in; margin: 0 auto; padding: .55in .5in .45in; background: #fff; display: flex; flex-direction: column; position: relative; page-break-after: always; break-after: page; overflow: hidden; font-size: 11px; line-height: 1.4; }
.rp-page:last-child { page-break-after: auto; break-after: auto; }
.rp .prep { position: absolute; top: .3in; right: .5in; font-size: 9px; color: #777; }
.rp h1 { color: ${BLUE}; font-weight: 500; font-size: 34px; margin: 0; letter-spacing: -.3px; }
.rp h2 { color: ${BLUE}; font-weight: 500; font-size: 22px; margin: 0; letter-spacing: -.2px; }
.rp .addr { font-size: 12px; color: #333; margin-top: 4px; }
.rp .cover-row { display: flex; justify-content: space-between; align-items: flex-start; margin-top: 2px; }
.rp .cover-row .l { font-size: 12px; color: #333; }
.rp .cover-row .r { text-align: right; font-size: 12px; color: #333; line-height: 1.6; }
.rp .cover-img { display: block; width: 6.5in; max-height: 5.6in; object-fit: cover; margin: .5in auto 0; }
.rp .cap { width: 6.5in; margin: 6px auto 0; font-size: 11px; color: #333; }
.rp .diagram { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; margin-top: 10px; }
.rp .diagram svg { width: 100%; height: 100%; display: block; }
.rp .legend { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 16px; margin-top: 22px; font-size: 12px; color: #333; }
.rp .legend span::before { content: ""; display: inline-block; width: 18px; height: 4px; background: var(--c); margin-right: 12px; vertical-align: middle; border-radius: 2px; }
.rp .legend span.dashed::before { background: repeating-linear-gradient(90deg, var(--c) 0 4px, transparent 4px 7px); }
.rp .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin-top: 22px; font-size: 12.5px; color: #333; }
.rp .note { font-size: 10px; color: #444; margin-top: 10px; line-height: 1.45; }
.rp .foot { display: flex; justify-content: space-between; font-size: 8.5px; color: #555; margin-top: 10px; }
.rp table { width: 100%; border-collapse: collapse; font-size: 11px; }
.rp th, .rp td { padding: 5px 8px; text-align: left; border-bottom: 1px solid #eee; }
.rp th { color: ${BLUE}; font-weight: 500; background: #f6f7f9; }
.rp td.num, .rp th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.rp tr.group td { background: #f6f7f9; color: #333; }
.rp .kv td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.rp .sec { color: ${BLUE}; font-weight: 500; font-size: 14px; margin: 16px 0 6px; }
.rp .two { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.rp .rec { font-size: 9px; color: #777; font-weight: 400; display: block; }
.rp .mat td, .rp .mat th { padding: 4px 8px; }
.rp .empty { padding: 30px; text-align: center; color: #777; border: 1px dashed #ccc; font-size: 11px; }
.rp table.tight td, .rp table.tight th { padding: 3px 6px; font-size: 10px; }
`;
export const FONT_LINK = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';

// ------------------------------------------------------------------ pages
export function reportHead(company: Company, address: string, title: string) {
  return `<div class="prep">Prepared by ${esc(company.name)}</div><h2>${title}</h2><div class="addr">${esc(address || '')}</div>`;
}
function foot(company: Company, n: number) { return `<div class="foot"><span>This report was prepared by ${esc(company.name)}.${company.phone ? ' ' + esc(company.phone) + '.' : ''}</span><span>${n}</span></div>`; }
export const reportPage = (company: Company, inner: string, n: number) => `<section class="rp-page">${inner}${foot(company, n)}</section>`;

interface Ctx { R: ReportData; company: Company; address: string; permitLine: string }

function coverPage(C: Ctx, satSrc: string | null, n: number) {
  const { R, company } = C;
  const t = R.t;
  const facets = R.hasTrace ? t.facetCount : R.s ? R.s.segs.length : 0;
  const total = R.hasTrace ? t.sloped : R.s ? R.s.total : 0;
  const pitch = R.hasTrace ? t.predominant : R.s ? Math.round(R.s.predominant) : null;
  const imagery = R.s && R.s.imageryDate ? `Google ${new Date(R.s.imageryDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Google satellite imagery';
  return reportPage(company, `<h1>Roof Report</h1>
    <div class="cover-row"><div class="l">Prepared by ${esc(company.name)}</div><div class="r">${sqftUp(total)} sqft<br>${facets} facets<br>Predominant pitch ${pitch == null ? '-' : pitch === 0 ? 'Flat' : pitchLabel(pitch)}</div></div>
    <div class="addr">${esc(C.address || '')}</div>
    ${C.permitLine}
    ${satSrc ? `<img class="cover-img" src="${satSrc}" alt="">` : '<div class="empty" style="margin-top:.5in">Satellite image unavailable</div>'}
    <div class="cap">${imagery}</div><div style="flex:1"></div>`, n);
}
function lengthPage(C: Ctx, n: number) {
  const bt = C.R.t.byType;
  const legend = `<div class="legend">${(Object.entries(EDGE_TYPES) as [EdgeType, (typeof EDGE_TYPES)[EdgeType]][]).map(([k, v]) => `<span class="${v.dashed ? 'dashed' : ''}" style="--c:${v.color}">${v.plural}: ${ftInR(bt[k].true)}</span>`).join('')}</div>`;
  return reportPage(C.company, `${reportHead(C.company, C.address, 'Length measurement report')}${legend}<div class="diagram">${roofrDiagram(C.R.t, 'lengths', 700, 640)}</div>
    <div class="note">Measurements in diagram are rounded up for display. Some edge lengths may be hidden from diagram to avoid overcrowding.</div>`, n);
}
function areaPage(C: Ctx, n: number) {
  const t = C.R.t;
  return reportPage(C.company, `${reportHead(C.company, C.address, 'Area measurement report')}
    <div class="stats"><div>Total roof area: ${sqftUp(t.sloped)} sqft</div><div>Predominant pitch: ${t.predominant == null ? '-' : t.predominant === 0 ? 'Flat' : pitchLabel(t.predominant)}</div>
    <div>Pitched roof area: ${sqftUp(t.pitched)} sqft</div><div>Predominant pitch area: ${sqftUp(t.predArea)} sqft</div>
    <div>Flat roof area: ${sqftUp(t.flat)} sqft</div><div>Unspecified pitch area: 0 sqft</div>
    <div>Two story area: ${sqftUp(t.twoStory)} sqft</div><div></div>
    <div>Two layer area: ${sqftUp(t.twoLayer)} sqft</div><div></div></div>
    <div class="diagram">${roofrDiagram(t, 'areas', 700, 620)}</div>
    <div class="note">Area measurements in diagram are rounded. The totals at the top of the page are the sums of the exact measurements, which are then rounded. Deleted facets (skylights, chimneys, etc.) are designated with a dashed line and are excluded from the calculations.</div>`, n);
}
function measurementsBlock(S: Summary, R: ReportData) {
  const bt = S.byType;
  const rec = S.recWaste != null ? S.recWaste : R.rec, wasteCols = wasteColumns(rec);
  const rows: [string, string][] = [
    ['Total roof area', `${sqftUp(S.sloped)} sqft`], ['Total pitched area', `${sqftUp(S.pitched)} sqft`], ['Total flat area', `${sqftUp(S.flat)} sqft`],
    ['Total roof facets', `${S.facetCount} facets`], ['Predominant pitch', S.predominant == null ? '-' : S.predominant === 0 ? '0/12' : pitchLabel(S.predominant)],
    ['Total eaves', ftInR(bt.eave.true)], ['Total valleys', ftInR(bt.valley.true)], ['Total hips', ftInR(bt.hip.true)], ['Total ridges', ftInR(bt.ridge.true)],
    ['Total rakes', ftInR(bt.rake.true)], ['Total wall flashing', ftInR(bt.wall.true)], ['Total step flashing', ftInR(bt.step.true)],
    ['Total transitions', ftInR(bt.transition.true)], ['Total parapet wall', ftInR(bt.parapet.true)], ['Total unspecified', ftInR(bt.unspecified.true)],
    ['Hips + ridges', ftInR(bt.hip.true + bt.ridge.true)], ['Eaves + rakes', ftInR(bt.eave.true + bt.rake.true)],
  ];
  const meas = `<div class="sec">Measurements</div><table class="kv">${rows.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join('')}</table>`;
  const pitchT = `<div class="sec">Pitch</div><table><tr><th>Pitch</th>${S.pitches.map((p) => `<th class="num">${p}/12</th>`).join('')}</tr>
    <tr><td>Area (sqft)</td>${S.pitches.map((p) => `<td class="num">${fmt(sqftUp(S.pitchGroups[p]))}</td>`).join('')}</tr>
    <tr><td>Squares</td>${S.pitches.map((p) => `<td class="num">${sq1(S.pitchGroups[p])}</td>`).join('')}</tr></table>`;
  const wasteT = `<div class="sec">Waste</div><table><tr><th>Waste %</th>${wasteCols.map((w) => `<th class="num">${w}%${w === rec ? '<span class="rec">Recommended</span>' : ''}</th>`).join('')}</tr>
    <tr><td>Area (sqft)</td>${wasteCols.map((w) => `<td class="num">${fmt(sqftUp(S.sloped * (1 + w / 100)))}</td>`).join('')}</tr>
    <tr><td>Squares</td>${wasteCols.map((w) => `<td class="num">${sq1(S.sloped * (1 + w / 100))}</td>`).join('')}</tr></table>
    <div class="note">Recommended waste is based on an asphalt shingle roof with a closed valley system (if applicable). Several other factors are involved in determining which waste percentage to use, including the complexity of the roof and individual roof application style. You will also need to calculate the post-waste quantity of other materials needed (hip and ridge caps, starter shingle, etc.).</div>`;
  return `<div class="two"><div>${meas}</div><div>${pitchT}${wasteT}</div></div>`;
}
function structurePage(C: Ctx, S: Summary, n: number, title: string) {
  const scope = { facets: S.facets, cutouts: S.cutouts, edges: S.edges, pitches: S.pitches };
  return reportPage(C.company, `${reportHead(C.company, C.address, title)}<div class="diagram" style="flex:0 0 3.4in">${roofrDiagram(scope, 'outline', 700, 330, C.R.t.pitches)}</div>${measurementsBlock(S, C.R)}<div style="flex:1"></div>`, n);
}
function materialsPage(C: Ctx, n: number) {
  const t = C.R.t, bt = t.byType;
  const bases = { pitched: t.pitched, starter: bt.eave.true + bt.rake.true, iw: bt.eave.true + bt.valley.true + bt.wall.true + bt.step.true, cap: bt.hip.true + bt.ridge.true };
  const cols = C.R.matCols;
  let rows = '';
  for (const g of MATERIAL_CATALOG) {
    const base = bases[g.base];
    rows += `<tr class="group"><td>${g.group}</td><td></td>${cols.map((w) => `<td class="num">${g.baseUnit === 'sqft' ? fmt(sqftUp(base * (1 + w / 100))) + ' sqft' : ftUp(base * (1 + w / 100)) + ' ft'}</td>`).join('')}</tr>`;
    for (const [name, cov] of g.items) rows += `<tr><td>${name}</td><td>${g.unit}</td>${cols.map((w) => `<td class="num">${base > 0 ? Math.ceil((base * (1 + w / 100)) / cov - 1e-9) : 0}</td>`).join('')}</tr>`;
  }
  rows += `<tr class="group"><td>Other</td><td></td>${cols.map(() => '<td></td>').join('')}</tr>`;
  rows += `<tr><td>8' Valley (no laps)</td><td>sheet</td>${cols.map(() => `<td class="num">${Math.ceil(bt.valley.true / 8 - 1e-9)}</td>`).join('')}</tr>`;
  rows += `<tr><td>10' Drip Edge (eaves + rakes; no laps)</td><td>sheet</td>${cols.map(() => `<td class="num">${Math.ceil((bt.eave.true + bt.rake.true) / 10 - 1e-9)}</td>`).join('')}</tr>`;
  return reportPage(C.company, `${reportHead(C.company, C.address, 'Material calculations')}
    <table class="mat" style="margin-top:14px"><tr><th>Product</th><th>Unit</th>${cols.map((w) => `<th class="num">Waste (${w}%)</th>`).join('')}</tr>${rows}</table>
    <div class="note">These calculations are estimates and are not guaranteed. Always double check calculations before ordering materials. Estimates are based off of the total pitched area (i.e., flat area is excluded).</div><div style="flex:1"></div>`, n);
}

// ------------------------------------------------------------------ build

export interface ReportPermits { data: PermitData | null; manual?: ManualPermit | null; now?: Date }
export interface ReportInput {
  project: Project;
  totals?: Totals; // computed from the project when omitted
  company?: Company;
  satellite?: string | null; // cover image src (data URL, or the live Static Maps URL for printing); null = "unavailable"
  // Permit history: the "Permit history & roof age" page is added when the project has a location and this is
  // given (data may be null: the page then says no permit data); the roof-age line goes on the cover when data is set.
  permits?: ReportPermits | null;
}

export function buildReportHTML(input: ReportInput): { html: string; data: ReportData } {
  const p = input.project;
  const company = input.company || COMPANY_DEFAULT;
  const R = reportData(p, input.totals);
  const permits = input.permits;
  const C: Ctx = { R, company, address: p.address, permitLine: permits ? permitCoverLine(permits.data, permits.manual, permits.now) : '' };
  const pages: ((n: number) => string)[] = [];
  pages.push((n) => coverPage(C, input.satellite || null, n));
  if (R.hasTrace) {
    pages.push(
      (n) => reportPage(company, `${reportHead(company, p.address, 'Diagram')}<div class="diagram">${roofrDiagram(R.t, 'outline', 700, 760)}</div>`, n),
      (n) => lengthPage(C, n),
      (n) => areaPage(C, n),
      (n) => reportPage(company, `${reportHead(company, p.address, 'Pitch &amp; direction measurement report')}<div class="diagram">${roofrDiagram(R.t, 'pitch', 700, 720)}</div>
    <div class="note">Deleted facets are designated with a dashed line and do not have a pitch.</div>`, n),
    );
    if (R.t.structures.length > 1) for (const S of R.t.structures) pages.push((n) => structurePage(C, S, n, `Structure #${S.index} summary`));
    pages.push((n) => structurePage(C, R.t, n, 'Report summary'));
  }
  if (permits && p.location) pages.push((n) => reportPage(company, permitReportPage(reportHead(company, p.address, 'Permit history &amp; roof age'), permits.data, permits.manual, permits.now), n));
  pages.push((n) => materialsPage(C, n));
  return { html: pages.map((fn, i) => fn(i + 1)).join(''), data: R };
}

// Never ship the API key inside a shareable file: replaces the live-URL cover image when it could not be embedded.
export function withoutLiveSatellite(html: string, liveUrl: string) {
  return html.replace(`<img class="cover-img" src="${liveUrl}" alt="">`, '<div class="empty" style="margin-top:.5in">Satellite image not embedded</div>');
}

// Self-contained report file with its own Print button.
export function standaloneDoc(html: string, address: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Roof Report - ${esc(address || '')}</title>${FONT_LINK}<style>${REPORT_CSS}
    body { margin: 0; background: #555; } .rp-page { margin: 16px auto; box-shadow: 0 2px 12px rgba(0,0,0,.4); }
    @media print { body { background: #fff; } .rp-page { margin: 0; box-shadow: none; } }
    .rp-print { position: fixed; top: 10px; right: 10px; background: ${BLUE}; color: #fff; border: 0; border-radius: 6px; padding: 10px 16px; font: 600 14px Inter, "Segoe UI", Arial; cursor: pointer; z-index: 9; } @media print { .rp-print { display: none; } }
  </style></head><body><button class="rp-print" onclick="window.print()">Print / Save as PDF</button><div class="rp">${html}</div></body></html>`;
}
