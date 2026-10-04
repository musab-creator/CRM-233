'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus } from 'lucide-react';
import {
  dashboardStats, formatDate, formatMoney, formatMoneyWhole, formatPct, marginTone, runSelfTest, scopeShortLabel,
  type PriceBook, type SelfTestResult, type Tone,
} from '@/lib/estimator';
import { useEstimatorHydrated, useEstimatorStore, useVisibleEstimates } from '@/store/estimator';
import EstimatorShell, { useIsEstimatorManager } from '../EstimatorShell';
import { Toaster } from './feedback';
import { useEstimateActions } from './useEstimateActions';
import {
  Alert, Button, Card, CardBody, CardFooterRow, CardHeader, DataTable, Note, Pill, SEGMENT_COLORS, StackedBar, StatTiles,
  buttonClass, type Tile,
} from './ui';

// The original's dashboard (td) with its price table (tf) and self-test (tp).

function PriceLevels({ pricing }: { pricing: PriceBook }) {
  const rows = [
    ...Object.keys(pricing.mfrs).map((k) => {
      const m = pricing.mfrs[k];
      return { key: k, label: m.label, unit: 'per square', comp: formatMoneyWhole(m.competitive), std: formatMoneyWhole(m.standard), high: formatMoneyWhole(m.high) };
    }),
    { key: 'g6', label: pricing.gutter.g6.label, unit: 'per LF', comp: '—', std: formatMoney(pricing.gutter.g6.sell), high: '—' },
    { key: 'g7', label: pricing.gutter.g7.label, unit: 'per LF', comp: '—', std: formatMoney(pricing.gutter.g7.sell), high: '—' },
  ];
  const r = pricing.roof;
  return (
    <Card>
      <CardHeader title="Current price levels" right={<Pill tone="navy">Verified {formatDate(pricing.version)}</Pill>} />
      <DataTable
        phone="table"
        rows={rows}
        rowKey={(x) => x.key}
        className="[&_td]:px-2 sm:[&_td]:px-3 [&_th]:px-2 sm:[&_th]:px-3"
        columns={[
          {
            header: 'Product',
            cell: (x) => (
              <>
                {x.label} <span className="text-[11.5px] text-gray-500">{x.unit}</span>
              </>
            ),
          },
          { header: 'Competitive', right: true, cell: (x) => x.comp },
          { header: 'Standard', right: true, cell: (x) => <b>{x.std}</b> },
          { header: 'High', right: true, cell: (x) => x.high },
        ]}
      />
      <CardFooterRow
        label={`Pitch +${formatMoneyWhole(r.pitchStep)}/sq per point over ${r.pitchFreeUpTo}/12 · 2-story +${formatMoneyWhole(r.story2)}/sq · peel-and-stick +${formatMoneyWhole(r.peelStick)}/sq`}
        value=""
      />
    </Card>
  );
}

function SelfTest({ pricing }: { pricing: PriceBook }) {
  const [result, setResult] = useState<SelfTestResult>(() => runSelfTest(pricing));
  return (
    <Card>
      <CardHeader
        title="Calculation self-test"
        right={
          <Pill tone={result.passed === result.total ? 'ok' : 'bad'}>
            {result.passed} / {result.total} pass
          </Pill>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div className="text-[13px] text-gray-500">
          Runs the six reference estimates through the live engine and compares every result against independently worked
          arithmetic. Run it after any change on Admin Pricing.
        </div>
        <div>
          <Button variant="primary" onClick={() => setResult(runSelfTest(pricing))}>
            Run self-test
          </Button>
        </div>
      </CardBody>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gray-50 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              <th className="border-b border-gray-200 px-3 py-2 text-left">Reference estimate</th>
              <th className="border-b border-gray-200 px-3 py-2 text-right">Qty</th>
              <th className="border-b border-gray-200 px-3 py-2 text-right">Expected</th>
              <th className="border-b border-gray-200 px-3 py-2 text-right">Engine</th>
              <th className="border-b border-gray-200 px-3 py-2 text-right">Margin</th>
              <th className="border-b border-gray-200 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {result.rows.map((x, i) => (
              <tr key={i} className="align-top">
                <td className="border-b border-gray-100 px-3 py-2">{x.name}</td>
                {x.summary ? (
                  <td colSpan={4} className="border-b border-gray-100 px-3 py-2 text-xs text-gray-500">
                    {x.summary}
                  </td>
                ) : (
                  <>
                    <td className="whitespace-nowrap border-b border-gray-100 px-3 py-2 text-right tabular-nums">{x.qty}</td>
                    <td className="border-b border-gray-100 px-3 py-2 text-right tabular-nums">{formatMoney(x.expected)}</td>
                    <td className="border-b border-gray-100 px-3 py-2 text-right tabular-nums">{formatMoney(x.got)}</td>
                    <td className="border-b border-gray-100 px-3 py-2 text-right tabular-nums">{formatPct(x.margin)}</td>
                  </>
                )}
                <td className="border-b border-gray-100 px-3 py-2 text-right">
                  <Pill tone={x.pass ? 'ok' : 'bad'}>{x.pass ? 'pass' : 'fail'}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-gray-100 md:hidden">
        {result.rows.map((x, i) => (
          <li key={i} className="px-4 py-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium text-gray-900">{x.name}</span>
              <Pill tone={x.pass ? 'ok' : 'bad'}>{x.pass ? 'pass' : 'fail'}</Pill>
            </div>
            {x.summary ? (
              <div className="mt-1 text-xs text-gray-500">{x.summary}</div>
            ) : (
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs tabular-nums text-gray-600">
                <span>{x.qty}</span>
                <span>Expected {formatMoney(x.expected)}</span>
                <span>Engine {formatMoney(x.got)}</span>
                <span>{formatPct(x.margin)}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function EstimatorDashboard() {
  const hydrated = useEstimatorHydrated();
  const isManager = useIsEstimatorManager();
  const pricing = useEstimatorStore((s) => s.pricing);
  const estimates = useVisibleEstimates();
  const { openHref } = useEstimateActions();
  const stats = useMemo(() => dashboardStats(estimates, pricing), [estimates, pricing]);

  const tiles: Tile[] = [
    { label: 'Open pipeline', value: formatMoneyWhole(stats.pipeline), sub: `${stats.openCount} open estimate${stats.openCount === 1 ? '' : 's'}` },
    { label: 'Sold', value: formatMoneyWhole(stats.soldTotal), sub: `${stats.soldCount} accepted` },
  ];
  if (isManager) {
    tiles.push(
      { label: 'Gross profit sold', value: formatMoneyWhole(stats.soldProfit), sub: stats.soldMargin !== null ? formatPct(stats.soldMargin) + ' margin' : '—', tone: 'ok' },
      { label: 'Average margin', value: stats.averageMargin !== null ? formatPct(stats.averageMargin) : '—', sub: `Target ≥ ${pricing.targets.minMargin}%` },
      {
        label: 'Below target',
        value: String(stats.belowTarget.length),
        sub: `estimates under ${pricing.targets.minMargin}%`,
        tone: stats.belowTarget.length ? 'bad' : undefined,
      },
    );
  }
  const pipelineColors: Record<string, string> = { draft: SEGMENT_COLORS[0], sent: SEGMENT_COLORS[3], accepted: SEGMENT_COLORS[2], lost: SEGMENT_COLORS[4] };
  const recent = stats.rows.slice(0, 8);

  return (
    <EstimatorShell
      title="Estimator"
      subtitle="Pipeline, margin health and the current price table."
      actions={
        <Link href="/estimator/new" className={buttonClass('primary')}>
          <Plus className="h-4 w-4" /> New estimate
        </Link>
      }
    >
      {!hydrated ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading estimates…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <StatTiles items={tiles} />
          {stats.statusTotal ? (
            <Card>
              <CardHeader title="Pipeline by status" sub="contract value" />
              <CardBody>
                <StackedBar
                  ariaLabel="Pipeline by status"
                  segments={stats.statusSegments.map((s) => ({ label: s.label, value: s.value, color: pipelineColors[s.status] }))}
                  total={stats.statusTotal}
                />
              </CardBody>
            </Card>
          ) : null}
          {isManager && stats.pricingStale ? (
            <Alert level="warn" title="Pricing may be out of date">
              Last verified {formatDate(pricing.version)} ({stats.pricingAgeDays} days ago). ABC Supply raised residential roofing
              6–10% on 1 June 2026 and 6–10% on 13 April 2026 — re-check material cost per square before quoting.
            </Alert>
          ) : null}
          {isManager ? (
            <div className="grid items-start gap-4 2xl:grid-cols-2">
              <PriceLevels pricing={pricing} />
              <SelfTest key={JSON.stringify(pricing)} pricing={pricing} />
            </div>
          ) : null}
          <Card>
            <CardHeader
              title="Recent estimates"
              right={
                <Link href="/estimator/saved" className={buttonClass('default', 'sm')}>
                  See all
                </Link>
              }
            />
            {recent.length ? (
              <DataTable
                rows={recent}
                rowKey={(r) => r.estimate.id}
                columns={[
                  {
                    header: 'Estimate',
                    cell: ({ estimate: e }) => (
                      <>
                        <span className="font-mono text-[13px] font-semibold text-gray-900">{e.number}</span>
                        <div className="text-[11.5px] text-gray-500">{formatDate(e.date)}</div>
                      </>
                    ),
                    mobile: false,
                  },
                  {
                    header: 'Customer',
                    mobile: 'title',
                    cell: ({ estimate: e }) => (
                      <div className="min-w-0">
                        <span className="md:hidden font-mono text-xs text-gray-500">{e.number} · </span>
                        {e.customer.name || '—'}
                        <div className="text-[11.5px] font-normal text-gray-500">{e.customer.address || ''}</div>
                      </div>
                    ),
                  },
                  { header: 'Scope', cell: ({ estimate: e }) => <Pill tone="mut">{scopeShortLabel(e.scope)}</Pill> },
                  { header: 'Price', right: true, cell: ({ totals: t }) => formatMoneyWhole(t.sell) },
                  ...(isManager
                    ? [
                        { header: 'Cost', right: true, cell: ({ totals: t }: (typeof recent)[number]) => formatMoneyWhole(t.totalCost) },
                        { header: 'GP', right: true, cell: ({ totals: t }: (typeof recent)[number]) => formatMoneyWhole(t.grossProfit) },
                        {
                          header: 'Margin',
                          right: true,
                          cell: ({ totals: t }: (typeof recent)[number]) => (
                            <Pill tone={marginTone(t.margin, pricing) as Tone}>{formatPct(t.margin)}</Pill>
                          ),
                        },
                      ]
                    : []),
                  {
                    right: true,
                    mobile: '',
                    mobileFull: true,
                    cell: ({ estimate: e }) => (
                      <Link href={openHref(e.id)} className={buttonClass('default', 'sm')}>
                        Open
                      </Link>
                    ),
                  },
                ]}
              />
            ) : (
              <CardBody>
                <Note>
                  No saved estimates yet. Start one from <b>New estimate</b>.
                </Note>
              </CardBody>
            )}
          </Card>
        </div>
      )}
      <Toaster />
    </EstimatorShell>
  );
}
