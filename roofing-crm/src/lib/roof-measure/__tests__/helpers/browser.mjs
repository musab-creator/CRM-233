// Loads the ORIGINAL Roof Measure (file:///home/user/musab-creator/roof-measure/index.html) in headless
// Chromium with a google.maps stand-in whose geometry functions are geo.ts itself (transpiled), the CDN
// libraries (geotiff 2.1.3, proj4 2.11.0) served from node_modules, and Solar API requests answered by the test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(here, '../..');
const nodeModules = path.resolve(engine, '../../../node_modules');
export const TOOL_DIR = '/home/user/musab-creator/roof-measure';
export const TOOL_URL = 'file://' + TOOL_DIR + '/index.html';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// geo.ts as a plain script (same formulas the engine uses), plus minimal LatLng / MVCArray / Polygon / Polyline.
export function googleStubSource() {
  const geoTs = readFileSync(path.join(engine, 'geo.ts'), 'utf8');
  const geoJs = ts.transpileModule(geoTs, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^export \{\};?$/gm, '').replace(/^export /gm, '');
  return `(() => {
${geoJs}
class LatLng {
  constructor(a, b) { if (a && typeof a === 'object') { this._a = typeof a.lat === 'function' ? a.lat() : a.lat; this._b = typeof a.lng === 'function' ? a.lng() : a.lng; } else { this._a = a; this._b = b; } }
  lat() { return this._a; } lng() { return this._b; }
  equals(o) { return !!o && this._a === o.lat() && this._b === o.lng(); }
  toJSON() { return { lat: this._a, lng: this._b }; }
}
const lit = (p) => (typeof p.lat === 'function' ? { lat: p.lat(), lng: p.lng() } : { lat: p.lat, lng: p.lng });
const lits = (path) => (Array.isArray(path) ? path : path.getArray()).map(lit);
class MVCArray {
  constructor(a) { this.a = (a || []).map((p) => (p instanceof LatLng ? p : new LatLng(p))); }
  getArray() { return this.a; } getLength() { return this.a.length; } getAt(i) { return this.a[i]; } forEach(f) { this.a.forEach(f); }
  addListener() { return { remove() {} }; } removeAt(i) { return this.a.splice(i, 1)[0]; } setAt(i, v) { this.a[i] = new LatLng(v); } insertAt(i, v) { this.a.splice(i, 0, new LatLng(v)); } push(v) { this.a.push(new LatLng(v)); }
}
class Shape {
  constructor(o) { o = o || {}; this.p = new MVCArray(o.paths || o.path || []); }
  getPath() { return this.p; } setPath(p) { this.p = new MVCArray(Array.isArray(p) ? p : p.getArray()); }
  addListener() { return { remove() {} }; } setMap() {} getMap() { return null; } setOptions() {} setEditable() {}
}
class Inert { constructor() {} setMap() {} getMap() { return null; } addListener() { return { remove() {} }; } setPosition() {} setOptions() {} }
class LatLngBounds { constructor() { this.pts = []; } extend(p) { this.pts.push(p); return this; } getCenter() { return this.pts[0]; } }
window.google = { maps: {
  LatLng, MVCArray, Polygon: Shape, Polyline: Shape, Rectangle: Inert, Marker: Inert, LatLngBounds,
  geometry: {
    spherical: {
      computeArea: (path) => computeArea(lits(path)),
      computeSignedArea: (path) => computeSignedArea(lits(path)),
      computeLength: (path) => computeLength(lits(path)),
      computeDistanceBetween: (a, b) => computeDistanceBetween(lit(a), lit(b)),
      computeHeading: (a, b) => computeHeading(lit(a), lit(b)),
      computeOffset: (a, d, h) => new LatLng(computeOffset(lit(a), d, h)),
    },
    poly: { containsLocation: (pt, polygon) => containsLocation(lit(pt), lits(polygon.getPath())) },
  },
} };
})();`;
}

// The port itself, transpiled for the browser (served at https://engine.test/), so it can also run in the same
// JavaScript engine as the original: node's V8 and Chromium's differ in the last bit of Math.sin / cos / pow.
const ENGINE_HOST = 'https://engine.test/';
const SHIMS = {
  'shims/geotiff.js': 'export const fromArrayBuffer = (...a) => window.GeoTIFF.fromArrayBuffer(...a);',
  'shims/proj4.js': 'export default (...a) => window.proj4(...a);',
};
function engineFile(rel) {
  if (SHIMS[rel]) return SHIMS[rel];
  const src = readFileSync(path.join(engine, rel.replace(/\.js$/, '.ts')), 'utf8');
  return ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true } }).outputText
    .replace(/from '(\.{1,2}\/[^']+)'/g, (m, s) => `from '${s}.js'`)
    .replace(/from 'geotiff'/g, `from '${ENGINE_HOST}shims/geotiff.js'`)
    .replace(/from 'proj4'/g, `from '${ENGINE_HOST}shims/proj4.js'`);
}
// Imports the port into the page as window.__rm.
export async function loadEngineInPage(page) {
  await page.evaluate(async (u) => { window.__rm = await import(u); }, ENGINE_HOST + 'index.js');
}

// handlers.solar(url) -> { status, json } | { status, body: Buffer, contentType }
// handlers.local(url, request) -> response | null: requests to the tool's own origin when it is served from
// http://localhost:8765/ (the tool's desktop / local-server mode, where it uses the /relay routes); other paths
// there are the tool's files from disk.
export const LOCAL_ORIGIN = 'http://localhost:8765/';
export async function openTool(handlers = {}, { local = false } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--allow-file-access-from-files'] });
  const context = await browser.newContext({ locale: 'en-US', timezoneId: process.env.TZ || 'America/New_York' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript({ content: googleStubSource() });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file:')) return route.continue();
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.startsWith(LOCAL_ORIGIN)) {
      const r = handlers.local ? await handlers.local(url, route.request()) : null;
      if (r) return route.fulfill({ status: r.status || 200, contentType: r.contentType || 'application/json', body: r.json !== undefined ? JSON.stringify(r.json) : r.body });
      const rel = new URL(url).pathname.slice(1) || 'index.html';
      if (/^[\w.-]+$/.test(rel)) { try { return route.fulfill({ body: readFileSync(path.join(TOOL_DIR, rel)), contentType: rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.css') ? 'text/css' : 'text/html' }); } catch { /* not a tool file */ } }
      return route.fulfill({ status: 404, body: 'not found' });
    }
    if (url.startsWith('https://') && handlers.other) { const r = await handlers.other(url, route.request()); if (r) return route.fulfill({ status: r.status || 200, headers: cors, contentType: r.contentType || 'application/json', body: r.json !== undefined ? JSON.stringify(r.json) : r.body }); }
    if (url.includes('cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js')) return route.fulfill({ path: path.join(nodeModules, 'geotiff/dist-browser/geotiff.js'), contentType: 'application/javascript' });
    if (url.includes('cdnjs.cloudflare.com/ajax/libs/proj4js/2.11.0/proj4.js')) return route.fulfill({ path: path.join(nodeModules, 'proj4/dist/proj4.js'), contentType: 'application/javascript' });
    if (url.includes('fonts.googleapis.com')) return route.fulfill({ body: '', contentType: 'text/css' });
    if (url.startsWith(ENGINE_HOST)) return route.fulfill({ headers: cors, contentType: 'application/javascript', body: engineFile(url.slice(ENGINE_HOST.length)) });
    if (url.startsWith('https://solar.googleapis.com/') && handlers.solar) {
      const r = await handlers.solar(url);
      if (r.json !== undefined) return route.fulfill({ status: r.status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(r.json) });
      return route.fulfill({ status: r.status || 200, headers: cors, contentType: r.contentType || 'application/octet-stream', body: r.body });
    }
    return route.abort();
  });
  await page.goto(local ? LOCAL_ORIGIN + 'index.html' : TOOL_URL);
  await page.waitForFunction(() => typeof window.computeTotals === 'function' && typeof window.buildReportHTML === 'function' && typeof window.comAnalyse === 'function' && typeof GeoTIFF !== 'undefined' && typeof proj4 !== 'undefined');
  return { browser, page, errors };
}
