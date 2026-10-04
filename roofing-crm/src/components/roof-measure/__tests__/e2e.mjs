// End-to-end test of the Roof Measure page (desktop 1440x900 and iPhone 13 390x844 with touch), against a
// production build: `npm run build && PORT=3203 npm start`, then
//   node --experimental-strip-types --import ./src/lib/roof-measure/__tests__/register.mjs src/components/roof-measure/__tests__/e2e.mjs
// Google Maps is the stand-in in gmaps-stub.js; Solar API data comes from the engine tests' synthetic scenes.
// Every total shown on the page is checked against the engine's computeTotals() of the project the page saved.
import { readFileSync, mkdirSync } from 'node:fs';
import proj4 from 'proj4';
import * as rm from '../../../lib/roof-measure/index.ts';
import { launch, newContext, openPage, pagePoint, scenes, comScene, BASE } from './harness.mjs';

const OUT = process.env.SHOTS || '/tmp/claude-0/-home-user-CRM-233/3fae1c33-6f93-5467-8d04-a339572eb840/scratchpad/ui-roofmeasure/';
mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); } };
const step = (s) => console.log('\n# ' + s);

// The gable scene in metres (UTM 17N) -> lat/lng.
const UTM17 = '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs';
const sc = scenes[0];
const LL = (e, n) => { const p = proj4(UTM17, 'EPSG:4326', [sc.cE + e, sc.cN + n]); return { lat: p[1], lng: p[0] }; };
const P = { NW: LL(-6, 4.5), NE: LL(6, 4.5), SE: LL(6, -4.5), SW: LL(-6, -4.5), RW: LL(-6, 0), RE: LL(6, 0) };
const CH = [LL(1, -3), LL(2.5, -3), LL(2.5, -1.5), LL(1, -1.5)]; // chimney cutout
const TMP = [LL(14, 3), LL(20, 3), LL(20, -3), LL(14, -3)]; // a temporary facet for corner edits

async function readAutosaved(page) {
  await page.waitForTimeout(600); // autosave debounce
  const raw = await page.evaluate(() => localStorage.getItem('crm.roofMeasure.autosave'));
  return raw ? rm.restoreProject(JSON.parse(raw).project) : null;
}
const txt = (page, id) => page.locator(`[data-testid=${id}]`).first().innerText();
async function noOverflow(page, label) {
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check(`no horizontal overflow (${label}): ${sw} <= ${w}`, sw <= w);
}
async function clickLL(page, ll, opts) { const p = await pagePoint(page, ll); await page.mouse.click(p.x, p.y, opts); }
async function collapse(page) {
  for (let i = 0; i < 3 && (await page.getAttribute('[data-testid=bottom-sheet]', 'data-state')) !== 'peek'; i++) await page.tap('[data-testid=sheet-toggle]');
}
async function tapLL(page, ll) { const p = await pagePoint(page, ll); await page.touchscreen.tap(p.x, p.y); }
async function key(page, k) { await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur()); await page.keyboard.press(k); }

// Totals panel vs computeTotals() of the saved project.
async function checkTotals(page, label) {
  const p = await readAutosaved(page);
  const t = rm.computeTotals(p);
  check(`${label}: roof sq ft ${rm.fmt(t.sloped)}`, (await txt(page, 'kpi-sqft')) === rm.fmt(t.sloped), await txt(page, 'kpi-sqft'));
  check(`${label}: squares ${rm.fmt(t.squares, 2)}`, (await txt(page, 'kpi-squares')) === rm.fmt(t.squares, 2));
  check(`${label}: squares with waste ${rm.fmt(t.squaresWaste, 2)}`, (await txt(page, 'kpi-waste')) === rm.fmt(t.squaresWaste, 2));
  check(`${label}: recommended waste ${t.recWaste}%`, (await txt(page, 'rec-waste')) === `${t.recWaste}%`);
  for (const [k, v] of Object.entries(rm.EDGE_TYPES)) {
    if (!t.byType[k].count) continue;
    const row = page.locator(`[data-testid=line-totals] tr[data-type=${k}] td`);
    const cells = await row.allInnerTexts();
    check(`${label}: ${v.plural} ${rm.fmt(t.byType[k].plan, 1)} / ${rm.fmt(t.byType[k].true, 1)} ft`, cells[1] === rm.fmt(t.byType[k].plan, 1) && cells[2] === rm.fmt(t.byType[k].true, 1), cells.join(' | '));
  }
  const mats = rm.computeMaterials(t, p.mat, p.waste);
  const matText = await txt(page, 'materials-out');
  check(`${label}: materials list (${mats.length} rows) matches computeMaterials`, mats.every((m) => matText.includes(`${m.qty} ${m.unit}`) && matText.includes(m.name)));
  return { p, t };
}

const browser = await launch();
const errorsAll = [];

// ====================================================================== desktop
{
  step('Desktop 1440x900: residential');
  const ctx = await newContext(browser);
  const { page, errors } = await openPage(ctx);
  errorsAll.push(errors);
  await noOverflow(page, 'desktop start');

  // the action bar error when nothing is traced: right next to the button, on screen
  await page.click('[data-testid=use-measurements]');
  const err = page.locator('[data-testid=use-error]');
  check('use-measurements error shows without a roof', await err.isVisible());
  const eb = await err.boundingBox(), bb = await page.locator('[data-testid=use-measurements]').boundingBox();
  check('error sits right under the button and inside the viewport', eb && bb && eb.y >= bb.y && eb.y - (bb.y + bb.height) < 40 && eb.y + eb.height <= 900, JSON.stringify({ eb, bb }));
  await page.screenshot({ path: OUT + 'desktop-01-use-error.png' });

  // API key box: show / hide
  await page.click('button:has-text("Show")');
  check('API key Show reveals the saved key', (await page.getAttribute('[data-testid=api-key]', 'type')) === 'text' && (await page.inputValue('[data-testid=api-key]')) === 'test-key');
  await page.click('button:has-text("Hide")');

  // pick the house on the map: crosshair, arrow keys pan, Enter locks (reverse geocoded)
  await page.evaluate((b) => { const m = window.__gmStub.map; m.setCenter(b); m.setZoom(20); }, LL(0, 0));
  await page.click('button:has-text("Pick on map")');
  const c0 = await page.evaluate(() => window.__gmStub.map.toPixel(window.__gmStub.map.getCenter()));
  const ll0 = await page.evaluate(() => window.__gmStub.map.getCenter().toJSON());
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const ll1 = await page.evaluate(() => window.__gmStub.map.getCenter().toJSON());
  const shifted = await page.evaluate((q) => window.__gmStub.map.toPixel(q), ll0);
  check('pick mode: arrow keys pan the map (80 px, Shift 12 px)', Math.abs(c0.x - shifted.x - 80) < 0.5 && Math.abs(c0.y - shifted.y - 12) < 0.5, JSON.stringify([c0, shifted]));
  check('pick mode: Lock center button shown', await page.locator('button:has-text("Lock center")').isVisible());
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-testid=address]').value === '100 Test St, Jacksonville, FL 32207, USA');
  const saved0 = await readAutosaved(page);
  check('Enter locks the house at the map centre with its street address', Math.abs(saved0.location.lat - ll1.lat) < 1e-12 && Math.abs(saved0.location.lng - ll1.lng) < 1e-12);
  // double-click a house (select tool) locks it too
  await page.evaluate((b) => window.__gmStub.map.setCenter(b), LL(0, 0));
  const dbl = await pagePoint(page, P.NE);
  await page.mouse.dblclick(dbl.x, dbl.y);
  await page.waitForTimeout(400);
  const saved1 = await readAutosaved(page);
  check('double-click on the map locks the house there', Math.abs(saved1.location.lat - P.NE.lat) < 2e-6 && Math.abs(saved1.location.lng - P.NE.lng) < 2e-6, JSON.stringify([saved1.location, P.NE, dbl, await page.evaluate(() => [window.__gmStub.map.getZoom(), window.__gmStub.map.getCenter().toJSON()])]));

  // address suggestions (Places refused -> Esri) and choosing one
  await page.fill('[data-testid=address]', '');
  await page.type('[data-testid=address]', '1234 Gab', { delay: 20 });
  await page.waitForSelector('[role=listbox]');
  check('address suggestions appear (Esri fallback)', (await page.locator('[role=option]').count()) === 2 && (await page.locator('[role=listbox]').innerText()).includes('suggestions by Esri'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-testid=address]').value.startsWith('1234 Gable Ct, Jacksonville, Florida'));
  check('choosing a suggestion locks the address', true);
  await page.waitForFunction(() => document.querySelector('[data-testid=permit-out]').innerText.includes('Built 2005'));
  check('permits: roof age from the parcel roll', (await txt(page, 'permit-out')).includes('Built 2005; no permit records for this area'));
  await page.fill('[data-testid=pm-date]', '2020-05-01');
  await page.waitForFunction(() => document.querySelector('[data-testid=permit-out]').innerText.includes('(entered)'));
  check('manual permit date updates roof age', (await txt(page, 'permit-out')).includes('last roof permit dated May 1, 2020 (entered)'));
  check('manual permit saved in rm.permitManual', (await page.evaluate(() => localStorage.getItem('rm.permitManual'))).includes('2020-05-01'));
  check('Street View / Google Earth links', (await page.locator('a', { hasText: 'Street View' }).getAttribute('href')).includes('map_action=pano'));

  // Solar API
  await page.click('button:has-text("Get roof data")');
  await page.waitForSelector('[data-testid=solar-out]');
  const sol = rm.solarSummaryOf(sc.main);
  check(`Solar: ${rm.fmt(sol.total)} roof sq ft, ${sol.segs.length} planes`, (await txt(page, 'solar-out')).includes(rm.fmt(sol.total)) && (await txt(page, 'solar-out')).includes(`${sol.segs.length} planes`));
  await page.click('button:has-text("as default pitch")');
  check('Use x/12 as default pitch', (await page.locator('[data-testid=default-pitch]').inputValue()) === String(Math.round(sol.predominant)));
  await page.click('button:has-text("Scan for other structures")');
  await page.waitForFunction(() => document.querySelector('[data-testid=hint]').innerText.includes('No other structures found'));
  check('Scan for other structures (24 probes) reports none for a lone house', true);
  await page.click('label:has-text("Show planes on map") input'); // hide planes for tracing

  // zoom in on the house (the stub's projection, like a user zooming)
  await page.evaluate(() => window.__gmStub.map.setZoom(21));

  step('trace a gable by clicking');
  await key(page, 'f');
  for (const q of [P.NW, P.NE, P.RE, P.RW]) await clickLL(page, q);
  await clickLL(page, P.NW); // click the first corner again: closes the facet
  for (const q of [P.RW, P.RE, P.SE, P.SW]) await clickLL(page, q);
  await key(page, 'Enter');
  check('two facets drawn (close-on-first-point and Enter)', (await page.locator('[data-testid=facet-list] > div').count()) === 2);
  // eave north: double-click to finish; eave south: toolbar Finish
  await key(page, 'e');
  await clickLL(page, P.NW);
  const ne = await pagePoint(page, P.NE); await page.mouse.dblclick(ne.x, ne.y);
  await clickLL(page, P.SW); await clickLL(page, P.SE);
  await page.click('[data-testid=btn-finish]');
  await key(page, 'r'); await clickLL(page, P.RW); await clickLL(page, P.RE); await key(page, 'Enter');
  await key(page, 'k'); for (const q of [P.NW, P.RW, P.SW]) await clickLL(page, q); await key(page, 'Enter');
  for (const q of [P.NE, P.RE, P.SE]) await clickLL(page, q); await key(page, 'Enter');
  // chimney cutout
  await key(page, 'f'); for (const q of CH) await clickLL(page, q); await key(page, 'Enter');
  await key(page, 'Escape');
  check('lines drawn: 2 eaves, ridge, 2 rakes', (await page.locator('[data-testid=edge-list] > div').count()) === 5);

  let saved = await readAutosaved(page);
  const shared = saved.facets[0].path.some((a) => saved.facets[1].path.some((b) => a.lat === b.lat && a.lng === b.lng));
  check('snapping: the two facets share their ridge corners exactly', shared);
  check('lines snapped onto facet corners', saved.edges.every((e) => e.path.every((q) => saved.facets.some((f) => f.path.some((v) => v.lat === q.lat && v.lng === q.lng)))));

  // pitch edit and exclude
  await page.click('[data-testid=facet-F1]');
  await page.selectOption('[data-testid=selection] [data-testid=sel-pitch]', '8');
  await page.click('[data-testid=facet-F3]');
  await page.check('#sel-excluded');
  saved = await readAutosaved(page);
  check('F1 pitch is 8/12 after editing', saved.facets[0].pitch === 8);
  check('F3 is excluded', saved.facets[2].excluded === true);
  await key(page, 'Escape');

  step('totals panel = computeTotals()');
  const { t } = await checkTotals(page, 'gable');
  const ideal = rm.computeTotals({ ...rm.emptyProject(), defaultPitch: saved.defaultPitch, facets: [rm.makeFacet(rm.emptyProject(), [P.NW, P.NE, P.RE, P.RW], 8), rm.makeFacet(rm.emptyProject(), [P.RW, P.RE, P.SE, P.SW], saved.defaultPitch), { ...rm.makeFacet(rm.emptyProject(), CH, saved.defaultPitch), excluded: true }], edges: [] });
  check(`traced area within 1% of the drawn geometry (${rm.fmt(t.sloped)} vs ${rm.fmt(ideal.sloped)})`, Math.abs(t.sloped - ideal.sloped) / ideal.sloped < 0.01);
  await page.selectOption('[data-testid=waste]', '15');
  await checkTotals(page, 'waste 15%');

  step('corner edits on a temporary facet: drag, right-click delete, minimum 3');
  await key(page, 'f'); for (const q of TMP) await clickLL(page, q); await key(page, 'Enter'); await key(page, 'Escape');
  await page.click('[data-testid=facet-F4]');
  const a = await pagePoint(page, TMP[1]);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + 20, a.y - 15, { steps: 5 }); await page.mouse.up();
  saved = await readAutosaved(page);
  const moved = saved.facets[3].path[1];
  check('dragging a corner writes the new path back', Math.abs(moved.lng - TMP[1].lng) > 1e-6 && Math.abs(moved.lat - TMP[1].lat) > 1e-6);
  const c = await pagePoint(page, TMP[2]); await page.mouse.click(c.x, c.y, { button: 'right' });
  saved = await readAutosaved(page);
  check('right-click a corner deletes it', saved.facets[3].path.length === 3);
  const d = await pagePoint(page, TMP[3]); await page.mouse.click(d.x, d.y, { button: 'right' });
  saved = await readAutosaved(page);
  check('a facet keeps at least 3 corners', saved.facets[3].path.length === 3);
  await page.click('[data-testid=facet-F4]');
  await key(page, 'Delete');
  saved = await readAutosaved(page);
  check('Delete key removes the selected facet', saved.facets.length === 3);
  await page.evaluate((b) => { const m = window.__gmStub.map; m.setCenter(b); m.setZoom(21); }, LL(0, 0));
  await page.click('label:has-text("Show planes on map") input');
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + 'desktop-02-traced.png' });

  step('save, reload, load, export / import');
  await page.click('[data-section=export] > summary');
  await page.fill('[data-testid=job-name]', 'Gable Test');
  await page.click('[data-testid=save-roof]');
  check('saved roofs list shows "Gable Test"', (await txt(page, 'saved-list')).includes('Gable Test'));
  const before = await txt(page, 'kpi-sqft');
  await page.reload();
  await page.waitForSelector('[data-testid=map] .gm-style');
  await page.waitForSelector('[data-testid=kpi-sqft]');
  check('reload restores the roof in progress (autosave)', (await txt(page, 'kpi-sqft')) === before && (await page.locator('[data-testid=facet-list] > div').count()) === 3);
  await page.click('button:has-text("New roof")');
  check('New roof clears the roof', (await page.locator('[data-testid=facet-list] > div').innerText()).includes('No facets yet'));
  await page.click('[data-section=export] > summary');
  await page.click('[data-testid=saved-list] [data-name="Gable Test"]');
  check('loading the saved roof restores it', (await txt(page, 'kpi-sqft')) === before);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=btn-json]')]);
  const json = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  check(`Export JSON: ${dl.suggestedFilename()} (app roof-measure v2, 3 facets, 5 lines)`, json.app === 'roof-measure' && json.version === 2 && json.facets.length === 3 && json.edges.length === 5 && dl.suggestedFilename() === 'Gable_Test_roof.json');
  const [dlc] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=btn-csv]')]);
  const csv = readFileSync(await dlc.path(), 'utf8');
  check('Export CSV has facets, lines, totals and materials', csv.startsWith('Roof Measure export,Gable Test') && csv.includes('\r\nTOTAL,') && csv.includes('Material,Qty,Unit,Basis'));
  await page.click('button:has-text("New roof")');
  await page.setInputFiles('[data-testid=file-json]', await dl.path());
  await page.waitForSelector('[data-testid=kpi-sqft]');
  check('Import JSON restores the roof', (await txt(page, 'kpi-sqft')) === before && (await page.locator('[data-testid=facet-list] > div').count()) === 3);

  step('report: print / PDF and download');
  await page.fill('[data-testid=co-rep]', 'Musab Test');
  await page.click('[data-testid=btn-report]');
  await page.waitForSelector('[data-testid=report-viewer] iframe');
  const frame = page.frameLocator('[data-testid=report-viewer] iframe');
  await frame.locator('.rp-page').first().waitFor();
  const pages = await frame.locator('.rp-page').count();
  check(`report has 8 pages (cover, diagram, length, area, pitch, summary, permits, materials): ${pages}`, pages === 8);
  const reportText = await frame.locator('body').innerText();
  // (the residential report prints the company, not the rep, exactly like the original's report.js)
  check('report: company, permit page, roof age line on the cover', reportText.includes('Prepared by Diversity Roofing') && reportText.includes('Permit history') && reportText.includes('(entered)'));
  check('report: cover photo embedded as a data URL', (await frame.locator('img.cover-img').getAttribute('src')).startsWith('data:image'));
  await page.waitForFunction(() => (window.__printed || 0) >= 1, null, { timeout: 8000 }).catch(() => {});
  check('print dialog opened for the report', (await page.evaluate(() => window.__printed || 0)) >= 1);
  await page.screenshot({ path: OUT + 'desktop-03-report.png' });
  const [dlr] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=report-viewer] button:has-text("Download")')]);
  const doc = readFileSync(await dlr.path(), 'utf8');
  check(`downloaded report ${dlr.suggestedFilename()} is standalone and has no API key`, doc.startsWith('<!doctype html>') && !doc.includes('test-key') && dlr.suggestedFilename() === 'Gable_Test_Roof_Report.html');
  await page.click('[data-testid=report-viewer] button:has-text("Close")');

  step('Use these measurements -> roof report');
  await page.click('[data-testid=use-measurements]');
  await page.waitForSelector('[data-testid=use-saved]');
  const store = JSON.parse(await page.evaluate(() => localStorage.getItem('crm-roof-reports-v1')));
  const rep = store.state.roofReports[0];
  const pr = await readAutosaved(page);
  const tm = rm.toRoofMeasurements(rm.computeTotals(pr), pr.defaultPitch);
  check('report saved with source roof_measure and toRoofMeasurements() numbers', rep.source === 'roof_measure' && JSON.stringify(rep.measurements) === JSON.stringify(tm), JSON.stringify(rep.measurements));
  check(`address split: ${rep.address} | ${rep.city} | ${rep.state} | ${rep.zip}`, rep.address === '1234 Gable Ct' && rep.city === 'Jacksonville' && rep.state === 'FL' && rep.zip === '32207');
  check('no lead attached, estimates []', !rep.leadId && Array.isArray(rep.estimates) && rep.estimates.length === 0);
  await page.click('[data-testid=use-measurements]');
  check('pressing again does not duplicate the report', JSON.parse(await page.evaluate(() => localStorage.getItem('crm-roof-reports-v1'))).state.roofReports.length === 1);
  await page.screenshot({ path: OUT + 'desktop-04-use-saved.png' });
  await page.click('[data-testid=view-reports]');
  await page.waitForURL('**/roof-reports');
  await page.waitForTimeout(800);
  check('/roof-reports lists the new report', (await page.locator('body').innerText()).includes('1234 Gable Ct'));

  step('lead flow: prefill, auto-trace, Build estimate');
  await page.goto(BASE + '/roof-measure?leadId=lead-1');
  await page.waitForSelector('[data-testid=map] .gm-style');
  await page.waitForFunction(() => document.querySelector('[data-testid=address]').value.includes('1234 Oak Ridge Dr'));
  check('lead: job name prefilled from the homeowner', (await page.inputValue('[data-testid=job-name]')) === 'Robert Thompson');
  check('previous roof kept among saved roofs', (await page.evaluate(() => localStorage.getItem('rm.projects'))).includes('Gable Test (autosaved'));
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Get roof data') && !b.disabled));
  await page.click('button:has-text("Get roof data")');
  await page.waitForSelector('[data-testid=solar-out]');
  await page.click('button:has-text("Auto-trace roof")');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=facet-list] > div[data-testid^=facet-]').length > 0, null, { timeout: 30000 });
  const auto = await readAutosaved(page);
  // the same trace in node
  const nodeFetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.includes('dataLayers')) return new Response(JSON.stringify({ imageryDate: sc.main.imageryDate, imageryQuality: 'HIGH', maskUrl: 'https://t.test/x?id=m', dsmUrl: 'https://t.test/x?id=d' }));
    return new Response(u.searchParams.get('id') === 'm' ? sc.mask : sc.dsm);
  };
  const layers = await rm.loadAutoTraceLayers(sc.main, '', nodeFetch);
  const res = await rm.autoTraceRoof({ building: sc.main, mask: layers.mask, dsm: layers.dsm, fetchBuilding: async () => sc.main, defaultPitch: auto.defaultPitch });
  const np = rm.emptyProject(); np.defaultPitch = auto.defaultPitch; rm.applyAutoTrace(np, res);
  check(`auto-trace: ${auto.facets.length} facets / ${auto.edges.length} lines, same as the engine in node`, auto.facets.length === np.facets.length && auto.edges.length === np.edges.length);
  await checkTotals(page, 'auto-traced');
  await page.click('[data-testid=use-measurements]');
  await page.waitForSelector('[data-testid=use-saved]');
  const store2 = JSON.parse(await page.evaluate(() => localStorage.getItem('crm-roof-reports-v1')));
  const rep2 = store2.state.roofReports[0];
  check(`lead report: lead-1 / ho-1, ${rep2.address}, ${rep2.city}, ${rep2.state} ${rep2.zip}`, rep2.leadId === 'lead-1' && rep2.homeownerId === 'ho-1' && rep2.address === '1234 Oak Ridge Dr' && rep2.city === 'Dallas' && rep2.state === 'TX' && rep2.zip === '75201');
  await page.click('[data-testid=build-estimate]');
  await page.waitForURL(/\/estimator\/[^/?#]+$/, { timeout: 15000 });
  const estId = page.url().split('/estimator/')[1];
  const est = JSON.parse(await page.evaluate(() => localStorage.getItem('crm-estimator-v1')));
  const e = est.state.estimates.find((x) => x.id === estId);
  const rep3 = JSON.parse(await page.evaluate(() => localStorage.getItem('crm-roof-reports-v1'))).state.roofReports.find((r) => r.id === rep2.id);
  check(`Build estimate navigates to /estimator/${estId}`, !!estId);
  check(`estimate ${e && e.number} exists for Robert Thompson`, !!e && e.customer.name === 'Robert Thompson' && e.customer.phone === '(555) 200-0001');
  check('estimate number recorded on the roof report', !!e && rep3.estimates.length === 1 && rep3.estimates[0].number === e.number);

  step('commercial');
  await page.goto(BASE + '/roof-measure');
  await page.waitForSelector('[data-testid=map] .gm-style');
  await page.click('[data-testid=mode-com]');
  check('commercial mode hides the residential panels and toolbar', (await page.locator('[data-section=trace]').count()) === 0 && (await page.locator('[data-testid=toolbar]').count()) === 0);
  await page.fill('[data-testid=c-drains]', '3');
  await page.fill('[data-testid=address]', `${comScene.target.lat}, ${comScene.target.lng}`);
  await page.keyboard.press('Enter');
  await page.click('[data-testid=btn-com]');
  await page.waitForSelector('[data-testid=com-out] table', { timeout: 60000 });
  check('commercial measurement shows sqft and sections', /sqft/.test(await txt(page, 'com-out')));
  check('a new address cleared the old site counts', (await page.inputValue('[data-testid=c-drains]')) === '');
  await page.evaluate((b) => { const m = window.__gmStub.map; m.setCenter(b); m.setZoom(19); }, { lat: comScene.bi.center.latitude, lng: comScene.bi.center.longitude });
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + 'desktop-05-commercial.png' });
  await page.click('[data-testid=btn-com-report]');
  const cframe = page.frameLocator('[data-testid=report-viewer] iframe');
  await cframe.locator('.rp-page').first().waitFor({ timeout: 30000 });
  const cpages = await cframe.locator('.rp-page').count();
  check(`commercial report pages: ${cpages}`, cpages >= 9);
  check('commercial report prints the rep on the cover', (await cframe.locator('body').innerText()).includes('Musab Test'));
  await page.click('[data-testid=report-viewer] button:has-text("Close")');
  await page.click('[data-testid=use-measurements]');
  await page.waitForSelector('[data-testid=use-saved]');
  const crep = JSON.parse(await page.evaluate(() => localStorage.getItem('crm-roof-reports-v1'))).state.roofReports[0];
  check(`commercial roof report: ${crep.measurements.totalSqFt} sq ft, flat ${crep.measurements.flatSqFt}, penetrations ${crep.measurements.penetrations}`, crep.measurements.totalSqFt > 0 && crep.measurements.flatSqFt > 0 && typeof crep.measurements.penetrations === 'number');
  await page.click('[data-testid=mode-res]');
  await noOverflow(page, 'desktop end');
  await ctx.close();
}

// ====================================================================== phone
{
  step('iPhone 13 390x844, touch');
  const ctx = await newContext(browser, { mobile: true });
  const { page, errors } = await openPage(ctx);
  errorsAll.push(errors);
  await noOverflow(page, 'phone start');
  await page.screenshot({ path: OUT + 'phone-01-start.png' });
  await page.tap('[data-testid=use-measurements]');
  const err = page.locator('[data-testid=use-error]');
  const eb = await err.boundingBox();
  check('phone: error visible on screen next to the button', await err.isVisible() && eb.y + eb.height < 844 && eb.y < 260);
  await page.screenshot({ path: OUT + 'phone-02-use-error.png' });
  await page.tap('[data-testid=use-error] button[aria-label=Dismiss]');

  await page.tap('[data-testid=tab-property]');
  check('phone: Property tab opens the sheet', (await page.getAttribute('[data-testid=bottom-sheet]', 'data-state')) === 'half');
  await page.tap('[data-testid=address]');
  await page.fill('[data-testid=address]', '1234 Gable Ct, Jacksonville, FL 32207');
  const fs = await page.$eval('[data-testid=address]', (el) => getComputedStyle(el).fontSize);
  check(`phone: inputs are 16px (${fs})`, fs === '16px');
  await page.tap('button[aria-label="Go to address"]');
  await page.waitForFunction(() => document.querySelector('[data-testid=permit-out]').innerText.includes('Built'));
  await page.screenshot({ path: OUT + 'phone-03-property.png' });
  await noOverflow(page, 'phone property sheet');
  await page.tap('[data-testid=tab-property]');
  check('phone: tapping the open tab collapses the sheet', (await page.getAttribute('[data-testid=bottom-sheet]', 'data-state')) === 'peek');
  // put the house in the upper half of the map (above the sheet)
  await page.evaluate((b) => { const m = window.__gmStub.map; m.setZoom(21); m.setCenter(b); m.panBy(0, 90); }, LL(0, 0));

  await page.tap('[data-testid=toolbar] [data-tool=facet]');
  for (const q of [P.NW, P.NE, P.RE, P.RW]) await tapLL(page, q);
  check('phone: Finish button shows while drawing', await page.locator('[data-testid=fab-finish]').isVisible());
  await page.screenshot({ path: OUT + 'phone-04-drawing.png' });
  await page.tap('[data-testid=fab-finish]');
  for (const q of [P.RW, P.RE, P.SE, P.SW]) await tapLL(page, q);
  await page.tap('[data-testid=fab-finish]');
  let p = await readAutosaved(page);
  check('phone: two facets traced with taps', p.facets.length === 2 && p.facets[1].path.length === 4);
  await page.tap('[data-testid=toolbar] [data-tool=select]');
  // tap a facet: its editor opens in the Trace tab
  const mid = rm.centroid([P.RW, P.RE, P.SE, P.SW]);
  await tapLL(page, mid);
  await page.waitForSelector('[data-testid=sheet-content] [data-testid=selection]');
  check('phone: tapping a facet opens its editor', (await txt(page, 'selection')).includes('Facet F2'));
  await page.screenshot({ path: OUT + 'phone-05-selected.png' });
  await page.selectOption('[data-testid=sheet-content] [data-testid=sel-pitch]', '4');
  p = await readAutosaved(page);
  check('phone: pitch edited to 4/12', p.facets[1].pitch === 4);
  // collapse, tap a corner, delete it with the button
  await collapse(page);
  await tapLL(page, P.SE);
  await page.waitForSelector('[data-testid=fab-delete-corner]');
  await page.screenshot({ path: OUT + 'phone-06-corner.png' });
  await page.tap('[data-testid=fab-delete-corner]');
  p = await readAutosaved(page);
  check('phone: Delete corner removes the tapped corner', p.facets[1].path.length === 3);
  // long-press a corner of F1 (select it first)
  await collapse(page);
  await tapLL(page, rm.centroid([P.NW, P.NE, P.RE, P.RW]));
  await collapse(page);
  const cdp = await ctx.newCDPSession(page);
  const nw = await pagePoint(page, P.NW);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: nw.x, y: nw.y }] });
  await page.waitForTimeout(900);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  p = await readAutosaved(page);
  check('phone: press and hold a corner deletes it', p.facets[0].path.length === 3, String(p.facets[0].path.length));

  await page.tap('[data-testid=tab-totals]');
  await page.waitForSelector('[data-testid=sheet-content] [data-testid=kpi-sqft]');
  const tt = rm.computeTotals(p);
  check('phone: totals tab = computeTotals()', (await txt(page, 'kpi-sqft')) === rm.fmt(tt.sloped));
  await page.screenshot({ path: OUT + 'phone-07-totals.png' });
  await noOverflow(page, 'phone totals');
  await page.tap('[data-testid=sheet-toggle]');
  check('phone: sheet expands to full', (await page.getAttribute('[data-testid=bottom-sheet]', 'data-state')) === 'full');
  await page.tap('[data-testid=tab-export]');
  await page.screenshot({ path: OUT + 'phone-08-report-full.png' });
  await noOverflow(page, 'phone report tab');
  await page.tap('[data-testid=btn-report]');
  await page.locator('[data-testid=report-viewer] iframe').waitFor();
  await page.frameLocator('[data-testid=report-viewer] iframe').locator('.rp-page').first().waitFor();
  await page.screenshot({ path: OUT + 'phone-09-report-viewer.png' });
  await page.tap('[data-testid=report-viewer] button:has-text("Close")');
  await page.tap('[data-testid=tab-trace]');
  await page.screenshot({ path: OUT + 'phone-10-trace-tab.png' });
  await page.tap('[data-testid=use-measurements]');
  await page.waitForSelector('[data-testid=use-saved]');
  const sb = await page.locator('[data-testid=build-estimate]').boundingBox();
  check('phone: Build estimate visible on screen after saving', sb && sb.y + sb.height < 844);
  await page.screenshot({ path: OUT + 'phone-11-use-saved.png' });
  await noOverflow(page, 'phone saved');
  await collapse(page);
  await page.screenshot({ path: OUT + 'phone-12-peek-traced.png' });
  // commercial on the phone
  await page.tap('[data-testid=mode-com]');
  await page.tap('[data-testid=tab-commercial]');
  await page.screenshot({ path: OUT + 'phone-13-commercial.png' });
  await noOverflow(page, 'phone commercial');
  await ctx.close();
}

await browser.close();
// /roof-reports still embeds the original tool in an iframe, whose commercial.js references comPrint before
// commercial_report.js defines it (a bug in the original, also noted in the engine's parity tests).
const errs = errorsAll.flat().filter((e) => !/comPrint is not defined/.test(e));
check('no page errors', errs.length === 0, errs.slice(0, 5).join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
