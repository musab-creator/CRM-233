// Commercial measure + report parity with the ORIGINAL tool (commercial.js / commercial_report.js in headless
// Chromium). A synthetic 50 x 30 m low-slope building (parapets, a higher section, rooftop units, a vent, an open
// courtyard) is served as the Solar API's data layers; comMeasure() / comTotals() / comWindZones() /
// comMaterials() / comPages() are compared with measureCommercial() / commercialTotals() /
// commercialWindZones() / commercialMaterials() / buildCommercialReportHTML() for several option sets.
// Run: TZ=America/New_York node --experimental-strip-types --import ./src/lib/roof-measure/__tests__/register.mjs src/lib/roof-measure/__tests__/parity-commercial.test.mjs
import * as rm from '../index.ts';
import { loadEngineInPage, openTool } from './helpers/browser.mjs';
import { commercialScene } from './helpers/scenes.mjs';
import { check, diff, countLeaves, summary } from './helpers/assert.mjs';

const scene = commercialScene();
function solar(url) {
  const u = new URL(url);
  if (u.pathname.includes('buildingInsights')) return { json: scene.bi };
  if (u.pathname.includes('dataLayers')) return { json: { imageryDate: scene.bi.imageryDate, imageryQuality: 'HIGH', maskUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=c-mask', dsmUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=c-dsm' } };
  const id = u.searchParams.get('id');
  return id === 'c-mask' ? { body: scene.mask } : id === 'c-dsm' ? { body: scene.dsm } : { status: 404, json: {} };
}
const nodeFetch = async (url) => { const r = solar(url); return new Response(r.json !== undefined ? JSON.stringify(r.json) : r.body, { status: r.status || 200 }); };

const OPTION_SETS = [
  { system: 'tpo_ma', waste: 10, rTarget: 25, cover: true, taper: false, drains: '', scuppers: '', skylights: '', hatches: '', heightFt: '', windMph: 130 },
  { system: 'modbit', waste: 12, rTarget: 20, cover: false, taper: true, drains: '3', scuppers: '', skylights: '2', hatches: '1', heightFt: '25', windMph: 125 },
  { system: 'epdm_fa', waste: 8, rTarget: 0, cover: true, taper: true, drains: '', scuppers: '4', skylights: '', hatches: '', heightFt: '70', windMph: 130 },
  { system: 'silicone', waste: 10, rTarget: 25, cover: true, taper: false, drains: '0', scuppers: '0', skylights: '', hatches: '', heightFt: '', windMph: 130 },
];
const PERMITS = { checked: '2026-10-01T10:00:00.000Z', address: 'X', county: 'Duval', jurisdiction: 'City of Jacksonville', parcel: { id: '1', re: '000001 0000' }, yearBuilt: 1988, effYear: 1995, roofCover: 'Built Up', roofStruct: 'Flat', searched: true, source: 'City of Jacksonville JAXEPICS (live)', recordsFrom: 1985, portal: null, notes: [], errors: [],
  permits: [{ number: 'C-2012-5', type: 'Roofing Permit', use: 'Non-Residential', structure: '', work: 'Reroof - TPO', status: 'Final', submitted: '2012-03-01', issued: '2012-03-15', finaled: '2012-05-01', contractor: 'Flat Roof Inc', address: 'X', link: '', roof: true }] };

const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'function' ? undefined : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x)));
// Everything the measure and the derived quantities produce, for one option set.
function portDerived(rm, M, opts) {
  const T = rm.commercialTotals(M, opts);
  const Z = rm.commercialWindZones(M, T);
  const systems = Object.keys(rm.COM_SYSTEMS).map((k) => rm.commercialMaterials(M, T, k, opts.waste, opts));
  return { T, Z, systems, insul: rm.commercialInsulationPlan(opts.rTarget) };
}
function portReport(rm, M, opts, permits) {
  return rm.buildCommercialReportHTML({ model: M, options: opts, address: '1200 Commerce Way, Jacksonville, FL 32256', satellite: null, permits });
}

const { browser, page } = await openTool({ solar: async (url) => solar(url) });
try {
  await loadEngineInPage(page);
  const orig = await page.evaluate(async ({ target, sets, PERMITS }) => {
    const M = await comMeasure(target);
    const derived = [], html = [];
    for (const o of sets) {
      Object.assign(com.opts, o);
      const T = comTotals(M); const Z = comWindZones(M, T);
      derived.push({ T, Z, systems: Object.keys(COM_SYSTEMS).map((k) => comMaterials(M, T, k, o.waste)), insul: comInsulationPlan(o.rTarget) });
      state.address = '1200 Commerce Way, Jacksonville, FL 32256';
      state.location = null; permit.data = null;
      html.push(comPages(M, null));
      state.location = { lat: target.lat, lng: target.lng }; permit.key = state.address; permit.data = PERMITS;
      html.push(comPages(M, null));
      state.location = null; permit.data = null;
    }
    const keep = { ...M }; delete keep.toLL;
    return { M: keep, ms: M.ms, derived, html };
  }, { target: scene.target, sets: OPTION_SETS, PERMITS });
  const inPage = await page.evaluate(async ({ target, sets, PERMITS, derivedSrc, reportSrc, ms }) => {
    const rmx = window.__rm; const derivedFn = (0, eval)('(' + derivedSrc + ')'), reportFn = (0, eval)('(' + reportSrc + ')');
    const M = await rmx.measureCommercial(target, { fetchBuilding: (lat, lng) => rmx.fetchBuildingInsights(lat, lng, '', (...a) => fetch(...a)), loadRasters: (lat, lng, radius) => rmx.loadCommercialRasters(lat, lng, radius, '', (...a) => fetch(...a)) });
    M.ms = ms;
    const derived = sets.map((o) => derivedFn(rmx, M, o));
    const html = sets.flatMap((o) => [reportFn(rmx, M, o, null), reportFn(rmx, M, o, { data: PERMITS })]);
    const keep = { ...M }; delete keep.toLL;
    return { M: keep, derived, html };
  }, { target: scene.target, sets: OPTION_SETS, PERMITS, derivedSrc: portDerived.toString(), reportSrc: portReport.toString(), ms: orig.ms });

  const Mnode = await rm.measureCommercial(scene.target, { fetchBuilding: (lat, lng) => rm.fetchBuildingInsights(lat, lng, '', nodeFetch), loadRasters: (lat, lng, radius) => rm.loadCommercialRasters(lat, lng, radius, '', nodeFetch) });
  Mnode.ms = orig.ms;
  const strip = (M) => { const x = plain(M); delete x.ms; return x; };
  const oM = strip(orig.M);
  console.log(`  model: ${oM.sections.length} sections, ${oM.edges.length} perimeter edges (${oM.edges.filter((e) => e.kind === 'parapet').length} parapet), ${oM.walls.length} walls/joints, ${oM.objects.length} rooftop objects, ${oM.courtyards.length} courtyard(s), plan ${Math.round(oM.planM2 * 10.7639104)} sqft`);
  // plane.rms is sqrt of a cancelling difference of sums: node's last-bit Math differences grow to ~1e-9 there
  const rmsOf = (M) => M.sections.map((s) => { const r = s.plane && s.plane.rms; if (s.plane) delete s.plane.rms; return r; });
  const nodeM = strip(Mnode), oM2 = strip(orig.M), rmsNode = rmsOf(nodeM), rmsOrig = rmsOf(oM2);
  const dM = diff(strip(inPage.M), oM, 0), dMn = [...diff(nodeM, oM2, 1e-9), ...diff(rmsNode, rmsOrig, 1e-6)];
  check('model (port in Chromium) bit-identical', !dM.length, dM.slice(0, 6).join('; '));
  check('model (port in node) within 1e-9 (plane fit rms within 1e-6)', !dMn.length, dMn.slice(0, 6).join('; '));
  let values = countLeaves(oM), htmlOk = 0, htmlNodeOk = 0;
  OPTION_SETS.forEach((o, i) => {
    const od = plain(orig.derived[i]);
    values += countLeaves(od);
    const dp = diff(plain(inPage.derived[i]), od, 0), dn = diff(plain(portDerived(rm, Mnode, o)), od, 1e-9);
    check(`options #${i} (${o.system}): totals / wind zones / materials, port in Chromium bit-identical`, !dp.length, dp.slice(0, 6).join('; '));
    check(`options #${i} (${o.system}): totals / wind zones / materials, port in node within 1e-9`, !dn.length, dn.slice(0, 6).join('; '));
    [null, { data: PERMITS }].forEach((permits, j) => {
      const a = orig.html[i * 2 + j], b = inPage.html[i * 2 + j], c = portReport(rm, Mnode, o, permits);
      const at = (x) => { let n = 0; while (n < a.length && a[n] === x[n]) n++; return `at ${n}: "${a.slice(Math.max(0, n - 50), n + 60)}" / "${x.slice(Math.max(0, n - 50), n + 60)}"`; };
      if (a === b) htmlOk++; if (a === c) htmlNodeOk++;
      check(`options #${i} report${permits ? ' with permit page' : ''}: port in Chromium identical`, a === b, a === b ? '' : at(b));
      check(`options #${i} report${permits ? ' with permit page' : ''}: port in node identical`, a === c, a === c ? '' : at(c));
    });
  });
  console.log(`commercial parity: model + ${OPTION_SETS.length} option sets (${values} compared values); reports identical ${htmlOk}/${OPTION_SETS.length * 2} in Chromium, ${htmlNodeOk}/${OPTION_SETS.length * 2} in node`);
} finally {
  await browser.close();
}
summary('parity-commercial');
