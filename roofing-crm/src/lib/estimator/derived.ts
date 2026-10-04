import type {
  AuditEntry, CostKey, Estimate, EstimateScope, EstimateStatus, EstimateTotals, GutterRun, MarginTarget,
  PriceBook, RoofItemKey, RoofSection, Tone,
} from './types';
import {
  billableSquares, costAtPrice, costStructure, estimateTotals, gutterRunRate, hasCostOverride, peelStickSquares,
  pitchSurchargePerSquare, priceForMargin, sectionPricePerSquare, storySurchargePerSquare,
} from './calc';
import { addDays, formatMoney, round2, toNumber } from './format';
import { isPricingStale, pricingAgeDays } from './warnings';

// Figures the original estimator's screens computed inline, pulled out so
// the CRM's screens show the same numbers. Each notes the screen it came from.

// ==================== MARGIN & COST HEALTH ====================

// Margin badge colour: healthy (ok), above the floor (warn), below it (bad).
export function marginTone(margin: number, pricing: PriceBook): 'ok' | 'warn' | 'bad' {
  return margin >= toNumber(pricing.targets.goodMargin) ? 'ok' : margin >= toNumber(pricing.targets.minMargin) ? 'warn' : 'bad';
}

// Cost as a fraction of the selling price (0 when nothing is sold). "Cost ÷ price".
export function costToPriceRatio(totals: EstimateTotals): number {
  return totals.sell ? totals.totalCost / totals.sell : 0;
}

// Job cost "Cost against price" badge: <= 70% ok, <= 80% warn, else bad.
export function costRatioTone(ratio: number): 'ok' | 'warn' | 'bad' {
  return ratio <= 0.7 ? 'ok' : ratio <= 0.8 ? 'warn' : 'bad';
}

// ==================== WHAT IT HAS TO SELL FOR ====================

// Live summary panel (managers): break even, floor and healthy-margin prices.
// Null when nothing is priced yet or a target cannot be reached.
export function sellForTargets(est: Estimate, pricing: PriceBook, totals: EstimateTotals) {
  if (totals.sell <= 0) return null;
  const breakEven = priceForMargin(est, pricing, totals, 0);
  const atMin = priceForMargin(est, pricing, totals, pricing.targets.minMargin);
  const atGood = priceForMargin(est, pricing, totals, pricing.targets.goodMargin);
  if (!breakEven || !atMin || !atGood) return null;
  return {
    breakEven,
    atMin,
    atGood,
    belowMin: totals.sell < atMin.price, // shown in bad
    belowGood: totals.sell < atGood.price, // shown in warn
    perSquareAtGood: totals.roof.billable > 0 ? atGood.perSquare : null,
    perLFAtGood: totals.gutter.lf > 0 ? atGood.perLF : null,
  };
}

export interface MarginLadderRow {
  target: MarginTarget;
  covered: boolean; // this estimate's price already reaches it
}

// Job cost "What it has to sell for" table: break even, floor, healthy, 50%, 60%.
export function marginLadder(est: Estimate, pricing: PriceBook, totals: EstimateTotals): MarginLadderRow[] {
  const margins = [0, toNumber(pricing.targets.minMargin), toNumber(pricing.targets.goodMargin), 50, 60];
  const rows: MarginLadderRow[] = [];
  margins.forEach((m) => {
    const target = priceForMargin(est, pricing, totals, m);
    if (target) rows.push({ target, covered: totals.sell >= target.price });
  });
  return rows;
}

export interface PriceScenario {
  changePct: number; // −5, 0, +5, +10
  price: number;
  cost: number; // overhead, financing and commission re-costed at this price
  profit: number;
  margin: number;
}

// Combined page "Price scenarios" (managers): the job re-costed at other prices.
export function priceScenarios(
  est: Estimate, pricing: PriceBook, totals: EstimateTotals, changes: number[] = [-5, 0, 5, 10],
): PriceScenario[] | null {
  if (totals.sell <= 0) return null;
  const cs = costStructure(est, pricing, totals);
  return changes.map((changePct) => {
    const price = round2(totals.sell * (1 + changePct / 100));
    const cost = round2(costAtPrice(cs, price));
    const profit = round2(price - cost);
    return { changePct, price, cost, profit, margin: price > 0 ? (profit / price) * 100 : 0 };
  });
}

// ==================== BREAKDOWN CHARTS ====================

export interface Segment {
  label: string;
  value: number;
}

// Combined page "Where the price goes". `overshoot` is how far the segments
// exceed the price (discounts are not a segment); the original flags it above $0.01.
export function priceBreakdown(totals: EstimateTotals): { segments: Segment[]; total: number; overshoot: number } | null {
  if (totals.sell <= 0) return null;
  const sections = totals.roof.sections;
  const base = sections.reduce((acc, s) => acc + s.base, 0);
  const pitchStory = sections.reduce((acc, s) => acc + s.pitchAmt + s.storyAmt, 0);
  const ps = sections.reduce((acc, s) => acc + s.psAmt, 0);
  const rest = Math.max(0, totals.roof.subtotal - base - pitchStory - ps);
  const segments: Segment[] = [
    { label: 'Roof base', value: round2(base) },
    { label: 'Pitch & story', value: round2(pitchStory) },
    { label: 'Peel-and-stick', value: round2(ps) },
    { label: 'Roof line items & upgrades', value: round2(rest) },
    { label: 'Gutters', value: round2(totals.gutter.subtotal) },
  ];
  const total = segments.reduce((acc, s) => acc + s.value, 0);
  return { segments, total, overshoot: Math.max(0, total - totals.sell) };
}

// Combined page "The selling price, split into cost and profit" (managers).
// `loss` is set when gross profit is negative.
export function costProfitSplit(totals: EstimateTotals): { segments: Segment[]; loss: number } | null {
  if (totals.sell <= 0 || totals.totalCost <= 0) return null;
  const c = totals.costs;
  return {
    segments: [
      { label: 'Material', value: round2(toNumber(c.material)) },
      { label: 'Labor', value: round2(toNumber(c.labor)) },
      {
        label: 'Site costs — dumpster, permit, delivery, repairs, decking',
        value: round2(toNumber(c.dumpster) + toNumber(c.permit) + toNumber(c.delivery) + toNumber(c.repairs) + toNumber(c.decking)),
      },
      { label: 'Gutter cost', value: round2(toNumber(c.gutter)) },
      {
        label: 'Overhead, commission & fees',
        value: round2(toNumber(c.overhead) + toNumber(c.commission) + toNumber(c.financing) + toNumber(c.other)),
      },
      { label: 'Gross profit', value: round2(Math.max(0, totals.grossProfit)) },
    ],
    loss: totals.grossProfit < 0 ? -totals.grossProfit : 0,
  };
}

// Breakdown bars hide slivers under 0.4% of the total.
export function visibleSegments(segments: Segment[], total: number): Segment[] {
  return segments.filter((s) => s.value > 0.004 * total && s.value > 0);
}

// ==================== INTERNAL COST TABLE ====================

export interface CostRow {
  key: CostKey;
  label: string;
  auto: number; // what the rules produce
  override: number | null; // the manager's override, null when blank
  used: number;
  note?: string;
}

// Combined page "Internal estimated cost" (managers): auto vs override per element.
export function costRows(est: Estimate, pricing: PriceBook, totals: EstimateTotals): CostRow[] {
  const ov = est.costs.overrides || {};
  const c = pricing.cost;
  const { roof, gutter, autoCosts: auto } = totals;
  const row = (key: CostKey, label: string, autoValue: number, note?: string): CostRow => {
    const set = hasCostOverride(ov, key);
    return { key, label, auto: autoValue, override: set ? toNumber(ov[key]) : null, used: set ? toNumber(ov[key]) : autoValue, note };
  };
  const materialNote = roof.billable
    ? `${roof.billable.toFixed(2)} sq × ${formatMoney(c.materialPerSq)}/sq` +
      (roof.psSquares ? ' + ' + roof.psSquares.toFixed(2) + ' sq peel-and-stick × ' + formatMoney(c.peelStickPerSq) : '')
    : undefined;
  const laborNote = roof.billable
    ? `${roof.billable.toFixed(2)} sq × ${formatMoney(c.laborPerSq)}/sq` +
      (roof.twoStorySq ? ' + 2-story ' + roof.twoStorySq.toFixed(2) + ' sq × ' + formatMoney(c.story2PerSq) : '') +
      (roof.steepSqPoints && toNumber(c.steepPerSq)
        ? ' + steep ' + roof.steepSqPoints.toFixed(1) + ' pitch-squares × ' + formatMoney(c.steepPerSq)
        : '')
    : undefined;
  return [
    row('material', 'Material cost', auto.material, materialNote),
    row('labor', 'Labor cost', auto.labor, laborNote),
    row('dumpster', 'Dumpster', auto.dumpster),
    row('permit', 'Permit', auto.permit,
      `${formatMoney(c.permitService)} service + ${formatMoney(c.permitFee)} municipal fee + ${formatMoney(c.noc)} NOC`),
    row('delivery', 'Delivery', auto.delivery, `${formatMoney(c.delivery)} incl. fuel surcharge`),
    row('repairs', 'Repairs', auto.repairs),
    row('decking', 'Decking', auto.decking, `${formatMoney(c.deckingSheet)} per sheet installed`),
    row('gutter', 'Gutter cost', auto.gutter, gutter.lf ? `${gutter.lf.toFixed(0)} LF of gutter plus accessories` : undefined),
    row('commission', 'Sales commission',
      c.commissionBasis === 'profit' ? totals.costs.commission : round2((totals.sell * toNumber(c.commissionPct)) / 100),
      c.commissionBasis === 'profit' ? `${c.commissionPct}% of job profit` : `${c.commissionPct}% of contract`),
    row('overhead', 'Overhead',
      c.overheadBasis === 'flat' ? toNumber(c.overheadFlat) : round2((totals.sell * toNumber(c.overheadPct)) / 100),
      c.overheadBasis === 'flat' ? `Flat ${formatMoney(c.overheadFlat)} per job` : `${c.overheadPct}% of contract`),
    row('financing', 'Financing / card fees', round2((totals.sell * toNumber(c.financingPct)) / 100), `${c.financingPct}% of contract`),
    row('other', 'Other expenses', 0),
  ];
}

export interface CostAgainstPriceRow {
  label: string;
  amount: number;
  perSquare: number | null; // null when there are no billable squares
  perLF: number | null; // null when there is no gutter footage
}

// Combined / job cost "Cost against price" table (managers), unrounded per-unit figures.
export function costAgainstPrice(est: Estimate, pricing: PriceBook, totals: EstimateTotals) {
  const cs = costStructure(est, pricing, totals);
  const sq = totals.roof.billable;
  const lf = totals.gutter.lf;
  const row = (label: string, amount: number, perSquare = amount / sq, perLF = amount / lf): CostAgainstPriceRow => ({
    label,
    amount,
    perSquare: sq > 0 ? perSquare : null,
    perLF: lf > 0 ? perLF : null,
  });
  const c = pricing.cost;
  const overheadBasis = cs.overheadRate
    ? toNumber(c.overheadPct) + '% of the selling price'
    : c.overheadBasis === 'flat'
      ? formatMoney(c.overheadFlat) + ' flat'
      : 'manual';
  const commissionBasis = cs.mode === 'profit'
    ? ` — ${toNumber(c.commissionPct)}% of profit`
    : c.commissionBasis === 'contract'
      ? ` — ${toNumber(c.commissionPct)}% of contract`
      : '';
  const rows: CostAgainstPriceRow[] = [
    row('Direct job cost — material, labor, dumpster, permit, delivery, repairs, decking, gutters', cs.direct),
    row('Overhead — ' + overheadBasis, totals.costs.overhead),
    row('Sales commission' + commissionBasis, totals.costs.commission),
  ];
  if (toNumber(totals.costs.financing)) rows.push(row('Financing / card fees', totals.costs.financing));
  rows.push(row('Real cost, all in', totals.totalCost));
  rows.push(row('Selling price on this estimate', totals.sell, totals.effectivePerSquare, totals.effectivePerLF));
  const ratio = costToPriceRatio(totals);
  return { rows, ratio, tone: costRatioTone(ratio) };
}

// ==================== ACTUAL JOB COST ====================

// Combined page "Actual job cost" (managers), once actuals are entered.
export function jobActuals(est: Estimate, totals: EstimateTotals, pricing: PriceBook) {
  const a = est.actuals || {};
  const actualCost = (['material', 'labor', 'other'] as const).reduce((acc, k) => acc + toNumber(a[k]), 0);
  const kept = round2(totals.sell - actualCost);
  const actualMargin = totals.sell > 0 ? (kept / totals.sell) * 100 : 0;
  return {
    isClosed: est.status === 'accepted' || est.status === 'completed', // actuals are meant for sold jobs
    hasActuals: actualCost > 0,
    actualCost,
    kept,
    actualMargin,
    estimatedMargin: totals.margin,
    underEstimate: actualCost <= totals.totalCost,
    variance: Math.abs(actualCost - totals.totalCost), // shown "−" when under, "+" when over
    tone: (actualMargin >= toNumber(pricing.targets.minMargin) ? 'ok' : 'bad') as Tone,
  };
}

export interface EstimateVsActualRow {
  estimate: Estimate;
  contract: number;
  estimatedCost: number;
  actualCost: number;
  underEstimate: boolean;
  variance: number; // absolute difference
  estimatedMargin: number;
  actualMargin: number;
}

// Historical pricing "Estimate vs actual": every estimate with actuals recorded.
export function estimateVsActual(estimates: Estimate[], pricing: PriceBook): EstimateVsActualRow[] {
  return estimates
    .filter((e) => {
      const a = e.actuals || {};
      return toNumber(a.material) + toNumber(a.labor) + toNumber(a.other) > 0;
    })
    .map((estimate) => {
      const t = estimateTotals(estimate, pricing);
      const a = estimate.actuals;
      const actualCost = toNumber(a.material) + toNumber(a.labor) + toNumber(a.other);
      return {
        estimate,
        contract: t.sell,
        estimatedCost: t.totalCost,
        actualCost,
        underEstimate: actualCost <= t.totalCost,
        variance: Math.abs(actualCost - t.totalCost),
        estimatedMargin: t.margin,
        actualMargin: t.sell > 0 ? ((t.sell - actualCost) / t.sell) * 100 : 0,
      };
    });
}

// ==================== DASHBOARD ====================

// Dashboard tiles and the pipeline bar, over the estimates the viewer can see.
export function dashboardStats(estimates: Estimate[], pricing: PriceBook, now: number = Date.now()) {
  const rows = estimates.map((estimate) => ({ estimate, totals: estimateTotals(estimate, pricing) }));
  const open = rows.filter((r) => r.estimate.status === 'draft' || r.estimate.status === 'sent');
  const sold = rows.filter((r) => r.estimate.status === 'accepted');
  const pipeline = open.reduce((acc, r) => acc + r.totals.sell, 0);
  const soldTotal = sold.reduce((acc, r) => acc + r.totals.sell, 0);
  const soldProfit = sold.reduce((acc, r) => acc + r.totals.grossProfit, 0);
  const averageMargin = rows.length ? rows.reduce((acc, r) => acc + r.totals.margin, 0) / rows.length : 0;
  const belowTarget = rows.filter((r) => r.totals.margin < toNumber(pricing.targets.minMargin) && r.totals.sell > 0);
  const byStatus: Record<string, number> = { draft: 0, sent: 0, accepted: 0, lost: 0 };
  rows.forEach((r) => {
    byStatus[r.estimate.status] = (byStatus[r.estimate.status] || 0) + r.totals.sell;
  });
  const statusTotal = Object.values(byStatus).reduce((acc, v) => acc + v, 0);
  return {
    rows,
    openCount: open.length,
    pipeline,
    soldCount: sold.length,
    soldTotal,
    soldProfit,
    soldMargin: soldTotal ? (soldProfit / soldTotal) * 100 : null,
    averageMargin: rows.length ? averageMargin : null,
    belowTarget: belowTarget.map((r) => r.estimate),
    // Pipeline bar segments, by status.
    statusSegments: [
      { status: 'draft', label: 'Draft', value: round2(byStatus.draft || 0) },
      { status: 'sent', label: 'Sent', value: round2(byStatus.sent || 0) },
      { status: 'accepted', label: 'Accepted', value: round2(byStatus.accepted || 0) },
      { status: 'lost', label: 'Lost', value: round2(byStatus.lost || 0) },
    ],
    statusTotal,
    pricingAgeDays: pricingAgeDays(pricing, now),
    pricingStale: isPricingStale(pricing, now),
  };
}

// ==================== ESTIMATE SCREENS ====================

// The estimate's step bar: which steps exist for its scope and which are done.
export function estimateSteps(est: Estimate, totals: EstimateTotals, currentView?: string) {
  const customerDone = !!(est.customer.name || est.customer.address);
  const roofDone = est.scope === 'gutter' || totals.roof.billable > 0;
  const gutterDone = est.scope === 'roof' || totals.gutter.lf > 0;
  const steps = [{ view: 'combined', n: '1', label: 'Customer & scope', done: customerDone, active: false }];
  if (est.scope !== 'gutter') steps.push({ view: 'roof', n: '2', label: 'Roof', done: roofDone, active: currentView === 'roof' });
  if (est.scope !== 'roof') steps.push({ view: 'gutter', n: '3', label: 'Gutters', done: gutterDone, active: currentView === 'gutter' });
  steps.push({
    view: 'combined', n: '4', label: 'Review & price', done: customerDone && roofDone && gutterDone, active: currentView === 'combined',
  });
  return steps;
}

// Roof calculator section card. Its "Section total" is the unrounded sum of
// the parts (the estimate totals round each part first, which can differ by a cent).
export function sectionPreview(pricing: PriceBook, sec: RoofSection) {
  const m = pricing.mfrs[sec.mfr];
  const billable = billableSquares(sec);
  const price = sectionPricePerSquare(pricing, sec.mfr, sec.tier, sec.custom);
  const pitchSurcharge = pitchSurchargePerSquare(pricing, sec.pitch);
  const storySurcharge = storySurchargePerSquare(pricing, sec.stories);
  const psSquares = peelStickSquares(sec, billable);
  const peelStickRate = toNumber(pricing.roof.peelStick);
  return {
    billable,
    price,
    pitchSurcharge,
    storySurcharge,
    psSquares,
    peelStickRate,
    total: billable * price + billable * pitchSurcharge + billable * storySurcharge + psSquares * peelStickRate,
    // Custom price outside the approved range: 'below' blocks, 'above' cautions.
    outOfRange: sec.tier === 'custom' && m
      ? price < toNumber(m.min) ? 'below' as const : price > toNumber(m.max) ? 'above' as const : null
      : null,
  };
}

// Gutter calculator run card; total is the unrounded sum like the original.
export function gutterRunPreview(pricing: PriceBook, run: GutterRun) {
  const g = pricing.gutter;
  const rate = gutterRunRate(pricing, run);
  const lf = round2(run.lf);
  const guardLF = run.guards ? (toNumber(run.guardLF) > 0 ? round2(run.guardLF) : lf) : 0;
  const removal = run.removal ? lf * toNumber(g.removalLF) : 0;
  const guards = guardLF * toNumber(g.guardLF);
  const story = toNumber(run.stories) >= 2 ? lf * toNumber(g.story2LF) : 0;
  const difficult = run.difficult ? lf * toNumber(g.difficultLF) : 0;
  const minimum = run.mode === 'labor' ? toNumber(g.laborOnly.min) : toNumber(g[run.size]?.min);
  return {
    lf,
    rate,
    base: lf * rate,
    removal,
    guardLF,
    guards,
    story,
    difficult,
    total: lf * rate + removal + guards + story + difficult,
    minimum,
    belowMinimum: rate < minimum,
  };
}

// The most a 12/12 roof adds per square under the current rules (admin page).
export function maxPitchSurcharge(pricing: PriceBook): number {
  return Math.max(0, 12 - toNumber(pricing.roof.pitchFreeUpTo)) * toNumber(pricing.roof.pitchStep);
}

// Aerial accessory count (boots, vents, skylights, chimneys): sets the
// count as a whole number and switches the item on when it is above zero.
export function setAccessoryCount(est: Estimate, key: RoofItemKey, count: unknown): void {
  const it = est.roof.items.find((i) => i.k === key);
  if (!it) return;
  it.qty = Math.max(0, Math.round(toNumber(count)));
  it.on = it.qty > 0;
}

export const AERIAL_COUNT_ITEMS: { key: RoofItemKey; label: string; rate: keyof PriceBook['roof'] }[] = [
  { key: 'boots', label: 'Pipe boots', rate: 'pipeBootEach' },
  { key: 'vents', label: 'Vents / off-ridge', rate: 'ventEach' },
  { key: 'skylight', label: 'Skylights', rate: 'skylightEach' },
  { key: 'chimney', label: 'Chimneys', rate: 'chimneyEach' },
];

// Changing the downspout size also reprices the downspout line.
export function setDownspoutSize(est: Estimate, size: string, pricing: PriceBook): void {
  const it = est.gutter.items.find((i) => i.k === 'ds');
  if (!it) return;
  it.meta = { ...(it.meta || { size, count: 0, len: 0 }), size };
  it.rate = toNumber(pricing.gutter.downspouts[size]);
}

// Google Maps satellite link for the aerial count.
export function satelliteViewUrl(est: Estimate): string {
  const c = est.customer;
  const q = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ') || 'Jacksonville FL';
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) + '&basemap=satellite&layer=c';
}

// Deposit on the combined page: a % of the price, the rest due later (unrounded).
export function depositSplit(sell: number, depositPct: unknown) {
  const deposit = (sell * toNumber(depositPct)) / 100;
  return { deposit, balance: sell - deposit };
}

export function estimateExpiresOn(est: Pick<Estimate, 'date' | 'validDays'>): string {
  return addDays(est.date, est.validDays);
}

// ==================== LABELS ====================

export function scopeLabel(scope: EstimateScope): string {
  return scope === 'both' ? 'Roofing + gutters' : scope === 'roof' ? 'Roofing only' : 'Gutters only';
}

// Short form used in estimate lists.
export function scopeShortLabel(scope: EstimateScope): string {
  return scope === 'both' ? 'Roof + gutter' : scope === 'roof' ? 'Roofing' : 'Gutters';
}

export const ESTIMATE_STATUSES: EstimateStatus[] = ['draft', 'sent', 'accepted', 'lost'];

export function statusTone(status: EstimateStatus | string): Tone {
  return status === 'accepted' ? 'ok' : status === 'lost' ? 'bad' : status === 'sent' ? 'navy' : 'mut';
}

// "Rep" column on saved estimates. Estimates from the old estimator are
// owned by "mgr"; `nameOf` can resolve a CRM user id to a current name.
export function ownerLabel(est: Pick<Estimate, 'ownerId' | 'ownerName'>, nameOf?: (id: string) => string | undefined): string {
  if (!est.ownerId || est.ownerId === 'mgr') return 'Manager';
  return nameOf?.(est.ownerId) || est.ownerName || '—';
}

// ==================== AUDIT ====================

// The price-change log as CSV ("When","Who","Rule","From","To").
export function auditToCsv(audit: AuditEntry[]): string {
  const header: unknown[] = ['When', 'Who', 'Rule', 'From', 'To'];
  const rows = [header, ...audit.map((e) => [e.at, e.who, e.path, e.before, e.after])];
  return rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
}

// A price-book path as the audit log shows it ("roof › pitchStep").
export function auditPathLabel(path: string): string {
  return path.replace(/\./g, ' › ');
}
