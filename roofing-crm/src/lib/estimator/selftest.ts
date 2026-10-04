import type { Estimate, EstimateScope, GutterItemKey, GutterRun, PriceBook, RoofSection } from './types';
import { costAtPrice, costStructure, estimateTotals } from './calc';
import { newEstimate, newGutterRun } from './factories';
import { round2, toNumber } from './format';
import { takeoffFromReportText } from './takeoff';

// The estimator's built-in self-test (shown on the manager dashboard):
// six hand-worked estimates priced against the live price book, the
// margin solver re-costed at four targets, and the report parser re-run on
// sample Roofr and GAF QuickMeasure text.

interface SelfTestCase {
  name: string;
  scope: EstimateScope;
  roof?: Partial<RoofSection>;
  gutter?: Partial<GutterRun>;
  gutterItems?: Partial<Record<GutterItemKey, { qty?: number; rate?: number; meta?: { size: string; count: number; len: number } }>>;
  expected: () => { sq?: number; lf?: number; sell: number };
}

export interface SelfTestRow {
  name: string;
  qty: string;
  expected: number;
  got: number;
  cost: number;
  grossProfit: number;
  margin: number;
  markup: number;
  pass: boolean;
  summary?: string; // rows 7-8 are a single pass/fail line
}

export interface SelfTestResult {
  rows: SelfTestRow[];
  passed: number;
  total: number;
}

function buildCase(pricing: PriceBook, c: SelfTestCase): Estimate {
  const est = newEstimate(pricing, 1);
  est.scope = c.scope;
  est.number = 'TEST';
  est.customer.name = 'Self-test';
  if (c.scope === 'gutter') est.roof.items.forEach((it) => (it.on = false));
  if (c.roof) {
    Object.assign(est.roof.sections[0], c.roof);
    est.roof.items.forEach((it) => (it.on = ['permit', 'dumpster', 'delivery'].includes(it.k)));
  } else {
    est.roof.sections = [];
  }
  if (c.gutter) {
    est.gutter.runs = [Object.assign(newGutterRun(pricing, 1), c.gutter)];
    const items = c.gutterItems;
    if (items) {
      est.gutter.items.forEach((it) => {
        const spec = items[it.k];
        if (!spec) return;
        it.on = true;
        if (spec.qty !== undefined) it.qty = spec.qty;
        if (spec.rate !== undefined) it.rate = spec.rate;
        if (spec.meta) it.meta = Object.assign({}, it.meta, spec.meta);
      });
    }
  } else {
    est.gutter.runs = [];
  }
  return est;
}

function selfTestCases(p: PriceBook): SelfTestCase[] {
  const site = () => p.roof.permit + p.roof.dumpster + p.roof.delivery;
  return [
    {
      name: '1 — IKO, one story, 6/12',
      scope: 'roof',
      roof: { measured: 30, waste: 15, mfr: 'IKO', tier: 'standard', pitch: 6, stories: 1, psMode: 'none' },
      expected: () => ({ sq: 34.5, sell: 34.5 * p.mfrs.IKO.standard + site() }),
    },
    {
      name: '2 — IKO, two story, 8/12, peel-and-stick',
      scope: 'roof',
      roof: { measured: 40, waste: 15, mfr: 'IKO', tier: 'standard', pitch: 8, stories: 2, psMode: 'full' },
      expected: () => ({
        sq: 46,
        sell:
          46 * p.mfrs.IKO.standard +
          46 * ((8 - p.roof.pitchFreeUpTo) * p.roof.pitchStep) +
          46 * p.roof.story2 +
          46 * p.roof.peelStick +
          site(),
      }),
    },
    {
      name: '3 — Owens Corning, one story, 7/12',
      scope: 'roof',
      roof: { measured: 25, waste: 15, mfr: 'OC', tier: 'standard', pitch: 7, stories: 1, psMode: 'none' },
      expected: () => {
        const sq = 25 * 1.15;
        const base = 25 * 1.15 * p.mfrs.OC.standard;
        const pitch = sq * ((7 - p.roof.pitchFreeUpTo) * p.roof.pitchStep);
        return { sq, sell: base + pitch + site() };
      },
    },
    {
      name: '4 — Owens Corning, two story, 10/12, peel-and-stick',
      scope: 'roof',
      roof: { measured: 50, waste: 15, mfr: 'OC', tier: 'standard', pitch: 10, stories: 2, psMode: 'full' },
      expected: () => {
        const sq = 50 * 1.15;
        const base = 50 * 1.15 * p.mfrs.OC.standard;
        const pitch = sq * ((10 - p.roof.pitchFreeUpTo) * p.roof.pitchStep);
        const story = sq * p.roof.story2;
        const ps = sq * p.roof.peelStick;
        return { sq, sell: base + pitch + story + ps + site() };
      },
    },
    {
      name: '5 — 6" gutter installation',
      scope: 'gutter',
      gutter: { size: 'g6', lf: 180, mode: 'new', removal: true, stories: 1 },
      gutterItems: { ds: { meta: { size: '2x3', count: 5, len: 20 }, rate: p.gutter.downspouts['2x3'] } },
      expected: () => ({
        lf: 180,
        sell: 180 * p.gutter.g6.sell + 180 * p.gutter.removalLF + 100 * p.gutter.downspouts['2x3'],
      }),
    },
    {
      name: '6 — 7" gutter, labor and accessories',
      scope: 'gutter',
      gutter: { size: 'g7', lf: 220, mode: 'new', removal: true, guards: true, stories: 2 },
      gutterItems: {
        ds: { meta: { size: '3x4', count: 6, len: 22 }, rate: p.gutter.downspouts['3x4'] },
        miterIn: { qty: 4 },
        miterOut: { qty: 6 },
        endcap: { qty: 8 },
        outlet: { qty: 6 },
        elbow: { qty: 12 },
      },
      expected: () => ({
        lf: 220,
        sell:
          220 * p.gutter.g7.sell +
          220 * p.gutter.removalLF +
          220 * p.gutter.guardLF +
          220 * p.gutter.story2LF +
          (132 * p.gutter.downspouts['3x4'] +
            4 * p.gutter.miterInside +
            6 * p.gutter.miterOutside +
            8 * p.gutter.endCap +
            6 * p.gutter.outlet +
            12 * p.gutter.elbow),
      }),
    },
  ];
}

const ROOFR_SAMPLE =
  'Roof Report 2802 sqft Prepared by Roofr 9 facets Predominant pitch 6/12 1923 Sterling Lane, Fernandina Beach, FL 32034 Eaves: 188ft 7in Valleys: 41ft 2in Hips: 98ft 0in Ridges: 52ft 3in Rakes: 79ft 8in Total roof area: 2802 sqft Pitched roof area: 2197 sqft Flat roof area: 605 sqft Two story area: 0 sqft Hips + ridges 150ft 3in Eaves + rakes 268ft 3in Roofr.com';
const QUICKMEASURE_SAMPLE =
  'Measurements Roof Area 4,697 sq ft Roof Facets 18 Predominant Pitch 7 / 12 Ridges/Hips 270 ft Valleys 108 ft Rakes 111 ft Eaves 338 ft Drip Edge 449 ft Ridge Cap 270 ft Starter 338 ft Penetrations 2 Pitch 7 8 Area 4,637 59';

export const SELF_TEST_REPORT_SAMPLES = { roofr: ROOFR_SAMPLE, quickMeasure: QUICKMEASURE_SAMPLE };

const blankRow = (name: string, pass: boolean, summary: string): SelfTestRow => ({
  name, qty: '', expected: 0, got: 0, cost: 0, grossProfit: 0, margin: 0, markup: 0, pass, summary,
});

export function runSelfTest(pricing: PriceBook): SelfTestResult {
  const rows: SelfTestRow[] = [];
  let passed = 0;
  const cases = selfTestCases(pricing);

  cases.forEach((c) => {
    const t = estimateTotals(buildCase(pricing, c), pricing);
    const exp = c.expected();
    const sellOk = Math.abs(t.sell - round2(exp.sell)) < 0.005;
    const qtyOk = exp.sq !== undefined ? Math.abs(t.roof.billable - round2(exp.sq)) < 0.005 : Math.abs(t.gutter.lf - (exp.lf as number)) < 0.005;
    const mathOk =
      Math.abs(t.grossProfit - round2(t.sell - t.totalCost)) < 0.005 &&
      Math.abs(t.margin - (t.sell ? ((t.sell - t.totalCost) / t.sell) * 100 : 0)) < 1e-4 &&
      Math.abs(t.markup - (t.totalCost ? ((t.sell - t.totalCost) / t.totalCost) * 100 : 0)) < 1e-4;
    const pass = sellOk && qtyOk && mathOk;
    if (pass) passed++;
    rows.push({
      name: c.name,
      qty: exp.sq !== undefined ? round2(exp.sq).toFixed(2) + ' sq' : exp.lf + ' LF',
      expected: exp.sell,
      got: t.sell,
      cost: t.totalCost,
      grossProfit: t.grossProfit,
      margin: t.margin,
      markup: t.markup,
      pass,
    });
  });

  // Solve each case for a set of margins, then re-cost at the solved price:
  // the margin it actually lands at must match the target.
  let solverOk = true;
  const failures: string[] = [];
  cases.forEach((c) => {
    const est = buildCase(pricing, c);
    const cs = costStructure(est, pricing, estimateTotals(est, pricing));
    [0, toNumber(pricing.targets.minMargin), toNumber(pricing.targets.goodMargin), 50].forEach((target) => {
      const price = cs.solve(target / 100);
      if (!isFinite(price)) return;
      const cost = costAtPrice(cs, price);
      const landed = price > 0 ? ((price - cost) / price) * 100 : 0;
      if (Math.abs(landed - target) > 1e-4) {
        solverOk = false;
        failures.push(c.name + ' @ ' + target + '% → ' + landed.toFixed(4) + '%');
      }
    });
  });
  if (solverOk) passed++;
  rows.push(
    blankRow(
      '7 — Cost-to-price solver',
      solverOk,
      cases.length + ' estimates × 4 target margins re-solved and re-costed' + (solverOk ? '' : ' — ' + failures[0]),
    ),
  );

  const s = takeoffFromReportText(ROOFR_SAMPLE);
  const o = takeoffFromReportText(QUICKMEASURE_SAMPLE);
  const parserOk =
    s.ok && s.total === 2802 && s.pitched === 2197 && s.flat === 605 && s.pitch === 6 &&
    Math.abs(s.eaves - 188.58) < 0.01 && Math.abs(s.hipsRidges - 150.25) < 0.01 && Math.abs(s.eavesRakes - 268.25) < 0.01 &&
    o.ok && o.total === 4697 && o.pitch === 7 && o.eaves === 338 && o.hipsRidges === 270 && o.eavesRakes === 449 &&
    o.penetrations === 2;
  if (parserOk) passed++;
  rows.push(blankRow('8 — Roof report parser', parserOk, 'Roofr + GAF QuickMeasure sample text re-parsed, 13 fields checked'));

  return { rows, passed, total: cases.length + 2 };
}
