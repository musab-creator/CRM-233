// Playwright harness for the Roof Measure page: a browser context with the Google Maps stand-in (gmaps-stub.js,
// geometry from the engine's geo.ts), a test API key, and every outside service answered locally: the Solar API
// from the engine tests' synthetic scenes (GeoTIFF mask + height model), Static Maps (a PNG), Esri suggestions,
// the Florida parcel roll (permits). Nothing reaches the network.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { residentialScenes, commercialScene, pickBuildingSource } from '../../../lib/roof-measure/__tests__/helpers/scenes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.resolve(here, '../../../lib/roof-measure');
export const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const BASE = process.env.BASE || 'http://localhost:3203';

export const scenes = residentialScenes();
export const comScene = commercialScene();
const pick = (0, eval)(pickBuildingSource());
const sceneData = scenes.map((s) => ({ name: s.name, main: s.main, sheds: s.sheds }));
const tiffs = new Map([...scenes.flatMap((s) => [[s.id + '-mask', s.mask], [s.id + '-dsm', s.dsm]]), ['commercial-mask', comScene.mask], ['commercial-dsm', comScene.dsm]]);

function geoSource() {
  const src = readFileSync(path.join(engineDir, 'geo.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^export \{\};?$/gm, '').replace(/^export /gm, '');
  const names = [...js.matchAll(/^(?:function|const|let)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
  return `(() => { ${js}\n window.__geo = { ${names.join(', ')} }; })();`;
}

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function solar(url) {
  const u = new URL(url);
  const lat = +u.searchParams.get('location.latitude'), lng = +u.searchParams.get('location.longitude');
  const nearCom = Math.hypot(lat - comScene.bi.center.latitude, lng - comScene.bi.center.longitude) < 0.002;
  if (u.pathname.includes('buildingInsights')) return { json: nearCom ? comScene.bi : pick(sceneData, lat, lng) };
  if (u.pathname.includes('dataLayers')) {
    if (nearCom) return { json: { imageryDate: comScene.bi.imageryDate, imageryQuality: 'HIGH', maskUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=commercial-mask', dsmUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=commercial-dsm' } };
    const s = scenes.find((x) => x.main === pick(sceneData, lat, lng)) || scenes[0];
    return { json: { imageryDate: s.main.imageryDate, imageryQuality: 'HIGH', maskUrl: `https://solar.googleapis.com/v1/geoTiff:get?id=${s.id}-mask`, dsmUrl: `https://solar.googleapis.com/v1/geoTiff:get?id=${s.id}-dsm` } };
  }
  const id = u.searchParams.get('id');
  return tiffs.has(id) ? { body: tiffs.get(id), contentType: 'image/tiff' } : { status: 404, json: { error: { message: 'not found' } } };
}

export const counters = { solar: 0, staticmap: 0, esri: 0, parcel: 0 };

export async function launch() {
  return chromium.launch({ executablePath: CHROME });
}

// opts: { stub: { defaultLocation, forwardAddress, reverseAddress }, mobile: bool, viewport }
export async function newContext(browser, opts = {}) {
  const mobile = !!opts.mobile;
  const context = await browser.newContext({
    viewport: opts.viewport || (mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }),
    deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : undefined,
    locale: 'en-US', timezoneId: 'America/New_York', acceptDownloads: true,
  });
  const stubConf = { defaultLocation: { lat: scenes[0].main.center.latitude, lng: scenes[0].main.center.longitude }, ...(opts.stub || {}) };
  await context.addInitScript({ content: `window.__gmStub = ${JSON.stringify(stubConf)};` });
  await context.addInitScript({ content: geoSource() });
  await context.addInitScript({ path: path.join(here, 'gmaps-stub.js') });
  await context.addInitScript({ content: `try { if (window.top === window && !localStorage.getItem('rm.key')) localStorage.setItem('rm.key', 'test-key'); } catch (e) {}
    window.print = () => { try { window.top.__printed = (window.top.__printed || 0) + 1; } catch (e) {} };` });
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.startsWith(BASE)) return route.continue();
    if (url.startsWith('https://solar.googleapis.com/')) {
      counters.solar++;
      const r = solar(url);
      if (r.json !== undefined) return route.fulfill({ status: r.status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(r.json) });
      return route.fulfill({ status: 200, headers: cors, contentType: r.contentType, body: r.body });
    }
    if (url.startsWith('https://maps.googleapis.com/maps/api/staticmap')) { counters.staticmap++; return route.fulfill({ status: 200, headers: cors, contentType: 'image/png', body: PNG }); }
    if (url.startsWith('https://places.googleapis.com/')) return route.fulfill({ status: 403, headers: cors, contentType: 'application/json', body: '{"error":{"message":"Places API (New) not enabled"}}' });
    if (url.includes('geocode.arcgis.com') && url.includes('/suggest')) {
      counters.esri++;
      return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ suggestions: [{ text: '1234 Gable Ct, Jacksonville, FL, 32207, USA', magicKey: 'k1' }, { text: '1236 Gable Ct, Jacksonville, FL, 32207, USA', magicKey: 'k2' }] }) });
    }
    if (url.includes('geocode.arcgis.com') && url.includes('findAddressCandidates')) {
      const c = scenes[0].main.center;
      return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ candidates: [{ address: '1234 Gable Ct, Jacksonville, Florida, 32207', location: { x: c.longitude, y: c.latitude } }] }) });
    }
    if (url.includes('Florida_Statewide_Cadastral')) {
      counters.parcel++;
      return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ features: [{ attributes: { CO_NO: 65, PARCEL_ID: '123456-0000', PHY_ADDR1: '1234 GABLE CT', PHY_CITY: 'ST AUGUSTINE', PHY_ZIPCD: '32080', ACT_YR_BLT: 2005, EFF_YR_BLT: 2006, DOR_UC: '0100', NO_BULDNG: 1, TOT_LVG_AR: 2100 } }] }) });
    }
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.abort();
  });
  return context;
}

export async function openPage(context, query = '') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/roof-measure' + query);
  await page.waitForSelector('[data-testid=map] .gm-style', { timeout: 30000 });
  return { page, errors };
}

// Pixel on the page of a lat/lng, through the stub map's projection.
export async function pagePoint(page, ll) {
  return page.evaluate((q) => {
    const m = window.__gmStub.map; const p = m.toPixel(q); const r = m.el.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, ll);
}
