'use client';

import { useState } from 'react';
import { Download, Lock, RotateCcw, Unlock } from 'lucide-react';
import {
  ADMIN_FIELD_GROUPS, auditPathLabel, auditToCsv, COMPANY_FIELDS, formatDate, formatMoney, getPath, isPricingStale,
  manufacturerFieldGroups, MANUFACTURER_RANGE_NOTE, maxPitchSurcharge, pricingAgeDays, toNumber, type AdminField,
  type AdminFieldGroup,
} from '@/lib/estimator';
import { useEstimatorStore, useEstimatorUser } from '@/store/estimator';
import {
  Button, Card, CardBody, CardHeader, CollapsibleCard, CommitTextInput, Field, Notice, NumberInput, Pill, Tip, inputCls,
} from './ui';

// Admin pricing (managers only): every rule the calculator uses, the
// company details printed on proposals, and the price-change log. Editing
// is locked until unlocked, as in the original; every change is logged with
// the CRM user who made it.

const FIELD_GRID = 'grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4';

function groupByTitle(title: string): AdminFieldGroup {
  const g = ADMIN_FIELD_GROUPS.find((x) => x.title === title);
  if (!g) throw new Error('Missing admin field group: ' + title);
  return g;
}

function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function AdminPricing() {
  const pricing = useEstimatorStore((s) => s.pricing);
  const audit = useEstimatorStore((s) => s.audit);
  const updatePricing = useEstimatorStore((s) => s.updatePricing);
  const resetPricing = useEstimatorStore((s) => s.resetPricing);
  const user = useEstimatorUser();
  const [unlocked, setUnlocked] = useState(false);
  const [flash, setFlash] = useState('');

  const change = (path: string, value: unknown) => updatePricing(path, value, user);

  const field = (f: AdminField) =>
    f.options ? (
      <Field key={f.path} label={f.label}>
        <select
          className={inputCls}
          disabled={!unlocked}
          value={String(getPath(pricing, f.path))}
          onChange={(e) => change(f.path, e.target.value)}
        >
          {f.options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </Field>
    ) : (
      <Field key={f.path} label={f.label}>
        <NumberInput
          ariaLabel={f.label}
          commitOnBlur
          disabled={!unlocked}
          value={toNumber(getPath(pricing, f.path))}
          onChange={(v) => change(f.path, v)}
        />
      </Field>
    );

  const grid = (fields: AdminField[]) => <div className={FIELD_GRID}>{fields.map(field)}</div>;

  const roofRules = groupByTitle('Roof add-on rules');
  const roofItems = groupByTitle('Roofing optional line-item pricing');
  const g6 = groupByTitle('6" Seamless K-Style');
  const g7 = groupByTitle('7" Seamless / Box');
  const gutterAddOns = groupByTitle('Labor-only & add-ons');
  const costs = groupByTitle('Internal cost assumptions');
  const targets = groupByTitle('Targets & thresholds');
  const firstBasis = costs.fields.findIndex((f) => f.path === 'cost.commissionBasis');

  const stale = isPricingStale(pricing);
  const age = pricingAgeDays(pricing);

  return (
    <div className="flex flex-col gap-4">
      {stale ? (
        <Notice level="warn" title="Pricing may be out of date">
          Last verified {formatDate(pricing.version)} ({age} days ago). ABC Supply raised residential roofing 6–10% on 1 June 2026
          and 6–10% on 13 April 2026 — re-check material cost per square before quoting.
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="Editing"
          right={
            <>
              <Pill tone={unlocked ? 'warn' : 'mut'}>{unlocked ? 'Unlocked — changes are logged' : 'Locked'}</Pill>
              <Button size="sm" variant={unlocked ? 'default' : 'primary'} onClick={() => setUnlocked(!unlocked)}>
                {unlocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                {unlocked ? 'Lock' : 'Unlock editing'}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  if (confirm('Reset every pricing rule to the seeded defaults? The change log is kept.')) {
                    resetPricing(user);
                    setFlash('Pricing reset to defaults');
                  }
                }}
              >
                <RotateCcw className="h-4 w-4" /> Reset to defaults
              </Button>
            </>
          }
        />
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Recorded in the change log as" hint="Your CRM account. Switch user from the sidebar.">
              <input className={inputCls} readOnly value={user?.name || 'Manager'} />
            </Field>
            <Field label="Pricing verified on">
              <CommitTextInput
                type="date"
                disabled={!unlocked}
                value={pricing.version}
                onCommit={(v) => v && change('version', v)}
              />
            </Field>
          </div>
          {flash ? <Notice level="ok">{flash}</Notice> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Rep / manager access" right={<Pill tone="ok">CRM roles</Pill>} />
        <CardBody>
          <div className="max-w-[80ch] text-[13px] text-gray-700">
            Access follows the CRM account. Sales reps work in <b>rep view</b>: no internal costs, no profit or margin, no material
            or labor $/sq, and no Admin, Historical, Market or Job-Cost pages, and they see only their own estimates. Managers see
            every estimate and the full cost side. The old estimator{"'"}s manager PIN and rep profiles are replaced by CRM sign-in.
          </div>
        </CardBody>
      </Card>

      <CollapsibleCard title="Manufacturer price levels & approved ranges" open>
        {manufacturerFieldGroups(pricing.mfrs).map((g) => (
          <div key={g.title} className="flex flex-col gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">{g.title}</div>
            {grid(g.fields)}
          </div>
        ))}
        <Tip>{MANUFACTURER_RANGE_NOTE}</Tip>
      </CollapsibleCard>

      <CollapsibleCard title={roofRules.title}>
        {grid(roofRules.fields)}
        <Tip>
          Formula in use:{' '}
          <span className="font-mono text-[12px]">
            pitch surcharge per square = max(0, pitch numerator − {toNumber(pricing.roof.pitchFreeUpTo)}) ×{' '}
            {formatMoney(pricing.roof.pitchStep)}
          </span>
          . At the current settings a 12/12 adds {formatMoney(maxPitchSurcharge(pricing))}/sq.
        </Tip>
      </CollapsibleCard>

      <CollapsibleCard title={roofItems.title}>
        {grid(roofItems.fields)}
        {roofItems.note ? <Tip>{roofItems.note}</Tip> : null}
      </CollapsibleCard>

      <CollapsibleCard title="Gutter pricing">
        {(
          [
            ['6-inch', g6],
            ['7-inch', g7],
            ['Labor-only & add-ons', gutterAddOns],
          ] as [string, AdminFieldGroup][]
        ).map(([label, g]) => (
          <div key={label} className="flex flex-col gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</div>
            {grid(g.fields)}
          </div>
        ))}
      </CollapsibleCard>

      <CollapsibleCard title={costs.title}>
        {grid(costs.fields.slice(0, firstBasis))}
        {grid(costs.fields.slice(firstBasis))}
        {costs.note ? <Tip>{costs.note}</Tip> : null}
      </CollapsibleCard>

      <CollapsibleCard title={targets.title}>{grid(targets.fields)}</CollapsibleCard>

      <CollapsibleCard title="Company details on the proposal">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {COMPANY_FIELDS.map((f) => (
            <Field key={f.path} label={f.label}>
              <CommitTextInput
                disabled={!unlocked}
                value={String(getPath(pricing, f.path) ?? '')}
                onCommit={(v) => change(f.path, v)}
              />
            </Field>
          ))}
        </div>
      </CollapsibleCard>

      <Card>
        <CardHeader title="Price change log" sub={`${audit.length} entries`} />
        <CardBody>
          {audit.length ? (
            <div className="flex flex-col gap-2.5">
              {audit.slice(0, 60).map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-col gap-1 border-b border-gray-100 pb-2.5 sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-3"
                >
                  <div className="whitespace-nowrap text-xs tabular-nums text-gray-500">
                    {new Date(entry.at).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </div>
                  <div className="min-w-0 break-words text-[13px] text-gray-800">
                    <b>{auditPathLabel(entry.path)}</b> changed from <span className="tabular-nums">{String(entry.before)}</span> to{' '}
                    <span className="font-medium tabular-nums text-blue-800">{String(entry.after)}</span>
                    <div className="text-xs text-gray-500">by {entry.who}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[13px] text-gray-500">No pricing changes recorded yet.</div>
          )}
        </CardBody>
        {audit.length ? (
          <div className="flex justify-end border-t border-gray-100 bg-gray-50/60 px-4 py-2.5">
            <Button
              size="sm"
              onClick={() => downloadText(`price-change-log-${new Date().toISOString().slice(0, 10)}.csv`, auditToCsv(audit))}
            >
              <Download className="h-4 w-4" /> Export log
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
