'use client';

import Link from 'next/link';
import { Droplets, Home, Layers, Loader2 } from 'lucide-react';
import { estimateTotals, formatMoney, type EstimateScope } from '@/lib/estimator';
import { useEstimatorHydrated, useEstimatorStore, useVisibleEstimates } from '@/store/estimator';
import EstimatorShell from '../EstimatorShell';
import { Toaster } from './feedback';
import { useEstimateActions } from './useEstimateActions';
import { Button, Card, CardBody, CardHeader, DataTable, Note, buttonClass } from './ui';
import { cn } from '@/lib/utils';

// The original's "New estimate" screen (th): pick a scope, or work from an
// existing estimate.

const SCOPES: { scope: EstimateScope; label: string; icon: typeof Home; primary?: boolean }[] = [
  { scope: 'both', label: 'Roofing + gutters', icon: Layers, primary: true },
  { scope: 'roof', label: 'Roofing only', icon: Home },
  { scope: 'gutter', label: 'Gutters only', icon: Droplets },
];

export default function NewEstimate() {
  const hydrated = useEstimatorHydrated();
  const pricing = useEstimatorStore((s) => s.pricing);
  const estimates = useVisibleEstimates();
  const { create, duplicate, openHref } = useEstimateActions();
  const iko = pricing.mfrs.IKO;
  const recent = estimates.slice(0, 6);

  return (
    <EstimatorShell title="New estimate" subtitle="Pick a scope and start. Everything can be changed later.">
      {!hydrated ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="flex max-w-[760px] flex-col gap-4">
          <Card>
            <CardHeader title="Start a new estimate" />
            <CardBody className="flex flex-col gap-3">
              <Note>
                A new estimate opens with one roof section at the {iko?.label ?? 'IKO'} Standard price ({formatMoney(iko?.standard)}/sq),{' '}
                {pricing.roof.defaultWaste}% waste, permit, dumpster and delivery switched on. Change anything from there.
              </Note>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {SCOPES.map((s) => (
                  <Button
                    key={s.scope}
                    variant={s.primary ? 'primary' : 'default'}
                    className={cn('min-h-[48px]')}
                    onClick={() => create(s.scope)}
                  >
                    <s.icon className="h-4 w-4" /> {s.label}
                  </Button>
                ))}
              </div>
            </CardBody>
          </Card>
          {recent.length ? (
            <Card>
              <CardHeader title="Or work from an existing estimate" />
              <DataTable
                rows={recent}
                rowKey={(e) => e.id}
                columns={[
                  { header: 'Estimate', mobile: false, cell: (e) => <span className="font-mono text-[13px] font-semibold">{e.number}</span> },
                  {
                    header: 'Customer',
                    mobile: 'title',
                    cell: (e) => (
                      <>
                        <span className="font-mono text-xs text-gray-500 md:hidden">{e.number} · </span>
                        {e.customer.name || '—'}
                      </>
                    ),
                  },
                  { header: 'Total', right: true, cell: (e) => formatMoney(estimateTotals(e, pricing).sell) },
                  {
                    right: true,
                    mobile: '',
                    mobileFull: true,
                    cell: (e) => (
                      <div className="flex justify-end gap-1.5">
                        <Link href={openHref(e.id)} className={buttonClass('default', 'sm')}>
                          Open
                        </Link>
                        <Button size="sm" onClick={() => duplicate(e.id)}>
                          Duplicate
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          ) : null}
        </div>
      )}
      <Toaster />
    </EstimatorShell>
  );
}
