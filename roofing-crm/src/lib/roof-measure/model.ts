import type { LatLng } from './geo';

// Roof Measure's data model and its saved-file format.
//
// serializeProject() writes the same object as the tool's "Export JSON" button
// and its saved roofs in localStorage (rm.projects, app "roof-measure",
// version 2); restoreProject() reads either back, so roofs saved in the
// original tool import unchanged.

export type EdgeType = 'eave' | 'valley' | 'hip' | 'ridge' | 'rake' | 'wall' | 'step' | 'transition' | 'parapet' | 'unspecified';

export interface Facet {
  id: number;
  name: string;
  pitch: number; // rise per 12"; 0 = flat
  path: LatLng[]; // corners, not closed
  twoStory: boolean;
  twoLayer: boolean;
  excluded: boolean; // skylight / chimney / cutout: subtracted from the roof
  azimuth: number | null; // compass direction the plane faces (Solar API / auto-trace), null if unknown
}

export interface Edge {
  id: number;
  type: EdgeType;
  pitch: number | null; // null = pitch of the facet it runs along, else the default pitch
  path: LatLng[];
  name: string;
}

// Material coverage assumptions (the sidebar's quick materials list).
export interface MaterialAssumptions {
  ridgeCapLF: number;
  starterLF: number;
  underlaySq: number;
  iwLF: number;
  dripStick: number;
  valleyStick: number;
  nailsPerSq: number;
  nailsPerBox: number;
}

export const DEFAULT_MATERIALS: MaterialAssumptions = { ridgeCapLF: 33, starterLF: 105, underlaySq: 10, iwLF: 66.7, dripStick: 10, valleyStick: 10, nailsPerSq: 320, nailsPerBox: 7200 };

// Google Solar API buildingInsights response (fields the tool reads).
export interface SolarLatLng { latitude: number; longitude: number }
export interface SolarBox { sw: SolarLatLng; ne: SolarLatLng }
export interface SolarDate { year: number; month: number; day: number }
export interface RoofSegmentStats {
  pitchDegrees: number;
  azimuthDegrees: number;
  stats: { areaMeters2: number; groundAreaMeters2?: number; sunshineQuantiles?: number[] };
  center: SolarLatLng;
  boundingBox: SolarBox;
  planeHeightAtCenterMeters: number;
}
export interface BuildingInsights {
  name?: string;
  center?: SolarLatLng;
  boundingBox?: SolarBox;
  imageryDate?: SolarDate;
  imageryQuality?: string;
  solarPotential?: {
    wholeRoofStats?: { areaMeters2: number; groundAreaMeters2?: number };
    roofSegmentStats?: RoofSegmentStats[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface Project {
  jobName: string;
  address: string;
  location: LatLng | null;
  defaultPitch: number;
  waste: number; // % for the quick materials list
  mat: MaterialAssumptions;
  facets: Facet[];
  edges: Edge[];
  solar: BuildingInsights | null; // main building
  otherSolar: BuildingInsights[]; // other buildings found by the structure scan / auto-trace
}

export function emptyProject(): Project {
  return { jobName: '', address: '', location: null, defaultPitch: 6, waste: 10, mat: { ...DEFAULT_MATERIALS }, facets: [], edges: [], solar: null, otherSolar: [] };
}

export const EDGE_TYPE_KEYS: EdgeType[] = ['eave', 'valley', 'hip', 'ridge', 'rake', 'wall', 'step', 'transition', 'parapet', 'unspecified'];
export const isEdgeType = (t: unknown): t is EdgeType => typeof t === 'string' && (EDGE_TYPE_KEYS as string[]).includes(t);

export const nextId = (p: Project) => Math.max(0, ...p.facets.map((f) => f.id), ...p.edges.map((e) => e.id)) + 1;

// The tool's addFacet(): default name "F<n>", flags coerced to booleans.
export function makeFacet(p: Project, path: LatLng[], pitch: number, name?: string, flags: { twoStory?: boolean; twoLayer?: boolean; excluded?: boolean; azimuth?: number | null } = {}): Facet {
  return {
    id: nextId(p), name: name || `F${p.facets.length + 1}`, pitch, path: path.map((q) => ({ lat: q.lat, lng: q.lng })),
    twoStory: !!flags.twoStory, twoLayer: !!flags.twoLayer, excluded: !!flags.excluded, azimuth: flags.azimuth == null ? null : flags.azimuth,
  };
}
export function addFacet(p: Project, path: LatLng[], pitch: number, name?: string, flags?: Parameters<typeof makeFacet>[4]): Facet {
  const f = makeFacet(p, path, pitch, name, flags);
  p.facets.push(f);
  return f;
}
export function addEdge(p: Project, type: EdgeType, path: LatLng[], pitch: number | null = null, name = ''): Edge {
  const e: Edge = { id: nextId(p), type, pitch: pitch == null ? null : pitch, path: path.map((q) => ({ lat: q.lat, lng: q.lng })), name };
  p.edges.push(e);
  return e;
}
// The tool's removeItem(): deleting a facet renumbers auto-named facets (F1, F2, ...).
export function removeItem(p: Project, kind: 'facet' | 'edge', id: number) {
  if (kind === 'facet') {
    p.facets = p.facets.filter((f) => f.id !== id);
    p.facets.forEach((f, k) => { if (/^F\d+$/.test(f.name)) f.name = `F${k + 1}`; });
  } else p.edges = p.edges.filter((e) => e.id !== id);
}

// ------------------------------------------------------------------ saved format (version 2)

export interface SavedFacet { name: string; pitch: number; twoStory: boolean; twoLayer: boolean; excluded: boolean; azimuth: number | null; path: LatLng[] }
export interface SavedEdge { type: string; pitch: number | null; path: LatLng[] }
export interface SavedProject {
  app: 'roof-measure';
  version: number;
  savedAt: string;
  jobName: string;
  address: string;
  location: LatLng | null;
  defaultPitch: number;
  waste: number;
  mat: MaterialAssumptions;
  facets: SavedFacet[];
  edges: SavedEdge[];
  solar: BuildingInsights | null;
  otherSolar: BuildingInsights[];
}

export function serializeProject(p: Project, savedAt: Date = new Date()): SavedProject {
  return {
    app: 'roof-measure', version: 2, savedAt: savedAt.toISOString(),
    jobName: p.jobName, address: p.address, location: p.location, defaultPitch: p.defaultPitch, waste: p.waste, mat: p.mat,
    facets: p.facets.map((f) => ({ name: f.name, pitch: f.pitch, twoStory: f.twoStory, twoLayer: f.twoLayer, excluded: f.excluded, azimuth: f.azimuth, path: f.path.map((q) => ({ lat: q.lat, lng: q.lng })) })),
    edges: p.edges.map((e) => ({ type: e.type, pitch: e.pitch, path: e.path.map((q) => ({ lat: q.lat, lng: q.lng })) })),
    solar: p.solar, otherSolar: p.otherSolar,
  };
}

type Loose = Record<string, unknown>;
const latLngOf = (v: unknown): LatLng => { const o = v as Loose; return { lat: Number(o.lat), lng: Number(o.lng) }; };

// The tool's restore(): a fresh project from a saved / exported object.
export function restoreProject(d: Partial<SavedProject> | Loose): Project {
  const s = d as Loose;
  const p = emptyProject();
  p.jobName = typeof s.jobName === 'string' ? s.jobName : '';
  if (s.location) {
    p.location = latLngOf(s.location);
    p.address = (s.address as string) || `${p.location.lat.toFixed(6)}, ${p.location.lng.toFixed(6)}`;
  } else p.address = typeof s.address === 'string' ? s.address : '';
  if (s.defaultPitch != null) p.defaultPitch = s.defaultPitch as number;
  if (s.waste != null) p.waste = s.waste as number;
  if (s.mat) Object.assign(p.mat, s.mat);
  for (const f of (s.facets as Loose[]) || []) addFacet(p, ((f.path as unknown[]) || []).map(latLngOf), f.pitch as number, f.name as string, f as Parameters<typeof makeFacet>[4]);
  for (const e of (s.edges as Loose[]) || []) addEdge(p, isEdgeType(e.type) ? e.type : 'unspecified', ((e.path as unknown[]) || []).map(latLngOf), e.pitch as number | null);
  p.solar = (s.solar as BuildingInsights) || null;
  p.otherSolar = (s.otherSolar as BuildingInsights[]) || [];
  return p;
}

// Reads an exported JSON file; throws like the tool's import does.
export function parseProjectJSON(text: string): Project {
  const d = JSON.parse(text);
  if (!d || d.app !== 'roof-measure') throw new Error('Not a Roof Measure file');
  return restoreProject(d);
}

// The tool's saved-roofs store (localStorage "rm.projects"): name -> saved project, newest first.
export const SAVED_PROJECTS_KEY = 'rm.projects';
export function parseSavedProjects(json: string | null): { name: string; saved: SavedProject }[] {
  const all = JSON.parse(json || '{}') as Record<string, SavedProject>;
  return Object.keys(all).sort((a, b) => (all[b].savedAt || '').localeCompare(all[a].savedAt || '')).map((name) => ({ name, saved: all[name] }));
}
