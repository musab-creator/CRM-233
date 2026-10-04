import type { RoofReport } from '@/types';
import { round2, SOURCE_LABELS } from '@/lib/roof-report';

// Hands a roof report to the Diversity Roofing Estimator
// (public/tools/estimator.html) without modifying the estimator itself.
//
// The estimator is served from the CRM's own origin, so both share
// localStorage and (inside the same tab, including iframes) sessionStorage.
// It already exposes two hooks we rely on:
//   - localStorage "dr_estimator_v1": its saved state ({ pricing, estimates, seq, ... })
//   - sessionStorage "dr_resume": read once on boot; { est, view } opens that
//     estimate on that screen
// We build an estimate the same way the estimator's own "Apply to this
// estimate" button does, save it into its list, then point dr_resume at it.
//
// If the estimator is upgraded, re-check these keys and the estimate shape
// against its source before relying on this.

export const ESTIMATOR_URL = '/tools/estimator.html';
const STATE_KEY = 'dr_estimator_v1';
const SESSION_KEY = 'dr_session';
const RESUME_KEY = 'dr_resume';

type Json = Record<string, unknown>;

// Defaults copied from the estimator's built-in price book. Only the fields a
// new estimate reads are needed; a manager's saved pricing overrides them.
const DEFAULT_PRICING = {
  targets: { quoteValidDays: 30, depositPct: 50 },
  roof: {
    defaultWaste: 15,
    tearOffExtraLayer: 45,
    deckingSheet: 95,
    repairEach: 150,
    permit: 350,
    dumpster: 600,
    delivery: 150,
    dripEdgeLF: 3.5,
    starterLF: 2.25,
    ridgeCapLF: 7,
    valleyLF: 8.5,
    flashingLF: 9,
    pipeBootEach: 85,
    ventEach: 145,
    skylightEach: 650,
    chimneyEach: 750,
    flatRoofSq: 850,
    taxRate: 0,
    taxOn: 'none',
  },
  gutter: {
    laborOnly: { def: 4.5 },
    downspouts: { '2x3': 9 } as Record<string, number>,
    miterInside: 35,
    miterOutside: 35,
    endCap: 8,
    outlet: 12,
    elbow: 12,
    splashBlock: 25,
    undergroundEach: 185,
    fasciaLF: 14,
    soffitLF: 12,
  },
};
type Pricing = typeof DEFAULT_PRICING;

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base } as Json;
  for (const [k, v] of Object.entries(over as Json)) {
    const b = (base as Json)[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
        ? deepMerge(b, v)
        : v;
  }
  return out as T;
}

const uid = () => Math.random().toString(36).slice(2, 10);

function readJson(storage: Storage, key: string): Json | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as Json) : null;
  } catch {
    return null;
  }
}

function newSection(p: Pricing, n: number) {
  return {
    id: uid(),
    name: 'Section ' + n,
    measured: 0,
    waste: p.roof.defaultWaste,
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

// Mirrors the estimator's new-estimate factory.
function newEstimate(p: Pricing, seq: number) {
  const r = p.roof;
  const g = p.gutter;
  const now = new Date().toISOString();
  const item = (k: string, label: string, unit: string, rate: number, qty = 0, on = false) => ({
    k, label, unit, qty, rate, on,
  });
  return {
    id: uid(),
    number: 'DR-' + seq,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    date: now.slice(0, 10),
    validDays: p.targets.quoteValidDays,
    scope: 'both',
    customer: { name: '', address: '', city: '', state: 'FL', zip: '', phone: '', email: '' },
    roof: {
      sections: [newSection(p, 1)],
      items: [
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
      ],
      upgrades: [],
      discounts: [],
      adjustments: [],
      taxOn: r.taxOn,
      taxRate: r.taxRate,
    },
    gutter: {
      runs: [
        {
          id: uid(), name: 'Run 1', size: 'g6', lf: 0, mode: 'new', sellOverride: 0,
          laborRate: g.laborOnly.def, color: 'White', stories: 1,
          difficult: false, removal: false, guards: false, guardLF: 0,
        },
      ],
      items: [
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
      ],
      upgrades: [],
      discounts: [],
      adjustments: [],
    },
    costs: { overrides: {}, notes: '' },
    reports: [],
    actuals: {},
    revisions: [],
    proposal: {
      depositPct: p.targets.depositPct,
      exclusions: [
        'Structural repair, truss or rafter work, and any concealed damage discovered after tear-off',
        'Mold, asbestos, or other hazardous-material remediation',
        'Interior repairs, painting, or drywall',
        'Solar panel detach and reset unless listed as a line item',
        'Permit fees beyond the allowance shown, and any engineering required by the building department',
        'Landscaping restoration and driveway protection beyond normal care',
      ],
      allowances: [
        'Decking replacement is billed per sheet at the rate shown; only sheets actually replaced are charged',
        'Rotted fascia or sub-fascia discovered at tear-off is billed at the per-foot rate shown',
        "Permit allowance is an estimate; the actual municipal fee is billed at cost if it exceeds the allowance",
      ],
      notes: '',
      contractType: 'cash',
      coverPhoto: '',
      pay: { sign: 0, delivery: 50 },
      deckingAllowance: 85,
      warrantyYears: 10,
      ins: {
        carrier: '', claim: '', acv: '', depreciation: '', deductible: '', upgradesAmt: '',
        contractor: 'Diversity Contracting', contractorPhone: '904-979-0556',
      },
    },
  };
}

export interface HandoffCustomer {
  name: string;
  phone?: string;
  email?: string;
}

export interface HandoffResult {
  number: string;
}

// Builds the estimate, saves it into the estimator's list and queues it to
// open. Call, then navigate to the estimator in the same tab.
export function sendReportToEstimator(report: RoofReport, customer: HandoffCustomer): HandoffResult {
  const stored = readJson(localStorage, STATE_KEY);
  const pricing = deepMerge(DEFAULT_PRICING, stored?.pricing);
  const seq = Number(stored?.seq) || 1001;
  const est = newEstimate(pricing, seq);
  const m = report.measurements;

  Object.assign(est.customer, {
    name: customer.name || report.address,
    address: report.address,
    city: report.city,
    state: report.state || 'FL',
    zip: report.zip,
    phone: customer.phone || '',
    email: customer.email || '',
  });

  // Same mapping as the estimator's "Apply to this estimate".
  const main = est.roof.sections[0];
  Object.assign(main, {
    name: 'Main roof — from report',
    measured: round2((m.pitchedSqFt || m.totalSqFt) / 100),
    waste: m.wastePct,
    pitch: Math.max(0, Math.min(12, Math.round(m.pitch))),
    stories: m.twoStorySqFt > 0 ? 2 : 1,
  });
  if (m.flatSqFt > 50) {
    est.roof.sections.push({
      ...newSection(pricing, 2),
      name: 'Flat / low-slope — from report',
      measured: round2(m.flatSqFt / 100),
      waste: 10,
      pitch: 0,
      stories: main.stories,
    });
  }
  const setQty = (k: string, qty: number, on?: boolean) => {
    const it = est.roof.items.find((i) => i.k === k);
    if (!it) return;
    it.qty = round2(qty);
    if (on !== undefined) it.on = on;
  };
  setQty('dripedge', m.eavesRakes);
  setQty('starter', m.eavesRakes);
  setQty('ridge', m.hipsRidges);
  setQty('valley', m.valleys);
  if (m.penetrations !== null) setQty('boots', m.penetrations, m.penetrations > 0);
  if (m.eaves > 0) est.gutter.runs[0].lf = Math.round(m.eaves);

  const from =
    report.fileName ||
    (report.orderId ? `${SOURCE_LABELS[report.source]} order ${report.orderId}` : SOURCE_LABELS[report.source]);
  const takeoff = {
    vendor: SOURCE_LABELS[report.source],
    from,
    address: [report.address, report.city, `${report.state} ${report.zip}`.trim()].filter(Boolean).join(', '),
    total: m.totalSqFt,
    pitched: m.pitchedSqFt,
    flat: m.flatSqFt,
    pitch: m.pitch,
    facets: m.facets,
    eaves: m.eaves,
    eavesRakes: m.eavesRakes,
    valleys: m.valleys,
    hipsRidges: m.hipsRidges,
    penetrations: m.penetrations,
    waste: m.wastePct,
  };
  const notes = [
    `Built from the CRM roof report (${from}, ${report.createdAt.slice(0, 10)}).`,
    report.simulated ? 'SIMULATED measurements from a mocked provider — do not send this estimate until a real report replaces them.' : '',
    m.penetrations === null ? 'Penetrations not on the report — do the aerial count before sending.' : '',
  ].filter(Boolean).join(' ');

  // Owner follows the estimator's signed-in profile so a rep can see it in their list.
  const session = readJson(localStorage, SESSION_KEY);
  const isRep = session?.role === 'rep';
  const full = {
    ...est,
    takeoff,
    costs: { ...est.costs, notes },
    ownerId: isRep ? session?.profileId : 'mgr',
    ownerName: (session?.name as string) || 'Manager',
  };

  const state: Json = stored ?? {
    audit: [],
    estimates: [],
    seq,
    user: { name: 'Manager', role: 'admin' },
    auth: { pin: '' },
    profiles: [],
    theme: 'system',
  };
  state.estimates = [full, ...((state.estimates as unknown[]) || [])];
  state.seq = seq + 1;
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  sessionStorage.setItem(RESUME_KEY, JSON.stringify({ est: full, view: 'combined' }));

  return { number: full.number };
}
