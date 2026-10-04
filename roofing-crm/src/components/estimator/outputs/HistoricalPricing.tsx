'use client';

import Link from 'next/link';
import {
  confidenceTone, estimateVsActual, formatMoneyWhole, formatPct, HISTORICAL_PRICING, historicalPricingSummary,
  type HistoricalPricePoint,
} from '@/lib/estimator';
import { useEstimatorStore } from '@/store/estimator';
import { cn } from '@/lib/utils';
import { Card, CardBody, CardHeader, DataTable, KpiStrip, Notice, Tip } from './ui';

const BAR: Record<'ok' | 'warn' | 'bad', string> = { ok: 'bg-green-600', warn: 'bg-amber-500', bad: 'bg-red-600' };

function ConfidenceBar({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block h-1.5 w-[54px] overflow-hidden rounded-full bg-gray-200">
        <i className={cn('block h-full', BAR[confidenceTone(value)])} style={{ width: value + '%' }} />
      </span>
      <span className="text-xs tabular-nums">{value}%</span>
    </span>
  );
}

// "Estimate vs actual": every job with actual costs recorded.
function EstimateVsActual() {
  const estimates = useEstimatorStore((s) => s.estimates);
  const pricing = useEstimatorStore((s) => s.pricing);
  const rows = estimateVsActual(estimates, pricing);
  if (!rows.length) {
    return (
      <Card>
        <CardHeader title="Estimate vs actual" />
        <CardBody>
          <Tip>
            No completed jobs with actual costs recorded yet. Enter actuals on the Combined estimate page once a job closes — this
            table is how the cost library stays calibrated against reality.
          </Tip>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Estimate vs actual" sub={`${rows.length} closed job${rows.length === 1 ? '' : 's'}`} />
      <DataTable
        rows={rows}
        rowKey={(r) => r.estimate.id}
        columns={[
          {
            key: 'job',
            header: 'Job',
            primary: true,
            cell: (r) => (
              <Link href={`/estimator/${r.estimate.id}`} className="inline-flex min-h-[36px] items-center font-medium text-gray-900 hover:text-orange-700 md:min-h-0">
                {r.estimate.number} · {r.estimate.customer.name || r.estimate.customer.address || '—'}
              </Link>
            ),
          },
          { key: 'contract', header: 'Contract', right: true, mono: true, cell: (r) => formatMoneyWhole(r.contract) },
          { key: 'est', header: 'Est. cost', right: true, mono: true, cell: (r) => formatMoneyWhole(r.estimatedCost) },
          { key: 'act', header: 'Actual cost', right: true, mono: true, cell: (r) => formatMoneyWhole(r.actualCost) },
          {
            key: 'var',
            header: 'Variance',
            right: true,
            mono: true,
            cell: (r) => (
              <span className={r.underEstimate ? 'text-green-700' : 'text-red-700'}>
                {r.underEstimate ? '−' : '+'}
                {formatMoneyWhole(r.variance)}
              </span>
            ),
          },
          {
            key: 'margin',
            header: 'Margin est → actual',
            right: true,
            mono: true,
            cell: (r) => (
              <>
                {formatPct(r.estimatedMargin)} → <b>{formatPct(r.actualMargin)}</b>
              </>
            ),
          },
        ]}
      />
      <CardBody>
        <div className="text-xs text-gray-500">
          Consistent variance in one direction means the cost rules on Admin Pricing need updating — that is the calibration loop.
        </div>
      </CardBody>
    </Card>
  );
}

export default function HistoricalPricing() {
  const summary = historicalPricingSummary();
  return (
    <div className="flex flex-col gap-4">
      <EstimateVsActual />
      <Notice level="warn" title="Read this before trusting any figure below.">
        Paid supplier invoices, subcontractor invoices, checks and completed-job accounting were prioritised. Carrier estimates and our
        own supplement estimates are shown for reference only and are never treated as company cost.
      </Notice>
      <KpiStrip
        items={[
          { label: 'Figures reviewed', value: summary.reviewed, sub: 'across email and Drive' },
          { label: 'High confidence', value: summary.highConfidence, sub: '75% or better', tone: 'ok' },
          { label: 'Unverified', value: summary.unverified, sub: 'use with caution', tone: 'bad' },
          { label: 'Best-evidenced rate', value: '$95', sub: 'labor / sq, 28 invoices' },
        ]}
      />
      {summary.categories.map((cat) => (
        <Card key={cat}>
          <CardHeader title={cat} />
          <DataTable<HistoricalPricePoint>
            rows={HISTORICAL_PRICING.filter((p) => p.category === cat)}
            rowKey={(p, i) => p.item + i}
            columns={[
              {
                key: 'item',
                header: 'Item',
                primary: true,
                cell: (p) => (
                  <>
                    <b>{p.item}</b>
                    <div className="mt-1 max-w-[52ch] text-xs text-gray-500">{p.note}</div>
                  </>
                ),
              },
              { key: 'amount', header: 'Amount found', mono: true, cell: (p) => p.amount },
              { key: 'src', header: 'Source type', className: 'text-xs', cell: (p) => p.source },
              { key: 'date', header: 'Source date', className: 'text-xs tabular-nums', cell: (p) => p.date },
              { key: 'jobs', header: 'Jobs', right: true, mono: true, cell: (p) => p.jobs || '—' },
              { key: 'rec', header: 'Recommended now', mono: true, cell: (p) => p.recommended },
              { key: 'conf', header: 'Confidence', cell: (p) => <ConfidenceBar value={p.confidence} /> },
            ]}
          />
        </Card>
      ))}
      <Card>
        <CardHeader title="Documents that would close the remaining gaps" />
        <CardBody>
          <div className="mb-2 text-[13px] text-gray-500">
            These are PDF attachments already in the mailbox that no automated search could open. Each one would replace a
            low-confidence figure above with a verified one.
          </div>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-gray-800">
            <li>
              <b>AMF — Gutter Price Sheet (6-1-26).pdf</b>{' '}— the entire gutter cost side, 6{'"'} and 7{'"'} plus accessories.
              Emailed 12 Aug 2026 by Phillip Galloway.
            </li>
            <li>
              <b>Labor Pricing Guide (Diversity Roofing).pdf</b> — High Caliber Roofing, 14 Sep 2025. Should confirm the steep and
              two-story labor rules.
            </li>
            <li>
              <b>price list.pdf</b> — sent internally 23 Mar 2026.
            </li>
            <li>
              <b>2322 West Clovelly Lane — Proposal.pdf</b> — the only customer-facing gutter proposal found; carries the $2,800
              leaf-guard option and the linear feet behind it.
            </li>
            <li>
              <b>Estimate 1777 — Project Exteriors Inc</b> — line-item breakdown of the $5,120 gutter job.
            </li>
            <li>
              <b>{'ABC Supply "ST. Augustine.pdf" price sheets'}</b> — full contract line pricing, 3 Jun 2026.
            </li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
