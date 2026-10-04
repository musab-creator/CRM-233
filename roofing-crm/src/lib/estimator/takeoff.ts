import type { RoofReport } from '@/types';
import type { Confidence, Estimate, EstimateTakeoff, PriceBook, ReportTakeoff, RoofItemKey } from './types';
import type { ParsedRoofReport } from '../roof-report';
import { parseRoofReportText, SOURCE_LABELS } from '../roof-report';
import { newRoofSection } from './factories';
import { round2, toNumber } from './format';

// Roof report measurements -> estimate. Text parsing lives in the CRM's
// lib/roof-report.ts (the same Roofr / GAF QuickMeasure rules the original
// estimator used, plus EagleView and Roof Measure); this module maps its
// output onto an estimate exactly like the estimator's "Apply to this
// estimate" button.

// The CRM parser's result, in the estimator's takeoff shape.
export function takeoffFromParsed(parsed: ParsedRoofReport): ReportTakeoff {
  const m = parsed.measurements;
  return {
    vendor: parsed.source ? SOURCE_LABELS[parsed.source] : null,
    address: parsed.address,
    total: m.totalSqFt,
    pitched: m.pitchedSqFt,
    flat: m.flatSqFt,
    pitch: m.pitch,
    twoStoryArea: m.twoStorySqFt,
    eaves: m.eaves,
    rakes: m.rakes,
    valleys: m.valleys,
    hipsRidges: m.hipsRidges,
    eavesRakes: m.eavesRakes,
    facets: m.facets,
    penetrations: m.penetrations,
    waste: m.wastePct,
    flashing: m.flashing,
    ok: parsed.ok,
  };
}

// Reads the text of a measurement report PDF.
export function takeoffFromReportText(text: string): ReportTakeoff {
  return takeoffFromParsed(parseRoofReportText(text));
}

// Where a CRM roof report came from, as the estimate's takeoff records it:
// the file name, else "<vendor> order <id>", else the vendor.
export function roofReportSourceName(report: Pick<RoofReport, 'fileName' | 'orderId' | 'source'>): string {
  return (
    report.fileName ||
    (report.orderId ? `${SOURCE_LABELS[report.source]} order ${report.orderId}` : SOURCE_LABELS[report.source])
  );
}

// A saved CRM roof report (RoofReport) in the estimator's takeoff shape.
// The address is the full "street, city, ST zip" line.
export function takeoffFromRoofReport(report: RoofReport): ReportTakeoff {
  const m = report.measurements;
  return {
    vendor: SOURCE_LABELS[report.source],
    address: [report.address, report.city, `${report.state} ${report.zip}`.trim()].filter(Boolean).join(', '),
    total: m.totalSqFt,
    pitched: m.pitchedSqFt,
    flat: m.flatSqFt,
    pitch: m.pitch,
    twoStoryArea: m.twoStorySqFt,
    eaves: m.eaves,
    rakes: m.rakes,
    valleys: m.valleys,
    hipsRidges: m.hipsRidges,
    eavesRakes: m.eavesRakes,
    facets: m.facets,
    penetrations: m.penetrations,
    waste: m.wastePct,
    flashing: m.flashing,
    ok: m.totalSqFt > 0,
  };
}

export interface ApplyTakeoffOptions {
  // Name of the report file it came from; stored as takeoff.from ("report" if omitted).
  from?: string;
  // Fill a blank customer street/city from the report's address (default true).
  fillAddress?: boolean;
}

// Loads report measurements into an estimate, in place:
// - section 1 becomes the pitched roof (measured squares, waste, pitch, 2 stories if any two-story area);
// - more than 50 sq ft of flat roof goes into section 2 at 10% waste, 0 pitch;
// - drip edge, starter, ridge, valley (and flashing, when the report has it)
//   quantities are loaded but left switched off;
// - a penetration count loads pipe boots and switches them on;
// - eaves become the first gutter run's LF if that run is still blank;
// - the takeoff summary is stored on the estimate.
export function applyTakeoff(est: Estimate, pricing: PriceBook, t: ReportTakeoff, options: ApplyTakeoffOptions = {}): Estimate {
  if (options.fillAddress !== false && t.address) {
    const parts = t.address.split(',');
    if (!est.customer.address) est.customer.address = (parts[0] || t.address).trim();
    if (parts[1] && !est.customer.city) est.customer.city = parts[1].trim();
  }

  const main = est.roof.sections[0];
  main.name = 'Main roof — from report';
  main.measured = round2((t.pitched || t.total) / 100);
  main.waste = t.waste;
  main.pitch = Math.max(0, Math.min(12, Math.round(t.pitch)));
  if (t.twoStoryArea > 0) main.stories = 2;
  if (t.flat > 50) {
    if (est.roof.sections.length < 2) est.roof.sections.push(newRoofSection(pricing, est.roof.sections.length + 1));
    const flat = est.roof.sections[1];
    flat.name = 'Flat / low-slope — from report';
    flat.measured = round2(t.flat / 100);
    flat.waste = 10;
    flat.pitch = 0;
    flat.stories = main.stories;
  }

  const setQty = (k: RoofItemKey, qty: number, on?: boolean) => {
    const it = est.roof.items.find((i) => i.k === k);
    if (!it) return;
    it.qty = round2(qty);
    if (on !== undefined) it.on = on;
  };
  setQty('dripedge', t.eavesRakes);
  setQty('starter', t.eavesRakes);
  setQty('ridge', t.hipsRidges);
  setQty('valley', t.valleys);
  if (t.flashing && t.flashing > 0) setQty('flashing', t.flashing);
  if (t.penetrations !== null && t.penetrations !== undefined) setQty('boots', t.penetrations, t.penetrations > 0);
  if (est.scope !== 'roof' && t.eaves > 0 && !toNumber(est.gutter.runs[0].lf)) {
    est.gutter.runs[0].lf = Math.round(t.eaves);
  }

  const takeoff: EstimateTakeoff = {
    vendor: t.vendor,
    from: options.from || 'report',
    address: t.address,
    total: t.total,
    pitched: t.pitched,
    flat: t.flat,
    pitch: t.pitch,
    facets: t.facets,
    eaves: t.eaves,
    eavesRakes: t.eavesRakes,
    valleys: t.valleys,
    hipsRidges: t.hipsRidges,
    penetrations: t.penetrations,
    waste: t.waste,
  };
  est.takeoff = takeoff;
  return est;
}

// How far to trust the quantities: an explicit choice, else "measured" once
// a report has been applied, else "rough".
export function measurementConfidence(est: Pick<Estimate, 'confidence' | 'takeoff'>): Confidence {
  return est.confidence ? est.confidence : est.takeoff ? 'measured' : 'rough';
}

export const CONFIDENCE_LEVELS: Record<Confidence, { label: string; tone: 'warn' | 'navy' | 'ok'; note: string }> = {
  rough: {
    label: 'Rough',
    tone: 'warn',
    note: 'Measurements typed in by hand — expect ±15% until a roof report or site visit confirms them.',
  },
  measured: {
    label: 'Measured',
    tone: 'navy',
    note: 'Quantities derived from a measurement report — expect ±5% pending field verification.',
  },
  verified: { label: 'Site-verified', tone: 'ok', note: 'Scope confirmed on site.' },
};
