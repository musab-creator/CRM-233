'use client';

import type { LatLng } from '@/lib/roof-measure/geo';
import { serializeProject, parseProjectJSON, parseSavedProjects, restoreProject, SAVED_PROJECTS_KEY, type Project, type SavedProject } from '@/lib/roof-measure/model';
import { buildCSV, computeTotals, fileBase } from '@/lib/roof-measure/measure';
import { fetchBuildingInsights, scanStructures as engineScan, type FetchBuilding } from '@/lib/roof-measure/solar';
import { coordsLabel, parseLatLngInput, pickReverseAddress, type GeocodeResult } from '@/lib/roof-measure/geocode';
import { lookupPermits, type PermitData } from '@/lib/roof-measure/permits';
import { buildReportHTML, coverPhotoUrl, imageToDataURL, standaloneDoc, withoutLiveSatellite } from '@/lib/roof-measure/report';
import { cloneProject, permitKeyOf, useRM } from './store';
import { KEYS, readString, writeJSON, writeString } from './storage';
import type { MapController } from './MapController';
import type { AutoTraceLayers } from '@/lib/roof-measure/autotrace';
import type { CommercialRasters } from '@/lib/roof-measure/commercial';

// The tool's buttons: geocoding, Solar API, auto-trace, permits, commercial
// measure, reports, save / load / export. Each reads and writes the store and
// moves the map through the controller; the engine does the work.

let controller: MapController | null = null;
export const setController = (c: MapController | null) => { controller = c; };
export const getController = () => controller;

const S = () => useRM.getState();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------ location

// Sets the house (address box, pin, map view) and looks up its permits.
export function setLocation(loc: LatLng, label?: string) {
  S().setLocationState(loc, label);
  controller?.setView(loc, 20);
  void ensurePermits();
}

function geocoder(): google.maps.Geocoder | null {
  return typeof google !== 'undefined' && google.maps?.Geocoder ? new google.maps.Geocoder() : null;
}
const toResult = (r: google.maps.GeocoderResult): GeocodeResult => ({
  formatted_address: r.formatted_address, types: r.types,
  geometry: { location_type: r.geometry.location_type as string | undefined, location: { lat: r.geometry.location.lat(), lng: r.geometry.location.lng() } },
});

// Address box "Go": coordinates as typed, else Google's first geocoder result.
export async function goToAddress() {
  const q = S().addressInput.trim();
  if (!q) return;
  const ll = parseLatLngInput(q);
  if (ll) { setLocation(ll, q); return; }
  const g = geocoder();
  if (!g || !controller) { S().showToast('The map is not loaded yet. Save a Google Maps API key first.', true); return; }
  try {
    const res = await g.geocode({ address: q });
    const r = res.results && res.results[0];
    if (!r) throw new Error('No results');
    setLocation({ lat: r.geometry.location.lat(), lng: r.geometry.location.lng() }, r.formatted_address);
  } catch (e) {
    S().showToast('Address not found: ' + errMsg(e), true);
  }
}

// Locks in the house at the exact point (on the roof) with Google's nearest street address.
export async function lockHouse(loc: LatLng, keepView = false) {
  if (S().busy.lock) return;
  S().setBusy('lock', true);
  S().setPicking(false);
  S().showToast('Locking in this house...');
  try {
    let addr: string | null = null;
    const g = geocoder();
    if (g) { try { const res = await g.geocode({ location: loc }); addr = pickReverseAddress((res.results || []).map(toResult)); } catch { addr = null; } }
    const view = keepView && controller ? { c: controller.center(), z: controller.zoom() } : null;
    setLocation(loc, addr || coordsLabel(loc));
    if (view) controller?.setView(view.c, view.z);
    S().showToast(addr ? `Locked: ${addr}` : 'Locked at this point (no street address found here)');
  } finally {
    S().setBusy('lock', false);
  }
}

// ------------------------------------------------------------------ Solar API

const fetchBuilding = (): FetchBuilding => (lat, lng) => fetchBuildingInsights(lat, lng, S().apiKey);

export async function runSolar(): Promise<boolean> {
  const loc = S().project.location;
  if (!loc) return false;
  S().setBusy('solar', true);
  S().setSolarError('');
  try {
    const solar = await fetchBuildingInsights(loc.lat, loc.lng, S().apiKey);
    S().mutate((p) => { p.solar = solar; });
    return true;
  } catch (e) {
    S().setSolarError(errMsg(e));
    return false;
  } finally {
    S().setBusy('solar', false);
  }
}

export async function scanForStructures() {
  const loc = S().project.location;
  if (!loc) return;
  S().setBusy('scan', true);
  try {
    const found = await engineScan(loc, S().project.solar?.name, fetchBuilding());
    S().mutate((p) => { p.otherSolar = found; });
    S().showToast(found.length ? `${found.length} other structure${found.length === 1 ? '' : 's'} found` : 'No other structures found within about 120 ft');
  } finally {
    S().setBusy('scan', false);
  }
}

// Downloaded rasters per building, for this page session: re-tracing (or re-printing) the same roof costs nothing extra.
const layerCache = new Map<string, AutoTraceLayers>();

export async function autoTrace(): Promise<void> {
  const main = S().project.solar;
  if (!main) throw new Error('Get roof data first');
  const at = await import('@/lib/roof-measure/autotrace');
  const key = `${main.name}|${at.autoTraceRadius(main)}`;
  let layers = layerCache.get(key);
  if (!layers) {
    S().showToast('Downloading roof height model...');
    layers = await at.loadAutoTraceLayers(main, S().apiKey);
    layerCache.set(key, layers);
  }
  const res = await at.autoTraceRoof({ building: main, mask: layers.mask, dsm: layers.dsm, fetchBuilding: fetchBuilding(), defaultPitch: S().project.defaultPitch });
  const p = cloneProject(S().project);
  const info = at.applyAutoTrace(p, res);
  S().replaceProject(p);
  if (p.facets.length) controller?.fitPaths(p.facets.map((f) => f.path));
  S().showToast(`Auto-traced ${info.facets} facets, ${info.edges} lines, ${info.structures} structure${info.structures === 1 ? '' : 's'}`);
}

export async function runAutoTrace() {
  S().setBusy('auto', true);
  try { await autoTrace(); } catch (e) { S().showToast('Auto-trace failed: ' + errMsg(e), true); } finally { S().setBusy('auto', false); }
}

// ------------------------------------------------------------------ permits

let permitLookup: { key: string; promise: Promise<PermitData> } | null = null;

export async function ensurePermits(force = false): Promise<PermitData | null> {
  const p = S().project;
  const key = permitKeyOf(p);
  if (!key || !p.location) return null;
  const cur = S().permit;
  if (!force && cur.key === key && cur.data) return cur.data;
  if (!force && cur.key === key && cur.pending && permitLookup?.key === key) return permitLookup.promise;
  S().setPermit({ key, data: force && cur.key === key ? cur.data : null, pending: true });
  const promise = lookupPermits(p.location, p.address);
  permitLookup = { key, promise };
  try {
    const data = await promise;
    if (S().permit.key === key) S().setPermit({ data, pending: false });
    return data;
  } finally {
    if (permitLookup?.promise === promise) permitLookup = null;
  }
}

export const manualPermitOf = () => { const k = S().permit.key; return k ? S().permitManual[k] || null : null; };

// ------------------------------------------------------------------ commercial

const rasterCache = new Map<string, CommercialRasters>();

export async function runCommercial() {
  const p = S().project;
  if (!p.location) { S().showToast('Enter the address first', true); return; }
  S().setBusy('com', true);
  try {
    S().showToast('Downloading roof height model...');
    const com = await import('@/lib/roof-measure/commercial');
    const key = S().apiKey;
    const model = await com.measureCommercial(p.location, {
      fetchBuilding: fetchBuilding(),
      loadRasters: (lat, lng, radius) => com.loadCommercialRasters(lat, lng, radius, key, fetch, rasterCache),
    });
    model.address = p.address;
    S().setComModel(model);
    S().showToast('Commercial roof measured');
  } catch (e) {
    S().showToast('Commercial measure failed: ' + errMsg(e), true);
  } finally {
    S().setBusy('com', false);
  }
}

// ------------------------------------------------------------------ reports

export interface BuiltReport { title: string; printDoc: string; downloadDoc: string; fileName: string }

// The diagram, length, area, pitch and summary pages need a traced roof: trace it automatically when there is none yet.
async function ensureTrace(): Promise<boolean> {
  if (S().project.facets.length) return true;
  if (!S().project.solar && S().project.location) await runSolar();
  if (!S().project.solar) {
    if (!S().project.edges.length) { S().showToast('Nothing to report yet. Enter an address and get roof data first.', true); return false; }
    return true;
  }
  S().showToast('Tracing the roof for the diagram pages...');
  try { await autoTrace(); } catch (e) { S().showToast('Auto-trace failed (' + errMsg(e) + '). Trace the roof by hand to get the diagram pages.', true); }
  return true;
}

export async function buildResidentialReport(): Promise<BuiltReport | null> {
  if (!(await ensureTrace())) return null;
  try { await ensurePermits(); } catch { /* shown as unavailable */ }
  S().showToast('Building report...');
  const p = S().project;
  const t = computeTotals(p);
  const url = coverPhotoUrl(p, t, S().apiKey);
  const sat = await imageToDataURL(url);
  const satForPrint = sat || url;
  const permits = p.location ? { data: S().permit.data, manual: manualPermitOf() } : null;
  const { html } = buildReportHTML({ project: p, totals: t, company: S().company, satellite: satForPrint || null, permits });
  // never ship the API key inside a shareable file: drop the live-URL image if it could not be embedded
  const shareable = sat || !url ? html : withoutLiveSatellite(html, url);
  return {
    title: 'Roof Report - ' + (p.address || ''),
    printDoc: standaloneDoc(html, p.address),
    downloadDoc: standaloneDoc(shareable, p.address),
    fileName: fileBase(p) + '_Roof_Report.html',
  };
}

export async function buildCommercialReport(): Promise<BuiltReport | null> {
  if (!S().comModel) { await runCommercial(); if (!S().comModel) return null; }
  try { await ensurePermits(); } catch { /* shown as unavailable */ }
  S().showToast('Building commercial report...');
  const cr = await import('@/lib/roof-measure/commercial-report');
  const M = S().comModel!;
  const p = S().project;
  const url = cr.commercialCoverUrl(M, S().apiKey);
  const sat = await imageToDataURL(url, 9000);
  const permits = p.location ? { data: S().permit.data, manual: manualPermitOf() } : null;
  const html = cr.buildCommercialReportHTML({ model: M, options: S().comOpts, company: S().company, address: p.address, satellite: sat || url || null, permits });
  const title = 'Commercial Roof Report - ' + (M.address || p.address || '');
  return {
    title,
    printDoc: cr.commercialStandaloneDoc(html, title),
    downloadDoc: cr.commercialStandaloneDoc(sat || !url ? html : cr.withoutLiveCommercialSatellite(html, url), title),
    fileName: fileBase(p) + '_Commercial_Roof_Report.html',
  };
}

// ------------------------------------------------------------------ files

export function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const exportCSV = () => download(fileBase(S().project) + '_measurements.csv', buildCSV(S().project), 'text/csv');
export const exportJSON = () => download(fileBase(S().project) + '_roof.json', JSON.stringify(serializeProject(S().project), null, 2), 'application/json');

// Loads a saved / imported roof: replaces facets, lines and Solar data, moves the map to it.
// keepSiteCounts: reloading the roof in progress keeps the commercial site counts typed for it.
export function restore(p: Project, keepSiteCounts = false) {
  const comOpts = S().comOpts;
  S().replaceProject(p);
  if (p.location) {
    S().setLocationState(p.location, p.address);
    if (keepSiteCounts) { useRM.setState({ comOpts }); writeJSON(KEYS.comOpts, comOpts); }
    if (!p.facets.length) controller?.setView(p.location, 20);
    void ensurePermits();
  }
  if (p.facets.length) controller?.fitPaths(p.facets.map((f) => f.path));
}

export async function importJSONFile(file: File) {
  try {
    restore(parseProjectJSON(await file.text()));
    S().showToast('Imported');
  } catch (e) {
    S().showToast('Import failed: ' + errMsg(e), true);
  }
}

// ------------------------------------------------------------------ saved roofs (this browser)

export function savedRoofs() {
  try { return parseSavedProjects(readString(SAVED_PROJECTS_KEY)); } catch { return []; }
}
function savedMap(): Record<string, SavedProject> {
  try { return JSON.parse(readString(SAVED_PROJECTS_KEY) || '{}'); } catch { return {}; }
}
export function saveRoof(name: string): boolean {
  const all = savedMap();
  all[name] = serializeProject(S().project);
  if (!writeString(SAVED_PROJECTS_KEY, JSON.stringify(all))) { S().showToast('Could not save (browser storage full). Use Export JSON instead.', true); return false; }
  S().showToast(`Saved "${name}"`);
  return true;
}
export function deleteSavedRoof(name: string) {
  const all = savedMap();
  delete all[name];
  writeString(SAVED_PROJECTS_KEY, JSON.stringify(all));
}
export function loadSavedRoof(name: string) {
  const d = savedMap()[name];
  if (!d) return;
  restore(restoreProject(d));
  S().showToast(`Loaded "${name}"`);
}

// ------------------------------------------------------------------ the roof in progress (autosave)

// origin: how the page was opened (lead / address query), so a roof is only restored for the same job.
export interface Autosave { v: 1; leadId: string | null; paramAddress: string | null; savedAt: string; project: SavedProject }
export function writeAutosave(leadId: string | null, paramAddress: string | null) {
  const data: Autosave = { v: 1, leadId, paramAddress, savedAt: new Date().toISOString(), project: serializeProject(S().project) };
  writeString(KEYS.autosave, JSON.stringify(data));
}
export function readAutosave(): Autosave | null {
  try {
    const d = JSON.parse(readString(KEYS.autosave) || 'null');
    return d && d.v === 1 && d.project && d.project.app === 'roof-measure' ? d : null;
  } catch { return null; }
}
// Keeps a roof that is about to be replaced among the saved roofs, so nothing traced is ever lost.
export function stashAutosave(a: Autosave) {
  const p = a.project;
  if (!p.facets.length && !p.edges.length) return null;
  const all = savedMap();
  const name = `${p.jobName || p.address || 'Roof'} (autosaved ${new Date(a.savedAt).toLocaleDateString('en-US')})`;
  all[name] = p;
  return writeString(SAVED_PROJECTS_KEY, JSON.stringify(all)) ? name : null;
}
