'use client';

import {
  costRows, estimateWarnings, formatDate, formatMoney, formatPct, marginTone, toNumber, type CostKey, type Estimate,
  type EstimateTotals, type PriceBook,
} from '@/lib/estimator';
import { cn } from '@/lib/utils';
import CostAgainstPrice from './CostAgainstPrice';
import { Card, CardBody, CardHeader, DataTable, KpiStrip, Notice, TONE_TEXT } from './ui';

// The internal job-cost report (managers only): revenue, every cost line
// (after any manager overrides), cost against price, the margin ladder,
// the estimate's checks, cost notes and the formulas in use.
export default function JobCostReport({ est, pricing, totals }: { est: Estimate; pricing: PriceBook; totals: EstimateTotals }) {
  const tone = marginTone(totals.margin, pricing);
  const c = totals.costs;
  const cost = pricing.cost;
  const pct = (v: number) => (totals.sell ? formatPct((v / totals.sell) * 100) : '—');
  const overridden = new Set(costRows(est, pricing, totals).filter((r) => r.override !== null).map((r) => r.key));
  const warnings = estimateWarnings(est, pricing, totals);

  type Row = { label: string; amount: number; note?: string; key?: CostKey; total?: 'cost' | 'profit' };
  const revenue: Row[] = [];
  if (totals.roof.subtotal)
    revenue.push({
      label: 'Roofing',
      amount: totals.roof.subtotal,
      note: `${totals.roof.billable.toFixed(2)} billable squares · effective ${formatMoney(totals.effectivePerSquare)}/sq`,
    });
  if (totals.gutter.subtotal)
    revenue.push({
      label: 'Gutters',
      amount: totals.gutter.subtotal,
      note: `${totals.gutter.lf.toFixed(0)} LF · effective ${formatMoney(totals.effectivePerLF)}/LF`,
    });
  if (totals.tax) revenue.push({ label: 'Sales tax', amount: totals.tax });

  const costs: Row[] = [
    { key: 'material', label: 'Material', amount: c.material },
    { key: 'labor', label: 'Labor', amount: c.labor },
    { key: 'dumpster', label: 'Dumpster', amount: c.dumpster },
    { key: 'permit', label: 'Permit', amount: c.permit },
    { key: 'delivery', label: 'Delivery', amount: c.delivery },
    { key: 'repairs', label: 'Repairs', amount: c.repairs },
    { key: 'decking', label: 'Decking', amount: c.decking },
    { key: 'gutter', label: 'Gutter cost', amount: c.gutter },
    {
      key: 'commission',
      label: 'Sales commission',
      amount: c.commission,
      note: cost.commissionBasis === 'profit' ? `${cost.commissionPct}% of profit` : `${cost.commissionPct}% of contract`,
    },
    {
      key: 'overhead',
      label: 'Overhead',
      amount: c.overhead,
      note: cost.overheadBasis === 'flat' ? 'flat per job' : `${cost.overheadPct}% of contract`,
    },
    { key: 'financing', label: 'Financing / card fees', amount: c.financing },
    { key: 'other', label: 'Other expenses', amount: c.other },
    { label: 'Total estimated cost', amount: totals.totalCost, total: 'cost' },
    { label: 'Gross profit', amount: totals.grossProfit, total: 'profit' },
  ];
  const rows = [...revenue, ...costs];

  return (
    <div className="flex flex-col gap-4">
      <KpiStrip
        items={[
          { label: 'Selling price', value: formatMoney(totals.sell) },
          { label: 'Estimated cost', value: formatMoney(totals.totalCost) },
          { label: 'Gross profit', value: formatMoney(totals.grossProfit), tone },
          { label: 'Gross margin', value: formatPct(totals.margin), tone },
          { label: 'Markup on cost', value: formatPct(totals.markup) },
        ]}
      />

      <Card>
        <CardHeader
          title={`${est.number} — ${est.customer.name || 'Unnamed'}`}
          sub={`${est.customer.address || ''} · ${formatDate(est.date)}`}
        />
        <DataTable
          rows={rows}
          rowKey={(r) => r.label}
          groups={[{ before: revenue.length, header: ['Estimated cost', '', ''] }]}
          columns={[
            {
              key: 'label',
              header: 'Revenue',
              primary: true,
              cell: (r) => (
                <>
                  <span className={cn(r.total && 'font-semibold')}>{r.label}</span>
                  {r.note || (r.key && overridden.has(r.key)) ? (
                    <div className="mt-0.5 text-xs text-gray-500">
                      {[r.note, r.key && overridden.has(r.key) ? 'manual override' : ''].filter(Boolean).join(' · ')}
                    </div>
                  ) : null}
                </>
              ),
            },
            {
              key: 'amount',
              header: 'Amount',
              right: true,
              mono: true,
              cell: (r) => (
                <span className={cn(r.total && 'font-semibold', r.total === 'profit' && TONE_TEXT[tone])}>
                  {formatMoney(r.amount)}
                </span>
              ),
            },
            {
              key: 'pct',
              header: '% of price',
              right: true,
              mono: true,
              cell: (r) => (
                <span className={r.total === 'profit' ? TONE_TEXT[tone] : r.total ? 'text-gray-900' : 'text-gray-500'}>
                  {r.total === 'profit' ? formatPct(totals.margin) : pct(r.amount)}
                </span>
              ),
            },
          ]}
        />
      </Card>

      <CostAgainstPrice est={est} pricing={pricing} totals={totals} forReport />

      <Card>
        <CardHeader title="Checks & warnings" />
        <CardBody className="flex flex-col gap-2">
          {warnings.length ? (
            warnings.map((w, i) => (
              <Notice key={i} level={w.level} title={w.title}>
                {w.detail}
              </Notice>
            ))
          ) : (
            <Notice level="ok">No pricing or margin warnings on this estimate.</Notice>
          )}
        </CardBody>
      </Card>

      {est.costs.notes ? (
        <Card>
          <CardHeader title="Cost notes" />
          <CardBody>
            <div className="whitespace-pre-wrap text-[13px] text-gray-800">{est.costs.notes}</div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Formulas used" />
        <CardBody>
          <ul className="flex flex-col gap-2 break-words font-mono text-[12px] leading-relaxed text-gray-700">
            <li>billable squares = measured squares × (1 + waste ÷ 100)</li>
            <li>
              pitch surcharge per square = max(0, pitch numerator − {toNumber(pricing.roof.pitchFreeUpTo)}) ×{' '}
              {formatMoney(pricing.roof.pitchStep)}
            </li>
            <li>
              section total = billable × (price/sq + pitch surcharge + story surcharge) + peel-and-stick squares ×{' '}
              {formatMoney(pricing.roof.peelStick)}
            </li>
            <li>roofing subtotal = Σ sections + line items + upgrades − discounts + adjustments</li>
            <li>
              gutter run total = LF × ($/LF + two-story + difficult access + removal) + guard LF × {formatMoney(pricing.gutter.guardLF)}
            </li>
            <li>total selling price = roofing subtotal + gutter subtotal + sales tax</li>
            <li>
              total estimated cost = material + labor + dumpster + permit + delivery + repairs + decking + gutter + overhead + financing
              + other + commission
            </li>
            <li>gross profit = total selling price − total estimated cost</li>
            <li>gross margin % = gross profit ÷ total selling price × 100</li>
            <li>markup % = gross profit ÷ total estimated cost × 100</li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
