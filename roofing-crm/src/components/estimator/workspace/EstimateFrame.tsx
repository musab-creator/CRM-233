'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Save, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { VIEWS, formatMoneyWhole, formatPct, marginTone, statusTone } from '@/lib/estimator';
import EstimatorShell, { EstimateTabs, useIsEstimatorManager } from '../EstimatorShell';
import { discardDraft, useEstimateWorkspace, type EstimateWorkspace } from './useEstimateWorkspace';
import { ConfirmDialog, Toaster, type ConfirmRequest } from './feedback';
import { StepBar, SummaryAside, capitalize, estimateHref, type EstimateView } from './parts';
import { Button, Card, CardBody, Pill, buttonClass } from './ui';

// Frame shared by the Combined, Roof and Gutter pages: estimator shell,
// estimate tabs, step bar, the page body beside the live summary column,
// and the sticky save bar.

const VIEW_KEY: Record<EstimateView, 'combined' | 'roof' | 'gutter'> = { combined: 'combined', roof: 'roof', gutter: 'gutter' };

function SaveBar({ ws, onDiscard }: { ws: EstimateWorkspace; onDiscard: () => void }) {
  const isManager = useIsEstimatorManager();
  const { est, totals, pricing, dirty } = ws;
  if (!est || !totals) return null;
  return (
    <div className="sticky bottom-0 z-20 -mx-4 border-t border-gray-200 bg-white/95 px-4 py-2.5 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] backdrop-blur sm:-mx-6 sm:px-6 lg:mx-0 lg:rounded-xl lg:border lg:px-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
            <span className="font-mono font-semibold text-gray-700">{est.number}</span>
            <Pill tone={statusTone(est.status)} className="!px-2 !py-0 text-[11px]">
              {capitalize(est.status)}
            </Pill>
            {dirty ? (
              <span className="inline-flex items-center gap-1 font-medium text-amber-700" data-testid="unsaved">
                <i className="inline-block h-2 w-2 rounded-full bg-amber-500" /> Unsaved changes
              </span>
            ) : (
              <span className="hidden text-gray-400 sm:inline">All changes saved</span>
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">Total</span>
            <span className="text-lg font-bold tabular-nums text-gray-900" data-testid="savebar-sell">
              {formatMoneyWhole(totals.sell)}
            </span>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {isManager ? (
            <Pill tone={marginTone(totals.margin, pricing)} title="Gross margin">
              {formatPct(totals.margin)}
            </Pill>
          ) : null}
          {dirty ? (
            <Button size="sm" variant="ghost" onClick={onDiscard} title="Discard unsaved changes" aria-label="Discard unsaved changes">
              <Undo2 className="h-4 w-4" />
              <span className="hidden sm:inline">Discard</span>
            </Button>
          ) : null}
          <Button size="sm" variant={dirty ? 'primary' : 'default'} onClick={() => ws.save()} title="Save (Ctrl/Cmd+S)">
            <Save className="h-4 w-4" /> Save
            <kbd className="ml-1 hidden rounded border border-current/30 px-1 text-[10px] font-medium opacity-70 lg:inline">⌘S</kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}

function Workspace({
  id, view, onDiscard, children,
}: {
  id: string;
  view: EstimateView;
  onDiscard: () => void;
  children: (ws: EstimateWorkspace) => ReactNode;
}) {
  const ws = useEstimateWorkspace(id);
  const router = useRouter();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const meta = VIEWS.find((v) => v.view === VIEW_KEY[view])!;
  const { dirty, est, save } = ws;
  const closeConfirm = useCallback(() => setConfirm(null), []);

  // Leaving this estimate's Combined/Roof/Gutter pages with unsaved changes:
  // offer to save or discard first. (Between those three pages the edits
  // simply carry over.)
  useEffect(() => {
    if (!dirty || !est) return;
    const own = new Set(['combined', 'roof', 'gutter'].map((v) => estimateHref(id, v as EstimateView)));
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || own.has(url.pathname)) return;
      e.preventDefault();
      e.stopPropagation();
      const href = url.pathname + url.search + url.hash;
      setConfirm({
        title: 'Save your changes?',
        body: `${est.number} has changes that are not saved yet.`,
        confirmLabel: 'Save and continue',
        secondary: {
          label: 'Discard changes',
          onClick: () => {
            discardDraft(id);
            router.push(href);
          },
        },
        onConfirm: () => {
          save();
          router.push(href);
        },
      });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [dirty, est, id, router, save]);

  let body: ReactNode;
  if (!ws.hydrated || (!ws.est && !ws.notFound)) {
    body = (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading estimate…
      </div>
    );
  } else if (ws.notFound || !ws.est) {
    body = (
      <Card>
        <CardBody className="flex flex-col items-start gap-3">
          <p className="text-sm text-gray-700">This estimate doesn&apos;t exist, or it belongs to another rep.</p>
          <Link href="/estimator/saved" className={buttonClass('default', 'sm')}>
            Saved estimates
          </Link>
        </CardBody>
      </Card>
    );
  } else {
    body = (
      <>
        <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start xl:gap-5">
          <div className="flex min-w-0 flex-col gap-4">
            <StepBar ws={ws} view={view} />
            {children(ws)}
          </div>
          <aside className="min-w-0 xl:sticky xl:top-[72px]">
            <SummaryAside ws={ws} />
          </aside>
        </div>
        <SaveBar ws={ws} onDiscard={onDiscard} />
      </>
    );
  }

  return (
    <EstimatorShell
      title={meta.title}
      subtitle={
        ws.est ? (
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span className="font-mono font-semibold text-gray-700">{ws.est.number}</span>
            {ws.est.customer.name ? <span>· {ws.est.customer.name}</span> : null}
            <span className="hidden md:inline">· {meta.subtitle}</span>
          </span>
        ) : (
          meta.subtitle
        )
      }
    >
      <EstimateTabs id={id} />
      <div className={cn('flex flex-col gap-4')}>{body}</div>
      <Toaster raised />
      <ConfirmDialog request={confirm} onClose={closeConfirm} />
    </EstimatorShell>
  );
}

export default function EstimateFrame({ id, view, children }: { id: string; view: EstimateView; children: (ws: EstimateWorkspace) => ReactNode }) {
  // Discarding remounts the workspace, which reopens the saved copy.
  const [generation, setGeneration] = useState(0);
  return (
    <Workspace
      key={generation}
      id={id}
      view={view}
      onDiscard={() => {
        discardDraft(id);
        setGeneration((g) => g + 1);
      }}
    >
      {children}
    </Workspace>
  );
}
