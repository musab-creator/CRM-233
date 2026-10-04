'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Check as CheckIcon, Trash2, Undo2, X } from 'lucide-react';
import { drawingHint, EDGE_TYPES, FACET_COLOR, type Tool } from '@/lib/roof-measure/measure';
import { useRM } from './store';
import { loadGoogleMaps } from './gmaps';
import { MapController } from './MapController';
import { lockHouse, setController } from './actions';
import { cn } from '@/lib/utils';

// The map area: Google Map, drawing toolbar, hint line, pick-mode crosshair, the "no key" card and the
// drawing action bar (Undo / Finish / Cancel, large for touch).

const TOOLS: { tool: Tool; label: string; key: string; title: string; color: string }[] = [
  { tool: 'select', label: 'Select', key: 'S', title: 'Select / edit', color: '#ffffff' },
  { tool: 'facet', label: 'Facet', key: 'F', title: 'Roof facet polygon', color: FACET_COLOR },
  { tool: 'eave', label: 'Eave', key: 'E', title: 'Eave', color: EDGE_TYPES.eave.color },
  { tool: 'ridge', label: 'Ridge', key: 'R', title: 'Ridge', color: EDGE_TYPES.ridge.color },
  { tool: 'hip', label: 'Hip', key: 'H', title: 'Hip', color: EDGE_TYPES.hip.color },
  { tool: 'valley', label: 'Valley', key: 'V', title: 'Valley', color: EDGE_TYPES.valley.color },
  { tool: 'rake', label: 'Rake', key: 'K', title: 'Rake', color: EDGE_TYPES.rake.color },
  { tool: 'wall', label: 'Wall', key: 'W', title: 'Wall flashing', color: EDGE_TYPES.wall.color },
  { tool: 'step', label: 'Step', key: 'T', title: 'Step flashing', color: EDGE_TYPES.step.color },
  { tool: 'transition', label: 'Transition', key: 'N', title: 'Transition', color: EDGE_TYPES.transition.color },
  { tool: 'parapet', label: 'Parapet', key: 'P', title: 'Parapet wall', color: EDGE_TYPES.parapet.color },
  { tool: 'unspecified', label: 'Other', key: 'U', title: 'Unspecified line', color: EDGE_TYPES.unspecified.color },
];

const LABEL_CSS = `
.rm-labels { position: absolute; left: 0; top: 0; }
.rm-lbl { position: absolute; transform: translate(-50%, -50%); pointer-events: none; white-space: nowrap; font: 11px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #fff; background: rgba(0,0,0,.72); padding: 1px 5px; border-radius: 3px; text-shadow: 0 0 2px #000; }
.rm-lbl small { display: block; font-weight: 400; font-size: 10px; opacity: .9; }
.rm-lbl-facet { font-size: 12px; font-weight: 600; padding: 3px 7px; background: rgba(0,120,150,.85); text-align: center; }
.rm-lbl-cut { background: rgba(120,120,120,.85); }
.rm-lbl-fe { font-size: 10px; background: rgba(0,0,0,.5); color: #d8f6ff; }
.rm-lbl-solar { background: rgba(255,214,10,.85); color: #111; font-weight: 600; text-shadow: none; }
.rm-lbl-other { background: rgba(255,122,0,.9); color: #111; text-align: center; }
.rm-lbl-draft { background: rgba(255,122,0,.9); color: #111; font-weight: 600; text-shadow: none; }
`;

function useHint(): { text: string; err: boolean } {
  const toast = useRM((s) => s.toast);
  const picking = useRM((s) => s.picking);
  const mode = useRM((s) => s.mode);
  const tool = useRM((s) => s.tool);
  const draft = useRM((s) => s.draft);
  const hasShapes = useRM((s) => s.project.facets.length > 0 || s.project.edges.length > 0);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useRM.getState().clearToast(toast.id), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  if (toast) return { text: toast.msg, err: toast.err };
  if (picking) return { text: 'Click the house, or move the map with the arrow keys so the + is on the roof and press Enter. Esc cancels.', err: false };
  if (mode === 'com') return { text: 'Commercial: enter the address, then press Measure commercial roof.', err: false };
  return { text: drawingHint(tool, draft ? draft.points : null, hasShapes), err: false };
}

export function Toolbar({ compact }: { compact: boolean }) {
  const tool = useRM((s) => s.tool);
  const draft = useRM((s) => s.draft);
  const selected = useRM((s) => s.selected);
  const { setTool, finishDraft, undoPoint, removeItem } = useRM.getState();
  const btn = 'inline-flex flex-none items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors';
  return (
    <div
      data-testid="toolbar"
      className={cn(
        'pointer-events-auto flex max-w-full gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-white/95 p-1 shadow-md backdrop-blur [scrollbar-width:none]',
        compact ? 'w-full' : 'flex-wrap justify-center',
      )}
    >
      {TOOLS.map((t) => (
        <button
          key={t.tool} type="button" data-tool={t.tool} title={`${t.title} (${t.key})`} onClick={() => setTool(t.tool)}
          className={cn(btn, compact ? 'h-10' : 'h-8', tool === t.tool ? 'bg-orange-600 text-white' : 'text-gray-700 hover:bg-gray-100')}
          aria-pressed={tool === t.tool}
        >
          <span className="h-2.5 w-2.5 rounded-sm border border-black/20" style={{ background: t.color }} />{t.label}
        </button>
      ))}
      <span className="mx-0.5 w-px flex-none self-stretch bg-gray-200" />
      <button type="button" data-testid="btn-finish" title="Finish shape (Enter)" disabled={!draft} onClick={finishDraft} className={cn(btn, compact ? 'h-10' : 'h-8', 'text-gray-700 hover:bg-gray-100 disabled:opacity-40')}>Finish</button>
      <button type="button" title="Undo last point (Backspace)" disabled={!draft} onClick={undoPoint} className={cn(btn, compact ? 'h-10' : 'h-8', 'text-gray-700 hover:bg-gray-100 disabled:opacity-40')}>Undo pt</button>
      <button type="button" data-testid="btn-delete" title="Delete selected (Del)" disabled={!selected} onClick={() => { if (selected) removeItem(selected.kind, selected.id); }} className={cn(btn, compact ? 'h-10' : 'h-8', 'text-red-600 hover:bg-red-50 disabled:opacity-40')}>Delete</button>
    </div>
  );
}

// Big touch buttons while a shape is being drawn, and for the corner tapped on the selected shape.
export function DrawActions() {
  const mode = useRM((s) => s.mode);
  const draft = useRM((s) => s.draft);
  const sel = useRM((s) => s.selected);
  const selVertex = useRM((s) => s.selVertex);
  const project = useRM((s) => s.project);
  const { finishDraft, undoPoint, cancelDraft, deleteVertex, showToast } = useRM.getState();
  const item = sel ? (sel.kind === 'facet' ? project.facets.find((f) => f.id === sel.id) : project.edges.find((e) => e.id === sel.id)) : null;
  const pill = 'pointer-events-auto inline-flex h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold shadow-lg';
  if (mode !== 'res') return null;
  if (draft) {
    const need = draft.tool === 'facet' ? 3 : 2;
    return (
      <div className="flex justify-center gap-2" data-testid="draw-actions">
        <button type="button" className={cn(pill, 'bg-white text-gray-700')} onClick={undoPoint}><Undo2 className="h-4 w-4" />Undo</button>
        <button type="button" data-testid="fab-finish" className={cn(pill, 'bg-orange-600 text-white disabled:opacity-60')} disabled={draft.points.length < need} onClick={finishDraft}><CheckIcon className="h-4 w-4" />Finish</button>
        <button type="button" className={cn(pill, 'bg-white text-gray-700')} onClick={cancelDraft}><X className="h-4 w-4" />Cancel</button>
      </div>
    );
  }
  if (sel && item && selVertex != null && selVertex < item.path.length) {
    const min = sel.kind === 'facet' ? 3 : 2;
    return (
      <div className="flex justify-center">
        <button type="button" data-testid="fab-delete-corner" className={cn(pill, 'bg-white text-red-600 disabled:opacity-60')} disabled={item.path.length <= min}
          onClick={() => { if (deleteVertex(sel.kind, sel.id, selVertex)) showToast('Corner removed'); }}>
          <Trash2 className="h-4 w-4" />Delete corner {selVertex + 1}
        </button>
      </div>
    );
  }
  return null;
}

export default function MapView({ compact, onOpenProperty, bottomSlot }: { compact: boolean; onOpenProperty: () => void; bottomSlot?: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const apiKey = useRM((s) => s.apiKey);
  const mapStatus = useRM((s) => s.mapStatus);
  const mapError = useRM((s) => s.mapError);
  const mode = useRM((s) => s.mode);
  const picking = useRM((s) => s.picking);
  const hint = useHint();

  useEffect(() => {
    if (!apiKey || !el.current) return;
    let ctl: MapController | null = null;
    let cancelled = false;
    const S = useRM.getState();
    if (S.mapStatus !== 'ready') S.setMapStatus('loading');
    loadGoogleMaps(apiKey, () => useRM.getState().setMapStatus('error', 'Google rejected this API key. Check the key, billing, and that Maps JavaScript API is enabled.'))
      .then(() => {
        if (cancelled || !el.current) return;
        ctl = new MapController(el.current, { onLockHouse: (ll, keepView) => void lockHouse(ll, keepView) });
        setController(ctl);
        useRM.getState().setMapStatus('ready');
      })
      .catch((e) => { if (!cancelled) useRM.getState().setMapStatus('error', e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; if (ctl) { ctl.destroy(); setController(null); } };
  }, [apiKey]);

  const overlay = !apiKey || mapStatus === 'error';
  return (
    <div className="absolute inset-0 overflow-hidden bg-gray-900">
      <style>{LABEL_CSS}</style>
      <div ref={el} data-testid="map" className="absolute inset-0" />
      {mode === 'res' && !overlay && (
        <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center', compact ? 'p-2' : 'p-2.5')}>
          <Toolbar compact={compact} />
        </div>
      )}
      {!overlay && hint.text && (
        <div
          data-testid="hint" role="status"
          className={cn(
            'pointer-events-none absolute z-10 max-w-[calc(100%-1.5rem)] rounded-lg border px-3 py-1.5 text-xs shadow',
            compact ? 'left-3 right-3 top-[64px] mx-auto w-fit text-center' : 'bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap',
            hint.err ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-white/95 text-gray-800',
          )}
        >
          {hint.text}
        </div>
      )}
      {picking && (
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-[34px] w-[34px] -translate-x-1/2 -translate-y-1/2">
          <span className="absolute left-4 top-0 h-[34px] w-0.5 bg-red-500 shadow-[0_0_0_1px_rgba(0,0,0,.6)]" />
          <span className="absolute left-0 top-4 h-0.5 w-[34px] bg-red-500 shadow-[0_0_0_1px_rgba(0,0,0,.6)]" />
        </div>
      )}
      {!compact && !overlay && (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-10 flex justify-center"><DrawActions /></div>
      )}
      {overlay && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-gray-100 p-4">
          <div className="max-w-sm rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm" data-testid="nokey">
            <h2 className="mb-2 text-lg font-semibold text-gray-900">Roof Measure</h2>
            <p className="text-sm text-gray-700">{mapStatus === 'error' ? mapError : 'Paste your Google Maps API key in the Property panel to load satellite imagery.'}</p>
            <p className="mt-2 text-xs text-gray-500">Need a key? Open &quot;How to get a key&quot; in the Property panel.</p>
            {compact && <button type="button" onClick={onOpenProperty} className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-orange-600 px-4 text-sm font-medium text-white">Open Property panel</button>}
          </div>
        </div>
      )}
      {mapStatus === 'loading' && !overlay && (
        <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center text-sm text-gray-300">Loading map...</div>
      )}
      {bottomSlot}
    </div>
  );
}
