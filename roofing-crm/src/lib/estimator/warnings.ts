import type { Estimate, EstimateTotals, EstimateWarning, PriceBook } from './types';
import { formatDate, formatMoney, formatPct, toNumber } from './format';

const DAY_MS = 864e5;

// Whole days since the price book was last verified (pricing.version).
export function pricingAgeDays(pricing: PriceBook, now: number = Date.now()): number {
  return Math.round((now - new Date(pricing.version + 'T12:00:00').getTime()) / DAY_MS);
}

export function isPricingStale(pricing: PriceBook, now: number = Date.now()): boolean {
  return pricingAgeDays(pricing, now) > toNumber(pricing.targets.staleAfterDays);
}

// The estimate's checks, in the original's order. `managerOnly` warnings
// (margin and cost) must not be shown to sales reps.
export function estimateWarnings(
  est: Estimate, pricing: PriceBook, totals: EstimateTotals, now: number = Date.now(),
): EstimateWarning[] {
  const out: EstimateWarning[] = [];

  totals.roof.sections.forEach((row) => {
    const m = pricing.mfrs[row.section.mfr];
    // (The original threw here for a custom price on an unknown manufacturer.)
    if (row.section.tier === 'custom' && m) {
      if (row.price < toNumber(m.min)) {
        out.push({
          level: 'bad',
          title: 'Roofing price below approved range',
          detail: `${row.name}: ${formatMoney(row.price)}/sq is under the ${m.label} minimum of ${formatMoney(m.min)}/sq.`,
        });
      } else if (row.price > toNumber(m.max)) {
        out.push({
          level: 'warn',
          title: 'Roofing price above published range',
          detail: `${row.name}: ${formatMoney(row.price)}/sq exceeds the ${m.label} maximum of ${formatMoney(m.max)}/sq. Allowed, but confirm it is intentional.`,
        });
      }
    }
    if (toNumber(row.section.measured) <= 0 && toNumber(row.section.billableOverride) <= 0) {
      out.push({
        level: 'warn',
        title: 'Roof section has no squares',
        detail: row.name + ' has no measured or billable squares entered.',
      });
    }
  });

  totals.gutter.runs.forEach((row) => {
    if (row.run.mode === 'labor') {
      if (row.rate < toNumber(pricing.gutter.laborOnly.min)) {
        out.push({
          level: 'bad',
          title: 'Labor-only gutter rate below minimum',
          detail: `${row.name}: ${formatMoney(row.rate)}/LF is under the ${formatMoney(pricing.gutter.laborOnly.min)}/LF floor.`,
        });
      }
    } else {
      const product = pricing.gutter[row.run.size] || { label: String(row.run.size), min: 0 };
      const min = toNumber(product.min);
      if (row.rate < min) {
        out.push({
          level: 'bad',
          title: 'Gutter price below minimum selling price',
          detail: `${row.name}: ${formatMoney(row.rate)}/LF is under the ${product.label} minimum of ${formatMoney(min)}/LF.`,
        });
      }
    }
    if (toNumber(row.run.lf) <= 0) {
      out.push({ level: 'warn', title: 'Gutter run has no linear feet', detail: row.name + ' has no LF entered.' });
    }
  });

  const { targets } = pricing;
  if (totals.sell > 0 && totals.margin < toNumber(targets.minMargin)) {
    out.push({
      managerOnly: true,
      level: 'bad',
      title: 'Gross margin below company target',
      detail: `${formatPct(totals.margin)} is under the ${targets.minMargin}% minimum. Gross profit is ${formatMoney(totals.grossProfit)}.`,
    });
  } else if (totals.sell > 0 && totals.margin < toNumber(targets.goodMargin)) {
    out.push({
      managerOnly: true,
      level: 'warn',
      title: 'Gross margin below the healthy band',
      detail: `${formatPct(totals.margin)} clears the ${targets.minMargin}% floor but is under the ${targets.goodMargin}% target.`,
    });
  }

  const missing: string[] = [];
  if (totals.roof.billable > 0) {
    if (totals.costs.material <= 0) missing.push('material cost');
    if (totals.costs.labor <= 0) missing.push('labor cost');
  }
  if (totals.gutter.lf > 0 && totals.costs.gutter <= 0) missing.push('gutter cost');
  if (totals.sell > 0 && totals.costs.overhead <= 0) missing.push('overhead');
  if (missing.length) {
    out.push({
      managerOnly: true,
      level: 'warn',
      title: 'Required cost information is missing',
      detail: 'No value for: ' + missing.join(', ') + '.',
    });
  }

  const discounts = totals.discounts;
  if (discounts > 0 && totals.preTax > 0) {
    const pct = (discounts / (totals.preTax + discounts)) * 100;
    if (pct > toNumber(targets.maxDiscountPct)) {
      out.push({
        level: 'bad',
        title: 'Discount exceeds the approved limit',
        detail: `${formatMoney(discounts)} is ${formatPct(pct)} of the pre-discount price; the approved maximum is ${targets.maxDiscountPct}%.`,
      });
    }
  }

  est.roof.adjustments.concat(est.gutter.adjustments).forEach((adj) => {
    if (!String(adj.label || '').trim()) {
      out.push({
        level: 'bad',
        title: 'Manual adjustment needs an explanation',
        detail: `A manual adjustment of ${formatMoney(adj.amount)} has no reason recorded. Every manual adjustment must be explained.`,
      });
    }
  });

  const age = pricingAgeDays(pricing, now);
  if (age > toNumber(targets.staleAfterDays)) {
    out.push({
      level: 'warn',
      title: 'Pricing may be out of date',
      detail: `The pricing table was last verified ${formatDate(pricing.version)} (${age} days ago). Supplier costs have moved 5–10% per increase this year.`,
    });
  }
  return out;
}

// Warnings a given viewer may see: reps do not see margin/cost warnings.
export function visibleWarnings(warnings: EstimateWarning[], isManager: boolean): EstimateWarning[] {
  return isManager ? warnings : warnings.filter((w) => !w.managerOnly);
}
