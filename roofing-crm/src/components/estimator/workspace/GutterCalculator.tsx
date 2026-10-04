'use client';

import { Plus } from 'lucide-react';
import { formatMoney, gutterRunPreview, newGutterRun, toNumber, type GutterRun } from '@/lib/estimator';
import type { EstimateWorkspace } from './useEstimateWorkspace';
import { AmountLines, CustomerCard, LineItems, ScopeCard } from './parts';
import {
  Alert, Button, Card, CardBody, CardFooterRow, CardHeader, Check, DataTable, Eyebrow, Field, FieldGrid, NumInput, ReadOnly,
  Select, SubCard, TextInput,
} from './ui';

// The original's gutter calculator (tt).

function RunCard({ ws, run, index }: { ws: EstimateWorkspace; run: GutterRun; index: number }) {
  const pricing = ws.pricing;
  const g = pricing.gutter;
  const est = ws.est!;
  const product = g[run.size];
  const p = gutterRunPreview(pricing, run);
  const set = (field: keyof GutterRun, v: unknown) => ws.update(`gutter.runs.${index}.${field}`, v);
  const twoStory = toNumber(run.stories) >= 2;

  const rows = [
    {
      label: run.mode === 'labor' ? 'Labor-only installation' : run.mode === 'material' ? 'Material only' : 'New gutter — ' + (product?.label ?? run.size),
      lf: p.lf,
      rate: p.rate,
      amount: p.base,
    },
    ...(run.removal ? [{ label: 'Removal & disposal', lf: p.lf, rate: toNumber(g.removalLF), amount: p.removal }] : []),
    ...(p.guardLF ? [{ label: 'Gutter guards', lf: p.guardLF, rate: toNumber(g.guardLF), amount: p.guards }] : []),
    ...(twoStory ? [{ label: 'Two-story surcharge', lf: p.lf, rate: toNumber(g.story2LF), amount: p.story }] : []),
    ...(run.difficult ? [{ label: 'Difficult access', lf: p.lf, rate: toNumber(g.difficultLF), amount: p.difficult }] : []),
  ];

  return (
    <SubCard
      title={run.name}
      right={
        <>
          <span className="text-xs tabular-nums text-gray-500">{p.lf.toFixed(0)} LF</span>
          {est.gutter.runs.length > 1 ? (
            <Button size="sm" variant="danger" onClick={() => ws.edit((d) => void (d.gutter.runs = d.gutter.runs.filter((r) => r.id !== run.id)))}>
              Remove
            </Button>
          ) : null}
        </>
      }
      footer={<CardFooterRow label="Run total" value={formatMoney(p.total)} strong />}
    >
      <FieldGrid>
        <Field label="Run name">
          <TextInput value={run.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Gutter size">
          <Select value={run.size} onChange={(v) => set('size', v)}>
            <option value="g6">{g.g6.label}</option>
            <option value="g7">{g.g7.label}</option>
          </Select>
        </Field>
        <Field label="Linear feet">
          <NumInput value={toNumber(run.lf)} onChange={(v) => set('lf', v)} />
        </Field>
        <Field label="Work type">
          <Select value={run.mode} onChange={(v) => set('mode', v)}>
            <option value="new">New installation (material + labor)</option>
            <option value="labor">Labor only</option>
            <option value="material">Material only (customer installs)</option>
          </Select>
        </Field>
      </FieldGrid>
      <FieldGrid>
        {run.mode === 'labor' ? (
          <Field label="Labor rate $/LF">
            <Select value={String(toNumber(run.laborRate))} onChange={(v) => set('laborRate', toNumber(v))}>
              {g.laborOnly.options.map((o) => (
                <option key={o} value={o}>
                  {formatMoney(o)} / LF
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Selling price $/LF">
            <ReadOnly numeric value={formatMoney(toNumber(product?.sell))} />
          </Field>
        )}
        <Field label="Custom price $/LF (override)">
          <NumInput
            value={toNumber(run.sellOverride) || ''}
            blankable
            invalid={p.belowMinimum}
            placeholder={'blank = ' + formatMoney(p.rate)}
            onChange={(v) => set('sellOverride', v === '' ? 0 : v)}
          />
        </Field>
        <Field label="Color">
          <Select value={run.color} onChange={(v) => set('color', v)}>
            {g.colors.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Stories">
          <Select value={String(twoStory ? 2 : 1)} onChange={(v) => set('stories', toNumber(v))}>
            <option value="1">1 story</option>
            <option value="2">2+ story (+{formatMoney(g.story2LF)}/LF)</option>
          </Select>
        </Field>
      </FieldGrid>
      {p.belowMinimum ? (
        <Alert level="bad">
          {formatMoney(p.rate)}/LF is below the minimum selling price of {formatMoney(p.minimum)}/LF. Raise the price or get approval.
        </Alert>
      ) : null}
      <div className="flex flex-col gap-1">
        <Check checked={run.removal} onChange={(v) => set('removal', v)} label={<>Removal &amp; disposal of existing gutter ({formatMoney(g.removalLF)}/LF)</>} />
        <Check checked={run.guards} onChange={(v) => set('guards', v)} label={<>Gutter guards ({formatMoney(g.guardLF)}/LF)</>} />
        {run.guards ? (
          <Field label="Guard LF (blank = full run)" className="max-w-[220px]">
            <NumInput
              value={toNumber(run.guardLF) || ''}
              blankable
              placeholder={p.lf.toFixed(0)}
              onChange={(v) => set('guardLF', v === '' ? 0 : v)}
            />
          </Field>
        ) : null}
        <Check checked={run.difficult} onChange={(v) => set('difficult', v)} label={<>Difficult access (+{formatMoney(g.difficultLF)}/LF)</>} />
      </div>
      <div className="-mx-4 border-t border-gray-100">
        <DataTable
          phone="table"
          rows={rows}
          rowKey={(_, i) => i}
          columns={[
            { header: 'Component', cell: (r) => <span className="text-[13px]">{r.label}</span> },
            { header: 'LF', right: true, cell: (r) => r.lf.toFixed(0) },
            { header: 'Rate', right: true, cell: (r) => formatMoney(r.rate) },
            { header: 'Amount', right: true, cell: (r) => formatMoney(r.amount) },
          ]}
          className="text-[13px] [&_td]:px-2 sm:[&_td]:px-3 [&_th]:px-2 sm:[&_th]:px-3"
        />
      </div>
    </SubCard>
  );
}

export default function GutterCalculator({ ws }: { ws: EstimateWorkspace }) {
  const est = ws.est!;
  const t = ws.totals!;
  return (
    <>
      <CustomerCard ws={ws} />
      <ScopeCard ws={ws} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Eyebrow>Gutter runs</Eyebrow>
          <div className="text-[13px] text-gray-500">
            Downspouts, guards, fascia work and removal are never inside the base per-foot price — each is its own line.
          </div>
        </div>
        <Button onClick={() => ws.edit((d) => void d.gutter.runs.push(newGutterRun(ws.pricing, d.gutter.runs.length + 1)))}>
          <Plus className="h-4 w-4" /> Add gutter run
        </Button>
      </div>
      {est.gutter.runs.map((run, i) => (
        <RunCard key={run.id} ws={ws} run={run} index={i} />
      ))}
      <Card>
        <CardHeader title="Gutter accessories & related work" sub="Tick an item to include it" />
        <LineItems ws={ws} kind="Gutter" prefix="gutter.items" />
        <CardFooterRow label="Accessories total" value={formatMoney(t.gutter.itemsTotal)} strong />
      </Card>
      <Card>
        <CardHeader title="Upgrades, discounts & adjustments" />
        <CardBody>
          <AmountLines ws={ws} scope="gutter" />
        </CardBody>
      </Card>
    </>
  );
}
