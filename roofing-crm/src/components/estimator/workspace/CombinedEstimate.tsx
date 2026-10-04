'use client';

import { cn } from '@/lib/utils';
import {
  costAgainstPrice, costProfitSplit, costRows, depositSplit, estimateExpiresOn, formatDate, formatMoney, formatMoneyWhole,
  formatPct, jobActuals, marginLadder, marginTone, priceBreakdown, priceScenarios, scopeLabel, toNumber, type CostRow,
} from '@/lib/estimator';
import { useIsEstimatorManager } from '../EstimatorShell';
import type { EstimateWorkspace } from './useEstimateWorkspace';
import { CustomerCard, ScopeCard } from './parts';
import ReportsPanel from './ReportsPanel';
import {
  Alert, Card, CardBody, CardFooterRow, CardHeader, DataTable, Field, FieldGrid, Note, NumInput, Pill, ReadOnly, SEGMENT_COLORS,
  StackedBar, StatTiles, TONE_TEXT, controlClass, type Tile,
} from './ui';

// The original's combined estimate / review screen (ti) and its panels:
// price recap, revision history, where the price goes (tr), cost/profit
// split (tn), internal cost (tl), cost against price (e9), price scenarios
// (ts), actual job cost (to) and proposal terms.

const segs = (list: { label: string; value: number }[]) => list.map((s, i) => ({ ...s, color: SEGMENT_COLORS[i] }));

function PriceRecap({ ws }: { ws: EstimateWorkspace }) {
  const t = ws.totals!;
  const pricing = ws.pricing;
  type Row = { key: string; item: string; qty?: string; muted?: boolean; amount: string };
  const rows: Row[] = [];
  t.roof.sections
    .filter((s) => s.total > 0)
    .forEach((s) => {
      const sec = s.section;
      const stories = toNumber(sec.stories);
      rows.push({
        key: 'sec-' + s.id,
        item: `${s.name} — ${[pricing.mfrs[sec.mfr]?.label ?? sec.mfr, sec.product].filter(Boolean).join(' ')} · ${toNumber(sec.pitch)}/12 · ${stories} ${stories === 1 ? 'story' : 'stories'}`,
        qty: s.billable.toFixed(2) + ' sq',
        amount: formatMoney(s.total),
      });
    });
  if (t.roof.itemsTotal) {
    rows.push({ key: 'ri', item: 'Roofing line items', qty: t.roof.items.filter((i) => i.on).length + ' items', muted: true, amount: formatMoney(t.roof.itemsTotal) });
  }
  t.gutter.runs
    .filter((r) => r.total > 0)
    .forEach((r) => {
      rows.push({
        key: 'run-' + r.id,
        item: `${r.name} — ${pricing.gutter[r.run.size]?.label ?? r.run.size}${r.run.mode === 'labor' ? ' (labor only)' : r.run.mode === 'material' ? ' (material only)' : ''}`,
        qty: r.lf.toFixed(0) + ' LF',
        amount: formatMoney(r.total),
      });
    });
  if (t.gutter.itemsTotal) {
    rows.push({ key: 'gi', item: 'Gutter accessories', qty: t.gutter.items.filter((i) => i.on).length + ' items', muted: true, amount: formatMoney(t.gutter.itemsTotal) });
  }
  if (t.roof.upgrades + t.gutter.upgrades) rows.push({ key: 'up', item: 'Optional upgrades', amount: formatMoney(t.roof.upgrades + t.gutter.upgrades) });
  if (t.discounts) rows.push({ key: 'disc', item: 'Discounts', amount: '-' + formatMoney(t.discounts) });
  if (t.adjustments) rows.push({ key: 'adj', item: 'Manual adjustments', amount: formatMoney(t.adjustments) });
  if (t.tax) rows.push({ key: 'tax', item: `Sales tax (${formatPct(t.taxRate)})`, amount: formatMoney(t.tax) });
  return (
    <Card>
      <CardHeader title="Price recap" sub="Edit details on the Roof and Gutter pages" />
      <DataTable
        rows={rows}
        rowKey={(r) => r.key}
        columns={[
          { header: 'Item', mobile: 'title', cell: (r) => r.item },
          { header: 'Quantity', right: true, cell: (r) => <span className={cn(r.muted && 'text-gray-500')}>{r.qty ?? ''}</span>, mobile: '' },
          { header: 'Amount', right: true, cell: (r) => r.amount, mobile: '' },
        ]}
      />
      <CardFooterRow label={<b className="text-gray-900">Total selling price</b>} value={formatMoney(t.sell)} strong />
    </Card>
  );
}

function RevisionHistory({ ws }: { ws: EstimateWorkspace }) {
  const revs = ws.est!.revisions || [];
  if (!revs.length) return null;
  return (
    <Card>
      <CardHeader title="Revision history" sub="what changed between saves" />
      <DataTable
        rows={revs.slice().reverse()}
        rowKey={(_, i) => i}
        columns={[
          { header: 'When', cell: (r) => formatDate(r.at.slice(0, 10)), mobile: 'title' },
          { header: 'Who', cell: (r) => r.who },
          { header: 'From', right: true, cell: (r) => formatMoney(r.from) },
          { header: 'To', right: true, cell: (r) => formatMoney(r.to) },
          {
            header: 'Δ',
            right: true,
            cell: (r) => (
              <span className={r.to >= r.from ? 'text-emerald-600' : 'text-red-600'}>
                {r.to >= r.from ? '+' : ''}
                {formatMoney(r.to - r.from)}
              </span>
            ),
          },
        ]}
      />
    </Card>
  );
}

function WherePriceGoes({ ws }: { ws: EstimateWorkspace }) {
  const b = priceBreakdown(ws.totals!);
  if (!b) return null;
  return (
    <Card>
      <CardHeader title="Where the price goes" sub="tap or hover a block for the exact figure" />
      <CardBody className="flex flex-col gap-3">
        <StackedBar segments={segs(b.segments)} total={b.total} />
        {b.overshoot > 0.01 ? (
          <div className="text-[13px] text-gray-500">
            Discounts and downward adjustments then take off {formatMoney(b.overshoot)}, landing the contract at{' '}
            <b className="tabular-nums text-gray-900">{formatMoney(ws.totals!.sell)}</b>.
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function CostProfitSplit({ ws }: { ws: EstimateWorkspace }) {
  const s = costProfitSplit(ws.totals!);
  if (!s) return null;
  const total = s.segments.reduce((a, x) => a + x.value, 0);
  return (
    <Card>
      <CardHeader title="The selling price, split into cost and profit" right={<Pill tone="mut">manager view</Pill>} />
      <CardBody className="flex flex-col gap-3">
        <StackedBar segments={segs(s.segments)} total={total} />
        {s.loss > 0 ? (
          <Alert level="bad">
            This job is under water: costs exceed the selling price by {formatMoney(s.loss)} — no profit block to draw.
          </Alert>
        ) : null}
      </CardBody>
    </Card>
  );
}

function InternalCost({ ws }: { ws: EstimateWorkspace }) {
  const est = ws.est!;
  const t = ws.totals!;
  const rows = costRows(est, ws.pricing, t);
  const override = (r: CostRow) => (
    <NumInput
      ariaLabel={r.label + ' override'}
      className="!min-h-[38px] py-1"
      value={r.override === null ? '' : r.override}
      blankable
      placeholder="auto"
      onChange={(v) => ws.update(`costs.overrides.${r.key}`, v)}
    />
  );
  return (
    <Card>
      <CardHeader title="Internal estimated cost" right={<Pill tone="mut">Never shown to the customer</Pill>} />
      {/* md and up: table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gray-50 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              <th className="border-b border-gray-200 px-3 py-2 text-left">Cost element</th>
              <th className="border-b border-gray-200 px-3 py-2 text-right">Auto</th>
              <th className="w-[130px] border-b border-gray-200 px-3 py-2 text-right">Override</th>
              <th className="border-b border-gray-200 px-3 py-2 text-right">Used</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="align-top">
                <td className="border-b border-gray-100 px-3 py-2">
                  {r.label}
                  {r.note ? <div className="mt-0.5 text-[11.5px] text-gray-500">{r.note}</div> : null}
                </td>
                <td className="border-b border-gray-100 px-3 py-2 text-right tabular-nums text-gray-500">{formatMoney(r.auto)}</td>
                <td className="border-b border-gray-100 px-3 py-1.5">{override(r)}</td>
                <td className="border-b border-gray-100 px-3 py-2 text-right tabular-nums">{formatMoney(r.used)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* phones: one block per cost element */}
      <ul className="divide-y divide-gray-100 md:hidden">
        {rows.map((r) => (
          <li key={r.key} className="px-4 py-3">
            <div className="text-sm font-medium text-gray-900">{r.label}</div>
            {r.note ? <div className="mt-0.5 text-[11.5px] text-gray-500">{r.note}</div> : null}
            <div className="mt-2 grid grid-cols-3 items-end gap-2 text-sm">
              <div>
                <div className="text-[11px] text-gray-500">Auto</div>
                <div className="py-2 tabular-nums text-gray-500">{formatMoney(r.auto)}</div>
              </div>
              <div>
                <div className="text-[11px] text-gray-500">Override</div>
                {override(r)}
              </div>
              <div className="text-right">
                <div className="text-[11px] text-gray-500">Used</div>
                <div className="py-2 tabular-nums text-gray-900">{formatMoney(r.used)}</div>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <CardFooterRow label={<b className="text-gray-900">Total estimated cost</b>} value={formatMoney(t.totalCost)} strong />
      <CardBody>
        <Field label="Cost notes">
          <textarea
            className={cn(controlClass, 'min-h-[86px]')}
            placeholder="Anything a reviewer needs to know about these numbers"
            value={est.costs.notes || ''}
            onChange={(e) => ws.update('costs.notes', e.target.value)}
          />
        </Field>
      </CardBody>
    </Card>
  );
}

// e9 (combined page variant, with the explanatory note).
function CostAgainstPrice({ ws }: { ws: EstimateWorkspace }) {
  const est = ws.est!;
  const t = ws.totals!;
  const pricing = ws.pricing;
  const cap = costAgainstPrice(est, pricing, t);
  const ladder = marginLadder(est, pricing, t);
  const per = (v: number | null) => (v === null ? '—' : formatMoney(v));
  const bold = (label: string) => label === 'Real cost, all in';
  return (
    <Card>
      <CardHeader
        title="Cost against price"
        right={<Pill tone={cap.tone}>cost is {t.sell ? formatPct(100 * cap.ratio) : '—'} of price</Pill>}
      />
      <DataTable
        rows={cap.rows}
        rowKey={(r) => r.label}
        columns={[
          { cell: (r) => <span className={cn(bold(r.label) && 'font-semibold')}>{r.label}</span>, mobile: 'title' },
          { header: 'Amount', right: true, cell: (r) => <span className={cn(bold(r.label) && 'font-semibold')}>{formatMoney(r.amount)}</span> },
          { header: 'Per square', right: true, cell: (r) => per(r.perSquare) },
          { header: 'Per LF', right: true, cell: (r) => per(r.perLF) },
        ]}
        footer={
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-100 px-3 py-2 text-sm md:px-3 max-md:px-4">
            <b>Cost ÷ price</b>
            <b className="tabular-nums">{t.sell ? formatPct(100 * cap.ratio) : '—'}</b>
            <span className="text-xs text-gray-500">
              every dollar you charge, {t.sell ? formatMoney(cap.ratio) : '—'} goes straight back out
            </span>
          </div>
        }
      />
      <CardHeader
        className="border-t"
        title="What it has to sell for"
        sub="Overhead and commission are a share of the price, so these are solved, not just cost ÷ margin"
      />
      <DataTable
        rows={ladder}
        rowKey={(r) => r.target.margin}
        columns={[
          {
            header: 'To land at',
            mobile: 'title',
            cell: (r) =>
              r.target.margin === 0 ? <b>Break even — every dollar of cost covered, nothing left</b> : r.target.margin + '% gross margin',
          },
          { header: 'Total price', right: true, cell: (r) => formatMoney(r.target.price) },
          { header: 'Per square', right: true, cell: (r) => (t.roof.billable > 0 ? formatMoney(r.target.perSquare) : '—') },
          { header: 'Per LF', right: true, cell: (r) => (t.gutter.lf > 0 ? formatMoney(r.target.perLF) : '—') },
          {
            header: 'vs this estimate',
            right: true,
            cell: (r) => (
              <span className={r.target.delta > 0 ? 'text-red-600' : 'text-emerald-600'}>
                {r.target.delta > 0 ? '+' + formatMoney(r.target.delta) : formatMoney(r.target.delta)}
              </span>
            ),
          },
          { cell: (r) => <Pill tone={r.covered ? 'ok' : 'bad'}>{r.covered ? 'covered' : 'short'}</Pill>, mobile: '' },
        ]}
      />
      <CardBody>
        <Note>
          Break even is the price where gross profit is exactly zero — everything below it loses money before a single overhead
          dollar of the wider business is paid. The {toNumber(pricing.targets.minMargin)}% row is the company floor; the{' '}
          {toNumber(pricing.targets.goodMargin)}% row is where a job should land.
        </Note>
      </CardBody>
    </Card>
  );
}

function PriceScenarios({ ws }: { ws: EstimateWorkspace }) {
  const rows = priceScenarios(ws.est!, ws.pricing, ws.totals!);
  if (!rows) return null;
  return (
    <Card>
      <CardHeader title="Price scenarios" right={<Pill tone="mut">manager view</Pill>} />
      <DataTable
        phone="table"
        rows={rows}
        rowKey={(r) => r.changePct}
        rowClassName={(r) => (r.changePct === 0 ? 'bg-gray-100' : undefined)}
        columns={[
          { header: 'Move the price', cell: (r) => (r.changePct === 0 ? <b>As priced</b> : (r.changePct > 0 ? '+' : '') + r.changePct + '%') },
          { header: 'Contract', right: true, cell: (r) => formatMoney(r.price) },
          { header: 'Gross profit', right: true, cell: (r) => formatMoney(r.profit) },
          { header: 'Margin', right: true, cell: (r) => <span className={TONE_TEXT[marginTone(r.margin, ws.pricing)]}>{formatPct(r.margin)}</span> },
        ]}
        className="[&_td]:px-2 sm:[&_td]:px-3 [&_th]:px-2 sm:[&_th]:px-3"
      />
      <CardBody>
        <div className="text-xs text-gray-500">
          Scenario math only — it assumes the customer still signs. Win-rate response to price is not in this data, so the call is
          yours.
        </div>
      </CardBody>
    </Card>
  );
}

function ActualJobCost({ ws }: { ws: EstimateWorkspace }) {
  const est = ws.est!;
  const t = ws.totals!;
  const a = est.actuals || {};
  const j = jobActuals(est, t, ws.pricing);
  return (
    <Card>
      <CardHeader
        title="Actual job cost"
        right={
          j.hasActuals ? (
            <Pill tone={j.tone}>
              actual {formatPct(j.actualMargin)} vs estimated {formatPct(t.margin)}
            </Pill>
          ) : (
            <Pill tone="mut">enter after the job closes</Pill>
          )
        }
      />
      <CardBody className="flex flex-col gap-3">
        {j.isClosed ? null : (
          <div className="text-[13px] text-gray-500">
            Mark the estimate accepted or completed, then record what the job really cost — the variance is how the cost library
            stays honest.
          </div>
        )}
        <FieldGrid>
          <Field label="Actual material $">
            <NumInput value={a.material ?? ''} blankable onChange={(v) => ws.edit((d) => void ((d.actuals = d.actuals || {}).material = v))} />
          </Field>
          <Field label="Actual labor $">
            <NumInput value={a.labor ?? ''} blankable onChange={(v) => ws.edit((d) => void ((d.actuals = d.actuals || {}).labor = v))} />
          </Field>
          <Field label="Everything else $">
            <NumInput value={a.other ?? ''} blankable onChange={(v) => ws.edit((d) => void ((d.actuals = d.actuals || {}).other = v))} />
          </Field>
        </FieldGrid>
        {j.hasActuals ? (
          <div className="overflow-hidden rounded-lg border border-gray-200 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-gray-100 px-3 py-2">
              <span className="text-gray-700">Estimated cost → actual cost</span>
              <span className="tabular-nums">
                {formatMoney(t.totalCost)} → <b>{formatMoney(j.actualCost)}</b>{' '}
                <span className={cn('ml-2', j.underEstimate ? 'text-emerald-600' : 'text-red-600')}>
                  {j.underEstimate ? '−' : '+'}
                  {formatMoney(j.variance)}
                </span>
              </span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2">
              <span className="text-gray-700">Estimated margin → actual margin</span>
              <span className="tabular-nums">
                {formatPct(t.margin)} → <b>{formatPct(j.actualMargin)}</b> <span className="ml-2">{formatMoney(j.kept)} kept</span>
              </span>
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function ProposalTerms({ ws }: { ws: EstimateWorkspace }) {
  const est = ws.est!;
  const t = ws.totals!;
  const { deposit, balance } = depositSplit(t.sell, est.proposal.depositPct);
  return (
    <Card>
      <CardHeader title="Proposal terms" />
      <CardBody className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Deposit %">
            <NumInput value={toNumber(est.proposal.depositPct)} onChange={(v) => ws.update('proposal.depositPct', v)} />
          </Field>
          <Field label="Deposit amount">
            <ReadOnly numeric value={formatMoney(deposit)} />
          </Field>
          <Field label="Balance at completion">
            <ReadOnly numeric value={formatMoney(balance)} />
          </Field>
        </div>
        <Field label="Notes shown to the customer">
          <textarea
            className={cn(controlClass, 'min-h-[86px]')}
            placeholder="Scope notes, colour selections, scheduling"
            value={est.proposal.notes || ''}
            onChange={(e) => ws.update('proposal.notes', e.target.value)}
          />
        </Field>
      </CardBody>
    </Card>
  );
}

export default function CombinedEstimate({ ws }: { ws: EstimateWorkspace }) {
  const isManager = useIsEstimatorManager();
  const est = ws.est!;
  const t = ws.totals!;
  const pricing = ws.pricing;
  const tone = marginTone(t.margin, pricing);
  const tiles: Tile[] = isManager
    ? [
        { label: 'Total selling price', value: formatMoneyWhole(t.sell), sub: scopeLabel(est.scope) },
        { label: 'Estimated cost', value: formatMoneyWhole(t.totalCost), sub: t.sell ? formatPct((t.totalCost / t.sell) * 100) + ' of price' : '—' },
        { label: 'Gross profit', value: formatMoneyWhole(t.grossProfit), sub: formatPct(t.margin) + ' margin', tone },
        { label: 'Markup on cost', value: formatPct(t.markup), sub: `Target ≥ ${pricing.targets.minMargin}% margin` },
      ]
    : [
        { label: 'Total selling price', value: formatMoneyWhole(t.sell), sub: scopeLabel(est.scope) },
        { label: 'Effective $/square', value: t.roof.billable ? formatMoneyWhole(t.effectivePerSquare) : '—', sub: t.roof.billable.toFixed(2) + ' billable squares' },
        { label: 'Effective $/LF', value: t.gutter.lf ? formatMoney(t.effectivePerLF) : '—', sub: t.gutter.lf.toFixed(0) + ' gutter LF' },
        { label: 'Status', value: <span className="capitalize">{est.status}</span>, sub: 'expires ' + formatDate(estimateExpiresOn(est)) },
      ];
  return (
    <>
      <StatTiles items={tiles} />
      <CustomerCard ws={ws} />
      <ScopeCard ws={ws} />
      <ReportsPanel ws={ws} />
      <PriceRecap ws={ws} />
      {isManager ? <RevisionHistory ws={ws} /> : null}
      <WherePriceGoes ws={ws} />
      {isManager ? <CostProfitSplit ws={ws} /> : null}
      {isManager ? <InternalCost ws={ws} /> : null}
      {isManager ? <CostAgainstPrice ws={ws} /> : null}
      {isManager ? <PriceScenarios ws={ws} /> : null}
      {isManager ? <ActualJobCost ws={ws} /> : null}
      <ProposalTerms ws={ws} />
    </>
  );
}
