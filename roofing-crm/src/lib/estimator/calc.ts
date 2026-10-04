import type {
  AutoCosts, CostBreakdown, CostKey, CostOverrides, CostStructure, Estimate, EstimateTotals, GutterRun,
  GutterTotals, LineItem, MarginTarget, PriceBook, PriceTier, RoofSection, RoofTotals,
} from './types';
import { round2, toNumber } from './format';

// Pricing math ported from the original estimator. The order of every
// addition and every round2() matches the original so totals agree to the
// cent (and to the last floating-point bit); keep it that way when editing.

// $/square for a manufacturer + price tier ("custom" uses the section's own price).
export function sectionPricePerSquare(pricing: PriceBook, mfr: string, tier: PriceTier | string, custom: unknown): number {
  const m = pricing.mfrs[mfr];
  if (!m) return 0;
  return tier === 'custom' ? toNumber(custom) : toNumber((m as unknown as Record<string, unknown>)[tier]);
}

// $/square added for each pitch point above the free pitch.
export function pitchSurchargePerSquare(pricing: PriceBook, pitch: unknown): number {
  return Math.max(0, toNumber(pitch) - toNumber(pricing.roof.pitchFreeUpTo)) * toNumber(pricing.roof.pitchStep);
}

// $/square for stories: none for one story, story2 for two, story3 for three and up.
export function storySurchargePerSquare(pricing: PriceBook, stories: unknown): number {
  const s = toNumber(stories);
  return s <= 1 ? 0 : s === 2 ? toNumber(pricing.roof.story2) : toNumber(pricing.roof.story3);
}

// Billable squares: the override when set, else measured + waste.
export function billableSquares(section: Pick<RoofSection, 'billableOverride' | 'measured' | 'waste'>): number {
  return toNumber(section.billableOverride) > 0
    ? round2(section.billableOverride)
    : round2(toNumber(section.measured) * (1 + toNumber(section.waste) / 100));
}

// Peel-and-stick squares for a section, given its billable squares.
export function peelStickSquares(section: Pick<RoofSection, 'psMode' | 'psSquares'>, billable: number): number {
  return section.psMode === 'full' ? billable : section.psMode === 'partial' ? round2(section.psSquares) : 0;
}

// Selling $/LF for a gutter run: override, labor-only rate, or the size's price.
export function gutterRunRate(pricing: PriceBook, run: Pick<GutterRun, 'sellOverride' | 'mode' | 'laborRate' | 'size'>): number {
  if (toNumber(run.sellOverride) > 0) return toNumber(run.sellOverride);
  if (run.mode === 'labor') return toNumber(run.laborRate);
  return toNumber(pricing.gutter[run.size]?.sell);
}

// Downspout footage is count × length per drop; every other item uses qty.
export function gutterItemQty(it: Pick<LineItem, 'k' | 'qty' | 'meta'>): number {
  return it.k === 'ds' && it.meta ? round2(toNumber(it.meta.count) * toNumber(it.meta.len)) : toNumber(it.qty);
}

const sumAmounts = (lines: { amount: unknown }[]) => lines.reduce((acc, l) => acc + toNumber(l.amount), 0);

function roofTotals(est: Estimate, pricing: PriceBook): RoofTotals {
  const r: RoofTotals = {
    sections: [], sectionsTotal: 0, base: 0, pitch: 0, story: 0, ps: 0, billable: 0, measured: 0,
    psSquares: 0, items: [], itemsTotal: 0, upgrades: 0, discounts: 0, adjustments: 0, subtotal: 0,
    steepSqPoints: 0, twoStorySq: 0, threeStorySq: 0,
  };
  if (est.scope === 'gutter') return r;

  est.roof.sections.forEach((sec) => {
    const billable = billableSquares(sec);
    const price = sectionPricePerSquare(pricing, sec.mfr, sec.tier, sec.custom);
    const pitchSurcharge = pitchSurchargePerSquare(pricing, sec.pitch);
    const storySurcharge = storySurchargePerSquare(pricing, sec.stories);
    const psSquares = peelStickSquares(sec, billable);
    const base = round2(billable * price);
    const pitchAmt = round2(billable * pitchSurcharge);
    const storyAmt = round2(billable * storySurcharge);
    const psAmt = round2(psSquares * toNumber(pricing.roof.peelStick));
    const total = round2(base + pitchAmt + storyAmt + psAmt);
    r.sections.push({
      id: sec.id, name: sec.name, billable, price, pitchSurcharge, storySurcharge, psSquares,
      base, pitchAmt, storyAmt, psAmt, total, section: sec,
    });
    r.base += base;
    r.pitch += pitchAmt;
    r.story += storyAmt;
    r.ps += psAmt;
    r.billable += billable;
    r.measured += toNumber(sec.measured);
    r.psSquares += psSquares;
    r.sectionsTotal += total;
    r.steepSqPoints += billable * Math.max(0, toNumber(sec.pitch) - toNumber(pricing.roof.pitchFreeUpTo));
    if (toNumber(sec.stories) === 2) r.twoStorySq += billable;
    if (toNumber(sec.stories) >= 3) r.threeStorySq += billable;
  });
  r.base = round2(r.base);
  r.pitch = round2(r.pitch);
  r.story = round2(r.story);
  r.ps = round2(r.ps);
  r.billable = round2(r.billable);
  r.measured = round2(r.measured);
  r.psSquares = round2(r.psSquares);
  r.sectionsTotal = round2(r.sectionsTotal);
  r.steepSqPoints = round2(r.steepSqPoints);
  r.twoStorySq = round2(r.twoStorySq);
  r.threeStorySq = round2(r.threeStorySq);

  est.roof.items.forEach((it) => {
    const total = it.on ? round2(toNumber(it.qty) * toNumber(it.rate)) : 0;
    r.items.push({ ...it, total });
    r.itemsTotal += total;
  });
  r.itemsTotal = round2(r.itemsTotal);
  r.upgrades = round2(sumAmounts(est.roof.upgrades));
  r.discounts = round2(sumAmounts(est.roof.discounts));
  r.adjustments = round2(sumAmounts(est.roof.adjustments));
  r.subtotal = round2(r.sectionsTotal + r.itemsTotal + r.upgrades - r.discounts + r.adjustments);
  return r;
}

function gutterTotals(est: Estimate, pricing: PriceBook): GutterTotals {
  const g: GutterTotals = {
    runs: [], runsTotal: 0, lf: 0, guardLF: 0, items: [], itemsTotal: 0, upgrades: 0, discounts: 0,
    adjustments: 0, subtotal: 0, removalLF: 0, twoStoryLF: 0, difficultLF: 0, materialLF: 0, laborOnlyLF: 0,
  };
  if (est.scope === 'roof') return g;

  est.gutter.runs.forEach((run) => {
    const lf = round2(run.lf);
    const rate = gutterRunRate(pricing, run);
    const base = round2(lf * rate);
    const removal = run.removal ? round2(lf * toNumber(pricing.gutter.removalLF)) : 0;
    const guardLF = run.guards ? (toNumber(run.guardLF) > 0 ? round2(run.guardLF) : lf) : 0;
    const guards = round2(guardLF * toNumber(pricing.gutter.guardLF));
    const story = toNumber(run.stories) >= 2 ? round2(lf * toNumber(pricing.gutter.story2LF)) : 0;
    const difficult = run.difficult ? round2(lf * toNumber(pricing.gutter.difficultLF)) : 0;
    const total = round2(base + removal + guards + story + difficult);
    g.runs.push({ id: run.id, name: run.name, lf, rate, base, removal, guardLF, guards, story, difficult, total, run });
    g.runsTotal += total;
    g.lf += lf;
    g.guardLF += guardLF;
    if (run.removal) g.removalLF += lf;
    if (toNumber(run.stories) >= 2) g.twoStoryLF += lf;
    if (run.difficult) g.difficultLF += lf;
    if (run.mode === 'material') g.materialLF += lf;
    if (run.mode === 'labor') g.laborOnlyLF += lf;
  });
  g.runsTotal = round2(g.runsTotal);
  g.lf = round2(g.lf);
  g.guardLF = round2(g.guardLF);
  g.removalLF = round2(g.removalLF);
  g.twoStoryLF = round2(g.twoStoryLF);
  g.difficultLF = round2(g.difficultLF);
  g.materialLF = round2(g.materialLF);
  g.laborOnlyLF = round2(g.laborOnlyLF);

  est.gutter.items.forEach((it) => {
    const qty = gutterItemQty(it);
    const total = it.on ? round2(qty * toNumber(it.rate)) : 0;
    g.items.push({ ...it, qty, total });
    g.itemsTotal += total;
  });
  g.itemsTotal = round2(g.itemsTotal);
  g.upgrades = round2(sumAmounts(est.gutter.upgrades));
  g.discounts = round2(sumAmounts(est.gutter.discounts));
  g.adjustments = round2(sumAmounts(est.gutter.adjustments));
  g.subtotal = round2(g.runsTotal + g.itemsTotal + g.upgrades - g.discounts + g.adjustments);
  return g;
}

// Internal cost from the cost rules. Note the original's quirks, kept for
// parity: site costs follow the roof line-item switches and downspout cost
// follows the downspout item even when that scope is not being sold.
function autoCosts(est: Estimate, pricing: PriceBook, roof: RoofTotals, gutter: GutterTotals): AutoCosts {
  const c = pricing.cost;
  const roofQty = (k: string) => {
    const it = est.roof.items.find((i) => i.k === k);
    return it && it.on ? toNumber(it.qty) : 0;
  };
  const gutterQty = (k: string) => {
    const it = est.gutter.items.find((i) => i.k === k);
    return it && it.on ? gutterItemQty(it) : 0;
  };
  const material = round2(roof.billable * toNumber(c.materialPerSq) + roof.psSquares * toNumber(c.peelStickPerSq));
  const labor = round2(
    roof.billable * toNumber(c.laborPerSq) +
      roof.steepSqPoints * toNumber(c.steepPerSq) +
      roof.twoStorySq * toNumber(c.story2PerSq) +
      roof.threeStorySq * toNumber(c.story3PerSq) +
      roofQty('tearoff') * toNumber(c.tearOffLayerPerSq),
  );
  const dumpster = round2(roofQty('dumpster') * toNumber(c.dumpster));
  const permit = round2(roofQty('permit') * (toNumber(c.permitService) + toNumber(c.permitFee) + toNumber(c.noc)));
  const delivery = round2(roofQty('delivery') * toNumber(c.delivery));
  const repairs = round2(roofQty('repairs') * toNumber(c.repairEach));
  const decking = round2(roofQty('decking') * toNumber(c.deckingSheet));

  let gutterCost = 0;
  gutter.runs.forEach((row) => {
    if (row.run.mode === 'labor') gutterCost += row.lf * toNumber(c.gutterLaborOnlyLF);
    else gutterCost += row.lf * toNumber(row.run.size === 'g7' ? c.g7PerLF : c.g6PerLF);
    if (row.run.removal) gutterCost += row.lf * toNumber(c.gutterRemovalLF);
    if (row.guardLF) gutterCost += row.guardLF * toNumber(c.guardPerLF);
  });
  gutterCost += gutterQty('ds') * toNumber(c.downspoutPerLF);
  const dsRate = est.gutter.items.find((i) => i.k === 'ds')?.rate;
  const accessorySell = gutter.itemsTotal - gutterQty('ds') * toNumber(dsRate);
  gutterCost += (Math.max(0, accessorySell) * toNumber(c.gutterAccessoryPct)) / 100;

  return { material, labor, dumpster, permit, delivery, repairs, decking, gutter: round2(gutterCost) };
}

export function hasCostOverride(overrides: CostOverrides, key: CostKey): boolean {
  const v = overrides[key];
  return v !== undefined && v !== '' && v !== null;
}

// Every price, cost and margin figure for an estimate.
export function estimateTotals(est: Estimate, pricing: PriceBook): EstimateTotals {
  const roof = roofTotals(est, pricing);
  const gutter = gutterTotals(est, pricing);
  const preTax = round2(roof.subtotal + gutter.subtotal);
  const taxRate = est.roof.taxOn === 'total' ? toNumber(est.roof.taxRate) : 0;
  const tax = round2((preTax * taxRate) / 100);
  const sell = round2(preTax + tax);

  const auto = autoCosts(est, pricing, roof, gutter);
  const ov = est.costs.overrides || {};
  const pick = (k: keyof AutoCosts) => (hasCostOverride(ov, k) ? toNumber(ov[k]) : toNumber(auto[k]));
  const rules = pricing.cost;
  const costs: CostBreakdown = {
    material: pick('material'),
    labor: pick('labor'),
    dumpster: pick('dumpster'),
    permit: pick('permit'),
    delivery: pick('delivery'),
    repairs: pick('repairs'),
    decking: pick('decking'),
    gutter: pick('gutter'),
    other: toNumber(ov.other),
    overhead: 0,
    financing: 0,
    commission: 0,
  };
  costs.overhead = hasCostOverride(ov, 'overhead')
    ? toNumber(ov.overhead)
    : rules.overheadBasis === 'flat'
      ? toNumber(rules.overheadFlat)
      : round2((sell * toNumber(rules.overheadPct)) / 100);
  costs.financing = hasCostOverride(ov, 'financing')
    ? toNumber(ov.financing)
    : round2((sell * toNumber(rules.financingPct)) / 100);
  const beforeCommission = round2(
    costs.material + costs.labor + costs.dumpster + costs.permit + costs.delivery + costs.repairs +
      costs.decking + costs.gutter + costs.overhead + costs.financing + costs.other,
  );
  costs.commission = hasCostOverride(ov, 'commission')
    ? toNumber(ov.commission)
    : rules.commissionBasis === 'profit'
      ? round2((Math.max(0, sell - beforeCommission) * toNumber(rules.commissionPct)) / 100)
      : round2((sell * toNumber(rules.commissionPct)) / 100);

  const totalCost = round2(beforeCommission + costs.commission);
  const grossProfit = round2(sell - totalCost);
  return {
    roof,
    gutter,
    preTax,
    tax,
    taxRate,
    sell,
    autoCosts: auto,
    costs,
    totalCost,
    grossProfit,
    margin: sell > 0 ? (grossProfit / sell) * 100 : 0,
    markup: totalCost > 0 ? (grossProfit / totalCost) * 100 : 0,
    effectivePerSquare: roof.billable > 0 ? round2(roof.subtotal / roof.billable) : 0,
    effectivePerLF: gutter.lf > 0 ? round2(gutter.subtotal / gutter.lf) : 0,
    addOns: round2(roof.itemsTotal + gutter.itemsTotal + roof.upgrades + gutter.upgrades),
    discounts: round2(roof.discounts + gutter.discounts),
    adjustments: round2(roof.adjustments + gutter.adjustments),
  };
}

// Splits cost into the part fixed in dollars and the parts that are a share
// of the price (overhead %, financing %, commission), so a target margin can
// be solved for exactly rather than approximated as cost ÷ (1 − margin).
export function costStructure(est: Estimate, pricing: PriceBook, totals: EstimateTotals): CostStructure {
  const ov = est.costs.overrides || {};
  const rules = pricing.cost;
  let direct = (['material', 'labor', 'dumpster', 'permit', 'delivery', 'repairs', 'decking', 'gutter', 'other'] as const)
    .reduce((acc, k) => acc + toNumber(totals.costs[k]), 0);
  let overheadRate = 0;
  let financingRate = 0;
  let contractCommRate = 0;
  let profitCommRate = 0;
  let mode: CostStructure['mode'] = 'contract';

  if (hasCostOverride(ov, 'overhead')) direct += toNumber(totals.costs.overhead);
  else if (rules.overheadBasis === 'flat') direct += toNumber(rules.overheadFlat);
  else overheadRate = toNumber(rules.overheadPct) / 100;

  if (hasCostOverride(ov, 'financing')) direct += toNumber(totals.costs.financing);
  else financingRate = toNumber(rules.financingPct) / 100;

  if (hasCostOverride(ov, 'commission')) direct += toNumber(totals.costs.commission);
  else if (rules.commissionBasis === 'profit') {
    mode = 'profit';
    profitCommRate = toNumber(rules.commissionPct) / 100;
  } else contractCommRate = toNumber(rules.commissionPct) / 100;

  const fixed = direct;
  return {
    direct: round2(fixed),
    overheadRate,
    financingRate,
    commissionRate: mode === 'profit' ? profitCommRate : contractCommRate,
    mode,
    solve: (margin: number) => {
      if (fixed <= 0) return 0;
      if (mode === 'profit') {
        const k = (1 - profitCommRate) * (1 - overheadRate - financingRate) - margin;
        return k > 0 ? round2(((1 - profitCommRate) * fixed) / k) : NaN;
      }
      const k = 1 - overheadRate - financingRate - contractCommRate - margin;
      return k > 0 ? round2(fixed / k) : NaN;
    },
  };
}

// Total cost at a hypothetical selling price under a cost structure.
export function costAtPrice(cs: CostStructure, price: number): number {
  if (cs.mode === 'profit') {
    const beforeCommission = cs.direct + (cs.overheadRate + cs.financingRate) * price;
    return beforeCommission + cs.commissionRate * Math.max(0, price - beforeCommission);
  }
  return cs.direct + (cs.overheadRate + cs.financingRate + cs.commissionRate) * price;
}

// "What it has to sell for": the price that lands at `marginPct` gross
// margin, with the matching $/square and $/LF. Null when no price can reach it.
export function priceForMargin(
  est: Estimate, pricing: PriceBook, totals: EstimateTotals, marginPct: unknown,
): MarginTarget | null {
  const price = costStructure(est, pricing, totals).solve(toNumber(marginPct) / 100);
  if (!isFinite(price)) return null;
  const scale = totals.sell > 0 ? price / totals.sell : 0;
  return {
    margin: toNumber(marginPct),
    price,
    delta: round2(price - totals.sell),
    perSquare: totals.roof.billable > 0 ? round2((totals.effectivePerSquare || 0) * scale) : 0,
    perLF: totals.gutter.lf > 0 ? round2((totals.effectivePerLF || 0) * scale) : 0,
  };
}
