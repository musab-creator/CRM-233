'use client';

import { Fragment, useMemo } from 'react';
import Link from 'next/link';
import { Check as CheckIcon, ExternalLink, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCRMStore } from '@/store';
import {
  AERIAL_COUNT_ITEMS, CONFIDENCE_LEVELS, ESTIMATE_STATUSES, estimateExpiresOn, estimateSteps, estimateWarnings,
  formatDate, formatMoney, formatMoneyWhole, formatPct, gutterItemQty, marginTone, measurementConfidence,
  satelliteViewUrl, sellForTargets, setAccessoryCount, setDownspoutSize, toNumber, visibleWarnings,
  type AmountLine, type Estimate, type EstimateScope, type LineItem,
} from '@/lib/estimator';
import { useIsEstimatorManager } from '../EstimatorShell';
import type { EstimateWorkspace } from './useEstimateWorkspace';
import {
  Alert, Button, Card, CardBody, CardHeader, Eyebrow, Field, FieldGrid, KV, MarginBar, NumInput, Pill, ReadOnly, Select,
  TextInput, buttonClass,
} from './ui';

export type EstimateView = 'combined' | 'roof' | 'gutter';

export function estimateHref(id: string, view: EstimateView | 'proposal' | 'job-cost') {
  return view === 'combined' ? `/estimator/${id}` : `/estimator/${id}/${view}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ==================== STEP BAR (e6) ====================

export function StepBar({ ws, view }: { ws: EstimateWorkspace; view: EstimateView }) {
  if (!ws.est || !ws.totals) return null;
  const steps = estimateSteps(ws.est, ws.totals, view);
  return (
    <nav className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-label="Estimate steps">
      <div className="flex w-max items-center gap-1.5 py-0.5">
        {steps.map((s, i) => (
          <Fragment key={i}>
            <Link
              href={estimateHref(ws.est!.id, s.view as EstimateView)}
              aria-current={s.active ? 'step' : undefined}
              className={cn(
                'inline-flex min-h-[36px] items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-[13px] font-semibold',
                s.active
                  ? 'border-orange-600 bg-orange-600 text-white'
                  : s.done
                    ? 'border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50'
                    : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50',
              )}
            >
              <span className="tabular-nums">{s.done ? <CheckIcon className="h-3.5 w-3.5" /> : s.n}</span>
              {s.label}
            </Link>
            {i < steps.length - 1 ? <span className="text-gray-400">→</span> : null}
          </Fragment>
        ))}
      </div>
    </nav>
  );
}

// ==================== CUSTOMER & PROPERTY (e0) ====================

// A CRM lead whose homeowner matches the estimate's customer (name or street).
function useMatchingLead(est: Estimate) {
  const homeowners = useCRMStore((s) => s.homeowners);
  const leads = useCRMStore((s) => s.leads);
  const name = est.customer.name.trim().toLowerCase();
  const street = est.customer.address.trim().toLowerCase();
  return useMemo(() => {
    if (!name && !street) return null;
    const ho = homeowners.find(
      (h) =>
        (name && `${h.firstName} ${h.lastName}`.trim().toLowerCase() === name) ||
        (street && h.address.trim().toLowerCase() === street),
    );
    if (!ho) return null;
    const lead = leads.find((l) => l.homeownerId === ho.id);
    return lead ? { id: lead.id, label: `${ho.firstName} ${ho.lastName}` } : null;
  }, [homeowners, leads, name, street]);
}

export function CustomerCard({ ws }: { ws: EstimateWorkspace }) {
  const est = ws.est!;
  const c = est.customer;
  const lead = useMatchingLead(est);
  const set = ws.update;
  return (
    <Card>
      <CardHeader
        title="Customer & property"
        right={
          <>
            {lead ? (
              <Link
                href={`/leads/${lead.id}`}
                className="inline-flex min-h-[32px] items-center gap-1 rounded-md px-2 text-xs font-semibold text-orange-700 hover:bg-orange-50"
                title={`Open the CRM lead for ${lead.label}`}
              >
                <UserRound className="h-3.5 w-3.5" /> CRM lead
              </Link>
            ) : null}
            <Pill tone="mut">{est.number}</Pill>
          </>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <FieldGrid min={170}>
          <Field label="Customer name">
            <TextInput value={c.name} placeholder="Full name" onChange={(e) => set('customer.name', e.target.value)} />
          </Field>
          <Field label="Phone">
            <TextInput type="tel" inputMode="tel" value={c.phone} placeholder="(904) 555-0100" onChange={(e) => set('customer.phone', e.target.value)} />
          </Field>
          <Field label="Email">
            <TextInput type="email" inputMode="email" value={c.email} placeholder="name@email.com" onChange={(e) => set('customer.email', e.target.value)} />
          </Field>
        </FieldGrid>
        <Field label="Property address">
          <TextInput value={c.address} placeholder="Street address" onChange={(e) => set('customer.address', e.target.value)} />
        </Field>
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-3">
          <Field label="City">
            <TextInput value={c.city} onChange={(e) => set('customer.city', e.target.value)} />
          </Field>
          <Field label="State">
            <TextInput value={c.state} onChange={(e) => set('customer.state', e.target.value)} />
          </Field>
          <Field label="ZIP">
            <TextInput inputMode="numeric" value={c.zip} onChange={(e) => set('customer.zip', e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Estimate date">
            <TextInput type="date" value={est.date} onChange={(e) => set('date', e.target.value)} />
          </Field>
          <Field label="Valid for (days)">
            <NumInput value={toNumber(est.validDays)} onChange={(v) => set('validDays', v)} />
          </Field>
          <Field label="Expires">
            <ReadOnly value={formatDate(estimateExpiresOn(est))} />
          </Field>
          <Field label="Status">
            <Select value={est.status} onChange={(v) => set('status', v)}>
              {ESTIMATE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {capitalize(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </CardBody>
    </Card>
  );
}

// ==================== SCOPE & CONFIDENCE (eZ, eK) ====================

export function ConfidencePill({ est }: { est: Pick<Estimate, 'confidence' | 'takeoff'> }) {
  const level = CONFIDENCE_LEVELS[measurementConfidence(est)];
  return (
    <Pill tone={level.tone} title={level.note}>
      {level.label}
    </Pill>
  );
}

const SCOPES: [EstimateScope, string][] = [
  ['roof', 'Roofing only'],
  ['gutter', 'Gutters only'],
  ['both', 'Roofing + gutters'],
];

export function ScopeCard({ ws }: { ws: EstimateWorkspace }) {
  const est = ws.est!;
  return (
    <Card>
      <CardHeader
        title="Scope of work"
        right={
          <div className="flex items-center gap-2">
            <ConfidencePill est={est} />
            <Select
              ariaLabel="Measurement confidence"
              className="!min-h-[36px] max-w-[200px] py-1 text-[13px]"
              value={est.confidence || ''}
              onChange={(v) => ws.update('confidence', v)}
            >
              <option value="">Auto ({est.takeoff ? 'measured' : 'rough'})</option>
              <option value="rough">Rough — hand-measured</option>
              <option value="measured">Measured — report</option>
              <option value="verified">Site-verified</option>
            </Select>
          </div>
        }
      />
      <CardBody>
        <div className="grid grid-cols-3 gap-2">
          {SCOPES.map(([scope, label]) => {
            const on = est.scope === scope;
            return (
              <button
                key={scope}
                type="button"
                aria-pressed={on}
                onClick={() => ws.update('scope', scope)}
                className={cn(
                  'min-h-[46px] rounded-lg border px-2 text-[13px] font-semibold leading-tight transition-colors',
                  on ? 'border-orange-600 bg-orange-600 text-white' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}

// ==================== LINE ITEMS (e1) ====================

export function LineItems({
  ws, kind, prefix,
}: {
  ws: EstimateWorkspace;
  kind: 'Roofing' | 'Gutter';
  prefix: 'roof.items' | 'gutter.items';
}) {
  const est = ws.est!;
  const pricing = ws.pricing;
  const items = (prefix === 'roof.items' ? est.roof.items : est.gutter.items) as LineItem[];
  const set = ws.update;

  const downspoutControls = (it: LineItem, i: number) =>
    it.k === 'ds' && it.meta ? (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
        <Select
          ariaLabel="Downspout size"
          className="!min-h-[36px] !w-auto py-1 text-[13px]"
          value={it.meta.size}
          onChange={(size) => ws.edit((d) => setDownspoutSize(d, size, pricing))}
        >
          {Object.keys(pricing.gutter.downspouts).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
        <div className="w-[64px]">
          <NumInput ariaLabel="Downspout count" className="!min-h-[36px] py-1 text-[13px]" value={toNumber(it.meta.count)} onChange={(v) => set(`${prefix}.${i}.meta.count`, v)} />
        </div>
        <span>×</span>
        <div className="w-[64px]">
          <NumInput ariaLabel="Feet per drop" className="!min-h-[36px] py-1 text-[13px]" value={toNumber(it.meta.len)} onChange={(v) => set(`${prefix}.${i}.meta.len`, v)} />
        </div>
        <span>ft</span>
      </div>
    ) : null;

  return (
    <div>
      <div className="hidden grid-cols-[34px_minmax(0,1fr)_104px_42px_104px_104px] gap-x-2 border-b border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500 md:grid">
        <span />
        <span>{kind} line items</span>
        <span className="text-right">Qty</span>
        <span />
        <span className="text-right">Rate</span>
        <span className="text-right">Amount</span>
      </div>
      <ul className="divide-y divide-gray-100">
        {items.map((it, i) => {
          const isDs = it.k === 'ds';
          const qty = prefix === 'gutter.items' ? gutterItemQty(it) : toNumber(it.qty);
          const amount = it.on ? qty * toNumber(it.rate) : 0;
          const checkbox = (
            <input
              type="checkbox"
              checked={!!it.on}
              onChange={(e) => set(`${prefix}.${i}.on`, e.target.checked)}
              className="h-5 w-5 rounded border-gray-300 accent-orange-600"
              aria-label={'Include ' + it.label}
            />
          );
          const qtyControl = isDs ? (
            <span className="block py-2 text-right text-sm tabular-nums text-gray-700">{qty.toFixed(1)}</span>
          ) : (
            <NumInput ariaLabel={it.label + ' quantity'} className="!min-h-[38px] py-1" value={toNumber(it.qty)} onChange={(v) => set(`${prefix}.${i}.qty`, v)} />
          );
          const rateControl = (
            <NumInput ariaLabel={it.label + ' rate'} className="!min-h-[38px] py-1" value={toNumber(it.rate)} onChange={(v) => set(`${prefix}.${i}.rate`, v)} />
          );
          return (
            <li key={it.k} className={cn('px-3 py-2', !it.on && 'bg-white', it.on && 'bg-orange-50/30')}>
              {/* md and up: one table-like row */}
              <div className="hidden grid-cols-[34px_minmax(0,1fr)_104px_42px_104px_104px] items-start gap-x-2 md:grid">
                <div className="pt-2.5">{checkbox}</div>
                <div className="min-w-0 pt-2">
                  <span className="text-sm text-gray-900">{it.label}</span>
                  {downspoutControls(it, i)}
                </div>
                <div>{qtyControl}</div>
                <div className="pt-2.5 text-xs text-gray-500">{it.unit}</div>
                <div>{rateControl}</div>
                <div className="pt-2.5 text-right text-sm tabular-nums text-gray-900">{formatMoney(amount)}</div>
              </div>
              {/* phones: label row, then qty × rate */}
              <div className="md:hidden">
                <label className="flex min-h-[40px] items-center gap-3">
                  {checkbox}
                  <span className="min-w-0 flex-1 text-sm text-gray-900">{it.label}</span>
                  <span className="text-sm font-medium tabular-nums text-gray-900">{formatMoney(amount)}</span>
                </label>
                <div className="pl-8">
                  {downspoutControls(it, i)}
                  <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                    <div className="flex items-center gap-1.5">
                      {qtyControl}
                      <span className="w-9 flex-shrink-0 text-xs text-gray-500">{it.unit}</span>
                    </div>
                    <span className="text-xs text-gray-400">× $</span>
                    {rateControl}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ==================== UPGRADES, DISCOUNTS, ADJUSTMENTS (e2) ====================

export function AmountLines({ ws, scope }: { ws: EstimateWorkspace; scope: 'roof' | 'gutter' }) {
  const est = ws.est!;
  const group = (title: string, key: 'upgrades' | 'discounts' | 'adjustments', placeholder: string, note?: string) => {
    const lines: AmountLine[] = est[scope][key];
    return (
      <div className="flex flex-col gap-2">
        <Eyebrow>{title}</Eyebrow>
        {lines.length === 0 ? <div className="text-[13px] text-gray-500">None.</div> : null}
        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_110px] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_116px_auto]">
            <Field label={key === 'adjustments' ? 'Reason (required)' : 'Description'}>
              <TextInput
                value={line.label || ''}
                placeholder={placeholder}
                onChange={(e) => ws.update(`${scope}.${key}.${i}.label`, e.target.value)}
              />
            </Field>
            <Field label="Amount">
              <NumInput value={toNumber(line.amount)} onChange={(v) => ws.update(`${scope}.${key}.${i}.amount`, v)} />
            </Field>
            <Button
              size="sm"
              variant="danger"
              className="col-span-2 justify-self-end sm:col-span-1 sm:mb-0.5"
              onClick={() => ws.edit((d) => void d[scope][key].splice(i, 1))}
            >
              Remove
            </Button>
          </div>
        ))}
        <div>
          <Button size="sm" onClick={() => ws.edit((d) => void d[scope][key].push({ label: '', amount: 0 }))}>
            Add
          </Button>
        </div>
        {note ? <div className="text-[11.5px] text-gray-500">{note}</div> : null}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-5">
      {group('Optional upgrades', 'upgrades', 'e.g. upgrade to high-profile ridge')}
      {group('Discounts', 'discounts', 'e.g. repeat-customer discount', 'Enter a positive number. It is subtracted from the price.')}
      {group(
        'Manual adjustments',
        'adjustments',
        'Why this adjustment is being made',
        'Positive or negative. An explanation is required — blank reasons raise a warning.',
      )}
    </div>
  );
}

// ==================== AERIAL ACCESSORY COUNT (e8) ====================

export function AerialCount({ ws }: { ws: EstimateWorkspace }) {
  const est = ws.est!;
  const r = ws.pricing.roof;
  return (
    <Card>
      <CardHeader
        title="Aerial accessory count"
        right={
          <a
            className="inline-flex items-center gap-1 text-[13px] font-semibold text-orange-700 underline underline-offset-2"
            href={satelliteViewUrl(est)}
            target="_blank"
            rel="noopener"
          >
            Open satellite view <ExternalLink className="h-3.5 w-3.5" />
          </a>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div className="max-w-[80ch] text-[13px] text-gray-500">
          Open the property in satellite view and count what the measurement report cannot see priced: pipe boots, box/off-ridge
          vents, skylights and chimneys. Each count becomes a switched-on line item at the admin rate. GAF QuickMeasure reports
          include a penetration count; Roofr reports do not, so the aerial check is how those get on the estimate.
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {AERIAL_COUNT_ITEMS.map((a) => {
            const it = est.roof.items.find((i) => i.k === a.key);
            return (
              <Field
                key={a.key}
                label={
                  <>
                    {a.label} <span className="text-gray-400">@ {formatMoney(r[a.rate])}</span>
                  </>
                }
              >
                <NumInput
                  value={toNumber(it?.qty) || ''}
                  placeholder="0"
                  blankable
                  onChange={(v) => ws.edit((d) => setAccessoryCount(d, a.key, v))}
                />
              </Field>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}

// ==================== LIVE SUMMARY (e3, e4, e5, eJ) ====================

function SellFor({ ws }: { ws: EstimateWorkspace }) {
  const { est, totals, pricing } = ws;
  if (!est || !totals) return null;
  const t = sellForTargets(est, pricing, totals);
  if (!t) return null;
  const row = (label: string, price: number, delta: number, tone?: 'ok' | 'warn' | 'bad') => (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[13px]">
      <span className="text-gray-600">{label}</span>
      <span className={cn('tabular-nums', tone === 'ok' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : tone === 'bad' ? 'text-red-600' : 'text-gray-900')}>
        {formatMoney(price)}
        {delta !== 0 ? (
          <span className="text-gray-400">
            {' '}
            {delta > 0 ? '+' : ''}
            {formatMoneyWhole(delta)}
          </span>
        ) : null}
      </span>
    </div>
  );
  const min = toNumber(pricing.targets.minMargin);
  const good = toNumber(pricing.targets.goodMargin);
  return (
    <div className="mt-3 border-t border-gray-200 pt-3">
      <Eyebrow className="mb-1">What it has to sell for</Eyebrow>
      {row('Break even', t.breakEven.price, t.breakEven.delta)}
      {row(`At ${min}% margin`, t.atMin.price, t.atMin.delta, t.belowMin ? 'bad' : 'ok')}
      {row(`At ${good}% margin`, t.atGood.price, t.atGood.delta, t.belowGood ? 'warn' : 'ok')}
      {t.perSquareAtGood !== null ? row(`Needed $/sq at ${good}%`, t.perSquareAtGood, 0) : null}
      {t.perLFAtGood !== null ? row(`Needed $/LF at ${good}%`, t.perLFAtGood, 0) : null}
    </div>
  );
}

export function LiveSummary({ ws }: { ws: EstimateWorkspace }) {
  const isManager = useIsEstimatorManager();
  const { totals: t, pricing } = ws;
  if (!t) return null;
  const tone = marginTone(t.margin, pricing);
  return (
    <Card>
      <CardHeader title="Live summary" right={isManager ? <Pill tone={tone}>{formatPct(t.margin)} margin</Pill> : undefined} />
      <div className="px-4 py-3.5">
        <KV k="Roofing subtotal" v={formatMoney(t.roof.subtotal)} />
        <KV k="Gutter subtotal" v={formatMoney(t.gutter.subtotal)} />
        <KV k="Add-ons & upgrades" v={formatMoney(t.addOns)} />
        <KV k="Discounts" v={t.discounts ? '-' + formatMoney(t.discounts) : formatMoney(0)} />
        <KV k="Manual adjustments" v={formatMoney(t.adjustments)} />
        {t.tax ? <KV k={`Sales tax (${formatPct(t.taxRate)})`} v={formatMoney(t.tax)} /> : null}
        <KV k="Total selling price" v={formatMoney(t.sell)} strong />
        {isManager ? (
          <>
            <div className="mt-3 border-t border-gray-200 pt-2" />
            <KV
              k={
                <>
                  Estimated cost{' '}
                  {pricing.cost.overheadBasis === 'pct' ? (
                    <span className="text-gray-400">incl. {toNumber(pricing.cost.overheadPct)}% overhead</span>
                  ) : null}
                </>
              }
              v={formatMoney(t.totalCost)}
            />
            <KV k="Cost ÷ price" v={t.sell ? formatPct((t.totalCost / t.sell) * 100) : '—'} />
            <KV k="Gross profit" v={formatMoney(t.grossProfit)} tone={tone} />
            <MarginBar margin={t.margin} tone={tone} />
            <KV k="Gross margin" v={formatPct(t.margin)} tone={tone} />
            <KV k="Markup on cost" v={formatPct(t.markup)} />
            <SellFor ws={ws} />
          </>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-gray-200 bg-gray-200">
        {[
          { label: 'Eff. roof $/square', value: t.effectivePerSquare ? formatMoneyWhole(t.effectivePerSquare) : '—' },
          { label: 'Eff. gutter $/LF', value: t.effectivePerLF ? formatMoney(t.effectivePerLF) : '—' },
          { label: 'Billable squares', value: t.roof.billable.toFixed(2) },
          { label: 'Gutter linear ft', value: t.gutter.lf.toFixed(0) },
        ].map((x) => (
          <div key={x.label} className="bg-gray-50 px-3.5 py-2.5">
            <Eyebrow>{x.label}</Eyebrow>
            <div className="text-base font-semibold tabular-nums text-gray-900">{x.value}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function Checks({ ws }: { ws: EstimateWorkspace }) {
  const isManager = useIsEstimatorManager();
  const { est, totals, pricing } = ws;
  const warnings = useMemo(
    () => (est && totals ? visibleWarnings(estimateWarnings(est, pricing, totals), isManager) : []),
    [est, totals, pricing, isManager],
  );
  return (
    <Card>
      <CardHeader title="Checks" />
      <CardBody>
        {warnings.length ? (
          <div className="flex flex-col gap-2">
            {warnings.map((w, i) => (
              <Alert key={i} level={w.level} title={w.title}>
                {w.detail}
              </Alert>
            ))}
          </div>
        ) : (
          <Alert level="ok">No pricing or margin warnings on this estimate.</Alert>
        )}
      </CardBody>
    </Card>
  );
}

// The right-hand column of every estimate page (e4).
export function SummaryAside({ ws }: { ws: EstimateWorkspace }) {
  const isManager = useIsEstimatorManager();
  const id = ws.est!.id;
  return (
    <div className="flex flex-col gap-4">
      <LiveSummary ws={ws} />
      <Checks ws={ws} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => ws.save()}>
          Save estimate
        </Button>
        <Link href={estimateHref(id, 'proposal')} className={buttonClass('default')}>
          Proposal
        </Link>
        {isManager ? (
          <Link href={estimateHref(id, 'job-cost')} className={buttonClass('default')}>
            Job cost
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export { capitalize };
