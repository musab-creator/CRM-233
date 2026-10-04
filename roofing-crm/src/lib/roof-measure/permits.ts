import type { LatLng } from './geo';
import { esc } from './format';

// Permit history and roof age (the tool's permits.js), as data.
//
// Sources: the Florida Department of Revenue parcel roll (county, parcel,
// year built), City of Jacksonville parcels and its JAXEPICS permit system
// (through /relay/jaxepics: the city's API only answers its own site), the
// published copy of every city roofing permit, the Duval County Property
// Appraiser record (/relay/pao) and Clay County's EnerGov search
// (/relay/clay). Other jurisdictions get a link to their permit portal.

export const PERMIT_URL = {
  fdor: 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query',
  cojParcels: 'https://maps.coj.net/coj/rest/services/CityBiz/Parcels/MapServer/0/query',
  jaxSite: 'https://jaxepics.coj.net',
  pao: 'https://paopropertysearch.coj.net/Basic/Detail.aspx?RE=',
};
// Published permit index (meta.json, roof_<3 digits>.json, addr.json); the CRM rewrites this path to the tool's site.
export const PERMIT_INDEX_BASE = '/roof-measure-data/permits/';
export const PERMIT_COUNTY: Record<number, string> = { 26: 'Duval', 65: 'St. Johns', 20: 'Clay', 55: 'Nassau', 10: 'Baker', 54: 'Putnam' };
export interface PermitPortal { name: string; url: string }
export const PERMIT_PORTAL: Record<string, PermitPortal> = {
  coj: { name: 'City of Jacksonville (JAXEPICS)', url: 'https://jaxepics.coj.net/Search/SearchResults' },
  beaches: { name: 'Jacksonville Beach / Atlantic Beach / Neptune Beach building department', url: 'https://www.jacksonvillebeach.org/207/Building-Inspection' },
  'St. Johns': { name: 'St. Johns County permit search (WATS)', url: 'https://webapp.sjcfl.us/WATSWebX/Permit/SearchPermit.aspx' },
  Clay: { name: 'Clay County permit portal (EnerGov)', url: 'https://claycountyfl-energovpub.tylerhost.net/apps/selfservice' },
  Nassau: { name: 'Nassau County permit portal', url: 'https://aca-prod.accela.com/NASSAU/Cap/CapHome.aspx?module=Building' },
};
const BEACH_CITIES = /JACKSONVILLE BEACH|JAX BEACH|ATLANTIC BEACH|NEPTUNE BEACH|BALDWIN/i;
export const PERMIT_MANUAL_KEY = 'rm.permitManual'; // the tool's storage of hand-entered last roof permits, by address

export interface Permit {
  number: string; type: string; use: string; structure: string; work: string; status: string;
  submitted: string | null; issued: string | null; finaled: string | null;
  contractor?: string; cost?: number | null; address: string; link: string; roof: boolean;
}
export interface PermitData {
  checked: string;
  address: string;
  county: string | null;
  jurisdiction: string | null;
  parcel: { id?: string; address?: string; city?: string; zip?: string; buildings?: number; livingArea?: number; re?: string; reNoSpace?: string; cityAddress?: string; use?: string } | null;
  yearBuilt: number | null;
  effYear: number | null;
  roofCover: string | null;
  roofStruct: string | null;
  permits: Permit[];
  searched: boolean;
  source: string | null;
  portal: PermitPortal | null;
  notes: string[];
  errors: string[];
  recordsFrom?: number;
  searchTerm?: string;
  indexOnly?: boolean;
  paoUrl?: string;
}
export interface ManualPermit { date?: string; number?: string }

// Date-only values ("2026-05-06") are calendar dates: read them as local dates, not midnight UTC.
export const pDate = (s: string | Date | null | undefined): Date | null => {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s as string);
};
export const pFmt = (s: string | Date | null | undefined) => { const d = pDate(s); return d && !isNaN(+d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-'; };
const yearsSince = (d: Date | null, now: Date) => (d && !isNaN(+d) ? (+now - +d) / (365.25 * 86400000) : null);
export const normAddr = (s: unknown) => String(s || '').toUpperCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ sources

export interface PermitLookupOptions {
  fetch?: typeof fetch;
  relayBase?: string; // origin of the CRM's /relay routes ('' = same origin)
  permitIndexBase?: string; // published permit index
  now?: Date;
}
interface Env { fetch: typeof fetch; relay: string; index: string }

type Attrs = Record<string, unknown>;
async function arcQuery(env: Env, url: string, params: Record<string, string | number | boolean>): Promise<{ attributes: Attrs }[]> {
  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), f: 'json' });
  const r = await env.fetch(url + '?' + q);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json(); if (j.error) throw new Error(j.error.message || 'query failed');
  return j.features || [];
}
// Parcel at a point, falling back to the nearest parcel within 25 m (geocoded points can sit on the street).
async function parcelAt(env: Env, url: string, loc: LatLng, outFields: string): Promise<Attrs | null> {
  const base = { geometry: `${loc.lng},${loc.lat}`, geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields, returnGeometry: false };
  let f = await arcQuery(env, url, base);
  if (!f.length) f = await arcQuery(env, url, { ...base, distance: 25, units: 'esriSRUnit_Meter' });
  return f.length ? f[0].attributes : null;
}

const str = (v: unknown) => (v == null ? '' : String(v));

// JAXEPICS address search (pages of 100).
export async function jaxPermits(term: string, opts: PermitLookupOptions = {}): Promise<Permit[]> {
  const env = envOf(opts);
  const all: Attrs[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await env.fetch(`${env.relay}/relay/jaxepics?op=address&page=${page}&term=${encodeURIComponent(term)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error('permit search HTTP ' + r.status);
    const j = await r.json(); const v = (j.values || []) as Attrs[]; all.push(...v); if (v.length < 100) break;
  }
  return all.filter((v) => v.type === 'Permit' && v.obj).map((v) => {
    const o = v.obj as Attrs;
    return {
      number: str(v.title), type: str(o.PermitType), use: str(o.ProposedUse), structure: str(o.StructureType), work: str(o.WorkType),
      status: str(o.Status), submitted: (o.DateLastSubmitted as string) || null, issued: (o.DateIssued as string) || null, finaled: null,
      address: str(o.Address), link: v.link ? PERMIT_URL.jaxSite + v.link : '', roof: /roof/i.test(str(o.PermitType)) || /roof/i.test(str(v.description)),
    };
  });
}

// JAXEPICS advanced search by parcel (RE number "162112 0625"): every permit on the parcel, any type, exact match.
let jaxColumns: Record<number, unknown> | null = null;
const jaxDate = (s: unknown) => { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
export async function jaxByRE(re: string, opts: PermitLookupOptions = {}): Promise<Permit[]> {
  const env = envOf(opts);
  if (!jaxColumns) {
    const r = await env.fetch(`${env.relay}/relay/jaxepics?op=columns`);
    if (!r.ok) throw new Error('permit search HTTP ' + r.status);
    jaxColumns = Object.fromEntries(((await r.json()) as Attrs[]).map((c) => [c.ColumnId as number, c]));
  }
  const obj = { SearchString: re };
  const filter = { SavedSearchFilterId: 0, SavedSearchId: 0, ColumnId: 28, Column: jaxColumns[28], OperatorId: 1, Order: -1, Obj: obj, groupedSectionControls: {}, Completed: true, EvalValueString: JSON.stringify(obj), IsActive: true, SavedSearch: null, DisplayInWidget: true, PinnedInWidget: false, Sort: 0 };
  const body = { SavedSearchColumns: [1, 2, 3, 4, 5, 6, 7, 8, 16, 18, 19, 20, 25, 28].map((id) => ({ ColumnId: id })), SavedSearchFilters: [filter], UserSavedSearches: [], UserSavedSearchWidgets: [], TableId: 82 };
  const r = await env.fetch(`${env.relay}/relay/jaxepics?op=advanced`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('permit search HTTP ' + r.status);
  const j = await r.json();
  return ((j.values || []) as Attrs[]).filter((v) => v.FullPermitNumber).map((v) => ({
    number: str(v.FullPermitNumber), type: str(v.PermitTypeDescription), use: str(v.ProposedUseDescription), structure: str(v.StructureTypeDescription),
    work: [v.WorkTypeDescription, v.WorkSubTypeDescription].filter(Boolean).join(' - '),
    status: str(v.StatusDescription), submitted: jaxDate(v.DateLastSubmitted), issued: jaxDate(v.DateIssued), finaled: jaxDate(v.DateFinal), contractor: str(v.CompanyName),
    cost: parseFloat(str(v.TotalCost)) || null, address: str(v.Address), link: v.FullPermitNumber_Click ? PERMIT_URL.jaxSite + '/' + v.FullPermitNumber_Click : '', roof: /roof/i.test(str(v.PermitTypeDescription)),
  }));
}

// Published copy of every City of Jacksonville roofing permit, split by the first three digits of the parcel number.
interface IndexMeta { statuses?: string[]; through?: string; updated?: string }
type IndexRow = (string | number | null)[];
const roofIndex: { base: string | null; meta: IndexMeta | null; buckets: Record<string, Promise<Record<string, IndexRow[]>>>; addr: Promise<Record<string, IndexRow[]>> | null } = { base: null, meta: null, buckets: {}, addr: null };
export async function roofIndexLookup(reNoSpace: string, addrKey: string | null, opts: PermitLookupOptions = {}): Promise<{ permits: Permit[]; meta: IndexMeta }> {
  const env = envOf(opts);
  const base = env.index;
  if (roofIndex.base !== base) { roofIndex.base = base; roofIndex.meta = null; roofIndex.buckets = {}; roofIndex.addr = null; }
  if (!roofIndex.meta) { const r = await env.fetch(base + 'meta.json', { cache: 'no-cache' }); if (!r.ok) throw new Error('permit index unavailable'); roofIndex.meta = await r.json(); }
  const b = reNoSpace.slice(0, 3);
  if (!roofIndex.buckets[b]) roofIndex.buckets[b] = env.fetch(base + 'roof_' + b + '.json').then((r) => (r.ok ? r.json() : {}));
  let rows = (await roofIndex.buckets[b])[reNoSpace] || [];
  if (!rows.length && addrKey) { // older permits recorded without a parcel number, matched by street address + ZIP
    if (!roofIndex.addr) roofIndex.addr = env.fetch(base + 'addr.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    rows = (await roofIndex.addr)[addrKey] || [];
  }
  const meta = roofIndex.meta!;
  const st = meta.statuses || [];
  const permits = rows.map((x) => ({
    number: str(x[0]), type: 'Roofing Permit', use: x[7] === 'N' ? 'Non-Residential' : 'Residential', structure: '', work: str(x[4] || ''), status: st[x[2] as number] || '',
    submitted: (x[8] as string) || null, issued: (x[1] as string) || null, finaled: (x[3] as string) || null, contractor: str(x[5] || ''), cost: (x[6] as number) || null, address: '',
    link: x[9] ? PERMIT_URL.jaxSite + '/Permit/View/' + x[9] : '', roof: true,
  }));
  return { permits, meta };
}

export async function clayPermits(keyword: string, opts: PermitLookupOptions = {}): Promise<Permit[]> {
  const env = envOf(opts);
  const body = { Keyword: keyword, ExactMatch: true, SearchModule: 1, FilterModule: 2, SearchMainAddress: false, PlanCriteria: { PageNumber: 0, PageSize: 0 },
    PermitCriteria: { PermitTypeId: 'none', PermitWorkclassId: 'none', PermitStatusId: 'none', PageNumber: 0, PageSize: 0, SortAscending: false },
    InspectionCriteria: { PageNumber: 0, PageSize: 0 }, CodeCaseCriteria: { PageNumber: 0, PageSize: 0 }, RequestCriteria: { PageNumber: 0, PageSize: 0 },
    BusinessLicenseCriteria: { PageNumber: 0, PageSize: 0 }, ProfessionalLicenseCriteria: { PageNumber: 0, PageSize: 0 }, LicenseCriteria: { PageNumber: 0, PageSize: 0 },
    ProjectCriteria: { PageNumber: 0, PageSize: 0 }, PlanSortList: [], PermitSortList: [], InspectionSortList: [], CodeCaseSortList: [], RequestSortList: [], LicenseSortList: [], ProjectSortList: [],
    PageNumber: 1, PageSize: 100, SortBy: 'relevance', SortAscending: false };
  const r = await env.fetch(`${env.relay}/relay/clay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Clay permit search HTTP ' + r.status);
  const j = await r.json(); const rows = ((j.Result && j.Result.EntityResults) || []) as Attrs[];
  return rows.map((x) => ({
    number: str(x.CaseNumber), type: str(x.CaseType), use: '', structure: '', work: str(x.CaseWorkclass), status: str(x.CaseStatus),
    submitted: (x.ApplyDate as string) || null, issued: (x.IssueDate as string) || null, finaled: (x.FinalDate as string) || (x.CompleteDate as string) || null,
    address: str(x.AddressDisplay || (x.Address && (x.Address as Attrs).FullAddress) || ''), link: '', roof: /^ROOF/i.test(str(x.CaseNumber)) || /roof/i.test(str(x.CaseType)),
  }));
}

// Duval County Property Appraiser record: year built, roof structure and roof cover.
export async function paoRecord(re: string, opts: PermitLookupOptions = {}) {
  const env = envOf(opts);
  const r = await env.fetch(`${env.relay}/relay/pao?re=` + encodeURIComponent(re)); if (!r.ok) throw new Error('PAO HTTP ' + r.status);
  const html = await r.text();
  const rowText = (label: string) => {
    const m = html.match(new RegExp('<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?' + label + '(?:(?!</tr>)[\\s\\S])*?</tr>', 'i')); if (!m) return null;
    const cells = (m[0].match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((c) => c.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return cells.length ? cells[cells.length - 1].replace(/^\d+\s+/, '') : null;
  };
  const yb = html.match(/lblYearBuilt[^>]*>\s*(\d{4})/i);
  return { yearBuilt: yb ? +yb[1] : null, roofStruct: rowText('Roof Struct'), roofCover: rowText('Roofing Cover'), url: PERMIT_URL.pao + re };
}

function envOf(opts: PermitLookupOptions): Env {
  return { fetch: opts.fetch || ((...a: Parameters<typeof fetch>) => fetch(...a)), relay: opts.relayBase || '', index: opts.permitIndexBase || PERMIT_INDEX_BASE };
}

// The whole lookup for a location: parcel, jurisdiction, permits, roof cover. Errors are collected, never thrown.
export async function lookupPermits(loc: LatLng, address: string, opts: PermitLookupOptions = {}): Promise<PermitData> {
  const env = envOf(opts);
  const out: PermitData = {
    checked: (opts.now || new Date()).toISOString(), address, county: null, jurisdiction: null, parcel: null, yearBuilt: null, effYear: null, roofCover: null, roofStruct: null,
    permits: [], searched: false, source: null, portal: null, notes: [], errors: [],
  };
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  try {
    const a = await parcelAt(env, PERMIT_URL.fdor, loc, 'CO_NO,PARCEL_ID,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,ACT_YR_BLT,EFF_YR_BLT,DOR_UC,NO_BULDNG,TOT_LVG_AR');
    if (a) {
      out.county = PERMIT_COUNTY[a.CO_NO as number] || `County ${a.CO_NO}`;
      out.parcel = { id: a.PARCEL_ID as string, address: a.PHY_ADDR1 as string, city: a.PHY_CITY as string, zip: a.PHY_ZIPCD as string, buildings: a.NO_BULDNG as number, livingArea: a.TOT_LVG_AR as number };
      out.yearBuilt = (a.ACT_YR_BLT as number) > 1800 ? (a.ACT_YR_BLT as number) : null; out.effYear = (a.EFF_YR_BLT as number) > 1800 ? (a.EFF_YR_BLT as number) : null;
    }
  } catch (e) { out.errors.push('Florida parcel data: ' + msg(e)); }
  if (out.county === 'Duval') {
    let p: Attrs | null = null;
    try { p = await parcelAt(env, PERMIT_URL.cojParcels, loc, 'RE,RE_NOSPACE,STREET_NO,ST_DIR,ST_NAME,ST_TYPE,UNIT_NO,ADDRCITY,ZIPCODE,DESCPU'); } catch (e) { out.errors.push('City parcel data: ' + msg(e)); }
    const city = str((p && p.ADDRCITY) || (out.parcel && out.parcel.city) || '');
    if (p) out.parcel = { ...(out.parcel || {}), re: p.RE as string, reNoSpace: p.RE_NOSPACE as string, cityAddress: [p.STREET_NO, p.ST_DIR, p.ST_NAME, p.ST_TYPE].filter((x) => x && String(x).trim()).join(' '), use: p.DESCPU as string };
    if (BEACH_CITIES.test(city)) { out.jurisdiction = city; out.portal = PERMIT_PORTAL.beaches; out.notes.push(`${city} issues its own building permits; the City of Jacksonville system does not list them.`); }
    else {
      out.jurisdiction = 'City of Jacksonville'; out.portal = PERMIT_PORTAL.coj;
      const term = (out.parcel && out.parcel.cityAddress) || String(address || '').split(',')[0];
      const lead = normAddr(term).split(' ').slice(0, 2).join(' '); // street number + first word of the street name
      let live: Permit[] | null = null, liveErr: string | null = null;
      // 1) live city records, matched exactly by parcel number
      if (p && p.RE) { try { live = await jaxByRE(p.RE as string, opts); } catch (e) { liveErr = msg(e); } }
      // condo / multi-unit parcels: roof permits are often filed under the street address of the building
      if (live && !live.some((x) => x.roof)) {
        try { const rows = await jaxPermits(term, opts); const have = new Set(live.map((x) => x.number)); for (const x of rows) if (normAddr(x.address).startsWith(lead) && !have.has(x.number)) live.push(x); } catch { /* parcel results stand */ }
      } else if (!live && !(p && p.RE)) {
        try { live = (await jaxPermits(term, opts)).filter((x) => normAddr(x.address).startsWith(lead)); } catch (e) { liveErr = msg(e); }
      }
      out.recordsFrom = 1985; // City of Jacksonville roofing permits are on line from mid-1984
      if (live) { out.permits = live; out.searched = true; out.source = 'City of Jacksonville JAXEPICS (live)'; out.searchTerm = p && p.RE ? `parcel ${p.RE}` : term; }
      // 2) otherwise the published copy of every city roofing permit
      else if (p && p.RE_NOSPACE) {
        try {
          const ix = await roofIndexLookup(p.RE_NOSPACE as string, normAddr(term) + '|' + String(p.ZIPCODE || '').slice(0, 5), opts);
          out.permits = ix.permits; out.searched = true; out.indexOnly = true; out.searchTerm = `parcel ${p.RE}`;
          out.source = `City of Jacksonville roofing permit records (copy through ${ix.meta.through || ix.meta.updated})`;
          out.notes.push(`Roofing permits issued after ${pFmt(ix.meta.through)} show once the permit copy is refreshed; the desktop app reads the city live.`);
        } catch (e) { out.errors.push('City permit records: ' + (liveErr || msg(e))); }
      } else out.errors.push('City permit search: ' + (liveErr || 'no parcel number for this location'));
      if (p && p.RE_NOSPACE) {
        out.paoUrl = PERMIT_URL.pao + p.RE_NOSPACE;
        try { const pr = await paoRecord(p.RE_NOSPACE as string, opts); out.roofCover = pr.roofCover; out.roofStruct = pr.roofStruct; if (pr.yearBuilt) out.yearBuilt = pr.yearBuilt; } catch (e) { out.errors.push('Property appraiser: ' + msg(e)); }
      }
    }
  } else if (out.county === 'Clay') {
    out.jurisdiction = 'Clay County'; out.portal = PERMIT_PORTAL.Clay; out.source = 'Clay County EnerGov';
    if (out.parcel && out.parcel.address) {
      try {
        let rows = await clayPermits(out.parcel.address, opts);
        if (!rows.length) rows = await clayPermits(out.parcel.address.split(' ').slice(0, -1).join(' '), opts);
        out.permits = rows; out.searched = true; out.searchTerm = out.parcel.address; out.recordsFrom = 2023;
        out.notes.push('Clay County\'s online permit records start in January 2023; older permits are in the county\'s archive.');
      } catch (e) { out.errors.push('Clay County permit search: ' + msg(e)); }
    } else out.errors.push('Clay County permits are looked up by the Roof Measure desktop app (local server).');
  } else if (out.county) {
    out.jurisdiction = out.county + ' County'; out.portal = PERMIT_PORTAL[out.county] || null;
    out.notes.push(`${out.county} County has no public permit data feed; check its permit portal and enter the last roof permit below.`);
  } else out.errors.push('No Florida parcel found at this location.');
  return out;
}

// ------------------------------------------------------------------ roof age

export interface RoofAge { age: number | null; basis: 'entered' | 'permit' | 'built' | 'unknown' | null; date: Date | null; number: string | null; lastIssued: Permit | null; lastSubmitted: Permit | null; roofCount: number; oldest: Date | null }

// Roof age from the newest roofing permit that was issued (a hand-entered permit wins), else from the year built.
export function roofAgeInfo(d: PermitData | null, manual?: ManualPermit | null, now: Date = new Date()): RoofAge {
  const m = manual || {};
  const roofs = (d ? d.permits : []).filter((p) => p.roof);
  const valid = roofs.filter((p) => !/void|withdr|cancel|denied|reject/i.test(p.status));
  const byDate = (p: Permit) => pDate(p.issued || p.finaled || p.submitted) || new Date(0);
  valid.sort((a, b) => +byDate(b) - +byDate(a)); roofs.sort((a, b) => +(pDate(b.submitted) || 0) - +(pDate(a.submitted) || 0));
  const lastIssued = valid.find((p) => p.issued || p.finaled) || null;
  const lastSubmitted = roofs[0] || null;
  const all = d ? d.permits.map((p) => pDate(p.submitted || p.issued)).filter((x): x is Date => !!x && !isNaN(+x)) : [];
  const oldest = all.length ? new Date(Math.min(...all.map(Number))) : null;
  let basis: RoofAge['basis'] = null, age: number | null = null, date: Date | null = null, number: string | null = null;
  if (m.date) { date = pDate(m.date); age = yearsSince(date, now); basis = 'entered'; number = m.number || null; }
  else if (lastIssued) { date = pDate(lastIssued.issued || lastIssued.finaled); age = yearsSince(date, now); basis = 'permit'; number = lastIssued.number; }
  else if (d && d.yearBuilt && (!d.searched || !d.recordsFrom || d.yearBuilt >= d.recordsFrom)) { age = now.getFullYear() - d.yearBuilt; basis = 'built'; } // likely the original roof
  else if (d && d.yearBuilt) basis = 'unknown'; // built before the permit records start and no roof permit since
  return { age, basis, date, number, lastIssued, lastSubmitted, roofCount: roofs.length, oldest };
}

export function roofAgeSentence(d: PermitData | null, manual?: ManualPermit | null, now: Date = new Date()): string {
  const R = roofAgeInfo(d, manual, now); const yrs = (a: number) => (a < 1 ? 'under 1 year' : `${Math.floor(a)} year${Math.floor(a) === 1 ? '' : 's'}`);
  const ageTxt = (a: number) => (a < 1 ? 'under 1 year' : 'about ' + yrs(a));
  if (R.basis === 'entered') return `Roof age ${ageTxt(R.age!)}: last roof permit ${R.number ? R.number + ' ' : ''}dated ${pFmt(R.date)} (entered).`;
  if (R.basis === 'permit') return `Roof age ${ageTxt(R.age!)}: last roof permit ${R.number} issued ${pFmt(R.date)}${R.lastIssued && R.lastIssued.status ? ' (' + R.lastIssued.status.toLowerCase() + ')' : ''}.`;
  if (R.basis === 'built') return d && d.searched ? `No roofing permit on file since the building went up in ${d.yearBuilt}: likely the original roof, ${ageTxt(R.age!)} old.` : `Built ${d!.yearBuilt}; no permit records for this area, so the roof could be up to ${yrs(R.age!)} old.`;
  if (R.basis === 'unknown') return `No roofing permit on file since ${d!.jurisdiction || 'the'} permit records began in ${d!.recordsFrom}. Built ${d!.yearBuilt}: the roof's age can't be confirmed from permits, so inspect it.`;
  return 'Roof age unknown: no permit data for this location.';
}

// Newest first by issue (or submit) date: the order of the panel list and the report tables.
export const sortPermits = (list: Permit[]) => list.slice().sort((a, b) => +(pDate(b.issued || b.submitted) || 0) - +(pDate(a.issued || a.submitted) || 0));

// ------------------------------------------------------------------ report page (shared by the residential and commercial reports)

export function permitReportPage(headHtml: string, d: PermitData | null, manual?: ManualPermit | null, now: Date = new Date()): string {
  const R = roofAgeInfo(d, manual, now);
  const list = d ? sortPermits(d.permits) : [];
  const roofRows = list.filter((p) => p.roof), other = list.filter((p) => !p.roof);
  const roofHead = '<tr><th>Permit</th><th>Work</th><th>Status</th><th>Contractor</th><th class="num">Issued</th><th class="num">Final</th></tr>';
  const roofRow = (p: Permit) => `<tr><td>${esc(p.number)}</td><td>${esc((p.work || p.type).slice(0, 40))}</td><td>${esc(p.status.slice(0, 16))}</td><td>${esc((p.contractor || '-').slice(0, 30))}</td><td class="num">${pFmt(p.issued)}</td><td class="num">${pFmt(p.finaled)}</td></tr>`;
  const row = (p: Permit) => `<tr><td>${esc(p.number)}</td><td>${esc([p.type, p.work].filter(Boolean).join(' - ').slice(0, 70))}</td><td>${esc(p.status.slice(0, 18))}</td><td class="num">${pFmt(p.submitted)}</td><td class="num">${pFmt(p.issued)}</td></tr>`;
  const head = '<tr><th>Permit</th><th>Type</th><th>Status</th><th class="num">Submitted</th><th class="num">Issued</th></tr>';
  const kv: [string, string][] = [
    ['Roof age', R.age == null ? (R.basis === 'unknown' ? `Unknown (no roof permit since ${d!.recordsFrom}; built ${d!.yearBuilt})` : 'Unknown') : `${R.age < 1 ? 'under 1 year' : Math.floor(R.age) + (Math.floor(R.age) === 1 ? ' year' : ' years')}${R.basis === 'built' ? (d && d.searched ? ' (original roof: no roof permit since construction)' : ' (since construction; permits not checked)') : ''}`],
    ['Last roof permit issued', R.lastIssued ? `${R.lastIssued.number}, ${pFmt(R.lastIssued.issued || R.lastIssued.finaled)} (${R.lastIssued.status || '-'})${R.lastIssued.contractor ? ', ' + R.lastIssued.contractor : ''}` : R.basis === 'entered' ? `${R.number || ''} ${pFmt(R.date)} (entered)` : 'None on file'],
    ['Last roof permit submitted', R.lastSubmitted ? `${R.lastSubmitted.number}, ${pFmt(R.lastSubmitted.submitted)} (${R.lastSubmitted.status || '-'})` : 'None on file'],
    ['Roof permits on file', String(R.roofCount)],
    ['Year built / effective year', d ? `${d.yearBuilt || '-'} / ${d.effYear || '-'}` : '-'],
    ['Roof structure / cover', d && (d.roofStruct || d.roofCover) ? `${d.roofStruct || '-'} / ${d.roofCover || '-'}` : '-'],
    ['Permit authority', d ? d.jurisdiction || '-' : '-'],
    ['Parcel', d && d.parcel ? d.parcel.re || d.parcel.id || '-' : '-'],
  ];
  // row budget for one 11 in page (long permit types wrap to two lines)
  const shownRoof = roofRows.slice(0, 10), shownOther = other.slice(0, Math.max(0, 16 - shownRoof.length));
  return `${headHtml}
    <div class="note" style="font-size:12px;margin-top:12px"><b>${esc(roofAgeSentence(d, manual, now))}</b></div>
    <div class="sec">Roof age</div><table class="kv">${kv.map(([l, v]) => `<tr><td>${l}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="sec">Roofing permits</div>${shownRoof.length ? `<table class="tight">${roofHead}${shownRoof.map(roofRow).join('')}</table>${roofRows.length > shownRoof.length ? `<div class="note">${roofRows.length - shownRoof.length} older roofing permits not listed.</div>` : ''}` : `<div class="empty">${d && d.searched ? 'No roofing permits on file for this address.' : 'Permit records were not available for this address.'}</div>`}
    ${shownOther.length ? `<div class="sec">Other permits at this address</div><table class="tight">${head}${shownOther.map(row).join('')}</table>${other.length > shownOther.length ? `<div class="note">${other.length - shownOther.length} older permits not listed.</div>` : ''}` : ''}
    <div class="note">Source: ${esc(d && d.source ? d.source : 'public permit records')}${d && d.searchTerm ? ` (address searched: ${esc(d.searchTerm)})` : ''}; year built from the Florida Department of Revenue parcel roll${d && d.roofCover ? ' and the Duval County Property Appraiser' : ''}. Checked ${pFmt(d ? d.checked : null)}. Roof age is counted from the issue date of the newest roofing permit; work done without a permit, or before the city's online records, is not shown.${d && d.notes.length ? ' ' + d.notes.map(esc).join(' ') : ''}</div><div style="flex:1"></div>`;
}

// Roof-age line on the report covers ('' when no permit data).
export function permitCoverLine(d: PermitData | null, manual?: ManualPermit | null, now: Date = new Date()): string {
  return d ? `<div class="addr" style="margin-top:6px"><b>${esc(roofAgeSentence(d, manual, now))}</b></div>` : '';
}
