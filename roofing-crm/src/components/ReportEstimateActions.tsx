'use client';

import Link from 'next/link';
import { Calculator, FileText, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RoofReport } from '@/types';
import { estimatePath, useBuildEstimate, useLatestReportEstimate } from './useBuildEstimate';

// Buttons that take a saved roof report to a full estimate / customer proposal.
// Before an estimate exists they build one; afterwards they open it, so a
// second tap doesn't make a duplicate (Build another does, on purpose).

const primary = 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-700';
const secondary = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-orange-300 bg-white px-3 py-2 text-sm font-semibold text-orange-700 hover:bg-orange-50';

export default function ReportEstimateActions({ report, className }: { report: RoofReport; className?: string }) {
  const build = useBuildEstimate();
  const latest = useLatestReportEstimate(report);

  if (latest) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <div className="grid grid-cols-2 gap-2">
          <Link href={estimatePath(latest.id, 'estimate')} className={primary}>
            <Calculator className="h-4 w-4" /> Open {latest.number}
          </Link>
          <Link href={estimatePath(latest.id, 'proposal')} className={secondary}>
            <FileText className="h-4 w-4" /> Open proposal
          </Link>
        </div>
        <button type="button" onClick={() => build(report)} className="inline-flex items-center justify-center gap-1 self-start rounded-md px-2 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100">
          <Plus className="h-3.5 w-3.5" /> Build another estimate
        </button>
      </div>
    );
  }

  return (
    <div className={cn('grid grid-cols-2 gap-2', className)}>
      <button type="button" onClick={() => build(report, 'estimate')} className={primary}>
        <Calculator className="h-4 w-4" /> Build estimate
      </button>
      <button type="button" onClick={() => build(report, 'proposal')} className={secondary}>
        <FileText className="h-4 w-4" /> Build proposal
      </button>
    </div>
  );
}
