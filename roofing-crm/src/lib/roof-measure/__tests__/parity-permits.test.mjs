// Permit lookup parity with the ORIGINAL permits.js. The tool is served from http://localhost (its desktop /
// local-server mode, where it uses the /relay/pao and /relay/clay routes, as the CRM always does). Mocked
// upstream services (FDOR and City of Jacksonville parcels, JAXEPICS, the published permit index, the Property
// Appraiser and Clay County) answer both the original (directly / via relays) and the port (via the CRM's relays,
// including the new /relay/jaxepics). Compares permitLookup() with lookupPermits(), then roofAgeSentence(),
// permitReportPage() and permitCoverLine() for every result, with and without a hand-entered permit.
// Run: TZ=America/New_York node --experimental-strip-types --import ./src/lib/roof-measure/__tests__/register.mjs src/lib/roof-measure/__tests__/parity-permits.test.mjs
import * as rm from '../index.ts';
import { LOCAL_ORIGIN, openTool } from './helpers/browser.mjs';
import { check, diff, summary } from './helpers/assert.mjs';

// ---------------------------------------------------------------- mocked public records, by location
const P = (lat, lng) => `${lng},${lat}`;
const SITES = {
  [P(30.30, -81.60)]: { name: 'Duval, parcel with live roof permits', fdor: { CO_NO: 26, PARCEL_ID: '1234560000', PHY_ADDR1: '100 N MAIN ST', PHY_CITY: 'JACKSONVILLE', PHY_ZIPCD: '32202', ACT_YR_BLT: 1987, EFF_YR_BLT: 1995, NO_BULDNG: 1, TOT_LVG_AR: 1800 }, coj: { RE: '123456 0000', RE_NOSPACE: '1234560000', STREET_NO: '100', ST_DIR: 'N', ST_NAME: 'MAIN', ST_TYPE: 'ST', ADDRCITY: 'JACKSONVILLE', ZIPCODE: '32202', DESCPU: '0100 Single Family' } },
  [P(30.31, -81.61)]: { name: 'Duval, parcel permits without a roof permit (address search merge)', fdor: { CO_NO: 26, PARCEL_ID: '2222220000', PHY_ADDR1: '200 OAK AVE', PHY_CITY: 'JACKSONVILLE', PHY_ZIPCD: '32205', ACT_YR_BLT: 2005, EFF_YR_BLT: 0 }, coj: { RE: '222222 0000', RE_NOSPACE: '2222220000', STREET_NO: '200', ST_DIR: '', ST_NAME: 'OAK', ST_TYPE: 'AVE', ADDRCITY: 'JACKSONVILLE', ZIPCODE: '32205', DESCPU: '0400 Condo' } },
  [P(30.32, -81.62)]: { name: 'Duval, JAXEPICS down: published permit index', fdor: { CO_NO: 26, PARCEL_ID: '3333330000', PHY_ADDR1: '300 ELM ST', PHY_CITY: 'JACKSONVILLE', PHY_ZIPCD: '32207', ACT_YR_BLT: 1975, EFF_YR_BLT: 1980 }, coj: { RE: '333333 0000', RE_NOSPACE: '3333330000', STREET_NO: '300', ST_DIR: '', ST_NAME: 'ELM', ST_TYPE: 'ST', ADDRCITY: 'JACKSONVILLE', ZIPCODE: '32207-1234', DESCPU: '0100' }, jaxDown: true },
  [P(30.33, -81.63)]: { name: 'Duval, JAXEPICS down, index by address', fdor: { CO_NO: 26, PARCEL_ID: '4444440000', PHY_ADDR1: '400 PINE RD', PHY_CITY: 'JACKSONVILLE', PHY_ZIPCD: '32210', ACT_YR_BLT: 1950, EFF_YR_BLT: 1960 }, coj: { RE: '444444 0000', RE_NOSPACE: '4444440000', STREET_NO: '400', ST_DIR: '', ST_NAME: 'PINE', ST_TYPE: 'RD', ADDRCITY: 'JACKSONVILLE', ZIPCODE: '32210', DESCPU: '0100' }, jaxDown: true },
  [P(30.34, -81.64)]: { name: 'Duval, no city parcel: address search', fdor: { CO_NO: 26, PARCEL_ID: '5555550000', PHY_ADDR1: '500 BAY ST', PHY_CITY: 'JACKSONVILLE', PHY_ZIPCD: '32202', ACT_YR_BLT: 2019, EFF_YR_BLT: 2019 }, coj: null },
  [P(30.29, -81.39)]: { name: 'Duval, Jacksonville Beach', fdor: { CO_NO: 26, PARCEL_ID: '6666660000', PHY_ADDR1: '600 1ST ST N', PHY_CITY: 'JACKSONVILLE BEACH', PHY_ZIPCD: '32250', ACT_YR_BLT: 1999, EFF_YR_BLT: 1999 }, coj: { RE: '666666 0000', RE_NOSPACE: '6666660000', STREET_NO: '600', ST_DIR: '', ST_NAME: '1ST', ST_TYPE: 'ST', ADDRCITY: 'JACKSONVILLE BEACH', ZIPCODE: '32250', DESCPU: '0100' } },
  [P(30.10, -81.70)]: { name: 'Clay County', fdor: { CO_NO: 20, PARCEL_ID: '38-04-25-012345', PHY_ADDR1: '700 CLAY RD', PHY_CITY: 'ORANGE PARK', PHY_ZIPCD: '32073', ACT_YR_BLT: 2001, EFF_YR_BLT: 2001 }, coj: null },
  [P(29.90, -81.40)]: { name: 'St. Johns County', fdor: { CO_NO: 65, PARCEL_ID: '0000065', PHY_ADDR1: '800 A1A', PHY_CITY: 'ST AUGUSTINE', PHY_ZIPCD: '32080', ACT_YR_BLT: 1990, EFF_YR_BLT: 1990 }, coj: null },
  [P(29.50, -81.20)]: { name: 'No parcel (nearest within 25 m)', fdor: null, fdorNear: { CO_NO: 54, PARCEL_ID: '54', PHY_ADDR1: '900 LAKE DR', PHY_CITY: 'PALATKA', PHY_ZIPCD: '32177', ACT_YR_BLT: 1700, EFF_YR_BLT: 0 }, coj: null },
  [P(29.00, -81.00)]: { name: 'Parcel service down', fdorDown: true, coj: null },
};
const ADV = {
  '123456 0000': [
    { FullPermitNumber: 'R-2018-00123', PermitTypeDescription: 'Roofing Permit', ProposedUseDescription: 'Residential', StructureTypeDescription: 'SFR', WorkTypeDescription: 'Reroof', WorkSubTypeDescription: 'Shingle', StatusDescription: 'Final', DateLastSubmitted: '3/2/2018 10:00:00 AM', DateIssued: '3/9/2018', DateFinal: '4/30/2018', CompanyName: 'Acme Roofing', TotalCost: '12500.00', Address: '100 N MAIN ST', FullPermitNumber_Click: 'Permit/View/123' },
    { FullPermitNumber: 'R-2003-00077', PermitTypeDescription: 'Roofing Permit', StatusDescription: 'Void', DateLastSubmitted: '1/5/2003', DateIssued: '', Address: '100 N MAIN ST' },
    { FullPermitNumber: 'B-2011-00001', PermitTypeDescription: 'Building', WorkTypeDescription: 'Pool', StatusDescription: 'Issued', DateLastSubmitted: '6/1/2011', DateIssued: '6/20/2011', Address: '100 N MAIN ST' },
    { FullPermitNumber: '', PermitTypeDescription: 'Roofing Permit' },
  ],
  '222222 0000': [{ FullPermitNumber: 'E-2015-1', PermitTypeDescription: 'Electrical', StatusDescription: 'Final', DateLastSubmitted: '2/2/2015', DateIssued: '2/3/2015', Address: '200 OAK AVE' }],
};
const ADDRESS_SEARCH = {
  '200 OAK AVE': [
    { type: 'Permit', title: 'R-2016-555', description: 'Re-roof building B', link: '/Permit/View/555', obj: { PermitType: 'Roofing Permit', ProposedUse: 'Residential', StructureType: 'Condo', WorkType: 'Reroof', Status: 'Final', DateLastSubmitted: '2016-07-01', DateIssued: '2016-07-08', Address: '200 OAK AVE UNIT 3' } },
    { type: 'Permit', title: 'R-2016-556', obj: { PermitType: 'Roofing', Status: 'Final', DateIssued: '2016-07-09', Address: '2001 OAKWOOD DR' } },
    { type: 'Contractor', title: 'x', obj: {} },
  ],
  '500 BAY ST': [{ type: 'Permit', title: 'R-2020-9', obj: { PermitType: 'Roofing Permit', Status: 'Issued', DateLastSubmitted: '2020-01-01', DateIssued: '2020-01-10', Address: '500 BAY ST' } }, { type: 'Permit', title: 'R-1999-1', obj: { PermitType: 'Roofing', Status: 'Final', DateIssued: '1999-05-05', Address: '5000 BAYMEADOWS RD' } }],
};
const INDEX = {
  meta: { statuses: ['Final', 'Issued', 'Void', 'Expired'], through: '2026-08-31', updated: '2026-09-01' },
  roof_333: { '3333330000': [['R-2010-31', '2010-04-02', 0, '2010-05-01', 'Reroof shingle', 'Best Roofs LLC', 9800, 'R', '2010-03-30', 31], ['R-1996-3', '1996-01-02', 2, null, '', '', null, 'N', null, null]] },
  roof_444: {},
  addr: { '400 PINE RD|32210': [['R-1992-44', '1992-06-06', 0, '1992-07-07', 'Reroof', '', null, 'R', '1992-06-01', 44]] },
};
const PAO_HTML = '<html><span id="ctl00_cphBody_lblYearBuilt">1986</span><table><tr><td>3</td><td>Roof Struct</td><td>4 Gable or Hip</td></tr><tr><td>4</td><td>Roofing Cover</td><td>3 Asph/Comp Shng</td></tr></table></html>';
const CLAY = { '700 CLAY RD': [], '700 CLAY': [{ CaseNumber: 'ROOF-2024-0101', CaseType: 'Residential Roof', CaseWorkclass: 'Re-Roof', CaseStatus: 'Finaled', ApplyDate: '2024-02-01T00:00:00', IssueDate: '2024-02-05T00:00:00', FinalDate: null, CompleteDate: '2024-03-01T00:00:00', AddressDisplay: '700 CLAY RD' }, { CaseNumber: 'BLD-2023-7', CaseType: 'Pool', CaseStatus: 'Issued', ApplyDate: '2023-05-01T00:00:00', IssueDate: '2023-05-10T00:00:00', Address: { FullAddress: '700 CLAY RD' } }] };

// One answer for every upstream request, given as (upstream URL, method, body).
function upstream(url, body) {
  const u = new URL(url);
  const q = u.searchParams;
  if (u.hostname.endsWith('arcgis.com') || u.hostname === 'maps.coj.net') {
    const site = SITES[q.get('geometry')];
    const isFdor = u.hostname.endsWith('arcgis.com');
    if (!site) return { json: { features: [] } };
    if (isFdor && site.fdorDown) return { status: 500, json: {} };
    const attrs = isFdor ? (q.get('distance') ? site.fdorNear || site.fdor : site.fdor) : site.coj;
    return { json: { features: attrs ? [{ attributes: attrs }] : [] } };
  }
  if (u.hostname === 'jaxepicsapi.coj.net') {
    if (u.pathname.endsWith('/GetColumns/82')) return { json: [{ ColumnId: 1, Name: 'Permit' }, { ColumnId: 28, Name: 'RE', DataType: 'string' }] };
    if (u.pathname.endsWith('/Advanced')) {
      const re = JSON.parse(body).SavedSearchFilters[0].Obj.SearchString;
      const site = Object.values(SITES).find((s) => s.coj && s.coj.RE === re);
      if (site && site.jaxDown) return { status: 503, json: {} };
      return { json: { values: ADV[re] || [] } };
    }
    if (u.pathname.endsWith('/AddressSearch')) return { json: { values: (ADDRESS_SEARCH[q.get('SearchTerm')] || []).slice(0, 100) } };
  }
  if (u.pathname === '/relay/pao') return { body: PAO_HTML, contentType: 'text/html' };
  if (u.pathname === '/relay/clay') return { json: { Result: { EntityResults: CLAY[JSON.parse(body).Keyword] || [] } } };
  const m = u.pathname.match(/\/permits\/(meta|roof_\d{3}|addr)\.json$/);
  if (m) return INDEX[m[1]] ? { json: INDEX[m[1]] } : { status: 404, json: {} };
  return null;
}

// The CRM side: /relay/jaxepics translated to the fixed upstream calls its route makes.
const API = 'https://jaxepicsapi.coj.net/api/';
async function crmFetch(input, init = {}) {
  const url = String(input); const u = new URL(url); const body = init.body || null;
  let r = null;
  if (u.pathname === '/relay/jaxepics') {
    const op = u.searchParams.get('op');
    if (op === 'columns') r = upstream(API + 'AdvancedSearches/GetColumns/82');
    else if (op === 'advanced') r = upstream(API + 'AdvancedSearches/Advanced?page=1&pageSize=500&filter=&sortActive=DateIssued&sortDirection=desc&forSpreadSheet=false', body);
    else if (op === 'address') r = upstream(`${API}Searches/Permits/AddressSearch?page=${u.searchParams.get('page')}&pageSize=100&filter=&sortActive=Title&sortDirection=desc&forSpreadSheet=false&SearchTerm=${encodeURIComponent(u.searchParams.get('term'))}`, '{}');
    if (r && r.status && r.status >= 400) r = { status: 502, json: { error: 'relay failed' } };
  } else r = upstream(url, body);
  if (!r) return new Response('not found', { status: 404 });
  return new Response(r.json !== undefined ? JSON.stringify(r.json) : r.body, { status: r.status || 200 });
}

const locs = Object.keys(SITES).map((k) => { const [lng, lat] = k.split(',').map(Number); return { lat, lng, name: SITES[k].name, address: `${SITES[k].fdor ? SITES[k].fdor.PHY_ADDR1 : 'Somewhere'}, Jacksonville, FL` }; });
const handler = async (url, req) => upstream(url, req.postData());
const { browser, page } = await openTool({ local: handler, other: handler }, { local: true });
try {
  const orig = await page.evaluate(async (locs) => {
    const out = [];
    for (const l of locs) out.push(await permitLookup({ lat: l.lat, lng: l.lng }, l.address));
    return out;
  }, locs);
  const noChecked = (d) => { const x = JSON.parse(JSON.stringify(d)); delete x.checked; return x; };
  for (let i = 0; i < locs.length; i++) {
    const l = locs[i];
    const mine = await rm.lookupPermits({ lat: l.lat, lng: l.lng }, l.address, { fetch: crmFetch, relayBase: LOCAL_ORIGIN.slice(0, -1), permitIndexBase: LOCAL_ORIGIN + 'permits/' });
    const d = diff(noChecked(mine), noChecked(orig[i]), 0);
    check(`lookup: ${l.name}`, !d.length, d.slice(0, 6).join('; '));
    console.log(`  ${l.name}: ${orig[i].jurisdiction || '-'}, ${orig[i].permits.length} permits, source ${orig[i].source || '-'}${orig[i].errors.length ? ', errors: ' + orig[i].errors.join(' / ') : ''} -> ${d.length ? 'DIFF' : 'identical'}`);
  }
  // roof age, the report page and the cover line, for every lookup result, with and without a hand-entered permit
  const manuals = [null, { date: '2022-11-03', number: 'HAND-1' }, { date: '2025-12-20' }];
  const pages = await page.evaluate(({ results, manuals }) => results.flatMap((d) => manuals.map((m) => {
    permit.key = 'k'; permit.data = d; if (m) permit.manual.k = m; else delete permit.manual.k;
    return { sentence: roofAgeSentence(d), page: permitReportPage('<h2>Permit history &amp; roof age</h2>'), cover: permitCoverLine() };
  })), { results: orig, manuals });
  let k = 0, same = 0;
  for (const d of orig) for (const m of manuals) {
    const mine = { sentence: rm.roofAgeSentence(d, m), page: rm.permitReportPage('<h2>Permit history &amp; roof age</h2>', d, m), cover: rm.permitCoverLine(d, m) };
    const dd = diff(mine, pages[k], 0);
    if (!dd.length) same++;
    check(`roof age / report page #${k}`, !dd.length, dd.slice(0, 2).join('; '));
    k++;
  }
  const empty = await page.evaluate(() => { permit.data = null; permit.key = 'none'; return { s: roofAgeSentence(null), p: permitReportPage('<h2>x</h2>'), c: permitCoverLine() }; });
  check('no permit data at all', empty.s === rm.roofAgeSentence(null) && empty.p === rm.permitReportPage('<h2>x</h2>', null) && empty.c === rm.permitCoverLine(null));
  console.log(`permits parity: ${locs.length} lookups, ${same}/${k} roof-age sentences + report pages + cover lines identical`);
} finally {
  await browser.close();
}
summary('parity-permits');
