'use client';

import { formatPct, normalizeProposal, setPath, toNumber, type Estimate, type PriceBook } from '@/lib/estimator';
import { Card, CardBody, CardHeader, Field, NumberInput, Pill, inputCls } from './ui';

// "Proposal setup": the proposal's editing controls (contract type, the
// payment schedule or insurance figures, decking allowance, warranty, cover
// photo), plus the customer-facing wording the proposal prints (notes,
// exclusions, allowances).

type Edit = (fn: (draft: Estimate) => void) => void;

export default function ProposalSetup({ est, pricing, edit }: { est: Estimate; pricing: PriceBook; edit: Edit }) {
  const s = normalizeProposal(est.proposal, pricing);
  const ins = s.ins;
  const insurance = s.contractType === 'insurance';
  const photos = (est.reports || []).filter((r) => r.kind === 'image' && !!r.data);

  // Older estimates may lack proposal.pay / .ins; fill them before writing a path inside.
  const set = (path: string, value: unknown) =>
    edit((draft) => {
      draft.proposal = normalizeProposal(draft.proposal, pricing);
      setPath(draft, path, value);
    });

  const text = (label: string, path: string, value: string) => (
    <Field label={label}>
      <input className={inputCls} value={value} onChange={(e) => set(path, e.target.value)} />
    </Field>
  );
  const money = (label: string, path: string, value: unknown) => (
    <Field label={label}>
      <NumberInput blankable value={value} onChange={(v) => set(path, v)} />
    </Field>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Proposal setup"
          right={<Pill tone={insurance ? 'navy' : 'mut'}>{insurance ? 'Insurance job — Green Sheet terms' : 'Cash / retail job'}</Pill>}
        />
        <CardBody className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Contract type">
              <select className={inputCls} value={s.contractType} onChange={(e) => set('proposal.contractType', e.target.value)}>
                <option value="cash">Cash / retail</option>
                <option value="insurance">Insurance (Green Sheet)</option>
              </select>
            </Field>
            {insurance ? (
              <>
                {text('Insurance carrier', 'proposal.ins.carrier', ins.carrier)}
                {text('Claim #', 'proposal.ins.claim', ins.claim)}
                {money('First payment / ACV $', 'proposal.ins.acv', ins.acv)}
                {money('Depreciation $', 'proposal.ins.depreciation', ins.depreciation)}
                {money('Deductible $', 'proposal.ins.deductible', ins.deductible)}
                {money('Upgrades $', 'proposal.ins.upgradesAmt', ins.upgradesAmt)}
                {text('Contractor name', 'proposal.ins.contractor', ins.contractor)}
                {text('Contractor cell', 'proposal.ins.contractorPhone', ins.contractorPhone)}
              </>
            ) : (
              <>
                <Field label="Due at signing %">
                  <NumberInput value={toNumber(s.pay.sign)} onChange={(v) => set('proposal.pay.sign', v)} />
                </Field>
                <Field label="Due on material delivery %">
                  <NumberInput value={toNumber(s.pay.delivery)} onChange={(v) => set('proposal.pay.delivery', v)} />
                </Field>
                <Field label="Due at completion %">
                  <input
                    className={`${inputCls} text-right tabular-nums`}
                    readOnly
                    value={formatPct(100 - toNumber(s.pay.sign) - toNumber(s.pay.delivery))}
                  />
                </Field>
              </>
            )}
            <Field label="Decking allowance $ / 4×8 sheet">
              <NumberInput value={toNumber(s.deckingAllowance) || 85} onChange={(v) => set('proposal.deckingAllowance', v)} />
            </Field>
            <Field label="Workmanship warranty (years)">
              <NumberInput value={toNumber(s.warrantyYears) || 10} onChange={(v) => set('proposal.warrantyYears', v)} />
            </Field>
          </div>
          <Field label="Cover photo" hint="Attach a property photo on the Roof page and it becomes selectable here.">
            <select className={inputCls} value={s.coverPhoto || ''} onChange={(e) => set('proposal.coverPhoto', e.target.value)}>
              <option value="">{photos.length ? 'First attached photo' : 'None — gold-on-navy cover'}</option>
              {photos.map((p, i) => (
                <option key={i} value={p.data}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </CardBody>
      </Card>

      <details className="group overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 bg-gray-50/60 px-4 py-3 text-sm font-semibold text-gray-900 select-none [&::-webkit-details-marker]:hidden">
          Customer notes, exclusions {'&'} allowances
          <span className="text-gray-400 transition-transform group-open:rotate-90" aria-hidden>
            ›
          </span>
        </summary>
        <div className="grid grid-cols-1 gap-4 border-t border-gray-100 px-4 py-4 lg:grid-cols-3">
          <Field label="Notes shown to the customer">
            <textarea
              className={`${inputCls} min-h-[120px]`}
              placeholder="Scope notes, colour selections, scheduling"
              value={s.notes || ''}
              onChange={(e) => set('proposal.notes', e.target.value)}
            />
          </Field>
          <LinesField
            label="Not included in this price"
            hint="One exclusion per line."
            lines={s.exclusions}
            onChange={(lines) => set('proposal.exclusions', lines)}
          />
          <LinesField
            label="Allowances"
            hint="One allowance per line."
            lines={s.allowances}
            onChange={(lines) => set('proposal.allowances', lines)}
          />
        </div>
      </details>
    </div>
  );
}

function LinesField({
  label,
  hint,
  lines,
  onChange,
}: {
  label: string;
  hint: string;
  lines: string[];
  onChange: (lines: string[]) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        className={`${inputCls} min-h-[120px]`}
        value={(lines || []).join('\n')}
        onChange={(e) => onChange(e.target.value.split('\n'))}
        onBlur={(e) => onChange(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean))}
      />
    </Field>
  );
}
