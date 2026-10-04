import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib";
import { BRAND } from "./config";
import { EDGE_DASHED, EDGE_HEX, EDGE_LABEL, EDGE_ORDER } from "./edges";
import { ftIn } from "./measure";
import { PERMIT_PORTALS, roofAgeSentence, type PropertyRecord } from "./property";
import type { EdgeType, Pt, RoofMeasurements } from "./types";

// Eight-page measurement report, Letter size, in the industry-standard order:
// cover · diagram · lengths · area · pitch & direction · summary ·
// permit history & roof age · material calculations.

const W = 612;
const H = 792;
const M = 36;

const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const C = {
  ink: hex("#1F2937"),
  text: hex("#333333"),
  muted: hex("#6B7280"),
  line: hex("#E5E7EB"),
  panel: hex("#F6F7F9"),
  blue: hex("#1E88D2"),
  amber: hex("#F59E0B"),
  facetLine: hex("#4A9BD9"),
  white: rgb(1, 1, 1),
};
const FACET_FILLS = ["#D9E6F5", "#AAC4E6", "#EAF1FA", "#C8DAF0", "#B9CFEB"].map(hex);

export interface ReportInput {
  orderId: string;
  address: string;
  preparedBy: { company: string; phone?: string };
  createdAt: Date;
  source: { provider: "google-solar" | "demo" | "model" | "manual"; label: string; imageryDate?: string; imageryQuality?: string };
  measurements: RoofMeasurements;
  aerial?: { bytes: Uint8Array; kind: "png" | "jpg"; credit: string } | null;
  property?: PropertyRecord | null;
}

interface Ctx {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  input: ReportInput;
  pages: PDFPage[];
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const dateLong = (iso?: string) =>
  iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "date unknown";

function t(p: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color = C.text) {
  p.drawText(s, { x, y, size, font, color });
}
function tr(p: PDFPage, s: string, xr: number, y: number, size: number, font: PDFFont, color = C.text) {
  p.drawText(s, { x: xr - font.widthOfTextAtSize(s, size), y, size, font, color });
}
function tc(p: PDFPage, s: string, cx: number, y: number, size: number, font: PDFFont, color = C.text) {
  p.drawText(s, { x: cx - font.widthOfTextAtSize(s, size) / 2, y, size, font, color });
}
/** Wrap text to a width; returns the y below the last line. */
function para(p: PDFPage, s: string, x: number, y: number, width: number, size: number, font: PDFFont, color = C.text, lead = 1.4) {
  let line = "";
  for (const w of s.split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      t(p, line, x, y, size, font, color);
      y -= size * lead;
      line = w;
    } else line = next;
  }
  if (line) t(p, line, x, y, size, font, color);
  return y - size * lead;
}

function brandRule(p: PDFPage) {
  p.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: C.blue });
  p.drawRectangle({ x: 0, y: H - 6, width: 90, height: 6, color: C.amber });
}

function page(ctx: Ctx, title: string): PDFPage {
  const p = ctx.doc.addPage([W, H]);
  ctx.pages.push(p);
  brandRule(p);
  tr(p, `Prepared by ${ctx.input.preparedBy.company}`, W - M, H - 24, 7.5, ctx.font, C.muted);
  t(p, title, M, H - 46, 19, ctx.font, C.blue);
  t(p, ctx.input.address, M, H - 62, 9.5, ctx.font, C.text);
  return p;
}

function footers(ctx: Ctx) {
  const { input, font, bold } = ctx;
  const who = `This report was prepared by ${input.preparedBy.company}${input.preparedBy.phone ? `. ${input.preparedBy.phone}` : ""}.`;
  ctx.pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 30 }, end: { x: W - M, y: 30 }, thickness: 0.5, color: C.line });
    t(p, who, M, 18, 7, font, C.muted);
    tr(p, `${BRAND.full} · ${input.orderId}`, W - M - 20, 18, 7, font, C.muted);
    tr(p, String(i + 1), W - M, 18, 8, bold, C.muted);
  });
}

// --- Diagram geometry ---------------------------------------------------------

interface Box {
  x: number;
  y: number; // top edge (PDF coords)
  w: number;
  h: number;
}

function fitter(m: RoofMeasurements, box: Box, pad = 22) {
  const pts = m.facets.flatMap((f) => f.polygon);
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const s = Math.min((box.w - pad * 2) / (maxX - minX || 1), (box.h - pad * 2) / (maxY - minY || 1));
  const ox = box.x + (box.w - (maxX - minX) * s) / 2;
  const oy = box.y - (box.h - (maxY - minY) * s) / 2;
  return { map: (q: Pt): [number, number] => [ox + (q[0] - minX) * s, oy - (maxY - q[1]) * s], scale: s };
}

function poly(p: PDFPage, box: Box, pts: [number, number][], fill: RGB | undefined, stroke: RGB, width: number) {
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${(x - box.x).toFixed(2)} ${(box.y - y).toFixed(2)}`).join(" ") + " Z";
  p.drawSvgPath(d, { x: box.x, y: box.y, color: fill, borderColor: stroke, borderWidth: width });
}

const facetFill = (i: number, azimuth: number) => FACET_FILLS[(i * 3 + Math.round(azimuth / 90)) % FACET_FILLS.length];

function facets(p: PDFPage, m: RoofMeasurements, box: Box, mode: "fill" | "outline") {
  const { map } = fitter(m, box);
  m.facets.forEach((f, i) => {
    if (mode === "fill") poly(p, box, f.polygon.map(map), facetFill(i, f.azimuth), C.facetLine, 0.8);
    else poly(p, box, f.polygon.map(map), undefined, hex("#9FB3C8"), 0.5);
  });
  return map;
}

function compass(p: PDFPage, font: PDFFont, x: number, y: number) {
  p.drawLine({ start: { x, y: y - 14 }, end: { x, y: y + 8 }, thickness: 0.6, color: C.muted });
  p.drawLine({ start: { x: x - 10, y: y - 3 }, end: { x: x + 10, y: y - 3 }, thickness: 0.6, color: C.muted });
  p.drawSvgPath("M0 -12 L3.5 0 L0 -3 L-3.5 0 Z", { x, y: y + 10, color: C.ink });
  tc(p, "N", x, y + 14, 6.5, font, C.ink);
}

function chip(p: PDFPage, font: PDFFont, s: string, x: number, y: number, size: number, color: RGB) {
  const w = font.widthOfTextAtSize(s, size);
  p.drawRectangle({ x: x - w / 2 - 1.5, y: y - size * 0.3, width: w + 3, height: size * 1.15, color: C.white, opacity: 0.85 });
  p.drawText(s, { x: x - w / 2, y: y - size * 0.05, size, font, color });
}

// --- Pages ----------------------------------------------------------------------

async function cover(ctx: Ctx) {
  const { input, font, bold, doc } = ctx;
  const m = input.measurements;
  const p = doc.addPage([W, H]);
  ctx.pages.push(p);
  brandRule(p);
  t(p, "Roof Report", M, H - 62, 32, font, C.blue);
  t(p, `Prepared by ${input.preparedBy.company}`, M, H - 80, 10, font, C.text);
  [`${fmt(m.totalAreaSqFt)} sqft`, `${m.facetCount} facets`, `Predominant pitch ${m.predominantPitch}/12`].forEach((s, i) =>
    tr(p, s, W - M, H - 50 - i * 14, 10, i === 0 ? bold : font, C.text),
  );
  t(p, input.address, M, H - 108, 10.5, font, C.text);
  para(p, roofAgeSentence(input.property), M, H - 126, W - M * 2, 9.5, bold, C.ink);

  const box: Box = { x: M + 18, y: H - 160, w: W - (M + 18) * 2, h: 420 };
  if (input.aerial) {
    const img = input.aerial.kind === "png" ? await doc.embedPng(input.aerial.bytes) : await doc.embedJpg(input.aerial.bytes);
    const r = Math.min(box.w / img.width, box.h / img.height);
    const dw = img.width * r;
    const dh = img.height * r;
    p.drawImage(img, { x: box.x + (box.w - dw) / 2, y: box.y - dh, width: dw, height: dh });
    t(p, `${input.aerial.credit} ${dateLong(input.source.imageryDate)}`, box.x + (box.w - dw) / 2, box.y - dh - 13, 8.5, font, C.text);
  } else if (m.facets.length) {
    p.drawRectangle({ x: box.x, y: box.y - box.h, width: box.w, height: box.h, color: C.panel });
    facets(p, m, { x: box.x + 30, w: box.w - 60, y: box.y - 20, h: box.h - 40 }, "fill");
    t(p, `Roof outline · imagery ${dateLong(input.source.imageryDate)}`, box.x, box.y - box.h - 13, 8.5, font, C.text);
  } else {
    p.drawRectangle({ x: box.x, y: box.y - box.h, width: box.w, height: box.h, color: C.panel });
    tc(p, "No image attached", box.x + box.w / 2, box.y - box.h / 2, 11, bold, C.muted);
    tc(p, "Upload a roof photo in your Xtract workspace to show it here.", box.x + box.w / 2, box.y - box.h / 2 - 16, 8.5, font, C.muted);
  }

  // Key figures strip
  const sy = 112;
  const tiles: [string, string][] = [
    ["Roof area", `${fmt(m.totalAreaSqFt)} sqft`],
    ["Squares", (m.totalAreaSqFt / 100).toFixed(1)],
    ["Recommended waste", `${m.suggestedWastePct}%`],
    ["Eaves + rakes", `${fmt(m.exactLengths.eave + m.exactLengths.rake)} ft`],
    ["Hips + ridges", `${fmt(m.exactLengths.hip + m.exactLengths.ridge)} ft`],
  ];
  const tw = (W - M * 2 - 4 * 8) / 5;
  tiles.forEach(([k, v], i) => {
    const x = M + i * (tw + 8);
    p.drawRectangle({ x, y: sy - 40, width: tw, height: 46, color: C.panel });
    p.drawRectangle({ x, y: sy + 4, width: tw, height: 2, color: i === 0 ? C.blue : C.amber });
    t(p, k.toUpperCase(), x + 7, sy - 8, 6, bold, C.muted);
    t(p, v, x + 7, sy - 28, 13, bold, C.ink);
  });
  t(p, `Measurement source: ${input.source.label}`, M, sy - 56, 7.5, font, input.source.provider === "demo" ? hex("#B45309") : C.muted);
}

function diagramPage(ctx: Ctx) {
  const p = page(ctx, "Diagram");
  facets(p, ctx.input.measurements, { x: M, y: H - 80, w: W - M * 2, h: H - 140 }, "fill");
  compass(p, ctx.bold, W - M - 14, 70);
}

function lengthsPage(ctx: Ctx) {
  const { input, font, bold } = ctx;
  const m = input.measurements;
  const p = page(ctx, "Length measurement report");
  const cw = (W - M * 2) / 3;
  EDGE_ORDER.forEach((type, i) => {
    const x = M + (i % 3) * cw;
    const y = H - 92 - Math.floor(i / 3) * 15;
    const col = hex(EDGE_HEX[type]);
    if (EDGE_DASHED[type]) for (let k = 0; k < 3; k++) p.drawRectangle({ x: x + k * 6, y: y + 1, width: 4, height: 3, color: col });
    else p.drawRectangle({ x, y: y + 1, width: 16, height: 3, color: col });
    const label = `${EDGE_LABEL[type]}: `;
    t(p, label, x + 24, y, 8.5, font);
    t(p, m.unmeasured.includes(type) ? "not measured" : ftIn(m.exactLengths[type]), x + 24 + font.widthOfTextAtSize(label, 8.5), y, 8.5, bold, C.ink);
  });

  const box: Box = { x: M, y: H - 160, w: W - M * 2, h: H - 230 };
  const map = facets(p, m, box, "outline");
  const drawn = m.edges.map((e) => ({ e, a: map(e.a), b: map(e.b) }));
  for (const { e, a, b } of drawn) {
    p.drawLine({
      start: { x: a[0], y: a[1] },
      end: { x: b[0], y: b[1] },
      thickness: 1.4,
      color: hex(EDGE_HEX[e.type]),
      dashArray: EDGE_DASHED[e.type] ? [3, 2] : undefined,
    });
  }
  for (const { e, a, b } of drawn) {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 16) continue;
    chip(p, bold, String(Math.ceil(e.lengthFt - 1e-9)), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 6, hex(EDGE_HEX[e.type]));
  }
  compass(p, bold, W - M - 14, 70);
  para(p, "Measurements in the diagram are rounded up for display; short edges are hidden to avoid overcrowding. Totals above are sums of the exact lengths.", M, 52, W - M * 2 - 40, 7.5, font, C.muted);
}

function areaPage(ctx: Ctx) {
  const { input, font } = ctx;
  const m = input.measurements;
  const p = page(ctx, "Area measurement report");
  const left: [string, string][] = [
    ["Total roof area", `${fmt(m.totalAreaSqFt)} sqft`],
    ["Pitched roof area", `${fmt(m.pitchedAreaSqFt)} sqft`],
    ["Flat roof area", `${fmt(m.flatAreaSqFt)} sqft`],
    ["Footprint (plan) area", `${fmt(m.footprintSqFt)} sqft`],
  ];
  const right: [string, string][] = [
    ["Predominant pitch", `${m.predominantPitch}/12`],
    ["Predominant pitch area", `${fmt(m.predominantPitchAreaSqFt)} sqft`],
    ["Roof facets", String(m.facetCount)],
  ];
  left.forEach(([k, v], i) => t(p, `${k}: ${v}`, M, H - 92 - i * 13, 9, font));
  right.forEach(([k, v], i) => t(p, `${k}: ${v}`, W / 2 + 20, H - 92 - i * 13, 9, font));
  const map = facets(p, m, { x: M, y: H - 150, w: W - M * 2, h: H - 230 }, "fill");
  for (const f of m.facets) {
    const [x, y] = map(f.label);
    tc(p, fmt(f.areaSqFt), x, y - 3, 7, font, C.ink);
  }
  compass(p, ctx.bold, W - M - 14, 70);
  para(p, "Area measurements in the diagram are rounded. The totals at the top of the page are the sums of the exact measurements, which are then rounded.", M, 52, W - M * 2 - 40, 7.5, font, C.muted);
}

function pitchPage(ctx: Ctx) {
  const { input, font, bold } = ctx;
  const m = input.measurements;
  const p = page(ctx, "Pitch & direction measurement report");
  const box: Box = { x: M, y: H - 80, w: W - M * 2, h: H - 150 };
  const { map, scale } = fitter(m, box);
  m.facets.forEach((f, i) => poly(p, box, f.polygon.map(map), facetFill(i, f.azimuth), C.facetLine, 0.8));
  for (const f of m.facets) {
    const [x, y] = map(f.label);
    const L = Math.min(18, Math.max(7, Math.sqrt(f.areaSqFt) * scale * 0.3));
    const a = (f.azimuth * Math.PI) / 180;
    const dx = Math.sin(a);
    const dy = Math.cos(a);
    tc(p, String(f.pitch), x - dx * 7, y - dy * 7 - 3, 7.5, bold, C.ink);
    if (f.pitch > 0) {
      const sx = x + dx * 3;
      const sy = y + dy * 3;
      const ex = sx + dx * L;
      const ey = sy + dy * L;
      p.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: 0.8, color: C.ink });
      for (const k of [1, -1]) {
        p.drawLine({ start: { x: ex, y: ey }, end: { x: ex - dx * 3.5 - dy * 2.2 * k, y: ey - dy * 3.5 + dx * 2.2 * k }, thickness: 0.8, color: C.ink });
      }
    }
  }
  compass(p, bold, W - M - 14, 70);
  para(p, "Numbers are pitch (inches of rise per 12 inches of run). Arrows point downslope.", M, 52, W - M * 2 - 40, 7.5, font, C.muted);
}

interface TableOpts {
  size?: number;
  rowH?: number;
  align?: ("l" | "r")[];
  highlightCol?: number;
  groupRows?: Set<number>;
}

function table(p: PDFPage, ctx: Ctx, x: number, y: number, widths: number[], head: string[] | null, rows: string[][], opts: TableOpts = {}) {
  const { font, bold } = ctx;
  const size = opts.size ?? 8.5;
  const rh = opts.rowH ?? 15;
  const total = widths.reduce((a, b) => a + b, 0);
  const colX = (ci: number) => x + widths.slice(0, ci).reduce((a, b) => a + b, 0);
  const cell = (s: string, ci: number, cy: number, f: PDFFont, col: RGB) => {
    if ((opts.align?.[ci] ?? (ci === 0 ? "l" : "r")) === "r") tr(p, s, colX(ci) + widths[ci] - 5, cy, size, f, col);
    else t(p, s, colX(ci) + 5, cy, size, f, col);
  };
  if (opts.highlightCol !== undefined) {
    const n = rows.length + (head ? 1 : 0);
    p.drawRectangle({ x: colX(opts.highlightCol), y: y - rh * n + 4, width: widths[opts.highlightCol], height: rh * n, color: hex("#FEF3C7") });
  }
  if (head) {
    p.drawRectangle({ x, y: y - rh + 4, width: total, height: rh, color: C.panel, opacity: opts.highlightCol !== undefined ? 0.6 : 1 });
    head.forEach((h, i) => cell(h, i, y - rh + 8, font, C.blue));
    y -= rh;
  }
  rows.forEach((r, ri) => {
    const group = opts.groupRows?.has(ri);
    if (group) p.drawRectangle({ x, y: y - rh + 4, width: total, height: rh, color: C.panel });
    r.forEach((v, ci) => cell(v, ci, y - rh + 8, group ? bold : font, C.text));
    p.drawLine({ start: { x, y: y - rh + 4 }, end: { x: x + total, y: y - rh + 4 }, thickness: 0.4, color: C.line });
    y -= rh;
  });
  return y;
}

function summaryPage(ctx: Ctx) {
  const { input, font, bold } = ctx;
  const m = input.measurements;
  const p = page(ctx, "Report summary");
  if (m.facets.length) {
    facets(p, m, { x: W / 2 - 130, y: H - 76, w: 260, h: 190 }, "fill");
    compass(p, bold, W - M - 14, H - 230);
  } else {
    para(p, "Quantities in this report were entered manually and have not been measured from imagery. Verify before ordering.", M, H - 100, W - M * 2, 9, bold, hex("#B45309"));
  }

  const L = m.exactLengths;
  const v = (type: EdgeType) => (m.unmeasured.includes(type) ? "not measured" : ftIn(L[type]));
  const rows: string[][] = [
    ["Total roof area", `${fmt(m.totalAreaSqFt)} sqft`],
    ["Total pitched area", `${fmt(m.pitchedAreaSqFt)} sqft`],
    ["Total flat area", `${fmt(m.flatAreaSqFt)} sqft`],
    ["Total roof facets", `${m.facetCount} facets`],
    ["Predominant pitch", `${m.predominantPitch}/12`],
    ...EDGE_ORDER.map((type) => [`Total ${EDGE_LABEL[type].toLowerCase()}`, v(type)]),
    ["Hips + ridges", ftIn(L.hip + L.ridge)],
    ["Eaves + rakes", ftIn(L.eave + L.rake)],
  ];
  const top = H - 290;
  t(p, "Measurements", M, top, 11, font, C.blue);
  table(p, ctx, M, top - 6, [130, 90], null, rows, { size: 8, rowH: 13.4 });

  const rx = M + 250;
  const rw = W - M - rx;
  t(p, "Pitch", rx, top, 11, font, C.blue);
  let y = top - 6;
  const per = 7;
  for (let i = 0; i < m.pitchBreakdown.length; i += per) {
    const chunk = m.pitchBreakdown.slice(i, i + per);
    const cols = [56, ...chunk.map(() => (rw - 56) / per)];
    y =
      table(
        p,
        ctx,
        rx,
        y,
        cols,
        ["Pitch", ...chunk.map((r) => `${r.pitch}/12`)],
        [
          ["Area (sqft)", ...chunk.map((r) => fmt(r.areaSqFt))],
          ["Squares", ...chunk.map((r) => r.squares.toFixed(1))],
        ],
        { size: 7.5, rowH: 14 },
      ) - 6;
  }

  y -= 10;
  t(p, "Waste", rx, y, 11, font, C.blue);
  const wi = m.wasteTable.findIndex((w) => w.pct === m.suggestedWastePct);
  const wcols = [56, ...m.wasteTable.map(() => (rw - 56) / m.wasteTable.length)];
  y = table(
    p,
    ctx,
    rx,
    y - 6,
    wcols,
    ["Waste %", ...m.wasteTable.map((w) => `${w.pct}%`)],
    [
      ["Area (sqft)", ...m.wasteTable.map((w) => fmt(w.areaSqFt))],
      ["Squares", ...m.wasteTable.map((w) => w.squares.toFixed(1))],
    ],
    { size: 7.5, rowH: 14, highlightCol: wi + 1 },
  );
  const recX = rx + wcols.slice(0, wi + 1).reduce((a, b) => a + b, 0) + wcols[wi + 1] / 2;
  tc(p, "Recommended", recX, y - 4, 6, bold, hex("#B45309"));
  para(
    p,
    "Recommended waste assumes an asphalt shingle roof with a closed valley system (if applicable) and reflects roof complexity. Your application style may call for more. Post-waste quantities of other materials are on the materials page.",
    rx,
    y - 20,
    rw,
    7,
    font,
    C.muted,
  );
}

function permitPage(ctx: Ctx) {
  const { input, font, bold } = ctx;
  const p = page(ctx, "Permit history & roof age");
  const pr = input.property;
  let y = para(p, roofAgeSentence(pr), M, H - 88, W - M * 2, 10, bold, C.ink) - 8;
  t(p, "Roof age", M, y, 11, font, C.blue);
  const yNow = input.createdAt.getFullYear();
  const age = pr?.lastRoofPermitYear
    ? `${yNow - pr.lastRoofPermitYear} years (since last roof permit)`
    : pr?.yearBuilt
      ? `up to ${yNow - pr.yearBuilt} years (since construction; permits not checked)`
      : "Unknown";
  const rows: string[][] = [
    ["Roof age", age],
    ["Last roof permit issued", pr?.lastRoofPermitYear ? String(pr.lastRoofPermitYear) : "None on file"],
    ["Year built / effective year", pr?.yearBuilt ? `${pr.yearBuilt} / ${pr.effectiveYearBuilt ?? pr.yearBuilt}` : "Not available"],
    ["Permit authority", pr?.county ? `${pr.county} County` : "-"],
    ["Parcel", pr?.parcelId ?? "-"],
  ];
  y = table(p, ctx, M, y - 6, [200, W - M * 2 - 200], null, rows, { size: 9, rowH: 17 });

  y -= 22;
  t(p, "Roofing permits", M, y, 11, font, C.blue);
  y -= 12;
  p.drawRectangle({ x: M, y: y - 56, width: W - M * 2, height: 56, borderColor: hex("#CCCCCC"), borderWidth: 0.6, borderDashArray: [3, 3] });
  tc(p, pr?.permitsChecked ? "No roofing permits were found for this address." : "Permit records were not checked for this address.", W / 2, y - 32, 9, font, C.muted);
  y -= 76;
  const portal = pr?.county ? PERMIT_PORTALS[pr.county] : undefined;
  const note = [
    pr ? `Source: ${pr.source}; checked ${new Date(pr.checkedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.` : "No public parcel record was available for this address.",
    "Roof age is counted from the newest roofing permit when one is on file, otherwise from the year built. Work done without a permit, or before online records, is not shown.",
    portal ? `Check the county permit portal (${portal}) and record the last roof permit in your Xtract workspace to update this page.` : "Check the county permit portal and record the last roof permit in your Xtract workspace to update this page.",
  ].join(" ");
  para(p, note, M, y, W - M * 2, 8, font, C.muted);
}

function materialsPage(ctx: Ctx) {
  const { input, font } = ctx;
  const m = input.measurements;
  const p = page(ctx, "Material calculations");
  const nCols = m.brandMaterials[0]?.rows[0]?.qty.length ?? 4;
  const wasteCols = [0, 10, m.suggestedWastePct, 15].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  if (wasteCols.length < nCols) wasteCols.push(20);
  const head = ["Product", "Unit", ...wasteCols.map((w) => `Waste (${w}%)`)];
  const rows: string[][] = [];
  const groups = new Set<number>();
  for (const g of m.brandMaterials) {
    groups.add(rows.length);
    rows.push([g.label, "", ...wasteCols.map((w) => (g.base ? `${fmt(g.base * (1 + w / 100))} ${g.baseUnit}` : ""))]);
    for (const r of g.rows) rows.push([r.product, r.unit, ...r.qty.map(String)]);
  }
  const widths = [210, 60, ...wasteCols.map(() => (W - M * 2 - 270) / wasteCols.length)];
  const y = table(p, ctx, M, H - 80, widths, head, rows, { size: 7.8, rowH: 15.2, groupRows: groups, align: ["l", "l", "r", "r", "r", "r"] });
  para(
    p,
    "These calculations are estimates and are not guaranteed. Always double check calculations before ordering materials. Estimates use the total pitched area (flat area is excluded). Valley metal and drip edge are cut to length, so no waste is added.",
    M,
    y - 12,
    W - M * 2,
    7.5,
    font,
    C.muted,
  );
}

export async function renderReportPdf(input: ReportInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Roof Report - ${input.address}`);
  doc.setAuthor(input.preparedBy.company);
  doc.setCreator(BRAND.full);
  doc.setSubject(`Order ${input.orderId}`);
  doc.setCreationDate(input.createdAt);
  const ctx: Ctx = {
    doc,
    font: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    input,
    pages: [],
  };
  await cover(ctx);
  if (input.measurements.facets.length) {
    diagramPage(ctx);
    lengthsPage(ctx);
    areaPage(ctx);
    pitchPage(ctx);
  }
  summaryPage(ctx);
  permitPage(ctx);
  materialsPage(ctx);
  footers(ctx);
  return doc.save();
}
