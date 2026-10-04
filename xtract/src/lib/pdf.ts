import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib";
import { BRAND, PRODUCTS } from "./config";
import { EDGE_HEX, EDGE_LABEL } from "./edges";
import type { EdgeType, Pt, ReportTier, RoofMeasurements } from "./types";

// Letter, points.
const W = 612;
const H = 792;
const M = 40;

const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const C = {
  navy: hex("#0F172A"),
  slate: hex("#334155"),
  muted: hex("#64748B"),
  line: hex("#E2E8F0"),
  panel: hex("#F8FAFC"),
  blue: hex("#0369A1"),
  amber: hex("#F59E0B"),
  white: rgb(1, 1, 1),
};

export interface ReportInput {
  orderId: string;
  tier: ReportTier;
  address: string;
  preparedFor: string;
  createdAt: Date;
  source: { provider: string; imageryDate?: string; imageryQuality?: string };
  measurements: RoofMeasurements;
  aerialPng?: Uint8Array | null;
}

interface Ctx {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  input: ReportInput;
  pages: PDFPage[];
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

function text(p: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color = C.navy) {
  p.drawText(s, { x, y, size, font, color });
}

function textRight(p: PDFPage, s: string, xRight: number, y: number, size: number, font: PDFFont, color = C.navy) {
  p.drawText(s, { x: xRight - font.widthOfTextAtSize(s, size), y, size, font, color });
}

function textCenter(p: PDFPage, s: string, cx: number, y: number, size: number, font: PDFFont, color = C.navy) {
  p.drawText(s, { x: cx - font.widthOfTextAtSize(s, size) / 2, y, size, font, color });
}

function newPage(ctx: Ctx, title: string): PDFPage {
  const p = ctx.doc.addPage([W, H]);
  ctx.pages.push(p);
  // Header band
  p.drawRectangle({ x: 0, y: H - 64, width: W, height: 64, color: C.navy });
  drawLogo(p, M, H - 46);
  text(p, BRAND.name.toUpperCase(), M + 30, H - 39, 15, ctx.bold, C.white);
  text(p, "ROOF REPORTS", M + 30, H - 51, 7, ctx.font, hex("#94A3B8"));
  textRight(p, title, W - M, H - 38, 13, ctx.bold, C.white);
  textRight(p, PRODUCTS[ctx.input.tier].name, W - M, H - 51, 8, ctx.font, hex("#7DD3FC"));
  // Address strip
  p.drawRectangle({ x: 0, y: H - 64 - 26, width: W, height: 26, color: C.panel });
  text(p, ctx.input.address, M, H - 82, 9.5, ctx.bold, C.slate);
  textRight(p, `Order ${ctx.input.orderId}`, W - M, H - 82, 8.5, ctx.font, C.muted);
  return p;
}

function drawLogo(p: PDFPage, x: number, y: number) {
  // Roof chevron with a measurement tick.
  p.drawSvgPath("M0 14 L11 3 L22 14", { x, y: y + 18, borderColor: C.white, borderWidth: 2.4 });
  p.drawSvgPath("M4 18 L18 18", { x, y: y + 18, borderColor: C.amber, borderWidth: 2.4 });
}

function footers(ctx: Ctx) {
  const n = ctx.pages.length;
  ctx.pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 34 }, end: { x: W - M, y: 34 }, thickness: 0.5, color: C.line });
    text(p, `Prepared for ${ctx.input.preparedFor}  ·  ${ctx.input.createdAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, M, 22, 7.5, ctx.font, C.muted);
    textRight(p, `Page ${i + 1} of ${n}`, W - M, 22, 7.5, ctx.font, C.muted);
  });
}

// --- Diagram -----------------------------------------------------------------

interface Box {
  x: number;
  y: number; // top edge (PDF coords)
  w: number;
  h: number;
}

function fitter(m: RoofMeasurements, box: Box) {
  const pts = m.facets.flatMap((f) => f.polygon);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 26;
  const s = Math.min((box.w - pad * 2) / (maxX - minX || 1), (box.h - pad * 2) / (maxY - minY || 1));
  const ox = box.x + (box.w - (maxX - minX) * s) / 2;
  const oy = box.y - (box.h - (maxY - minY) * s) / 2;
  // Returns PDF coords (y up).
  return (p: Pt): [number, number] => [ox + (p[0] - minX) * s, oy - (maxY - p[1]) * s];
}

function drawFacets(p: PDFPage, m: RoofMeasurements, box: Box, fill: RGB, opacity = 1) {
  const map = fitter(m, box);
  for (const f of m.facets) {
    const pts = f.polygon.map(map);
    const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${(x - box.x).toFixed(2)} ${(box.y - y).toFixed(2)}`).join(" ") + " Z";
    p.drawSvgPath(path, { x: box.x, y: box.y, color: fill, opacity, borderColor: hex("#CBD5E1"), borderWidth: 0.6 });
  }
  return map;
}

function drawCompass(p: PDFPage, font: PDFFont, x: number, y: number) {
  p.drawSvgPath("M0 -14 L5 4 L0 0 L-5 4 Z", { x, y, color: C.navy });
  textCenter(p, "N", x, y + 17, 8, font, C.navy);
}

function diagramPanel(p: PDFPage, box: Box) {
  p.drawRectangle({ x: box.x, y: box.y - box.h, width: box.w, height: box.h, color: C.white, borderColor: C.line, borderWidth: 0.8 });
}

function label(p: PDFPage, font: PDFFont, s: string, x: number, y: number, size: number, color: RGB, bg = C.white) {
  const w = font.widthOfTextAtSize(s, size);
  p.drawRectangle({ x: x - w / 2 - 2, y: y - size * 0.35, width: w + 4, height: size * 1.25, color: bg, opacity: 0.88 });
  p.drawText(s, { x: x - w / 2, y: y - size * 0.05, size, font, color });
}

// --- Pages -------------------------------------------------------------------

function overviewPage(ctx: Ctx) {
  const { input, font, bold } = ctx;
  const m = input.measurements;
  const p = newPage(ctx, "Roof Measurement Report");

  // Hero numbers
  let y = H - 128;
  text(p, "ROOF AREA", M, y, 8, bold, C.muted);
  text(p, `${fmt(m.totalAreaSqFt)} sq ft`, M, y - 30, 28, bold, C.navy);
  const sq = m.wasteTable[0].squares;
  text(p, `${sq} squares before waste  ·  ${m.facetCount} facets  ·  ${m.predominantPitch}/12 predominant pitch`, M, y - 46, 9.5, font, C.slate);

  // Tiles
  y = H - 205;
  const tiles: [string, string][] = [
    ["Facets", String(m.facetCount)],
    ["Predominant pitch", `${m.predominantPitch}/12`],
    ["Ridges / Hips", `${fmt(m.lengths.ridge + m.lengths.hip)} ft`],
    ["Valleys", `${fmt(m.lengths.valley)} ft`],
    ["Rakes", `${fmt(m.lengths.rake)} ft`],
    ["Eaves", `${fmt(m.lengths.eave)} ft`],
  ];
  const showLinear = input.tier !== "quick";
  const tw = (W - M * 2 - 5 * 8) / 6;
  tiles.forEach(([k, v], i) => {
    const x = M + i * (tw + 8);
    p.drawRectangle({ x, y: y - 46, width: tw, height: 50, color: C.panel, borderColor: C.line, borderWidth: 0.6 });
    p.drawRectangle({ x, y: y + 2, width: tw, height: 2, color: i < 2 ? C.blue : C.amber });
    text(p, k.toUpperCase(), x + 8, y - 12, 6.5, bold, C.muted);
    const val = i >= 2 && !showLinear ? "Full Report" : v;
    text(p, val, x + 8, y - 34, i >= 2 && !showLinear ? 9 : 15, bold, i >= 2 && !showLinear ? C.muted : C.navy);
  });

  // Top view
  const box: Box = { x: M, y: H - 285, w: W - M * 2, h: 370 };
  text(p, "TOP VIEW", M, box.y + 10, 8, bold, C.muted);
  diagramPanel(p, box);
  const map = drawFacets(p, m, box, hex("#E0F2FE"));
  for (const e of m.edges) {
    const [ax, ay] = map(e.a);
    const [bx, by] = map(e.b);
    p.drawLine({ start: { x: ax, y: ay }, end: { x: bx, y: by }, thickness: 1.1, color: C.navy });
  }
  for (const f of m.facets) {
    const [lx, ly] = map(f.label);
    label(p, bold, String(f.id), lx, ly, 8, C.blue, hex("#E0F2FE"));
  }
  drawCompass(p, bold, box.x + box.w - 24, box.y - 30);

  // Source panel
  const sy = box.y - box.h - 22;
  text(p, "SOURCE", M, sy, 8, bold, C.muted);
  const src =
    input.source.provider === "google-solar"
      ? `Google aerial imagery (${input.source.imageryQuality ?? "—"} quality)${input.source.imageryDate ? `, captured ${input.source.imageryDate}` : ""}. Plane geometry from Google Solar API.`
      : "DEMO DATA — synthetic roof generated for a test order. Connect a Google Maps Platform key for real measurements.";
  text(p, src, M, sy - 14, 8.5, font, input.source.provider === "demo" ? hex("#B45309") : C.slate);
  text(p, `Complexity: ${m.complexity}  ·  Footprint: ${fmt(m.footprintSqFt)} sq ft  ·  Suggested waste: ${m.suggestedWastePct}%`, M, sy - 28, 8.5, font, C.slate);
}

function lengthsPage(ctx: Ctx) {
  const { input, font, bold } = ctx;
  const m = input.measurements;
  const p = newPage(ctx, "Lengths");
  const box: Box = { x: M, y: H - 110, w: W - M * 2, h: 470 };
  diagramPanel(p, box);
  const map = drawFacets(p, m, box, hex("#F1F5F9"));
  for (const e of m.edges) {
    const [ax, ay] = map(e.a);
    const [bx, by] = map(e.b);
    p.drawLine({ start: { x: ax, y: ay }, end: { x: bx, y: by }, thickness: 2.2, color: hex(EDGE_HEX[e.type]) });
  }
  for (const e of m.edges) {
    const [ax, ay] = map(e.a);
    const [bx, by] = map(e.b);
    if (Math.hypot(bx - ax, by - ay) < 18) continue;
    label(p, bold, String(Math.round(e.lengthFt)), (ax + bx) / 2, (ay + by) / 2, 7, hex(EDGE_HEX[e.type]));
  }
  drawCompass(p, bold, box.x + box.w - 24, box.y - 30);
  text(p, "Lengths in feet, rounded to the nearest foot. Hip and valley lengths include slope.", M, box.y - box.h - 16, 8, font, C.muted);

  // Legend with totals
  const types: EdgeType[] = ["eave", "rake", "ridge", "hip", "valley", "flash"];
  const ly = box.y - box.h - 50;
  const cw = (W - M * 2) / 3;
  types.forEach((t, i) => {
    const x = M + (i % 3) * cw;
    const y = ly - Math.floor(i / 3) * 34;
    p.drawRectangle({ x, y: y - 2, width: 18, height: 4, color: hex(EDGE_HEX[t]) });
    text(p, EDGE_LABEL[t], x + 26, y - 3, 9.5, font, C.slate);
    textRight(p, `${fmt(m.lengths[t])} ft`, x + cw - 18, y - 3, 11, bold, C.navy);
  });
}

function pitchAreaPage(ctx: Ctx) {
  const { input, font, bold } = ctx;
  const m = input.measurements;
  const p = newPage(ctx, "Pitch & Area");
  const half = (W - M * 2 - 14) / 2;
  const boxes: Box[] = [
    { x: M, y: H - 128, w: half, h: 330 },
    { x: M + half + 14, y: H - 128, w: half, h: 330 },
  ];
  text(p, "PITCH (RISE PER 12)", M, H - 118, 8, bold, C.muted);
  text(p, "AREA (SQ FT)", M + half + 14, H - 118, 8, bold, C.muted);

  const maxPitch = Math.max(...m.facets.map((f) => f.pitch), 1);
  boxes.forEach((box, k) => {
    diagramPanel(p, box);
    const map = fitter(m, box);
    for (const f of m.facets) {
      const t = k === 0 ? 0.25 + 0.6 * (f.pitch / maxPitch) : 0.35;
      const fill = k === 0 ? rgb(1 - 0.6 * t, 1 - 0.3 * t, 1 - 0.05 * t) : hex("#FEF3C7");
      const pts = f.polygon.map(map);
      const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${(x - box.x).toFixed(2)} ${(box.y - y).toFixed(2)}`).join(" ") + " Z";
      p.drawSvgPath(path, { x: box.x, y: box.y, color: fill, borderColor: C.navy, borderWidth: 0.7 });
    }
    for (const f of m.facets) {
      const [lx, ly] = map(f.label);
      label(p, bold, k === 0 ? String(f.pitch) : fmt(f.areaSqFt), lx, ly, 8, C.navy, fill(k));
    }
    drawCompass(p, bold, box.x + box.w - 18, box.y - 26);
  });
  function fill(k: number) {
    return k === 0 ? hex("#E0F2FE") : hex("#FEF3C7");
  }

  // Facet table
  let y = H - 128 - 330 - 30;
  text(p, "FACETS", M, y, 8, bold, C.muted);
  y -= 16;
  const cols = [M, M + 50, M + 120, M + 200, M + 290];
  ["#", "Pitch", "Facing", "Area (sq ft)", "Squares"].forEach((h, i) => text(p, h, cols[i], y, 8, bold, C.slate));
  y -= 4;
  p.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: C.line });
  const rows = m.facets.slice(0, 14);
  for (const f of rows) {
    y -= 13;
    text(p, String(f.id), cols[0], y, 8.5, font);
    text(p, `${f.pitch}/12`, cols[1], y, 8.5, font);
    text(p, f.direction, cols[2], y, 8.5, font);
    text(p, fmt(f.areaSqFt), cols[3], y, 8.5, font);
    text(p, (f.areaSqFt / 100).toFixed(2), cols[4], y, 8.5, font);
  }
  if (m.facets.length > rows.length) {
    y -= 13;
    text(p, `+ ${m.facets.length - rows.length} more facets (see Claims Pro facet table)`, cols[0], y, 8, font, C.muted);
  }
}

function summaryPage(ctx: Ctx) {
  const { input, font, bold } = ctx;
  const m = input.measurements;
  const p = newPage(ctx, "Summary");
  let y = H - 125;

  // Pitch breakdown
  text(p, "AREA BY PITCH", M, y, 8, bold, C.muted);
  y -= 18;
  const barW = W - M * 2 - 170;
  for (const row of m.pitchBreakdown) {
    text(p, `${row.pitch}/12`, M, y, 10, bold);
    p.drawRectangle({ x: M + 50, y: y - 2, width: barW, height: 10, color: C.panel });
    p.drawRectangle({ x: M + 50, y: y - 2, width: Math.max(2, (barW * row.percent) / 100), height: 10, color: C.blue });
    textRight(p, `${fmt(row.areaSqFt)} sq ft`, W - M - 50, y, 9.5, font, C.slate);
    textRight(p, `${Math.round(row.percent)}%`, W - M, y, 9.5, bold);
    y -= 20;
  }

  // Waste table
  y -= 14;
  text(p, "WASTE CALCULATION", M, y, 8, bold, C.muted);
  y -= 8;
  const cw = (W - M * 2 - 70) / m.wasteTable.length;
  const rowsLbl = ["Waste", "Area (sq ft)", "Squares"];
  rowsLbl.forEach((r, ri) => {
    const ry = y - 20 - ri * 22;
    text(p, r, M, ry, 8.5, bold, C.slate);
  });
  m.wasteTable.forEach((w, i) => {
    const x = M + 70 + i * cw;
    const sel = w.pct === m.suggestedWastePct;
    if (sel) {
      p.drawRectangle({ x: x + 2, y: y - 74, width: cw - 4, height: 74, color: hex("#FEF3C7"), borderColor: C.amber, borderWidth: 1 });
      textCenter(p, "SUGGESTED", x + cw / 2, y - 86, 6.5, bold, hex("#B45309"));
    }
    textCenter(p, `${w.pct}%`, x + cw / 2, y - 20, 9.5, bold);
    textCenter(p, fmt(w.areaSqFt), x + cw / 2, y - 42, 9.5, font);
    textCenter(p, String(w.squares), x + cw / 2, y - 64, 11, bold, C.blue);
  });
  y -= 110;

  // Linear summary
  if (input.tier !== "quick") {
    text(p, "LINEAR MEASUREMENTS", M, y, 8, bold, C.muted);
    y -= 6;
    const rows: [string, number, string][] = [
      ["Eaves", m.lengths.eave, "level roof edges"],
      ["Rakes", m.lengths.rake, "sloped roof edges"],
      ["Ridges", m.lengths.ridge, ""],
      ["Hips", m.lengths.hip, ""],
      ["Valleys", m.lengths.valley, ""],
      ["Wall flashing", m.lengths.flash, "roof-to-wall at plane tops"],
      ["Drip edge", m.derived.dripEdge, "eaves + rakes"],
      ["Starter", m.derived.starter, "eaves + rakes"],
      ["Hip & ridge cap", m.derived.ridgeCap, "ridges + hips"],
      ["Leak barrier", m.derived.leakBarrier, "valleys"],
    ];
    rows.forEach(([k, v, note], i) => {
      const col = i % 2;
      const x = M + col * ((W - M * 2) / 2 + 6);
      const ry = y - 18 - Math.floor(i / 2) * 22;
      const cwid = (W - M * 2) / 2 - 6;
      p.drawLine({ start: { x, y: ry - 7 }, end: { x: x + cwid, y: ry - 7 }, thickness: 0.5, color: C.line });
      text(p, k, x, ry, 9.5, bold, C.slate);
      if (note) text(p, note, x + 92, ry, 7.5, font, C.muted);
      textRight(p, `${fmt(v)} ft`, x + cwid, ry, 10, bold);
    });
    y -= 18 + 5 * 22 + 10;
  } else {
    p.drawRectangle({ x: M, y: y - 52, width: W - M * 2, height: 52, color: C.panel, borderColor: C.line, borderWidth: 0.6 });
    text(p, "Need eaves, rakes, ridges, hips, valleys and a materials list?", M + 14, y - 22, 10, bold);
    text(p, "Upgrade this address to a Full Report — no re-entry needed. Reply to your delivery email.", M + 14, y - 38, 9, font, C.slate);
    y -= 70;
  }

  notes(p, ctx, y - 10);
}

function notes(p: PDFPage, ctx: Ctx, y: number) {
  const { font, bold } = ctx;
  text(p, "NOTES", M, y, 8, bold, C.muted);
  const lines = [
    "1) Roof area, pitch and facet count are measured from aerial imagery. Areas include slope; squares are rounded up.",
    "2) Linear measurements are derived from plane geometry and are estimates. Verify critical lengths on site.",
    "3) Rakes are sloped roof edges; eaves are level roof edges. Drip edge and starter = eaves + rakes.",
    "4) Waste table excludes extra material for ridges, hips and valleys. Suggested waste is guidance only.",
    "5) Step flashing around walls and penetrations is not measured from imagery.",
  ];
  lines.forEach((l, i) => text(p, l, M, y - 15 - i * 12, 7.6, font, C.slate));
}

function materialsPage(ctx: Ctx) {
  const { input, font, bold } = ctx;
  const m = input.measurements;
  const p = newPage(ctx, "Materials");
  let y = H - 125;
  text(p, `ESTIMATED ORDER AT ${m.suggestedWastePct}% WASTE`, M, y, 8, bold, C.muted);
  y -= 22;
  const cols = [M, M + 230, M + 300];
  ["Item", "Qty", "Basis"].forEach((h, i) => text(p, h, cols[i], y, 8.5, bold, C.slate));
  y -= 6;
  p.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: C.navy });
  for (const line of m.materials) {
    y -= 26;
    text(p, line.item, cols[0], y, 10.5, bold);
    text(p, `${line.qty} ${line.unit}`, cols[1], y, 10.5, bold, C.blue);
    text(p, line.basis, cols[2], y, 8.5, font, C.slate);
    p.drawLine({ start: { x: M, y: y - 9 }, end: { x: W - M, y: y - 9 }, thickness: 0.4, color: C.line });
  }
  y -= 34;
  p.drawRectangle({ x: M, y: y - 44, width: W - M * 2, height: 44, color: hex("#FFFBEB"), borderColor: C.amber, borderWidth: 0.8 });
  text(p, "Coverage rates: GAF Pro-Start 120 LF/bundle, Seal-A-Ridge 25 LF/bundle, FeltBuster 10 SQ/roll,", M + 12, y - 18, 8.5, font, C.slate);
  text(p, "36\" x 50' leak barrier. Swap in your own products — confirm quantities with your supplier.", M + 12, y - 32, 8.5, font, C.slate);
}

async function claimsPages(ctx: Ctx) {
  const { input, font, bold, doc } = ctx;
  const m = input.measurements;
  const p = newPage(ctx, "Aerial Imagery");
  const box: Box = { x: M, y: H - 110, w: W - M * 2, h: W - M * 2 };
  if (input.aerialPng) {
    const img = await doc.embedPng(input.aerialPng);
    p.drawImage(img, { x: box.x, y: box.y - box.h, width: box.w, height: box.h });
  } else {
    p.drawRectangle({ x: box.x, y: box.y - box.h, width: box.w, height: box.h, color: C.panel, borderColor: C.line, borderWidth: 0.8 });
    textCenter(p, "Aerial image unavailable in demo mode", W / 2, box.y - box.h / 2 + 6, 12, bold, C.muted);
    textCenter(p, "Set GOOGLE_MAPS_API_KEY to embed the satellite capture.", W / 2, box.y - box.h / 2 - 12, 9, font, C.muted);
  }
  const iy = box.y - box.h - 20;
  text(p, `Imagery date: ${input.source.imageryDate ?? "n/a"}   ·   Quality: ${input.source.imageryQuality ?? "n/a"}`, M, iy, 9, bold, C.slate);
  if (input.source.provider === "google-solar") {
    text(p, "Imagery © Google. Capture date is when the aerial photo was taken, not the inspection date.", M, iy - 14, 8, font, C.muted);
  }

  // Squares by pitch for estimate line items
  const q = newPage(ctx, "Estimate Line Items");
  let y = H - 125;
  text(q, "SQUARES BY PITCH (NO WASTE)", M, y, 8, bold, C.muted);
  y -= 20;
  for (const row of m.pitchBreakdown) {
    text(q, `${row.pitch}/12 pitch`, M, y, 10, bold);
    text(q, `${(row.areaSqFt / 100).toFixed(2)} SQ`, M + 140, y, 10, font, C.blue);
    text(q, row.pitch >= 10 ? "steep charge (10/12–12/12+)" : row.pitch >= 7 ? "steep charge (7/12–9/12)" : "standard", M + 240, y, 8.5, font, C.muted);
    y -= 18;
  }
  y -= 16;
  text(q, "ALL FACETS", M, y, 8, bold, C.muted);
  y -= 16;
  const cols = [M, M + 40, M + 100, M + 160, M + 250, M + 340];
  ["#", "Pitch", "Facing", "Azimuth", "Area (sq ft)", "Squares"].forEach((h, i) => text(q, h, cols[i], y, 8, bold, C.slate));
  y -= 4;
  q.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: C.line });
  for (const f of m.facets.slice(0, 34)) {
    y -= 13;
    text(q, String(f.id), cols[0], y, 8.5, font);
    text(q, `${f.pitch}/12`, cols[1], y, 8.5, font);
    text(q, f.direction, cols[2], y, 8.5, font);
    text(q, `${Math.round(f.azimuth)}°`, cols[3], y, 8.5, font);
    text(q, fmt(f.areaSqFt), cols[4], y, 8.5, font);
    text(q, (f.areaSqFt / 100).toFixed(2), cols[5], y, 8.5, font);
  }
}

export async function renderReportPdf(input: ReportInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${BRAND.full} — ${input.address}`);
  doc.setAuthor(BRAND.full);
  doc.setSubject(`${PRODUCTS[input.tier].name} · Order ${input.orderId}`);
  doc.setCreationDate(input.createdAt);
  const ctx: Ctx = {
    doc,
    font: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    input,
    pages: [],
  };

  overviewPage(ctx);
  if (input.tier !== "quick") {
    lengthsPage(ctx);
    pitchAreaPage(ctx);
  }
  summaryPage(ctx);
  if (input.tier !== "quick") materialsPage(ctx);
  if (input.tier === "claims") await claimsPages(ctx);
  footers(ctx);
  return doc.save();
}
