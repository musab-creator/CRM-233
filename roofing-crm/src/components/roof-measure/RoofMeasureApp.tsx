'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { Building2, Calculator, ChevronDown, ChevronUp, FileText, Home, MapPin, PenTool, Satellite } from 'lucide-react';
import { useCRMStore } from '@/store';
import { restoreProject, emptyProject } from '@/lib/roof-measure/model';
import { TOOL_KEYS } from '@/lib/roof-measure/measure';
import { pickPanPixels } from '@/lib/roof-measure/geocode';
import { loadStoredSettings, useRM } from './store';
import { KEYS, readString, writeString, seedRoofMeasureKey } from './storage';
import { mapsKey, mapsLoaded } from './gmaps';
import { ensurePermits, getController, goToAddress, lockHouse, readAutosave, restore, stashAutosave, writeAutosave } from './actions';
import MapView, { DrawActions } from './MapView';
import ActionBar from './ActionBar';
import PropertySection from './PropertySection';
import SolarSection from './SolarSection';
import TraceSection from './TraceSection';
import TotalsSection from './TotalsSection';
import ExportSection from './ExportSection';
import CommercialSection from './CommercialSection';
import ReportViewer, { useReportViewer } from './ReportViewer';
import { useMediaQuery } from './hooks';
import { cn } from '@/lib/utils';

// Roof Measure as a CRM page: the map fills the screen, the original tool's numbered panels sit beside it on
// desktop and in a bottom sheet on phones, and the action bar turns the roof into a CRM roof report.

type SectionId = 'property' | 'solar' | 'commercial' | 'trace' | 'totals' | 'export';
interface SectionDef { id: SectionId; n: number; title: string; short: string; icon: typeof Home; open: boolean }

const RES_SECTIONS: SectionDef[] = [
  { id: 'property', n: 1, title: 'Property', short: 'Property', icon: MapPin, open: true },
  { id: 'solar', n: 2, title: 'Auto measure (Google Solar API)', short: 'Auto', icon: Satellite, open: true },
  { id: 'trace', n: 3, title: 'Trace roof', short: 'Trace', icon: PenTool, open: true },
  { id: 'totals', n: 4, title: 'Measurements & materials', short: 'Totals', icon: Calculator, open: true },
  { id: 'export', n: 5, title: 'Report, save & export', short: 'Report', icon: FileText, open: false },
];
const COM_SECTIONS: SectionDef[] = [
  { id: 'property', n: 1, title: 'Property', short: 'Property', icon: MapPin, open: true },
  { id: 'commercial', n: 2, title: 'Commercial roof', short: 'Commercial', icon: Building2, open: true },
  { id: 'export', n: 5, title: 'Report, save & export', short: 'Save', icon: FileText, open: false },
];

function onSaveKey(k: string) {
  if (!k) return;
  const S = useRM.getState();
  writeString(KEYS.apiKey, k);
  if (mapsLoaded() && mapsKey() === k) { S.setApiKey(k); S.showToast('Key saved'); return; }
  if (mapsLoaded()) { window.location.reload(); return; } // Google Maps loads once per page: a new key needs a reload
  S.setApiKey(k);
}

function SectionBody({ id }: { id: SectionId }) {
  switch (id) {
    case 'property': return <PropertySection onSaveKey={onSaveKey} />;
    case 'solar': return <SolarSection />;
    case 'commercial': return <CommercialSection />;
    case 'trace': return <TraceSection />;
    case 'totals': return <TotalsSection />;
    case 'export': return <ExportSection />;
  }
}

function ModeSwitch({ small }: { small?: boolean }) {
  const mode = useRM((s) => s.mode);
  const setMode = useRM((s) => s.setMode);
  const b = (m: 'res' | 'com', label: string, title: string, Icon: typeof Home) => (
    <button
      type="button" title={title} onClick={() => setMode(m)} aria-pressed={mode === m} data-testid={`mode-${m}`}
      className={cn('inline-flex flex-1 items-center justify-center gap-1.5 font-semibold transition-colors', small ? 'min-h-9 px-2.5 text-xs' : 'min-h-9 px-3 text-sm',
        mode === m ? 'bg-orange-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}
    >
      <Icon className="h-3.5 w-3.5" />{label}
    </button>
  );
  return (
    <div className="flex overflow-hidden rounded-lg border border-gray-300">
      {b('res', 'Residential', 'Houses: pitched roofs, Roofr-style report', Home)}
      {b('com', 'Commercial', 'Commercial buildings: flat / low-slope roofs, commercial report', Building2)}
    </div>
  );
}

const FOOTNOTE = 'Measurements come from orthorectified satellite imagery and are typically within a few percent of field measurements. Verify pitch, penetrations, and layers on site.';

function SidePanel({ sections }: { sections: SectionDef[] }) {
  return (
    <aside className="flex w-[360px] flex-none flex-col overflow-y-auto border-l border-gray-200 bg-gray-50 xl:w-[400px]" data-testid="side-panel">
      <div className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50/95 p-3 backdrop-blur"><ModeSwitch /></div>
      <div className="space-y-3 p-3">
        {sections.map((s) => (
          <details key={s.id} open={s.open} className="group rounded-xl border border-gray-200 bg-white shadow-sm" data-section={s.id}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-4 text-sm font-semibold text-gray-800 [&::-webkit-details-marker]:hidden">
              <s.icon className="h-4 w-4 text-orange-600" />
              <span className="flex-1">{s.n}. {s.title}</span>
              <ChevronDown className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-gray-100 px-4 pb-4 pt-3"><SectionBody id={s.id} /></div>
          </details>
        ))}
        <p className="px-1 pb-2 text-xs text-gray-500">{FOOTNOTE}</p>
      </div>
    </aside>
  );
}

type SheetState = 'peek' | 'half' | 'full';
function BottomSheet({ sections, tab, setTab, state, setState }: { sections: SectionDef[]; tab: SectionId; setTab: (t: SectionId) => void; state: SheetState; setState: (s: SheetState) => void }) {
  const drag = useRef<{ y: number; start: SheetState } | null>(null);
  const current = sections.find((s) => s.id === tab) || sections[0];
  const height = state === 'peek' ? undefined : state === 'half' ? '58%' : 'calc(100% - 8px)';
  const onTab = (id: SectionId) => {
    if (id === current.id && state !== 'peek') setState('peek');
    else { setTab(id); if (state === 'peek') setState('half'); }
  };
  return (
    <div className="absolute inset-x-0 bottom-0 z-30 flex flex-col" style={{ height }} data-testid="bottom-sheet" data-state={state}>
      {state !== 'full' && <div className="pointer-events-none absolute bottom-full left-0 right-0 mb-2 px-2"><DrawActions /></div>}
      <div className="flex min-h-0 flex-1 flex-col rounded-t-2xl border-t border-gray-200 bg-white shadow-[0_-6px_20px_rgba(0,0,0,.15)]">
        <div
          className="flex touch-none items-center gap-2 px-3 pt-1.5"
          onPointerDown={(e) => { drag.current = { y: e.clientY, start: state }; }}
          onPointerUp={(e) => {
            const d = drag.current; drag.current = null;
            if (!d) return;
            const dy = e.clientY - d.y;
            if (Math.abs(dy) < 24) return;
            const order: SheetState[] = ['peek', 'half', 'full'];
            const i = order.indexOf(d.start) + (dy < 0 ? 1 : -1);
            setState(order[Math.max(0, Math.min(2, i))]);
          }}
        >
          <div className="w-[13.5rem] flex-none"><ModeSwitch small /></div>
          <div className="mx-auto h-1.5 w-10 rounded-full bg-gray-300" aria-hidden />
          <button type="button" className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100" aria-label={state === 'full' ? 'Collapse panel' : 'Expand panel'} data-testid="sheet-toggle"
            onClick={() => setState(state === 'full' ? 'peek' : state === 'half' ? 'full' : 'half')}>
            {state === 'full' ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />}
          </button>
        </div>
        <div className="flex gap-1 px-2 pb-1.5 pt-1" role="tablist" style={state === 'peek' ? { paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom))' } : undefined}>
          {sections.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={state !== 'peek' && s.id === current.id} data-testid={`tab-${s.id}`} onClick={() => onTab(s.id)}
              className={cn('flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center rounded-lg text-[11px] font-medium',
                state !== 'peek' && s.id === current.id ? 'bg-orange-50 text-orange-700' : 'text-gray-600 hover:bg-gray-50')}>
              <s.icon className="h-4 w-4" /><span className="truncate">{s.short}</span>
            </button>
          ))}
        </div>
        {state !== 'peek' && (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-gray-100 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3" data-testid="sheet-content">
            <h2 className="mb-3 text-sm font-semibold text-gray-800">{current.n}. {current.title}</h2>
            <SectionBody id={current.id} />
            {current.id === 'export' && <p className="mt-4 text-xs text-gray-500">{FOOTNOTE}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function RoofMeasureApp() {
  const params = useSearchParams();
  const leadId = params.get('leadId');
  const paramAddress = params.get('address');
  const desktop = useMediaQuery('(min-width: 1024px)');
  const mode = useRM((s) => s.mode);
  const mapStatus = useRM((s) => s.mapStatus);
  const [tab, setTab] = useState<SectionId>('property');
  const [sheet, setSheet] = useState<SheetState>('peek');
  const [ready, setReady] = useState(false);
  const pendingGo = useRef<string | null>(null);
  const sections = mode === 'com' ? COM_SECTIONS : RES_SECTIONS;

  // Start: settings from the browser, then the roof in progress, or a fresh roof for the lead / address asked for.
  useEffect(() => {
    loadStoredSettings();
    seedRoofMeasureKey();
    const { leads, homeowners } = useCRMStore.getState();
    const lead = leadId ? leads.find((l) => l.id === leadId) : undefined;
    const owner = lead ? homeowners.find((h) => h.id === lead.homeownerId) : undefined;
    const wanted = owner ? [owner.address, owner.city, `${owner.state} ${owner.zip}`.trim()].filter(Boolean).join(', ') : paramAddress;
    const auto = readAutosave();
    const sameJob = !!auto && (!(leadId || paramAddress) || (auto.leadId === leadId && auto.paramAddress === paramAddress));
    if (auto && sameJob) {
      restore(restoreProject(auto.project), true);
    } else {
      if (auto) {
        const kept = stashAutosave(auto);
        if (kept) useRM.getState().showToast(`Your previous roof was kept in Saved roofs as "${kept}"`);
      }
      const p = emptyProject();
      if (owner) p.jobName = `${owner.firstName} ${owner.lastName}`;
      useRM.getState().replaceProject(p);
      if (wanted) { useRM.getState().setAddressInput(wanted); pendingGo.current = wanted; }
      writeAutosave(leadId, paramAddress);
    }
    useRM.getState().setApiKey(readString(KEYS.apiKey) || '');
    setReady(true); // eslint-disable-line react-hooks/set-state-in-effect
    void ensurePermits();
  }, [leadId, paramAddress]);

  // The address from the lead / query string: look it up once the map is up (without a key it stays typed in).
  useEffect(() => {
    if (mapStatus !== 'ready' || !pendingGo.current) return;
    pendingGo.current = null;
    void goToAddress();
  }, [mapStatus]);

  // Autosave the roof in progress.
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { if (timer) { clearTimeout(timer); timer = null; } writeAutosave(leadId, paramAddress); };
    const unsub = useRM.subscribe((s, prev) => {
      if (s.project === prev.project) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 400);
    });
    window.addEventListener('pagehide', flush);
    return () => { unsub(); window.removeEventListener('pagehide', flush); if (timer) flush(); };
  }, [ready, leadId, paramAddress]);

  // Keyboard: drawing shortcuts, and the arrow keys / Enter / Esc while picking a house.
  useEffect(() => {
    const isField = (t: EventTarget | null) => { const tag = ((t as HTMLElement)?.tagName || '').toLowerCase(); return tag === 'input' || tag === 'select' || tag === 'textarea' || (t as HTMLElement)?.isContentEditable; };
    const onPick = (e: KeyboardEvent) => {
      const S = useRM.getState();
      if (!S.picking || isField(e.target) || useReportViewer.getState().report) return;
      const ctl = getController();
      if (!ctl) return;
      const pan = pickPanPixels(e.key, e.shiftKey);
      if (pan) { ctl.panBy(pan[0], pan[1]); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'Enter') { void lockHouse(ctl.center()); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'Escape') { S.setPicking(false); e.preventDefault(); e.stopPropagation(); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (isField(e.target) || useReportViewer.getState().report || e.defaultPrevented) return;
      if ((e.target as HTMLElement)?.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
      const S = useRM.getState();
      if (S.mode !== 'res') return;
      if (e.key === 'Enter') { S.finishDraft(); e.preventDefault(); }
      else if (e.key === 'Escape') { if (S.draft) S.cancelDraft(); else if (S.selected) S.select(null); else S.setTool('select'); }
      else if (e.key === 'Backspace') { if (S.draft) { S.undoPoint(); e.preventDefault(); } }
      else if (e.key === 'Delete') { if (S.selected) S.removeItem(S.selected.kind, S.selected.id); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && TOOL_KEYS[e.key.toLowerCase()]) S.setTool(TOOL_KEYS[e.key.toLowerCase()]);
    };
    document.addEventListener('keydown', onPick, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onPick, true); document.removeEventListener('keydown', onKey); };
  }, []);

  // On phones, picking a shape on the map opens its editor in the Trace tab.
  useEffect(() => useRM.subscribe((s, prev) => {
    if (desktop || !s.selected || s.selected === prev.selected) return;
    setTab('trace');
    setSheet((st) => (st === 'peek' ? 'half' : st));
  }), [desktop]);

  const openProperty = () => { setTab('property'); setSheet('half'); };
  const tabId = sections.some((s) => s.id === tab) ? tab : sections[0].id;

  return (
    <div className="-m-4 flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden sm:-m-6" data-testid="roof-measure">
      <ActionBar leadId={leadId} compact={!desktop} />
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {ready && <MapView compact={!desktop} onOpenProperty={openProperty} />}
          {ready && !desktop && <BottomSheet sections={sections} tab={tabId} setTab={setTab} state={sheet} setState={setSheet} />}
        </div>
        {ready && desktop && <SidePanel sections={sections} />}
      </div>
      <ReportViewer />
    </div>
  );
}

export function RoofMeasureFallback({ children }: { children?: ReactNode }) {
  return <div className="flex h-[60vh] items-center justify-center text-sm text-gray-500">{children || 'Loading Roof Measure...'}</div>;
}
