'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Calculator, CheckCircle2, FileText, Loader2, RotateCcw, Ruler, X } from 'lucide-react';
import { squares } from '@/lib/roof-report';
import { fmt } from '@/lib/roof-measure/format';
import { commercialTotals } from '@/lib/roof-measure/commercial';
import type { EstimateTarget } from '@/components/useBuildEstimate';
import { useRM } from './store';
import { useTotals } from './hooks';
import { useRoofReportTransfer } from './transfer';
import { Btn } from './ui';
import { cn } from '@/lib/utils';

// The page's always-visible bar: what is measured so far, "New roof", and "Use these measurements", which
// saves a CRM roof report (attached to the lead the page was opened from) and offers the estimate and proposal.

interface Props { leadId: string | null; compact: boolean }

export default function ActionBar({ compact }: Props) {
  const project = useRM((s) => s.project);
  const mode = useRM((s) => s.mode);
  const comModel = useRM((s) => s.comModel);
  const comOpts = useRM((s) => s.comOpts);
  const t = useTotals();
  const { lead, owner, saved, upToDate, error, setError, panel, setPanel, use, transfer } = useRoofReportTransfer();
  const [building, setBuilding] = useState<EstimateTarget | null>(null);

  const comT = mode === 'com' && comModel ? commercialTotals(comModel, comOpts) : null;
  const summary = mode === 'com'
    ? (comT ? `${fmt(comT.totalSF)} sq ft · ${fmt(comT.squares, 1)} sq` : 'Not measured yet')
    : (t.sloped > 0 ? `${fmt(t.sloped)} sq ft · ${fmt(t.squares, 2)} sq` : 'No roof traced yet');

  const newRoof = () => {
    const S = useRM.getState();
    if ((!S.project.facets.length && !S.project.edges.length) || window.confirm('Clear all facets, lines and Solar data?')) { S.clearAll(); setPanel(false); setError(''); }
  };

  const go = (target: EstimateTarget) => {
    if (building) return;
    setBuilding(target);
    if (!transfer(target)) setBuilding(null);
  };

  const who = owner ? `${owner.firstName} ${owner.lastName}` : project.jobName;

  return (
    <div className="z-20 border-b border-gray-200 bg-white px-3 py-2 sm:px-4" data-testid="action-bar">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        {!compact && <Ruler className="h-6 w-6 flex-none text-orange-500" />}
        <div className="min-w-0 flex-1">
          {!compact && (
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="flex-none text-base font-bold text-gray-900">Roof Measure</h1>
              <span className="truncate text-xs text-gray-500">{[who, project.address].filter(Boolean).join(' — ') || 'Satellite roof measurements & takeoff'}</span>
            </div>
          )}
          <div className={cn('truncate tabular-nums', compact ? 'text-xs text-gray-700' : 'text-xs font-medium text-gray-700')} data-testid="bar-summary">
            {compact && who ? <span className="font-semibold">{who} · </span> : null}{summary}
          </div>
        </div>
        <Btn variant="ghost" small onClick={newRoof} title="Clear everything and start a new roof" aria-label="New roof" className={compact ? 'w-9 px-0' : ''}>
          <RotateCcw className="h-4 w-4" />{!compact && 'New roof'}
        </Btn>
        <Btn variant="primary" onClick={use} data-testid="use-measurements" className={cn(compact && 'px-3')}>
          {upToDate ? <CheckCircle2 className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
          {upToDate ? 'Saved' : 'Use these measurements'}
        </Btn>
      </div>
      {error && (
        <div role="alert" data-testid="use-error" className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" /><span className="min-w-0 flex-1">{error}</span>
          <button type="button" className="-m-1 flex h-8 w-8 flex-none items-center justify-center rounded text-red-500 hover:bg-red-100" aria-label="Dismiss" onClick={() => setError('')}><X className="h-4 w-4" /></button>
        </div>
      )}
      {saved && panel && (
        <div data-testid="use-saved" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          <CheckCircle2 className="h-4 w-4 flex-none" />
          <span className="min-w-0 flex-1 basis-48">
            Roof report saved{lead && owner ? ` to ${owner.firstName} ${owner.lastName}` : ''}: {fmt(saved.report.measurements.totalSqFt)} sq ft, {squares(saved.report.measurements)} sq{!upToDate && saved.mode === mode ? ' (you changed the roof since — press the button again to save a new report)' : ''}.
          </span>
          <div className="flex flex-wrap gap-2">
            <Btn variant="primary" small onClick={() => go('estimate')} disabled={!!building} data-testid="build-estimate">
              {building === 'estimate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Calculator className="h-3.5 w-3.5" />}Build estimate
            </Btn>
            <Btn small onClick={() => go('proposal')} disabled={!!building} data-testid="build-proposal">
              {building === 'proposal' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}Build proposal
            </Btn>
            <Link href="/roof-reports" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50" data-testid="view-reports">
              <FileText className="h-3.5 w-3.5" />View roof reports
            </Link>
            <Btn small variant="ghost" onClick={() => setPanel(false)} data-testid="keep-measuring">Keep measuring</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
