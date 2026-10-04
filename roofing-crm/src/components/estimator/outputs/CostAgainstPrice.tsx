'use client';

import {
  costAgainstPrice, formatMoney, formatPct, marginLadder, toNumber, type Estimate, type EstimateTotals, type PriceBook,
} from '@/lib/estimator';
import { cn } from '@/lib/utils';
import { Card, CardBody, CardHeader, DataTable, Pill, Tip } from './ui';

// "Cost against price" and "What it has to sell for" (managers only).
// `forReport` drops the explanatory note, as the job-cost report did.
export default function CostAgainstPrice({
  est,
  pricing,
  totals,
  forReport,
}: {
  est: Estimate;
  pricing: PriceBook;
  totals: EstimateTotals;
  forReport?: boolean;
}) {
  const cap = costAgainstPrice(est, pricing, totals);
  const ladder = marginLadder(est, pricing, totals);
  const sq = totals.roof.billable > 0;
  const lf = totals.gutter.lf > 0;
  const money = (v: number | null) => (v === null ? '—' : formatMoney(v));
  const ratioText = totals.sell ? formatPct(100 * cap.ratio) : '—';

  type Row = { label: string; amount: string; perSquare: string; perLF: string; strong?: boolean; ratio?: boolean };
  const rows: Row[] = cap.rows.map((r) => ({
    label: r.label,
    amount: formatMoney(r.amount),
    perSquare: money(r.perSquare),
    perLF: money(r.perLF),
    strong: r.label === 'Real cost, all in',
  }));
  rows.push({
    label: 'Cost ÷ price',
    amount: ratioText,
    perSquare: `every dollar you charge, ${totals.sell ? formatMoney(cap.ratio) : '—'} goes straight back out`,
    perLF: '',
    strong: true,
    ratio: true,
  });

  return (
    <Card>
      <CardHeader title="Cost against price" right={<Pill tone={cap.tone}>cost is {ratioText} of price</Pill>} />
      <DataTable
        rows={rows}
        rowKey={(r) => r.label}
        columns={[
          {
            key: 'label',
            header: '',
            primary: true,
            cell: (r) => (
              <>
                <span className={cn(r.strong && 'font-semibold')}>{r.label}</span>
                {r.ratio ? <div className="text-xs text-gray-500 md:hidden">{r.perSquare}</div> : null}
              </>
            ),
          },
          {
            key: 'amount',
            header: 'Amount',
            right: true,
            mono: true,
            cell: (r) => <span className={cn(r.strong && 'font-semibold')}>{r.amount}</span>,
          },
          {
            key: 'sq',
            header: 'Per square',
            right: true,
            mono: true,
            colSpan: (r) => (r.ratio ? 2 : undefined),
            mobileSkip: (r) => !!r.ratio,
            cell: (r) => (r.ratio ? <span className="text-xs text-gray-500">{r.perSquare}</span> : r.perSquare),
          },
          { key: 'lf', header: 'Per LF', right: true, mono: true, skip: (r) => !!r.ratio, cell: (r) => r.perLF },
        ]}
      />
      <CardHeader
        title="What it has to sell for"
        sub="Overhead and commission are a share of the price, so these are solved, not just cost ÷ margin"
      />
      <DataTable
        rows={ladder}
        rowKey={(r) => r.target.margin}
        columns={[
          {
            key: 'land',
            header: 'To land at',
            primary: true,
            cell: (r) =>
              r.target.margin === 0 ? (
                <b>Break even — every dollar of cost covered, nothing left</b>
              ) : (
                <span className="font-medium md:font-normal">{r.target.margin}% gross margin</span>
              ),
          },
          { key: 'price', header: 'Total price', right: true, mono: true, cell: (r) => formatMoney(r.target.price) },
          { key: 'sq', header: 'Per square', right: true, mono: true, cell: (r) => (sq ? formatMoney(r.target.perSquare) : '—') },
          { key: 'lf', header: 'Per LF', right: true, mono: true, cell: (r) => (lf ? formatMoney(r.target.perLF) : '—') },
          {
            key: 'delta',
            header: 'vs this estimate',
            right: true,
            mono: true,
            cell: (r) => (
              <span className={r.target.delta > 0 ? 'text-red-700' : 'text-green-700'}>
                {r.target.delta > 0 ? '+' + formatMoney(r.target.delta) : formatMoney(r.target.delta)}
              </span>
            ),
          },
          {
            key: 'pill',
            header: '',
            cell: (r) => <Pill tone={r.covered ? 'ok' : 'bad'}>{r.covered ? 'covered' : 'short'}</Pill>,
          },
        ]}
      />
      {forReport ? null : (
        <CardBody>
          <Tip>
            Break even is the price where gross profit is exactly zero — everything below it loses money before a single overhead
            dollar of the wider business is paid. The {toNumber(pricing.targets.minMargin)}% row is the company floor; the{' '}
            {toNumber(pricing.targets.goodMargin)}% row is where a job should land.
          </Tip>
        </CardBody>
      )}
    </Card>
  );
}
