// Parity of the measurement engine and the Roofr-format report with the ORIGINAL tool (app.js / report.js /
// permits.js running in headless Chromium). Randomized roofs are built with the tool's own addFacet / addEdge
// and with the port's model; computeTotals(), roofrWaste(), computeMaterials(), serialize() and
// buildReportHTML() are compared:
//   - the port running in the same Chromium as the original: must be bit-identical (tolerance 0);
//   - the port running in node: within 1e-9 relative. Node's V8 and Chromium's V8 differ in the last bit of
//     Math.sin / Math.cos / Math.pow, so an exact tie (two facets at the same distance from a line) can break
//     the other way; such a roof only passes when the in-browser run of the port is bit-identical.
// Run: TZ=America/New_York node --experimental-strip-types --import ./src/lib/roof-measure/__tests__/register.mjs src/lib/roof-measure/__tests__/parity-measure.test.mjs
import * as rm from '../index.ts';
import { loadEngineInPage, openTool } from './helpers/browser.mjs';
import { randomRoof, snapshotTotals, fakeSolar } from './helpers/roofs.mjs';
import { check, diff, countLeaves, summary } from './helpers/assert.mjs';

const N = Number(process.env.ROOFS || 400);
const roofs = Array.from({ length: N }, (_, i) => randomRoof(1000 + i));
const DEFAULT_MAT = { ridgeCapLF: 33, starterLF: 105, underlaySq: 10, iwLF: 66.7, dripStick: 10, valleyStick: 10, nailsPerSq: 320, nailsPerBox: 7200 };

// The port's side, as source so it runs unchanged in node and in the page.
function portRun(rm, R, snapshot) {
  const p = rm.emptyProject();
  p.defaultPitch = R.defaultPitch; p.waste = R.waste; if (R.mat) Object.assign(p.mat, R.mat);
  for (const f of R.facets) rm.addFacet(p, f.path, f.pitch, f.name, f.flags);
  for (const e of R.edges) rm.addEdge(p, e.type, e.path, e.pitch);
  const t = rm.computeTotals(p);
  return { totals: snapshot(t, p.facets, p.edges), recWaste: rm.roofrWaste(t), materials: rm.computeMaterials(t, p.mat, p.waste), names: p.facets.map((f) => f.name) };
}
function portReport(rm, R, c) {
  const p = rm.emptyProject();
  p.defaultPitch = R.defaultPitch; p.waste = R.waste; if (R.mat) Object.assign(p.mat, R.mat);
  for (const f of R.facets) rm.addFacet(p, f.path, f.pitch, f.name, f.flags);
  for (const e of R.edges) rm.addEdge(p, e.type, e.path, e.pitch);
  p.address = c.address; p.solar = c.solar; p.location = c.location;
  return rm.buildReportHTML({ project: p, company: { ...rm.COMPANY_DEFAULT, ...c.company }, satellite: null, permits: c.location ? { data: c.permitData, manual: c.manual } : null }).html;
}

const { browser, page, errors } = await openTool();
try {
  await loadEngineInPage(page);
  // ---------------------------------------------------------------- totals, waste, materials, saved format
  const orig = await page.evaluate(({ roofs, snapSrc, DEFAULT_MAT }) => {
    const snapshot = (0, eval)('(' + snapSrc + ')');
    return roofs.map((R) => {
      state.facets = []; state.edges = []; state.selected = null;
      state.defaultPitch = R.defaultPitch; state.waste = R.waste; state.jobName = ''; state.address = ''; state.location = null; state.solar = null; state.otherSolar = [];
      Object.assign(state.mat, DEFAULT_MAT, R.mat || {});
      for (const f of R.facets) addFacet(f.path, f.pitch, f.name, f.flags);
      for (const e of R.edges) addEdge(e.type, e.path, e.pitch);
      const t = computeTotals();
      return { totals: snapshot(t, state.facets, state.edges), recWaste: roofrWaste(t), materials: computeMaterials(t), names: state.facets.map((f) => f.name), saved: serialize() };
    });
  }, { roofs, snapSrc: snapshotTotals.toString(), DEFAULT_MAT });
  const portInPage = await page.evaluate(({ roofs, snapSrc, runSrc }) => {
    const snapshot = (0, eval)('(' + snapSrc + ')'), run = (0, eval)('(' + runSrc + ')');
    return roofs.map((R) => run(window.__rm, R, snapshot));
  }, { roofs, snapSrc: snapshotTotals.toString(), runSrc: portRun.toString() });

  let fields = 0, exactOk = 0, nodeOk = 0, nodeTies = 0, savedOk = 0;
  const tieRoofs = new Set();
  roofs.forEach((R, i) => {
    const o = { ...orig[i] }; delete o.saved;
    fields += countLeaves(o);
    const dPage = diff(portInPage[i], o, 0);
    if (!dPage.length) exactOk++;
    check(`roof #${i} (port in Chromium) bit-identical`, !dPage.length, dPage.slice(0, 5).join('; '));
    const dNode = diff(portRun(rm, R, snapshotTotals), o, 1e-9);
    if (!dNode.length) nodeOk++; else if (!dPage.length) { nodeTies++; tieRoofs.add(i); }
    check(`roof #${i} (port in node) within 1e-9`, !dNode.length || !dPage.length, dNode.slice(0, 5).join('; '));
    // saved-file compatibility: the tool's serialize() restores into the same totals and re-serializes identically
    const saved = orig[i].saved;
    const back = rm.restoreProject(saved);
    const d2 = diff(rm.serializeProject(back, new Date(saved.savedAt)), saved, 0);
    const d3 = diff(snapshotTotals(rm.computeTotals(back), back.facets, back.edges), portRun(rm, R, snapshotTotals).totals, 0);
    if (!d2.length && !d3.length) savedOk++;
    check(`roof #${i} serialize() -> restoreProject -> serializeProject round trip`, !d2.length && !d3.length, [...d2, ...d3].slice(0, 5).join('; '));
  });
  console.log(`measurement parity over ${N} roofs (${fields} compared values each run: totals, every structure, every facet / line metric, recommended waste, materials, facet names):`);
  console.log(`  port in Chromium: ${exactOk}/${N} bit-identical; port in node: ${nodeOk}/${N} within 1e-9 (${nodeTies} differ only by a last-bit Math tie in node, identical in Chromium); saved-format round trip ${savedOk}/${N}`);

  // ---------------------------------------------------------------- map labels (baseLabels) and the CSV export
  const LBL = Math.min(N, 60);
  const labelCases = roofs.slice(0, LBL).map((R, i) => ({ R, solar: i % 3 === 0 && R.facets.length ? fakeSolar(900 + i, R.facets[0].path[0]) : null, others: i % 6 === 0 && R.facets.length ? [fakeSolar(950 + i, R.facets[0].path[0]), { name: 'no-data' }] : [], showFacetEdges: i % 4 !== 1, showSolar: i % 5 !== 2, jobName: i % 2 ? 'Smith "residence", rear' : '', address: '12 Elm St, Jacksonville' }));
  const origLabels = await page.evaluate(({ cases, DEFAULT_MAT }) => {
    let captured = null;
    download = (name, text) => { captured = { name, text }; };
    return cases.map((c) => {
      const R = c.R;
      state.facets = []; state.edges = []; state.defaultPitch = R.defaultPitch; state.waste = R.waste; Object.assign(state.mat, DEFAULT_MAT, R.mat || {});
      for (const f of R.facets) addFacet(f.path, f.pitch, f.name, f.flags);
      for (const e of R.edges) addEdge(e.type, e.path, e.pitch);
      state.solar = c.solar; state.otherSolar = c.others; state.showFacetEdges = c.showFacetEdges; state.showSolar = c.showSolar; state.jobName = c.jobName; state.address = c.address;
      captured = null; exportCSV();
      return { labels: baseLabels(), csv: captured };
    });
  }, { cases: labelCases, DEFAULT_MAT });
  let lblOk = 0, csvOk = 0;
  labelCases.forEach((c, i) => {
    const p = rm.emptyProject();
    p.defaultPitch = c.R.defaultPitch; p.waste = c.R.waste; if (c.R.mat) Object.assign(p.mat, c.R.mat);
    for (const f of c.R.facets) rm.addFacet(p, f.path, f.pitch, f.name, f.flags);
    for (const e of c.R.edges) rm.addEdge(p, e.type, e.path, e.pitch);
    p.solar = c.solar; p.otherSolar = c.others; p.jobName = c.jobName; p.address = c.address;
    const labels = rm.mapLabels(p, { showFacetEdges: c.showFacetEdges, showSolar: c.showSolar });
    const dl = diff(labels, origLabels[i].labels, 1e-9);
    if (!dl.length) lblOk++;
    check(`roof #${i} map labels`, !dl.length || tieRoofs.has(i), dl.slice(0, 3).join('; '));
    const csv = rm.buildCSV(p).split('\r\n'), oc = origLabels[i].csv.text.split('\r\n');
    const sameCsv = rm.fileBase(p) + '_measurements.csv' === origLabels[i].csv.name && csv.length === oc.length && csv.slice(1).join('\n') === oc.slice(1).join('\n') && csv[0].replace(/,"[^"]*"$/, '') === oc[0].replace(/,"[^"]*"$/, '');
    if (sameCsv) csvOk++;
    check(`roof #${i} CSV export (all but the export timestamp)`, sameCsv || tieRoofs.has(i), sameCsv ? '' : `${csv.slice(0, 3).join(' | ')} // ${oc.slice(0, 3).join(' | ')}`);
  });
  console.log(`map labels identical for ${lblOk}/${LBL} roofs, CSV export identical for ${csvOk}/${LBL} (the port in node)`);

  // ---------------------------------------------------------------- report HTML
  const permitSamples = [
    { checked: '2026-09-30T14:00:00.000Z', address: '1 Test St', county: 'Duval', jurisdiction: 'City of Jacksonville', parcel: { id: '123', re: '162112 0625' }, yearBuilt: 1994, effYear: 2001, roofCover: 'Asph/Comp Shng', roofStruct: 'Gable or Hip', searched: true, source: 'City of Jacksonville JAXEPICS (live)', searchTerm: 'parcel 162112 0625', recordsFrom: 1985, portal: null, notes: ['A note & <b>more</b>.'], errors: [],
      permits: [
        { number: 'R-2019-1', type: 'Roofing Permit', use: 'Residential', structure: '', work: 'Reroof - Shingle', status: 'Final', submitted: '2019-05-01', issued: '2019-05-06', finaled: '2019-06-01', contractor: 'Acme Roofing Co', address: '1 TEST ST', link: '', roof: true },
        { number: 'R-2005-9', type: 'Roofing Permit', use: 'Residential', structure: '', work: 'Reroof', status: 'Void', submitted: '2005-02-01', issued: null, finaled: null, address: '1 TEST ST', link: '', roof: true },
        { number: 'B-2010-4', type: 'Building', use: 'Residential', structure: 'SFR', work: 'Addition', status: 'Issued', submitted: '2010-03-03', issued: '2010-04-04', finaled: null, address: '1 TEST ST', link: '', roof: false },
      ] },
    { checked: '2026-10-01T10:00:00.000Z', address: '2 Test St', county: 'Clay', jurisdiction: 'Clay County', parcel: { id: '9-9' }, yearBuilt: 2018, effYear: null, roofCover: null, roofStruct: null, searched: true, source: 'Clay County EnerGov', recordsFrom: 2023, portal: null, notes: [], errors: [], permits: [] },
    { checked: '2026-10-01T10:00:00.000Z', address: '3 Test St', county: 'Duval', jurisdiction: 'City of Jacksonville', parcel: null, yearBuilt: 1960, effYear: 1970, roofCover: null, roofStruct: null, searched: true, source: null, recordsFrom: 1985, portal: null, notes: [], errors: ['City permit search: x'], permits: [] },
    { checked: '2026-10-01T10:00:00.000Z', address: '4 Test St', county: 'Nassau', jurisdiction: 'Nassau County', parcel: { id: '4' }, yearBuilt: 2001, effYear: null, roofCover: null, roofStruct: null, searched: false, source: null, portal: null, notes: ['Nassau County has no public permit data feed.'], errors: [], permits: [] },
  ];
  const companies = [{}, { rep: 'Pat Smith', phone: '', name: 'Acme & Sons <Roofing>' }];
  const reportCases = [];
  for (let i = 0, made = 0; i < N && made < 16; i++) {
    const R = roofs[i];
    if (!R.facets.length && made > 1) continue;
    const loc = R.facets.length ? R.facets[0].path[0] : { lat: 30.3, lng: -81.6 };
    reportCases.push({
      roof: i, address: made % 3 === 0 ? `${100 + made} Main St & "Oak" <Ave>, Jacksonville, FL 32256` : `${200 + made} Beach Blvd, Jacksonville, FL 32250`,
      solar: made % 2 === 0 ? fakeSolar(50 + made, loc) : null,
      location: made % 4 === 1 || made % 4 === 2 ? loc : null,
      permitData: permitSamples[made % permitSamples.length],
      manual: made % 5 === 2 ? { date: '2021-08-15', number: 'M-77' } : null,
      company: companies[made % 2],
    });
    made++;
  }
  const origHtml = await page.evaluate(async ({ roofs, cases, DEFAULT_MAT }) => {
    const base = { ...company };
    const out = [];
    for (const c of cases) {
      const R = roofs[c.roof];
      state.facets = []; state.edges = []; state.defaultPitch = R.defaultPitch; state.waste = R.waste; Object.assign(state.mat, DEFAULT_MAT, R.mat || {});
      for (const f of R.facets) addFacet(f.path, f.pitch, f.name, f.flags);
      for (const e of R.edges) addEdge(e.type, e.path, e.pitch);
      state.address = c.address; state.solar = c.solar; state.location = c.location;
      Object.assign(company, base, c.company);
      if (c.location) { permit.key = state.address; permit.data = c.permitData; permit.pending = null; if (c.manual) permit.manual[permit.key] = c.manual; else delete permit.manual[permit.key]; }
      else { permit.key = null; permit.data = null; }
      const { html } = await buildReportHTML();
      out.push(html);
    }
    Object.assign(company, base);
    return out;
  }, { roofs, cases: reportCases, DEFAULT_MAT });
  const pageHtml = await page.evaluate(({ roofs, cases, src }) => { const run = (0, eval)('(' + src + ')'); return cases.map((c) => run(window.__rm, roofs[c.roof], c)); }, { roofs, cases: reportCases, src: portReport.toString() });
  let htmlOk = 0, nodeHtmlOk = 0, htmlBytes = 0;
  const firstDiff = (a, b) => { let at = 0; while (at < a.length && a[at] === b[at]) at++; return `first difference at ${at}: original "${a.slice(Math.max(0, at - 60), at + 80)}" / port "${b.slice(Math.max(0, at - 60), at + 80)}"`; };
  reportCases.forEach((c, k) => {
    const a = origHtml[k];
    htmlBytes += a.length;
    if (a === pageHtml[k]) htmlOk++;
    check(`report #${k} (roof ${c.roof}, port in Chromium) HTML identical`, a === pageHtml[k], a === pageHtml[k] ? '' : firstDiff(a, pageHtml[k]));
    const nodeHtml = portReport(rm, roofs[c.roof], c);
    if (nodeHtml === a) nodeHtmlOk++;
    check(`report #${k} (roof ${c.roof}, port in node) HTML identical`, nodeHtml === a || (tieRoofs.has(c.roof) && a === pageHtml[k]), nodeHtml === a ? '' : firstDiff(a, nodeHtml));
  });
  console.log(`report parity: ${htmlOk}/${reportCases.length} reports byte-identical with the port in Chromium, ${nodeHtmlOk}/${reportCases.length} with the port in node (the rest: the Math tie roofs above; ${htmlBytes} bytes of original HTML; satellite image left out on both sides)`);
  // the original's commercial.js wiring calls comPrint before commercial_report.js defines it (a bug in the tool itself)
  const unexpected = errors.filter((e) => !/comPrint is not defined/.test(e));
  check('no unexpected page errors in the original tool', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}
summary('parity-measure');
