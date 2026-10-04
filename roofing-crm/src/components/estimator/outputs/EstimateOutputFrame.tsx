'use client';

import Link from 'next/link';
import { ArrowLeft, Check, Printer, Save } from 'lucide-react';
import EstimatorShell, { EstimateTabs } from '@/components/estimator/EstimatorShell';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/estimator';
import type { useWorkingEstimate } from '@/components/estimator/useWorkingEstimate';
import { EstimateNotFound, Loading, Pill, PrintStyles, buttonCls } from './ui';

type Working = ReturnType<typeof useWorkingEstimate>;

// Page frame for the per-estimate output screens (proposal, job cost): the
// estimator shell, the estimate's tabs, "Back to estimate", Save (when the
// screen edits the estimate) and "Print / save PDF". Children render only
// once the estimate is loaded.
export default function EstimateOutputFrame({
  id,
  title,
  subtitle,
  working,
  canSave,
  document,
  printable = true,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  working: Working;
  canSave?: boolean;
  document?: boolean; // print as Letter pages with no margins (the proposal)
  printable?: boolean;
  children: (w: Working & { est: NonNullable<Working['est']>; totals: NonNullable<Working['totals']> }) => React.ReactNode;
}) {
  const { hydrated, est, totals, notFound, dirty, save } = working;
  const ready = hydrated && est && totals;

  const actions = (
    <>
      <Link href={`/estimator/${id}`} className={buttonCls('default')}>
        <ArrowLeft className="h-4 w-4" /> Back to estimate
      </Link>
      {canSave && ready ? (
        <button type="button" onClick={() => save()} disabled={!dirty} className={buttonCls(dirty ? 'primary' : 'default')}>
          {dirty ? <Save className="h-4 w-4" /> : <Check className="h-4 w-4" />}
          {dirty ? 'Save' : 'Saved'}
        </button>
      ) : null}
      {printable && ready ? (
        <button
          type="button"
          onClick={() => window.print()}
          className={buttonCls(canSave && dirty ? 'default' : 'primary')}
        >
          <Printer className="h-4 w-4" /> Print / save PDF
        </button>
      ) : null}
    </>
  );

  return (
    <EstimatorShell title={title} subtitle={subtitle} actions={actions}>
      {printable && <PrintStyles document={document} />}
      <EstimateTabs id={id} />
      {!hydrated ? (
        <Loading />
      ) : notFound ? (
        <EstimateNotFound />
      ) : !ready ? (
        <Loading />
      ) : (
        <>
          <div className="no-print flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
            <span className="font-semibold text-gray-900">{est.number}</span>
            <span className="min-w-0 truncate">
              {est.customer.name || 'Unnamed'}
              {est.customer.address ? ` · ${est.customer.address}` : ''}
            </span>
            <span className="text-gray-400">{formatDate(est.date)}</span>
            {canSave && dirty ? <Pill tone="warn">Unsaved changes</Pill> : null}
          </div>
          <div className={cn('print-root')}>{children({ ...working, est, totals })}</div>
        </>
      )}
    </EstimatorShell>
  );
}
