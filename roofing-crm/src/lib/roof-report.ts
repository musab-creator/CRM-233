import type { RoofMeasurements, RoofReportSource } from '@/types';

// Parses the extracted text of a roof measurement report PDF.
//
// The Roofr and GAF QuickMeasure branches are ported from the parser inside
// public/tools/estimator.html, so a PDF read here yields the same numbers the
// estimator would get if the PDF were dropped into it directly. The EagleView
// branch is best-effort against EagleView's "Report Summary" layout
// ("Total Roof Area = 2,345 sq ft", "Ridges = 63 ft"); every parsed report is
// shown to the rep for review before it is saved, so a missed field is caught
// there rather than priced.
//
// Reports printed from Roof Measure (public/tools/roof-measure) use Roofr's
// layout and wording with the company's name in place of Roofr's, so they go
// through the Roofr branch.

export const SOURCE_LABELS: Record<RoofReportSource, string> = {
  roof_measure: 'Roof Measure',
  eagleview: 'EagleView',
  roofr: 'Roofr',
  gaf_quickmeasure: 'GAF QuickMeasure',
  manual: 'Manual entry',
};

export interface ParsedRoofReport {
  ok: boolean;
  source: RoofReportSource | null;
  address: string;
  measurements: RoofMeasurements;
}

export const round2 = (n: number) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// The estimator's waste rule: complex roofs (15+ facets) get 15%, the rest 12%.
export const defaultWaste = (facets: number) => (facets >= 15 ? 15 : 12);

export function emptyMeasurements(): RoofMeasurements {
  return {
    totalSqFt: 0,
    pitchedSqFt: 0,
    flatSqFt: 0,
    twoStorySqFt: 0,
    pitch: 6,
    facets: 0,
    eaves: 0,
    rakes: 0,
    valleys: 0,
    hipsRidges: 0,
    eavesRakes: 0,
    flashing: 0,
    penetrations: null,
    wastePct: 15,
  };
}

export const squares = (m: RoofMeasurements) => round2(m.totalSqFt / 100);

// "188ft 7in" -> 188.58
function feetInches(s: string): number {
  const m = String(s).match(/([\d,]+)\s*ft(?:\s*(\d+)\s*in)?/);
  return m ? round2(parseFloat(m[1].replace(/,/g, '')) + (m[2] ? parseFloat(m[2]) / 12 : 0)) : 0;
}

function num(re: RegExp, text: string, fallback = 0): number {
  const m = text.match(re);
  return m ? parseFloat(m[1].replace(/,/g, '')) : fallback;
}

function parseRoofr(t: string, m: RoofMeasurements): string {
  const addr = t.match(
    /(\d+\s+[A-Za-z][A-Za-z0-9 .'-]{2,40}?,\s*[A-Za-z .]{3,30},\s*(?:FL|Florida|GA|Georgia)\s*,?\s*\d{5})/,
  );
  m.totalSqFt = num(/Total roof area:?\s*([\d,]+)\s*sqft/i, t);
  m.pitchedSqFt = num(/Pitched roof area:?\s*([\d,]+)\s*sqft/i, t, m.totalSqFt);
  m.flatSqFt = num(/Flat roof area:?\s*([\d,]+)\s*sqft/i, t);
  m.twoStorySqFt = num(/Two story area:?\s*([\d,]+)\s*sqft/i, t);
  m.pitch = num(/Predominant pitch:?\s*(\d+)\s*\/\s*12/i, t, 6);
  m.facets = num(/(\d+)\s*facets/i, t);

  const len = (label: string) => {
    const r = t.match(new RegExp(label + ':?\\s*([\\d,]+ft(?:\\s*\\d+in)?)', 'i'));
    return r ? feetInches(r[1]) : 0;
  };
  m.eaves = len('(?:Total )?eaves');
  m.valleys = len('(?:Total )?valleys');
  m.rakes = len('(?:Total )?rakes');
  const hips = len('(?:Total )?hips');
  const ridges = len('(?:Total )?ridges');

  const hr = t.match(/Hips \+ ridges\s*([\d,]+ft(?:\s*\d+in)?)/i);
  m.hipsRidges = hr ? feetInches(hr[1]) : round2(hips + ridges);
  const er = t.match(/Eaves \+ rakes\s*([\d,]+ft(?:\s*\d+in)?)/i);
  m.eavesRakes = er ? feetInches(er[1]) : round2(m.eaves + m.rakes);
  m.flashing = round2(len('(?:Total )?wall flashing') + len('(?:Total )?step flashing'));
  return addr ? addr[1].trim() : '';
}

function parseQuickMeasure(t: string, m: RoofMeasurements): string {
  const addr = t.match(/([0-9][^.]{5,80}?,\s*(?:FL|Florida|GA|Georgia)\s*\d{5})/);
  m.totalSqFt = num(/Roof Area\s+([\d,]+)\s*sq ?ft/i, t);
  m.pitchedSqFt = m.totalSqFt;
  m.pitch = num(/Predominant Pitch\s+(\d+)\s*\/\s*12/i, t, 6);
  m.facets = num(/Roof Facets\s+(\d+)/i, t);
  m.eaves = num(/Eaves\s+([\d,]+)\s*ft/i, t);
  m.rakes = num(/Rakes\s+([\d,]+)\s*ft/i, t);
  m.valleys = num(/Valleys\s+([\d,]+)\s*ft/i, t);
  m.hipsRidges = num(/(?:Ridges\/Hips|Ridge Cap)\s+([\d,]+)\s*ft/i, t);
  m.eavesRakes = num(/Drip Edge\s+([\d,]+)\s*ft/i, t) || round2(m.eaves + m.rakes);
  const pen = t.match(/Penetrations\s+(\d+)/i);
  if (pen) m.penetrations = parseInt(pen[1], 10);

  // Pitch/area table: anything 2/12 or flatter is low-slope and priced separately.
  const table = t.match(/Pitch\s+((?:\d+\s+)+)Area\s+((?:[\d,]+\s+)+)/i);
  if (table) {
    const pitches = table[1].trim().split(/\s+/).map(Number);
    const areas = table[2].trim().split(/\s+/).map((a) => parseFloat(a.replace(/,/g, '')));
    let flat = 0;
    pitches.forEach((p, i) => {
      if (p <= 2 && areas[i]) flat += areas[i];
    });
    if (flat > 0) {
      m.flatSqFt = flat;
      m.pitchedSqFt = round2(m.totalSqFt - flat);
    }
  }
  return addr ? addr[1].trim() : '';
}

function parseEagleView(t: string, m: RoofMeasurements): string {
  const addr = t.match(/(\d+\s+[^,]{3,60},\s*[A-Za-z .]{3,30},\s*[A-Z]{2}\s*\d{5})/);
  const eq = (label: string, unit = 'ft') =>
    num(new RegExp(label + '\\s*=?\\s*([\\d,]+(?:\\.\\d+)?)\\s*' + unit, 'i'), t);

  m.totalSqFt = eq('Total (?:Roof )?Area', 'sq ?ft');
  m.pitchedSqFt = m.totalSqFt;
  m.pitch = num(/Predominant Pitch\s*=?\s*(\d+)\s*\/\s*12/i, t, 6);
  m.facets = num(/Total (?:Roof )?Facets\s*=?\s*(\d+)/i, t);
  m.eaves = eq('Eaves(?:\\/Starter)?');
  m.rakes = eq('Rakes');
  m.valleys = eq('Valleys');
  const combined = eq('(?:Ridges\\/Hips|Hips\\/Ridges)');
  m.hipsRidges = combined || round2(eq('Ridges') + eq('Hips'));
  m.eavesRakes = eq('Drip Edge(?: \\(Eaves \\+ Rakes\\))?') || round2(m.eaves + m.rakes);
  m.flashing = round2(eq('(?:Total )?(?:Wall|Counter) Flashing') + eq('(?:Total )?Step Flashing'));
  const pen = t.match(/(?:Total )?Penetrations\s*=?\s*(\d+)/i);
  if (pen) m.penetrations = parseInt(pen[1], 10);
  return addr ? addr[1].trim() : '';
}

export function parseRoofReportText(raw: string): ParsedRoofReport {
  const t = raw.replace(/\s+/g, ' ');
  const m = emptyMeasurements();
  let source: RoofReportSource | null = null;
  let address = '';

  const roofr = /Roofr\.com|Prepared by Roofr/i.test(t);
  const roofMeasure = !roofr && /Roof Report/i.test(t) && /Prepared by/i.test(t) && /Length measurement report/i.test(t);
  if (roofr || roofMeasure) {
    source = roofr ? 'roofr' : 'roof_measure';
    address = parseRoofr(t, m);
  } else if (/EagleView/i.test(t)) {
    source = 'eagleview';
    address = parseEagleView(t, m);
  } else if (/Roof Area\s+[\d,]+\s*sq ?ft/i.test(t) && /Predominant Pitch/i.test(t)) {
    source = 'gaf_quickmeasure';
    address = parseQuickMeasure(t, m);
  }

  m.wastePct = defaultWaste(m.facets);
  return { ok: m.totalSqFt > 0, source, address, measurements: m };
}
