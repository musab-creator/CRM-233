'use client';

import { useState } from 'react';
import { AlertTriangle, Calculator, FileText, Loader2 } from 'lucide-react';
import type { EstimateTarget } from '@/components/useBuildEstimate';
import { useRoofReportTransfer } from './transfer';
import { Btn } from './ui';
import { cn } from '@/lib/utils';

// "Create estimate" / "Create proposal" from the report panel and the report
// viewer: saves the roof report (once) and opens a full estimate or its
// customer proposal. Errors show right here, not off-screen.

export default function TransferButtons({ dark, className }: { dark?: boolean; className?: string }) {
  const { error, transfer } = useRoofReportTransfer();
  const [busy, setBusy] = useState<EstimateTarget | null>(null);
  const go = (target: EstimateTarget) => {
    if (busy) return;
    setBusy(target);
    if (!transfer(target)) setBusy(null);
  };
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap gap-2">
        <Btn variant="primary" small={dark} onClick={() => go('estimate')} disabled={!!busy} data-testid={dark ? 'viewer-create-estimate' : 'create-estimate'}>
          {busy === 'estimate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}Create estimate
        </Btn>
        <Btn small={dark} onClick={() => go('proposal')} disabled={!!busy} data-testid={dark ? 'viewer-create-proposal' : 'create-proposal'}>
          {busy === 'proposal' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}Create proposal
        </Btn>
      </div>
      {error && (
        <div role="alert" className={cn('flex items-start gap-2 rounded-lg px-3 py-2 text-sm', dark ? 'bg-red-900/60 text-red-100' : 'border border-red-200 bg-red-50 text-red-700')}>
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
