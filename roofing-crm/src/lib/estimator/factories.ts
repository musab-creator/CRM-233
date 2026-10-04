import type {
  Estimate, EstimateScope, EstimateTakeoff, GutterItemKey, GutterRun, LineItem, PriceBook,
  RoofItemKey, RoofSection,
} from './types';
import {
  DEFAULT_ALLOWANCES, DEFAULT_EXCLUSIONS, DEFAULT_INSURANCE_CONTRACTOR, DEFAULT_INSURANCE_CONTRACTOR_PHONE,
} from './defaults';
import { newId } from './format';

// `n` is the 1-based position, used only for the default name.
export function newRoofSection(pricing: PriceBook, n?: number): RoofSection {
  return {
    id: newId(),
    name: 'Section ' + (n || 1),
    measured: 0,
    waste: pricing.roof.defaultWaste,
    billableOverride: 0,
    mfr: 'IKO',
    tier: 'standard',
    custom: 0,
    product: '',
    color: '',
    pitch: 6,
    stories: 1,
    psMode: 'none',
    psSquares: 0,
  };
}

export function newGutterRun(pricing: PriceBook, n?: number): GutterRun {
  return {
    id: newId(),
    name: 'Run ' + (n || 1),
    size: 'g6',
    lf: 0,
    mode: 'new',
    sellOverride: 0,
    laborRate: pricing.gutter.laborOnly.def,
    color: 'White',
    stories: 1,
    difficult: false,
    removal: false,
    guards: false,
    guardLF: 0,
  };
}

function item<K extends string>(k: K, label: string, unit: string, rate: number, qty = 0, on = false): LineItem<K> {
  return { k, label, unit, qty, rate, on };
}

// A blank estimate numbered "DR-<seq>". It is not saved; saving assigns the
// owner and advances the sequence.
export function newEstimate(pricing: PriceBook, seq: number): Estimate {
  const r = pricing.roof;
  const g = pricing.gutter;
  const roofItems: LineItem<RoofItemKey>[] = [
    item('tearoff', 'Tear-off — additional layers', 'sq', r.tearOffExtraLayer),
    item('decking', 'Decking replacement', 'sheet', r.deckingSheet),
    item('repairs', 'Repairs', 'ea', r.repairEach),
    item('permit', 'Permit', 'ea', r.permit, 1, true),
    item('dumpster', 'Dumpster / debris removal', 'ea', r.dumpster, 1, true),
    item('delivery', 'Material delivery', 'ea', r.delivery, 1, true),
    item('dripedge', 'Drip edge', 'LF', r.dripEdgeLF),
    item('starter', 'Starter course', 'LF', r.starterLF),
    item('ridge', 'Ridge cap', 'LF', r.ridgeCapLF),
    item('valley', 'Valley metal', 'LF', r.valleyLF),
    item('flashing', 'Flashing (wall / counter / step)', 'LF', r.flashingLF),
    item('boots', 'Pipe boots', 'ea', r.pipeBootEach),
    item('vents', 'Ventilation', 'ea', r.ventEach),
    item('skylight', 'Skylights', 'ea', r.skylightEach),
    item('chimney', 'Chimneys', 'ea', r.chimneyEach),
    item('flat', 'Flat-roof section', 'sq', r.flatRoofSq),
  ];
  const gutterItems: LineItem<GutterItemKey>[] = [
    { ...item('ds', 'Downspouts', 'LF', g.downspouts['2x3']), meta: { size: '2x3', count: 0, len: 0 } },
    item('miterIn', 'Inside miters', 'ea', g.miterInside),
    item('miterOut', 'Outside miters', 'ea', g.miterOutside),
    item('endcap', 'End caps', 'ea', g.endCap),
    item('outlet', 'Outlets / drops', 'ea', g.outlet),
    item('elbow', 'Elbows', 'ea', g.elbow),
    item('splash', 'Splash blocks', 'ea', g.splashBlock),
    item('ugd', 'Underground-drain connections', 'ea', g.undergroundEach),
    item('fascia', 'Fascia repair', 'LF', g.fasciaLF),
    item('soffit', 'Soffit repair', 'LF', g.soffitLF),
  ];
  return {
    id: newId(),
    number: 'DR-' + seq,
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    validDays: pricing.targets.quoteValidDays,
    scope: 'both',
    customer: { name: '', address: '', city: '', state: 'FL', zip: '', phone: '', email: '' },
    roof: {
      sections: [newRoofSection(pricing, 1)],
      items: roofItems,
      upgrades: [],
      discounts: [],
      adjustments: [],
      taxOn: r.taxOn,
      taxRate: r.taxRate,
    },
    gutter: {
      runs: [newGutterRun(pricing, 1)],
      items: gutterItems,
      upgrades: [],
      discounts: [],
      adjustments: [],
    },
    costs: { overrides: {}, notes: '' },
    reports: [],
    actuals: {},
    revisions: [],
    proposal: {
      depositPct: pricing.targets.depositPct,
      exclusions: DEFAULT_EXCLUSIONS.slice(),
      allowances: DEFAULT_ALLOWANCES.slice(),
      notes: '',
      contractType: 'cash',
      coverPhoto: '',
      pay: { sign: 0, delivery: 50 },
      deckingAllowance: 85,
      warrantyYears: 10,
      ins: {
        carrier: '',
        claim: '',
        acv: '',
        depreciation: '',
        deductible: '',
        upgradesAmt: '',
        contractor: DEFAULT_INSURANCE_CONTRACTOR,
        contractorPhone: DEFAULT_INSURANCE_CONTRACTOR_PHONE,
      },
    },
  };
}

// "New estimate" with a scope picked up front (Roofing only / Gutters only / both).
export function newEstimateForScope(pricing: PriceBook, seq: number, scope: EstimateScope): Estimate {
  const est = newEstimate(pricing, seq);
  est.scope = scope;
  return est;
}

// The screen an estimate opens on, as the original did: gutter-only jobs on
// the gutter calculator, new roof jobs on the roof calculator, reopened ones
// on the combined page.
export function landingViewFor(est: Estimate, isNew: boolean): 'roof' | 'gutter' | 'combined' {
  if (est.scope === 'gutter') return 'gutter';
  return isNew ? 'roof' : 'combined';
}

const SITE_ITEMS: RoofItemKey[] = ['permit', 'dumpster', 'delivery'];

// The "Competitive bid" worked example on the market benchmark page: a
// 2,000 sq ft single-story IKO Cambridge roof plus 150 LF of 6" gutter.
export function competitiveBidSample(pricing: PriceBook, seq: number): Estimate {
  const est = newEstimate(pricing, seq);
  est.customer = {
    name: 'Sample — Competitive Bid',
    address: '2,000 sq ft single-story',
    city: 'Jacksonville',
    state: 'FL',
    zip: '',
    phone: '',
    email: '',
  };
  Object.assign(est.roof.sections[0], {
    measured: 20,
    waste: 15,
    mfr: 'IKO',
    tier: 'competitive',
    product: 'Cambridge',
    color: 'Weatherwood',
    pitch: 6,
    stories: 1,
    psMode: 'none',
  });
  est.roof.items.forEach((it) => {
    it.on = SITE_ITEMS.includes(it.k);
  });
  Object.assign(est.gutter.runs[0], { size: 'g6', lf: 150, mode: 'new', removal: true, color: 'White', stories: 1 });
  est.gutter.items.forEach((it) => {
    if (it.k === 'ds') {
      it.on = true;
      it.meta = { size: '3x4', count: 5, len: 11 };
      it.rate = pricing.gutter.downspouts['3x4'];
    }
  });
  return est;
}

interface SampleSpec {
  scope?: EstimateScope;
  customer: Partial<Estimate['customer']>;
  sec1: Partial<RoofSection>;
  sec2?: Partial<RoofSection>;
  qty?: Partial<Record<RoofItemKey, number>>;
  on?: RoofItemKey[];
  gutterLF?: number;
  drops?: number;
  takeoff: EstimateTakeoff;
  note?: string;
}

const SAMPLE_SPECS: SampleSpec[] = [
  {
    customer: { name: '1923 Sterling Lane', address: '1923 Sterling Lane', city: 'Fernandina Beach', state: 'FL', zip: '32034' },
    sec1: { measured: 21.97, waste: 15, pitch: 6, stories: 1, mfr: 'IKO', tier: 'standard', product: 'Cambridge' },
    sec2: { measured: 6.05, waste: 10, pitch: 2, stories: 1, mfr: 'IKO', tier: 'standard' },
    qty: { dripedge: 268.25, starter: 268.25, ridge: 150.25, valley: 41.17 },
    gutterLF: 189,
    drops: 5,
    takeoff: {
      vendor: 'Roofr',
      from: 'Roof Report - 1923 Sterling Lane.pdf',
      address: '1923 Sterling Lane, Fernandina Beach, FL 32034',
      total: 2802,
      pitched: 2197,
      flat: 605,
      pitch: 6,
      facets: 9,
      eaves: 188.58,
      eavesRakes: 268.25,
      valleys: 41.17,
      hipsRidges: 150.25,
      penetrations: null,
      waste: 15,
    },
    note: 'Built from the Roofr report (Jul 20, 2026). Flat 605 sq ft priced as its own section. Penetrations not on the report — do the aerial count before sending.',
  },
  {
    customer: { name: 'Jordan Moore', phone: '9043822169', address: '1980 Creekview Court', city: 'Jacksonville', state: 'FL', zip: '32225' },
    sec1: { measured: 33.17, waste: 15, pitch: 5, stories: 1, mfr: 'IKO', tier: 'standard', product: 'Cambridge' },
    sec2: { measured: 3.86, waste: 10, pitch: 0, stories: 1, mfr: 'IKO', tier: 'standard' },
    qty: { dripedge: 310.5, starter: 310.5, ridge: 125.67, valley: 76.75 },
    gutterLF: 158,
    drops: 5,
    takeoff: {
      vendor: 'Roofr',
      from: 'Roof Report - 1980 Creekview Ct.pdf',
      address: '1980 Creekview Court, Jacksonville, FL 32225',
      total: 3704,
      pitched: 3317,
      flat: 386,
      pitch: 5,
      facets: 10,
      eaves: 157.67,
      eavesRakes: 310.5,
      valleys: 76.75,
      hipsRidges: 125.67,
      penetrations: null,
      waste: 15,
    },
    note: "Built from the Roofr report (Jun 16, 2026). 76 LF of valleys — closed-valley waste is real here; Roofr's own table used 11% base. Aerial count pending.",
  },
  {
    customer: { name: '2322 W Clovelly Lane', address: '2322 West Clovelly Lane', city: 'St. Augustine', state: 'FL', zip: '32092' },
    sec1: { measured: 46.97, waste: 14, pitch: 7, stories: 1, mfr: 'OC', tier: 'standard', product: 'TruDefinition Duration' },
    qty: { dripedge: 449, starter: 338, ridge: 270, valley: 108, boots: 2 },
    on: ['boots'],
    gutterLF: 338,
    drops: 8,
    takeoff: {
      vendor: 'GAF QuickMeasure',
      from: 'Roof Report - 2322 W Clovelly Ln.pdf',
      address: '2322 West Clovelly Lane, St. Augustine, FL 32092',
      total: 4697,
      pitched: 4697,
      flat: 0,
      pitch: 7,
      facets: 18,
      eaves: 338,
      eavesRakes: 449,
      valleys: 108,
      hipsRidges: 270,
      penetrations: 2,
      waste: 14,
    },
    note: 'Built from the GAF QuickMeasure report (Apr 27, 2026). 18 facets, 7/12 — the pitch surcharge applies. QuickMeasure counted 2 penetrations; pipe boots pre-loaded.',
  },
];

function buildSample(pricing: PriceBook, seq: number, spec: SampleSpec): Estimate {
  const est = newEstimate(pricing, seq);
  est.status = 'draft';
  est.scope = spec.scope || 'both';
  Object.assign(est.customer, spec.customer);
  Object.assign(est.roof.sections[0], spec.sec1, { name: 'Main roof — from report' });
  if (spec.sec2) {
    est.roof.sections.push(newRoofSection(pricing, 2));
    Object.assign(est.roof.sections[1], spec.sec2, { name: 'Flat / low-slope — from report' });
  }
  est.roof.items.forEach((it) => {
    if (SITE_ITEMS.includes(it.k)) it.on = true;
    if (spec.qty && spec.qty[it.k] !== undefined) {
      it.qty = spec.qty[it.k] as number;
      if (spec.on && spec.on.includes(it.k)) it.on = true;
    }
  });
  if (spec.gutterLF) {
    Object.assign(est.gutter.runs[0], { size: 'g6', lf: spec.gutterLF, mode: 'new', removal: true });
    est.gutter.items.forEach((it) => {
      if (it.k === 'ds') {
        it.on = true;
        it.meta = { size: '3x4', count: spec.drops || 4, len: 11 };
        it.rate = pricing.gutter.downspouts['3x4'];
      }
    });
  }
  est.takeoff = { ...spec.takeoff };
  est.costs.notes = spec.note || '';
  return est;
}

// The three report-built sample estimates a brand-new install is seeded with.
// They are numbered from `seq`; the returned `seq` is the next free number.
export function sampleEstimates(pricing: PriceBook, seq: number): { estimates: Estimate[]; seq: number } {
  const estimates = SAMPLE_SPECS.map((spec, i) => buildSample(pricing, seq + i, spec));
  return { estimates, seq: seq + SAMPLE_SPECS.length };
}
