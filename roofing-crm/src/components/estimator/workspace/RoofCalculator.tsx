'use client';

import { Plus } from 'lucide-react';
import {
  formatMoney, formatMoneyWhole, newRoofSection, sectionPreview, toNumber, type RoofSection,
} from '@/lib/estimator';
import { useIsEstimatorManager } from '../EstimatorShell';
import type { EstimateWorkspace } from './useEstimateWorkspace';
import { AerialCount, AmountLines, CustomerCard, LineItems, ScopeCard } from './parts';
import ReportsPanel from './ReportsPanel';
import {
  Alert, Button, Card, CardBody, CardFooterRow, CardHeader, DataTable, Eyebrow, Field, FieldGrid, Note, NumInput,
  ReadOnly, Select, SubCard, TextInput,
} from './ui';

// The original's roof calculator (te).

// The original offered 3/12-12/12; a lower pitch already on the section
// (a flat section from a report is 0/12) is listed too so it shows as is.
const PITCHES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function SectionCard({ ws, sec, index }: { ws: EstimateWorkspace; sec: RoofSection; index: number }) {
  const isManager = useIsEstimatorManager();
  const pricing = ws.pricing;
  const est = ws.est!;
  const m = pricing.mfrs[sec.mfr];
  const p = sectionPreview(pricing, sec);
  const path = `roof.sections.${index}`;
  const set = (field: keyof RoofSection, v: unknown) => ws.update(`${path}.${field}`, v);
  const pitchFree = toNumber(pricing.roof.pitchFreeUpTo);
  const pitchStep = toNumber(pricing.roof.pitchStep);
  const stories = toNumber(sec.stories);

  const components = [
    { label: `Base roofing — ${m?.label ?? sec.mfr} ${sec.product || ''}`, sq: p.billable, rate: p.price, amount: p.billable * p.price },
    { label: `Pitch surcharge — ${toNumber(sec.pitch)}/12`, sq: p.billable, rate: p.pitchSurcharge, amount: p.billable * p.pitchSurcharge },
    {
      label: `Story surcharge — ${stories} ${stories === 1 ? 'story' : 'stories'}`,
      sq: p.billable,
      rate: p.storySurcharge,
      amount: p.billable * p.storySurcharge,
    },
    { label: 'Peel-and-stick underlayment', sq: p.psSquares, rate: p.peelStickRate, amount: p.psSquares * p.peelStickRate },
  ];

  return (
    <SubCard
      title={sec.name}
      right={
        <>
          <span className="text-xs tabular-nums text-gray-500">{p.billable.toFixed(2)} sq</span>
          {est.roof.sections.length > 1 ? (
            <Button size="sm" variant="danger" onClick={() => ws.edit((d) => void (d.roof.sections = d.roof.sections.filter((s) => s.id !== sec.id)))}>
              Remove
            </Button>
          ) : null}
        </>
      }
      footer={<CardFooterRow label="Section total" value={formatMoney(p.total)} strong />}
    >
      <FieldGrid>
        <Field label="Section name">
          <TextInput value={sec.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Measured squares">
          <NumInput value={toNumber(sec.measured)} onChange={(v) => set('measured', v)} />
        </Field>
        <Field label="Waste %">
          <NumInput value={toNumber(sec.waste)} onChange={(v) => set('waste', v)} />
        </Field>
        <Field label="Billable squares" hint="blank = measured + waste">
          <NumInput
            value={toNumber(sec.billableOverride) || ''}
            blankable
            placeholder={p.billable.toFixed(2) + ' auto'}
            onChange={(v) => set('billableOverride', v === '' ? 0 : v)}
          />
        </Field>
      </FieldGrid>
      <FieldGrid>
        <Field label="Manufacturer">
          <Select value={sec.mfr} onChange={(v) => set('mfr', v)}>
            {Object.keys(pricing.mfrs).map((k) => (
              <option key={k} value={k}>
                {pricing.mfrs[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Price level">
          <Select value={sec.tier} onChange={(v) => set('tier', v)}>
            <option value="competitive">Competitive{isManager && m ? ' — ' + formatMoney(m.competitive) + '/sq' : ''}</option>
            <option value="standard">Standard{isManager && m ? ' — ' + formatMoney(m.standard) + '/sq' : ''}</option>
            <option value="high">High{isManager && m ? ' — ' + formatMoney(m.high) + '/sq' : ''}</option>
            {isManager || sec.tier === 'custom' ? <option value="custom">Custom price…</option> : null}
          </Select>
        </Field>
        {isManager ? (
          sec.tier === 'custom' ? (
            <Field label="Custom $/square">
              <NumInput value={toNumber(sec.custom)} invalid={!!p.outOfRange} onChange={(v) => set('custom', v)} />
            </Field>
          ) : (
            <Field label="Price per square">
              <ReadOnly numeric value={formatMoney(p.price)} />
            </Field>
          )
        ) : null}
        <Field label="Product / series">
          <Select value={sec.product} onChange={(v) => set('product', v)}>
            <option value="">—</option>
            {(m?.products || []).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Select>
        </Field>
        <Field label="Color">
          <Select value={sec.color} onChange={(v) => set('color', v)}>
            <option value="">—</option>
            {(m?.colors || []).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Select>
        </Field>
      </FieldGrid>
      {p.outOfRange && m ? (
        <Alert level={p.outOfRange === 'below' ? 'bad' : 'warn'}>
          {p.outOfRange === 'below' ? (
            <>
              {formatMoney(p.price)}/sq is <b>below</b> the approved {m.label} range of {formatMoney(m.min)}–{formatMoney(m.max)}.
            </>
          ) : (
            <>
              {formatMoney(p.price)}/sq is above the published {m.label} range of {formatMoney(m.min)}–{formatMoney(m.max)}.
            </>
          )}
        </Alert>
      ) : null}
      <FieldGrid>
        <Field label="Roof pitch">
          <Select value={String(toNumber(sec.pitch))} onChange={(v) => set('pitch', toNumber(v))}>
            {(PITCHES.includes(toNumber(sec.pitch)) ? PITCHES : [toNumber(sec.pitch), ...PITCHES]).map((n) => (
              <option key={n} value={n}>
                {n}/12{n > 6 ? `  (+${formatMoneyWhole(Math.max(0, n - pitchFree) * pitchStep)}/sq)` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Stories">
          <Select value={String(stories >= 3 ? 3 : stories)} onChange={(v) => set('stories', toNumber(v))}>
            <option value="1">1 story (no surcharge)</option>
            <option value="2">2 story (+{formatMoneyWhole(pricing.roof.story2)}/sq)</option>
            <option value="3">3+ story (+{formatMoneyWhole(pricing.roof.story3)}/sq)</option>
          </Select>
        </Field>
        <Field label="Peel-and-stick underlayment">
          <Select value={sec.psMode} onChange={(v) => set('psMode', v)}>
            <option value="none">None</option>
            <option value="full">Entire roof ({p.billable.toFixed(2)} sq)</option>
            <option value="partial">Only certain squares…</option>
          </Select>
        </Field>
        {sec.psMode === 'partial' ? (
          <Field label="Peel-and-stick squares">
            <NumInput value={toNumber(sec.psSquares)} onChange={(v) => set('psSquares', v)} />
          </Field>
        ) : null}
      </FieldGrid>
      {stories >= 3 ? (
        <Note>
          Three or more stories uses the customizable {formatMoney(pricing.roof.story3)}/sq surcharge. Override it on Admin Pricing,
          or add a manual adjustment for this job.
        </Note>
      ) : null}
      <div className="-mx-4 border-t border-gray-100">
        <DataTable
          phone="table"
          rows={components}
          rowKey={(_, i) => i}
          columns={[
            { header: 'Component', cell: (r) => <span className="text-[13px]">{r.label}</span> },
            { header: 'Squares', right: true, cell: (r) => r.sq.toFixed(2) },
            { header: 'Rate', right: true, cell: (r) => formatMoney(r.rate) },
            { header: 'Amount', right: true, cell: (r) => formatMoney(r.amount) },
          ]}
          className="text-[13px] [&_td]:px-2 sm:[&_td]:px-3 [&_th]:px-2 sm:[&_th]:px-3"
        />
      </div>
    </SubCard>
  );
}

export default function RoofCalculator({ ws }: { ws: EstimateWorkspace }) {
  const est = ws.est!;
  const t = ws.totals!;
  return (
    <>
      <CustomerCard ws={ws} />
      <ScopeCard ws={ws} />
      <ReportsPanel ws={ws} />
      <AerialCount ws={ws} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Eyebrow>Roof sections</Eyebrow>
          <div className="text-[13px] text-gray-500">Add a section whenever slope, story height, shingle product, or underlayment changes.</div>
        </div>
        <Button onClick={() => ws.edit((d) => void d.roof.sections.push(newRoofSection(ws.pricing, d.roof.sections.length + 1)))}>
          <Plus className="h-4 w-4" /> Add roof section
        </Button>
      </div>
      {est.roof.sections.map((sec, i) => (
        <SectionCard key={sec.id} ws={ws} sec={sec} index={i} />
      ))}
      <Card>
        <CardHeader title="Roofing line items" sub="Tick an item to include it" />
        <LineItems ws={ws} kind="Roofing" prefix="roof.items" />
        <CardFooterRow label="Line items total" value={formatMoney(t.roof.itemsTotal)} strong />
      </Card>
      <Card>
        <CardHeader title="Upgrades, discounts & adjustments" />
        <CardBody>
          <AmountLines ws={ws} scope="roof" />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Sales tax" />
        <CardBody>
          <FieldGrid min={160}>
            <Field label="Apply sales tax">
              <Select value={est.roof.taxOn} onChange={(v) => ws.update('roof.taxOn', v)}>
                <option value="none">No — lump-sum improvement contract</option>
                <option value="total">Yes — on the estimate total</option>
              </Select>
            </Field>
            <Field label="Tax rate %">
              <NumInput value={toNumber(est.roof.taxRate)} onChange={(v) => ws.update('roof.taxRate', v)} />
            </Field>
            <Field label="Tax amount">
              <ReadOnly numeric value={formatMoney(t.tax)} />
            </Field>
          </FieldGrid>
        </CardBody>
      </Card>
    </>
  );
}
