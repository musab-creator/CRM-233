'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Copy, Download, FolderOpen, Loader2, Plus, Search, Trash2, Upload } from 'lucide-react';
import {
  ESTIMATE_STATUSES, estimateTotals, formatDate, formatMoneyWhole, formatPct, marginTone, ownerLabel, statusTone,
  type EstimateStatus,
} from '@/lib/estimator';
import { useCRMStore } from '@/store';
import { useEstimatorHydrated, useEstimatorStore, useVisibleEstimates } from '@/store/estimator';
import EstimatorShell, { useIsEstimatorManager } from '../EstimatorShell';
import { ConfirmDialog, Toaster, toast, type ConfirmRequest } from './feedback';
import { useEstimateActions } from './useEstimateActions';
import { ConfidencePill, capitalize } from './parts';
import { Button, Card, CardBody, CardHeader, DataTable, Note, Pill, buttonClass, controlClass } from './ui';
import { cn } from '@/lib/utils';

// The original's saved estimates list (tm): every estimate the viewer may
// see, with open / duplicate / delete and the backup file export / import.
// Search and the status filter are CRM additions.

function download(filename: string, text: string) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Saved ' + filename);
  } catch {
    toast('This viewer blocked the download.');
  }
}

export default function SavedEstimates() {
  const hydrated = useEstimatorHydrated();
  const isManager = useIsEstimatorManager();
  const pricing = useEstimatorStore((s) => s.pricing);
  const deleteEstimate = useEstimatorStore((s) => s.deleteEstimate);
  const exportBackup = useEstimatorStore((s) => s.exportBackup);
  const importBackup = useEstimatorStore((s) => s.importBackup);
  const users = useCRMStore((s) => s.users);
  const estimates = useVisibleEstimates();
  const { openHref, duplicate } = useEstimateActions();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<EstimateStatus | 'all'>('all');
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  const fileInput = useRef<HTMLInputElement>(null);

  const rows = useMemo(
    () => estimates.map((estimate) => ({ estimate, totals: estimateTotals(estimate, pricing) })),
    [estimates, pricing],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(({ estimate: e }) => {
      if (status !== 'all' && e.status !== status) return false;
      if (!q) return true;
      const c = e.customer;
      return [e.number, c.name, c.address, c.city, c.phone, c.email, e.ownerName].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [rows, query, status]);
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name;
  type Row = (typeof rows)[number];

  const askDelete = (row: Row) =>
    setConfirm({
      title: 'Delete this estimate?',
      body: `${row.estimate.number}${row.estimate.customer.name ? ' — ' + row.estimate.customer.name : ''}. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        deleteEstimate(row.estimate.id);
        toast('Estimate deleted');
      },
    });

  const onImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      try {
        const parsed = JSON.parse(text);
        if (!parsed || !parsed.state) throw new Error('not a backup');
      } catch {
        toast('That file is not a Diversity Estimator backup.');
        return;
      }
      setConfirm({
        title: 'Replace everything in this browser with the backup?',
        body: 'Every saved estimate, the price book and the price-change log are replaced by the file’s contents.',
        confirmLabel: 'Restore backup',
        danger: true,
        onConfirm: () => {
          try {
            importBackup(text);
            toast('Backup restored');
          } catch {
            toast('That file is not a Diversity Estimator backup.');
          }
        },
      });
    };
    reader.readAsText(file);
  };

  const columns = [
    {
      header: 'Estimate',
      mobile: false as const,
      cell: ({ estimate: e }: Row) => (
        <>
          <span className="font-mono text-[13px] font-semibold text-gray-900">{e.number}</span>
          <div className="text-[11.5px] text-gray-500">{formatDate(e.date)}</div>
        </>
      ),
    },
    ...(isManager
      ? [
          {
            header: 'Rep',
            cell: ({ estimate: e }: Row) => <Pill tone={e.ownerId && e.ownerId !== 'mgr' ? 'navy' : 'mut'}>{ownerLabel(e, nameOf)}</Pill>,
          },
        ]
      : []),
    {
      header: 'Customer',
      mobile: 'title' as const,
      cell: ({ estimate: e }: Row) => (
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-2">
            <span>
              <span className="font-mono text-xs text-gray-500 md:hidden">{e.number} · </span>
              {e.customer.name || '—'}
            </span>
          </div>
          <div className="text-[11.5px] font-normal text-gray-500">
            {e.customer.address || ''}
            <span className="md:hidden">{e.customer.address ? ' · ' : ''}{formatDate(e.date)}</span>
          </div>
        </div>
      ),
    },
    {
      header: 'Status',
      cell: ({ estimate: e }: Row) => (
        <div className="flex flex-col items-start gap-1">
          <Pill tone={statusTone(e.status)}>{e.status}</Pill>
          <ConfidencePill est={e} />
        </div>
      ),
    },
    { header: 'Squares', right: true, cell: ({ totals: t }: Row) => (t.roof.billable ? t.roof.billable.toFixed(2) : '—') },
    { header: 'LF', right: true, cell: ({ totals: t }: Row) => (t.gutter.lf ? t.gutter.lf.toFixed(0) : '—') },
    { header: 'Price', right: true, cell: ({ totals: t }: Row) => <b className="font-semibold">{formatMoneyWhole(t.sell)}</b> },
    ...(isManager
      ? [
          { header: 'Cost', right: true, cell: ({ totals: t }: Row) => formatMoneyWhole(t.totalCost) },
          { header: 'GP', right: true, cell: ({ totals: t }: Row) => formatMoneyWhole(t.grossProfit) },
          {
            header: 'Margin',
            right: true,
            cell: ({ totals: t }: Row) => <Pill tone={marginTone(t.margin, pricing)}>{formatPct(t.margin)}</Pill>,
          },
        ]
      : []),
    {
      right: true,
      mobile: '' as const,
      mobileFull: true,
      className: 'md:w-[1%]',
      cell: (row: Row) => (
        <div className="col-span-2 flex justify-end gap-1.5">
          <Link href={openHref(row.estimate.id)} className={buttonClass('default', 'sm')}>
            <FolderOpen className="h-4 w-4 md:hidden xl:inline" /> Open
          </Link>
          <Button size="sm" onClick={() => duplicate(row.estimate.id)}>
            <Copy className="h-4 w-4 md:hidden xl:inline" /> Duplicate
          </Button>
          <Button size="sm" variant="danger" onClick={() => askDelete(row)} aria-label={'Delete ' + row.estimate.number}>
            <Trash2 className="h-4 w-4" />
            <span className="hidden xl:inline">Delete</span>
          </Button>
        </div>
      ),
    },
  ];

  const title = `${estimates.length} ${isManager ? 'team' : 'of your'} estimate${estimates.length === 1 ? '' : 's'}`;

  return (
    <EstimatorShell
      title="Saved estimates"
      subtitle="Reopen, duplicate or revise any estimate."
      actions={
        <Link href="/estimator/new" className={buttonClass('primary')}>
          <Plus className="h-4 w-4" /> New estimate
        </Link>
      }
    >
      {!hydrated ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading estimates…
        </div>
      ) : !estimates.length ? (
        <Card>
          <CardBody>
            <Note>
              {isManager ? 'Nothing saved yet.' : 'You have no estimates yet.'} Build an estimate and press <b>Save estimate</b>.
            </Note>
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search number, customer, address…"
                aria-label="Search estimates"
                className={cn(controlClass, 'pl-9')}
              />
            </div>
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <div className="flex w-max gap-1 rounded-lg bg-gray-100 p-1">
                {(['all', ...ESTIMATE_STATUSES] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s)}
                    className={cn(
                      'min-h-[36px] rounded-md px-3 text-sm font-medium transition-colors',
                      status === s ? 'bg-white text-orange-700 shadow-sm' : 'text-gray-600 hover:text-gray-900',
                    )}
                  >
                    {s === 'all' ? 'All' : capitalize(s)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Card>
            <CardHeader
              title={title}
              right={
                isManager ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => download('diversity-estimates-' + new Date().toISOString().slice(0, 10) + '.json', exportBackup())}
                    >
                      <Download className="h-4 w-4" /> Export backup
                    </Button>
                    <Button size="sm" onClick={() => fileInput.current?.click()}>
                      <Upload className="h-4 w-4" /> Import backup
                    </Button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      data-testid="backup-file-input"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onImportFile(f);
                        e.target.value = '';
                      }}
                    />
                  </>
                ) : undefined
              }
            />
            {filtered.length ? (
              <DataTable rows={filtered} rowKey={(r) => r.estimate.id} columns={columns} className="[&_td]:align-middle" />
            ) : (
              <CardBody>
                <p className="py-6 text-center text-sm text-gray-500">No estimates match.</p>
              </CardBody>
            )}
          </Card>
          <Note>
            Saved estimates are stored in this browser — reps see their own, managers see everyone&apos;s.
            {isManager ? (
              <>
                {' '}
                <b>Export backup</b> gives you a file copy for safekeeping.
              </>
            ) : null}
          </Note>
        </div>
      )}
      <Toaster />
      <ConfirmDialog request={confirm} onClose={closeConfirm} />
    </EstimatorShell>
  );
}
