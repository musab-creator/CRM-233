'use client';

import { create } from 'zustand';
import type { LatLng } from '@/lib/roof-measure/geo';
import {
  addEdge, addFacet, emptyProject, removeItem as engineRemoveItem, type EdgeType, type Edge, type Facet, type MaterialAssumptions, type Project,
} from '@/lib/roof-measure/model';
import { allVertices, draftClickAction, snapToVertex, type Tool, type ToPixel } from '@/lib/roof-measure/measure';
import { COMPANY_DEFAULT, type Company } from '@/lib/roof-measure/report';
import type { ManualPermit, PermitData } from '@/lib/roof-measure/permits';
import { COMMERCIAL_DEFAULTS, type CommercialModel, type CommercialOptions } from '@/lib/roof-measure/commercial';
import { KEYS, readJSON, readString, writeJSON, writeString } from './storage';

// Roof Measure's working state: the project (the engine's data model) plus
// the editor around it. Project updates always produce a new Project object
// (facets / edges copied), so React and the map controller can compare by
// reference; the engine's own helpers (addFacet, removeItem, ...) mutate the
// copy.

export type Selection = { kind: 'facet' | 'edge'; id: number } | null;
export type DraftTool = 'facet' | EdgeType;
export interface Draft { tool: DraftTool; points: LatLng[]; cursor: LatLng | null }
export type Mode = 'res' | 'com';
export type MapStatus = 'nokey' | 'loading' | 'ready' | 'error';
export interface Toast { msg: string; err: boolean; id: number }

export interface PermitState { key: string | null; data: PermitData | null; pending: boolean }

interface RMState {
  project: Project;
  tool: Tool;
  draft: Draft | null;
  selected: Selection;
  selVertex: number | null; // corner tapped on the selected shape (touch: delete it with a button)
  showSolar: boolean;
  showFacetEdges: boolean;
  mode: Mode;
  picking: boolean;
  addressInput: string;
  apiKey: string;
  mapStatus: MapStatus;
  mapError: string;
  toast: Toast | null;
  busy: Partial<Record<'solar' | 'scan' | 'auto' | 'com' | 'report' | 'comReport' | 'lock', boolean>>;
  solarError: string;
  permit: PermitState;
  permitManual: Record<string, ManualPermit>;
  company: Company;
  comModel: CommercialModel | null;
  comOpts: CommercialOptions;

  // project
  mutate: (fn: (p: Project) => void) => void;
  replaceProject: (p: Project) => void;
  setJobName: (v: string) => void;
  setDefaultPitch: (p: number) => void;
  applyPitchToAll: () => void;
  setWaste: (w: number) => void;
  setMat: (k: keyof MaterialAssumptions, v: number) => void;
  updateFacet: (id: number, patch: Partial<Facet>) => void;
  updateEdge: (id: number, patch: Partial<Edge>) => void;
  setShapePath: (kind: 'facet' | 'edge', id: number, path: LatLng[]) => void;
  deleteVertex: (kind: 'facet' | 'edge', id: number, index: number) => boolean;
  removeItem: (kind: 'facet' | 'edge', id: number) => void;
  setLocationState: (loc: LatLng, label?: string) => void;
  clearAll: () => void;

  // editor
  setTool: (t: Tool) => void;
  select: (sel: Selection, vertex?: number | null) => void;
  mapClick: (ll: LatLng, toPixel: ToPixel) => void;
  mapMove: (ll: LatLng, toPixel: ToPixel) => void;
  undoPoint: () => void;
  cancelDraft: () => void;
  finishDraft: () => void;
  setShowSolar: (v: boolean) => void;
  setShowFacetEdges: (v: boolean) => void;
  setMode: (m: Mode) => void;
  setPicking: (v: boolean) => void;
  setAddressInput: (v: string) => void;
  setApiKey: (k: string) => void;
  setMapStatus: (s: MapStatus, err?: string) => void;
  showToast: (msg: string, err?: boolean) => void;
  clearToast: (id: number) => void;
  setBusy: (k: keyof RMState['busy'], v: boolean) => void;
  setSolarError: (e: string) => void;
  setPermit: (p: Partial<PermitState>) => void;
  setPermitManual: (key: string, m: ManualPermit) => void;
  setCompany: (k: keyof Company, v: string) => void;
  setComModel: (m: CommercialModel | null) => void;
  setComOpt: <K extends keyof CommercialOptions>(k: K, v: CommercialOptions[K]) => void;
}

// A new Project with its own facet / edge arrays (paths copied), solar data shared.
export function cloneProject(p: Project): Project {
  return {
    ...p,
    location: p.location ? { ...p.location } : null,
    mat: { ...p.mat },
    facets: p.facets.map((f) => ({ ...f, path: f.path.map((q) => ({ lat: q.lat, lng: q.lng })) })),
    edges: p.edges.map((e) => ({ ...e, path: e.path.map((q) => ({ lat: q.lat, lng: q.lng })) })),
    otherSolar: [...p.otherSolar],
  };
}

export const permitKeyOf = (p: Pick<Project, 'address' | 'location'>) =>
  p.location ? p.address || `${p.location.lat.toFixed(6)},${p.location.lng.toFixed(6)}` : null;

let toastSeq = 0;
const SITE_COUNTS = ['drains', 'scuppers', 'skylights', 'hatches', 'heightFt'] as const;

export const useRM = create<RMState>()((set, get) => {
  const mutate = (fn: (p: Project) => void) => {
    const p = cloneProject(get().project);
    fn(p);
    set({ project: p });
  };

  const finishDraft = () => {
    const { draft, project } = get();
    if (!draft) return;
    const pts = draft.points;
    set({ draft: null });
    if (draft.tool === 'facet') {
      if (pts.length < 3) { get().showToast('A facet needs at least 3 points', true); return; }
      mutate((p) => { addFacet(p, pts, project.defaultPitch); });
    } else {
      if (pts.length < 2) { get().showToast('A line needs at least 2 points', true); return; }
      mutate((p) => { addEdge(p, draft.tool as EdgeType, pts, null); });
    }
  };

  return {
    project: emptyProject(),
    tool: 'select',
    draft: null,
    selected: null,
    selVertex: null,
    showSolar: true,
    showFacetEdges: true,
    mode: 'res',
    picking: false,
    addressInput: '',
    apiKey: '',
    mapStatus: 'nokey',
    mapError: '',
    toast: null,
    busy: {},
    solarError: '',
    permit: { key: null, data: null, pending: false },
    permitManual: {},
    company: { ...COMPANY_DEFAULT },
    comModel: null,
    comOpts: { ...COMMERCIAL_DEFAULTS },

    mutate,
    replaceProject: (p) => set({ project: p, draft: null, selected: null, selVertex: null, addressInput: p.address }),
    setJobName: (v) => mutate((p) => { p.jobName = v; }),
    setDefaultPitch: (v) => mutate((p) => { p.defaultPitch = v; }),
    applyPitchToAll: () => mutate((p) => { p.facets.forEach((f) => { f.pitch = p.defaultPitch; }); }),
    setWaste: (w) => mutate((p) => { p.waste = w; }),
    setMat: (k, v) => mutate((p) => { p.mat[k] = v; }),
    updateFacet: (id, patch) => mutate((p) => { const f = p.facets.find((x) => x.id === id); if (f) Object.assign(f, patch); }),
    updateEdge: (id, patch) => mutate((p) => { const e = p.edges.find((x) => x.id === id); if (e) Object.assign(e, patch); }),
    setShapePath: (kind, id, path) => mutate((p) => {
      const item = kind === 'facet' ? p.facets.find((x) => x.id === id) : p.edges.find((x) => x.id === id);
      if (item) item.path = path.map((q) => ({ lat: q.lat, lng: q.lng }));
    }),
    // Right-click / long-press / "Delete corner": facets keep at least 3 corners, lines 2.
    deleteVertex: (kind, id, index) => {
      const p = get().project;
      const item = kind === 'facet' ? p.facets.find((x) => x.id === id) : p.edges.find((x) => x.id === id);
      const min = kind === 'facet' ? 3 : 2;
      if (!item || item.path.length <= min || index < 0 || index >= item.path.length) return false;
      mutate((q) => {
        const it = kind === 'facet' ? q.facets.find((x) => x.id === id) : q.edges.find((x) => x.id === id);
        if (it) it.path.splice(index, 1);
      });
      set({ selVertex: null });
      return true;
    },
    removeItem: (kind, id) => {
      mutate((p) => engineRemoveItem(p, kind, id));
      const sel = get().selected;
      if (sel && sel.kind === kind && sel.id === id) set({ selected: null, selVertex: null });
    },
    setLocationState: (loc, label) => {
      const address = label || `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
      mutate((p) => { p.location = { lat: loc.lat, lng: loc.lng }; p.address = address; });
      writeJSON(KEYS.lastLoc, loc);
      // a new house: permits are looked up again; the commercial measurement and its per-building site counts reset
      const comOpts = { ...get().comOpts };
      for (const k of SITE_COUNTS) comOpts[k] = '';
      writeJSON(KEYS.comOpts, comOpts);
      set({ addressInput: address, permit: { key: null, data: null, pending: false }, comModel: null, comOpts });
    },
    clearAll: () => {
      mutate((p) => { p.facets = []; p.edges = []; p.solar = null; p.otherSolar = []; p.jobName = ''; });
      set({ draft: null, selected: null, selVertex: null, solarError: '' });
    },

    setTool: (t) => {
      const drawing = t !== 'select';
      set((s) => ({ tool: t, draft: null, picking: false, selected: drawing ? null : s.selected, selVertex: drawing ? null : s.selVertex }));
    },
    // re-selecting the same shape keeps the same object, so "selection changed" means a different shape
    select: (sel, vertex = null) => set((s) => ({
      selected: sel && s.selected && s.selected.kind === sel.kind && s.selected.id === sel.id ? s.selected : sel,
      selVertex: sel ? vertex : null,
    })),
    mapClick: (ll, toPixel) => {
      const { tool, project } = get();
      if (tool === 'select') { set({ selected: null, selVertex: null }); return; }
      const draft = get().draft || { tool: tool as DraftTool, points: [], cursor: null };
      const pt = snapToVertex(ll, allVertices(project, draft.points), toPixel);
      const action = draftClickAction(draft.tool, draft.points, pt, toPixel);
      if (action === 'ignore') { if (!get().draft) set({ draft }); return; }
      if (action === 'finish') { set({ draft }); finishDraft(); return; }
      set({ draft: { ...draft, points: [...draft.points, { lat: pt.lat, lng: pt.lng }] } });
    },
    mapMove: (ll, toPixel) => {
      const { draft, project } = get();
      if (!draft) return;
      const c = snapToVertex(ll, allVertices(project, draft.points), toPixel);
      set({ draft: { ...draft, cursor: { lat: c.lat, lng: c.lng } } });
    },
    undoPoint: () => {
      const { draft } = get();
      if (!draft) return;
      const points = draft.points.slice(0, -1);
      set({ draft: points.length ? { ...draft, points } : null });
    },
    cancelDraft: () => set({ draft: null }),
    finishDraft,
    setShowSolar: (v) => set({ showSolar: v }),
    setShowFacetEdges: (v) => set({ showFacetEdges: v }),
    setMode: (m) => { writeString(KEYS.mode, m); set({ mode: m, draft: null, picking: false }); },
    setPicking: (v) => set((s) => ({ picking: v, tool: v ? 'select' : s.tool, draft: v ? null : s.draft })),
    setAddressInput: (v) => set({ addressInput: v }),
    setApiKey: (k) => set({ apiKey: k }),
    setMapStatus: (s, err = '') => set({ mapStatus: s, mapError: err }),
    showToast: (msg, err = false) => set({ toast: { msg, err, id: ++toastSeq } }),
    clearToast: (id) => { if (get().toast?.id === id) set({ toast: null }); },
    setBusy: (k, v) => set((s) => ({ busy: { ...s.busy, [k]: v } })),
    setSolarError: (e) => set({ solarError: e }),
    setPermit: (p) => set((s) => ({ permit: { ...s.permit, ...p } })),
    setPermitManual: (key, m) => {
      const all = { ...get().permitManual, [key]: m };
      writeJSON(KEYS.permitManual, all);
      set({ permitManual: all });
    },
    setCompany: (k, v) => {
      const company = { ...get().company, [k]: v };
      writeJSON(KEYS.company, company);
      set({ company });
    },
    setComModel: (m) => set({ comModel: m }),
    setComOpt: (k, v) => {
      const comOpts = { ...get().comOpts, [k]: v };
      writeJSON(KEYS.comOpts, comOpts);
      set({ comOpts });
    },
  };
});

// Settings kept in the browser (the original tool's storage keys), read once on the client.
export function loadStoredSettings() {
  const company = { ...COMPANY_DEFAULT, ...readJSON<Partial<Company>>(KEYS.company, {}) };
  const comOpts = { ...COMMERCIAL_DEFAULTS, ...(readJSON<Partial<CommercialOptions> | null>(KEYS.comOpts, null) || {}) };
  const permitManual = readJSON<Record<string, ManualPermit>>(KEYS.permitManual, {});
  const mode: Mode = readString(KEYS.mode) === 'com' ? 'com' : 'res';
  useRM.setState({ company, comOpts, permitManual, mode });
}
