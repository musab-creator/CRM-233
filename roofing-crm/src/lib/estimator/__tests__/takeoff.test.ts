/* eslint-disable @typescript-eslint/no-explicit-any -- compares against the untyped original */
// Takeoff parity: report text -> takeoff -> "Apply to this estimate", the
// port (CRM parser + applyTakeoff) against the original (its own parser and
// apply function, extracted from estimator.html), on the Roofr and GAF
// QuickMeasure samples and variants of them, across starting estimates.
//
//   node --experimental-strip-types src/lib/estimator/__tests__/takeoff.test.ts
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
const { check, checkEqual, finish } = (await import('./check' as string)) as typeof import('./check');
const E = (await import('../index' as string)) as typeof import('../index');
const src = (await import('./original-source.mjs' as string)) as { loadOriginal: (o: object) => { original: any } };
const { original: O } = src.loadOriginal({});

const { roofr: ROOFR, quickMeasure: QM } = E.SELF_TEST_REPORT_SAMPLES;
const texts: [string, string][] = [
  ['Roofr sample', ROOFR],
  ['QuickMeasure sample', QM],
  ['Roofr, two-story area', ROOFR.replace('Two story area: 0 sqft', 'Two story area: 840 sqft')],
  ['Roofr, small flat area', ROOFR.replace('Flat roof area: 605 sqft', 'Flat roof area: 40 sqft')],
  ['Roofr, no combined lines', ROOFR.replace(/Hips \+ ridges [^ ]+ [^ ]+ /, '').replace(/Eaves \+ rakes [^ ]+ [^ ]+ /, '')],
  ['Roofr, 16 facets, steep', ROOFR.replace('9 facets', '16 facets').replace('Predominant pitch 6/12', 'Predominant pitch 11/12')],
  ['QuickMeasure, no penetrations', QM.replace('Penetrations 2 ', '')],
  ['QuickMeasure, zero penetrations', QM.replace('Penetrations 2', 'Penetrations 0')],
  ['QuickMeasure, low-slope table', QM.replace('Pitch 7 8 Area 4,637 59', 'Pitch 7 2 1 Area 4,000 500 197')],
  ['QuickMeasure, no drip edge line', QM.replace('Drip Edge 449 ft ', '')],
];

type Setup = [string, (est: any) => void];
const setups: Setup[] = [
  ['blank estimate', () => {}],
  ['roof only', (e) => (e.scope = 'roof')],
  ['gutter only', (e) => (e.scope = 'gutter')],
  ['customer filled in', (e) => Object.assign(e.customer, { address: '9 Elm St', city: 'Yulee' })],
  ['gutter LF already entered', (e) => (e.gutter.runs[0].lf = 120)],
  ['two sections already', (e) => {
    e.roof.sections.push({ ...e.roof.sections[0], id: 'second', name: 'Garage', measured: 4, pitch: 4 });
  }],
];

const fields = ['vendor', 'address', 'total', 'pitched', 'flat', 'pitch', 'twoStoryArea', 'eaves', 'rakes', 'valleys', 'hipsRidges', 'eavesRakes', 'facets', 'penetrations', 'waste', 'ok'];
const pickFields = (t: any) => Object.fromEntries(fields.map((f) => [f, t[f]]));
// Sections the apply step creates get fresh random ids.
const normalize = (est: any) =>
  JSON.parse(JSON.stringify(est), (k, v) => (k === 'id' && typeof v === 'string' && v !== 'second' ? '<id>' : v));

const pricing = E.defaultPriceBook();
let applied = 0;
for (const [name, text] of texts) {
  const theirs = O.parseReport(text);
  const mine = E.takeoffFromReportText(text);
  checkEqual(pickFields(mine), pickFields(theirs), `${name}: parsed takeoff`);
  for (const [setupName, setup] of setups) {
    const base = E.newEstimate(pricing, 1001);
    setup(base);
    const a = JSON.parse(JSON.stringify(base));
    const b = JSON.parse(JSON.stringify(base));
    E.applyTakeoff(a, pricing, mine, { from: 'Roof Report.pdf' });
    O.applyTakeoff(b, pricing, { name: 'Roof Report.pdf' }, theirs);
    checkEqual(normalize(a), normalize(b), `${name} / ${setupName}: applied estimate`);
    checkEqual(E.estimateTotals(a, pricing).sell, O.totals(b, pricing).sell, `${name} / ${setupName}: sell`);
    applied++;
  }
}

// Flashing: the CRM parser reads wall + step flashing; the original never did.
// It is loaded onto the flashing item (left switched off); nothing else changes.
{
  const text = ROOFR.replace('Roofr.com', 'Wall flashing: 22ft 6in Step flashing: 18ft Roofr.com');
  const mine = E.takeoffFromReportText(text);
  check(mine.flashing === 40.5, 'flashing read from a Roofr report');
  const a = E.applyTakeoff(E.newEstimate(pricing, 1), pricing, mine, { from: 'x.pdf' });
  const b = O.newEstimate(pricing, 1);
  O.applyTakeoff(b, pricing, { name: 'x.pdf' }, O.parseReport(text));
  const flashing = a.roof.items.find((i) => i.k === 'flashing');
  check(flashing?.qty === 40.5 && flashing?.on === false, 'flashing quantity loaded, item left off');
  b.roof.items.find((i: any) => i.k === 'flashing').qty = 40.5;
  checkEqual(normalize(a), normalize(b), 'flashing is the only difference from the original');
}

// takeoffFromRoofReport maps the CRM's saved RoofReport.
{
  const parsed = E.takeoffFromReportText(QM);
  const report = {
    id: 'r1', address: '2322 West Clovelly Lane', city: 'St. Augustine', state: 'FL', zip: '32092',
    source: 'gaf_quickmeasure' as const, fileName: 'qm.pdf', createdAt: '2026-04-27T10:00:00Z', createdBy: 'u1', estimates: [],
    measurements: {
      totalSqFt: parsed.total, pitchedSqFt: parsed.pitched, flatSqFt: parsed.flat, twoStorySqFt: 0, pitch: parsed.pitch,
      facets: parsed.facets, eaves: parsed.eaves, rakes: parsed.rakes, valleys: parsed.valleys, hipsRidges: parsed.hipsRidges,
      eavesRakes: parsed.eavesRakes, flashing: 12, penetrations: parsed.penetrations, wastePct: parsed.waste,
    },
  };
  const t = E.takeoffFromRoofReport(report);
  checkEqual(
    { ...pickFields(t), address: '' },
    { ...pickFields(parsed), address: '' },
    'takeoffFromRoofReport carries the measurements',
  );
  check(t.address === '2322 West Clovelly Lane, St. Augustine, FL 32092' && t.flashing === 12, 'takeoffFromRoofReport address and flashing');
  check(E.roofReportSourceName(report) === 'qm.pdf', 'source name prefers the file name');
  check(E.roofReportSourceName({ ...report, fileName: undefined, orderId: '77' }) === 'GAF QuickMeasure order 77', 'source name from order id');
}

console.log(`  ${texts.length} report texts × ${setups.length} starting estimates = ${applied} applications compared`);
finish('takeoff');
