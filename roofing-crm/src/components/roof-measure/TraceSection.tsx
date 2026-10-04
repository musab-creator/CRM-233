'use client';

import { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { fmt, ftIn, pitchLabel } from '@/lib/roof-measure/format';
import { EDGE_TYPES, edgeMetrics, facetMetrics, PITCH_OPTIONS, pitchFactor, structureOf } from '@/lib/roof-measure/measure';
import type { EdgeType } from '@/lib/roof-measure/model';
import { centroid } from '@/lib/roof-measure/geo';
import { useRM } from './store';
import { getController } from './actions';
import { useTotals } from './hooks';
import { Btn, Check, H4, inputCls, LField, Muted, Out, Swatch } from './ui';
import { cn } from '@/lib/utils';

// 3. Trace roof: default pitch, drawing help, the selected shape's editor, the facet and line lists.

function PitchOptions({ withDefault, defaultPitch }: { withDefault?: boolean; defaultPitch: number }) {
  return (
    <>
      {withDefault && <option value="">Default ({pitchLabel(defaultPitch)})</option>}
      {PITCH_OPTIONS.map((p) => <option key={p} value={p}>{pitchLabel(p)}</option>)}
    </>
  );
}

// Facet name: edited locally, committed on change (blur / Enter) like the original.
function NameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) { setSeen(value); setText(value); }
  const commit = () => { const v = text.trim(); if (v && v !== value) onCommit(v); else setText(value); };
  return <input data-testid="sel-name" className={inputCls} type="text" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />;
}

export function SelectionEditor() {
  const sel = useRM((s) => s.selected);
  const selVertex = useRM((s) => s.selVertex);
  const project = useRM((s) => s.project);
  const { updateFacet, updateEdge, removeItem, deleteVertex, showToast } = useRM.getState();
  if (!sel) return null;
  const item = sel.kind === 'facet' ? project.facets.find((f) => f.id === sel.id) : project.edges.find((e) => e.id === sel.id);
  if (!item) return null;
  const minCorners = sel.kind === 'facet' ? 3 : 2;
  const cornerBtn = selVertex != null && selVertex < item.path.length && (
    <Btn small variant="danger" disabled={item.path.length <= minCorners} title={item.path.length <= minCorners ? `A ${sel.kind === 'facet' ? 'facet' : 'line'} needs at least ${minCorners} corners` : undefined}
      onClick={() => { if (deleteVertex(sel.kind, sel.id, selVertex)) showToast('Corner removed'); }}>
      <X className="h-3.5 w-3.5" />Delete corner {selVertex + 1}
    </Btn>
  );

  if (sel.kind === 'facet' && 'excluded' in item) {
    const f = item, m = facetMetrics(f);
    return (
      <Out testId="selection" className="border-orange-200 bg-orange-50/60">
        <div className="flex items-center justify-between gap-2"><b>Facet {f.name}</b><Btn small variant="danger" onClick={() => removeItem('facet', f.id)}><Trash2 className="h-3.5 w-3.5" />Delete</Btn></div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <LField label="Name"><NameInput value={f.name} onCommit={(v) => updateFacet(f.id, { name: v })} /></LField>
          <LField label="Pitch">
            <select data-testid="sel-pitch" className={inputCls} value={f.pitch} onChange={(e) => updateFacet(f.id, { pitch: +e.target.value })}><PitchOptions defaultPitch={project.defaultPitch} /></select>
          </LField>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4">
          <Check checked={f.twoStory} onChange={(v) => updateFacet(f.id, { twoStory: v })}>Two story</Check>
          <Check checked={f.twoLayer} onChange={(v) => updateFacet(f.id, { twoLayer: v })}>Two layers</Check>
          <Check id="sel-excluded" checked={f.excluded} onChange={(v) => updateFacet(f.id, { excluded: v })}>Exclude (skylight, chimney, cutout)</Check>
        </div>
        <div className="mt-1 text-xs text-gray-600">
          Plan {fmt(m.plan)} sf · pitch factor {fmt(pitchFactor(f.pitch), 3)} · <b>{fmt(m.sloped)} sf</b> {f.excluded ? 'subtracted from the roof it sits on' : 'roof area'} · perimeter {fmt(m.perimeterFt, 1)} ft · {m.path.length} corners
        </div>
        {cornerBtn && <div className="mt-2">{cornerBtn}</div>}
      </Out>
    );
  }
  const e = item as typeof project.edges[number], m = edgeMetrics(e, project.facets, project.defaultPitch);
  return (
    <Out testId="selection" className="border-orange-200 bg-orange-50/60">
      <div className="flex items-center justify-between gap-2"><b>{EDGE_TYPES[e.type].label} line</b><Btn small variant="danger" onClick={() => removeItem('edge', e.id)}><Trash2 className="h-3.5 w-3.5" />Delete</Btn></div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <LField label="Type">
          <select data-testid="sel-type" className={inputCls} value={e.type} onChange={(ev) => updateEdge(e.id, { type: ev.target.value as EdgeType })}>
            {Object.entries(EDGE_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </LField>
        <LField label="Pitch for slope length">
          <select data-testid="sel-pitch" className={inputCls} value={e.pitch == null ? '' : e.pitch} onChange={(ev) => updateEdge(e.id, { pitch: ev.target.value === '' ? null : +ev.target.value })}>
            <PitchOptions withDefault defaultPitch={project.defaultPitch} />
          </select>
        </LField>
      </div>
      <div className="mt-2 text-xs text-gray-600">Plan {fmt(m.planFt, 1)} ft &times; {fmt(m.factor, 3)} = <b>{fmt(m.trueFt, 1)} ft</b> ({ftIn(m.trueFt)}) · {m.path.length - 1} segment{m.path.length === 2 ? '' : 's'}</div>
      {cornerBtn && <div className="mt-2">{cornerBtn}</div>}
    </Out>
  );
}

export default function TraceSection() {
  const project = useRM((s) => s.project);
  const selected = useRM((s) => s.selected);
  const showFacetEdges = useRM((s) => s.showFacetEdges);
  const { setDefaultPitch, applyPitchToAll, setShowFacetEdges, removeItem, select, setTool } = useRM.getState();
  const t = useTotals();
  const multi = t.structures.length > 1;

  const pick = (kind: 'facet' | 'edge', id: number) => {
    if (useRM.getState().tool !== 'select') setTool('select');
    select({ kind, id });
    const it = kind === 'facet' ? project.facets.find((f) => f.id === id) : project.edges.find((e) => e.id === id);
    if (it && it.path.length) getController()?.panTo(kind === 'facet' ? centroid(it.path) : it.path[Math.floor(it.path.length / 2)]);
  };
  const rowCls = (on: boolean) => cn('flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-2 text-sm', on ? 'border-orange-400 bg-orange-50' : 'border-gray-200 bg-white hover:bg-gray-50');

  return (
    <div>
      <LField label={'Default pitch (rise per 12")'}>
        <div className="flex gap-1.5">
          <select data-testid="default-pitch" className={`${inputCls} flex-1`} value={project.defaultPitch} onChange={(e) => setDefaultPitch(+e.target.value)}><PitchOptions defaultPitch={project.defaultPitch} /></select>
          <Btn variant="ghost" small title="Set every facet to the default pitch" onClick={applyPitchToAll}>Apply to all facets</Btn>
        </div>
      </LField>
      <Muted className="mt-3">
        Pick a tool, click (tap) the roof corners, then double-click, press Enter or tap <b>Finish</b>. Points snap to existing corners. Right-click, Backspace or <b>Undo pt</b> removes the last point; Esc cancels.
        In <b>Select</b> mode, drag corners to adjust; right-click (or press and hold) a corner, or tap it and use <b>Delete corner</b>, to delete it. Facets that touch are grouped into one structure; a detached shed or garage becomes Structure #2.
        Mark skylights or chimneys as <b>Exclude</b> on the facet to subtract them.
      </Muted>
      <Check checked={showFacetEdges} onChange={setShowFacetEdges}>Show facet edge lengths</Check>
      <SelectionEditor />
      <H4>Facets</H4>
      <div data-testid="facet-list" className="flex flex-col gap-1">
        {project.facets.length ? project.facets.map((f) => {
          const m = facetMetrics(f);
          const tags = [f.twoStory ? '2-story' : '', f.twoLayer ? '2-layer' : ''].filter(Boolean).join(' ');
          return (
            <div key={f.id} data-testid={`facet-${f.name}`} className={cn(rowCls(selected?.kind === 'facet' && selected.id === f.id), f.excluded && 'opacity-70')} onClick={() => pick('facet', f.id)}>
              <Swatch color={f.excluded ? '#fff' : '#00d8ff'} />
              <span className="min-w-9 font-semibold">{f.name}</span>
              {multi && <span className="rounded border border-gray-200 bg-gray-50 px-1.5 text-[10px] text-gray-500">S{structureOf(t, f.id)}</span>}
              <span>{f.excluded ? 'excluded' : pitchLabel(f.pitch)}</span>
              {tags && <span className="rounded border border-gray-200 bg-gray-50 px-1.5 text-[10px] text-gray-500">{tags}</span>}
              <span className="ml-auto tabular-nums text-gray-500">{f.excluded ? '−' : ''}<b className="text-gray-800">{fmt(m.sloped)} sf</b></span>
              <button type="button" className="-mr-1 flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600" title="Delete" aria-label={`Delete ${f.name}`}
                onClick={(ev) => { ev.stopPropagation(); removeItem('facet', f.id); }}><X className="h-4 w-4" /></button>
            </div>
          );
        }) : <div className="py-1 text-xs text-gray-500">No facets yet. Use the Facet tool and click the corners of each roof plane.</div>}
      </div>
      <H4>Lines</H4>
      <div data-testid="edge-list" className="flex flex-col gap-1">
        {project.edges.length ? project.edges.map((e) => {
          const m = edgeMetrics(e, project.facets, project.defaultPitch);
          return (
            <div key={e.id} data-testid={`edge-${e.type}`} className={rowCls(selected?.kind === 'edge' && selected.id === e.id)} onClick={() => pick('edge', e.id)}>
              <Swatch color={EDGE_TYPES[e.type].color} />
              <span className="font-semibold">{EDGE_TYPES[e.type].label}</span>
              <span className="ml-auto tabular-nums text-gray-500">{m.factor !== 1 ? `${fmt(m.planFt, 1)} plan → ` : ''}<b className="text-gray-800">{fmt(m.trueFt, 1)} ft</b></span>
              <button type="button" className="-mr-1 flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600" title="Delete" aria-label={`Delete ${EDGE_TYPES[e.type].label}`}
                onClick={(ev) => { ev.stopPropagation(); removeItem('edge', e.id); }}><X className="h-4 w-4" /></button>
            </div>
          );
        }) : <div className="py-1 text-xs text-gray-500">No lines yet. Trace eaves, ridges, hips, valleys and rakes for linear footage.</div>}
      </div>
    </div>
  );
}
