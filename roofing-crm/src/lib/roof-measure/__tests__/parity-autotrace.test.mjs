// Auto-trace parity with the ORIGINAL tool (autotrace.js + autotrace2.js in headless Chromium). Synthetic scenes
// (a gable, a rotated hip roof, an L-shaped house with a shed) are written as UTM GeoTIFFs and served as the
// Solar API's data layers; the original's autoTraceRoof() and the port's loadAutoTraceLayers() + autoTraceRoof()
// + applyAutoTrace() read the same bytes. Both the height-model trace (v2) and the Solar-plane trace (v1) are
// compared: facets (corners, pitch, azimuth, names), lines (type, path), outbuildings and the resulting totals.
// Run: TZ=America/New_York node --experimental-strip-types --import ./src/lib/roof-measure/__tests__/register.mjs src/lib/roof-measure/__tests__/parity-autotrace.test.mjs
import * as rm from '../index.ts';
import { loadEngineInPage, openTool } from './helpers/browser.mjs';
import { residentialScenes, pickBuildingSource } from './helpers/scenes.mjs';
import { snapshotTotals } from './helpers/roofs.mjs';
import { check, diff, countLeaves, summary } from './helpers/assert.mjs';

const scenes = residentialScenes();
const sceneData = scenes.map((s) => ({ name: s.name, main: s.main, sheds: s.sheds }));
const pick = (0, eval)(pickBuildingSource());
const tiffs = new Map(scenes.flatMap((s) => [[s.id + '-mask', s.mask], [s.id + '-dsm', s.dsm]]));

function solar(url) {
  const u = new URL(url);
  const lat = +u.searchParams.get('location.latitude'), lng = +u.searchParams.get('location.longitude');
  if (u.pathname.includes('buildingInsights')) return { json: pick(sceneData, lat, lng) };
  if (u.pathname.includes('dataLayers')) {
    const s = scenes.find((x) => x.main === pick(sceneData, lat, lng)) || scenes[0];
    return { json: { imageryDate: s.main.imageryDate, imageryQuality: 'HIGH', maskUrl: `https://solar.googleapis.com/v1/geoTiff:get?id=${s.id}-mask`, dsmUrl: `https://solar.googleapis.com/v1/geoTiff:get?id=${s.id}-dsm` } };
  }
  const id = u.searchParams.get('id');
  return tiffs.has(id) ? { body: tiffs.get(id), contentType: 'image/tiff' } : { status: 404, json: { error: { message: 'not found' } } };
}
const nodeFetch = async (url) => { const r = solar(url); return new Response(r.json !== undefined ? JSON.stringify(r.json) : r.body, { status: r.status || 200 }); };

// The port's side, as source so it runs unchanged in node and in the page.
async function portTrace(rm, scene, v1, fetchImpl, pick, scenes, snapshot) {
  const layers = await rm.loadAutoTraceLayers(scene.main, '', fetchImpl);
  const res = await rm.autoTraceRoof({ building: scene.main, mask: layers.mask, dsm: layers.dsm, fetchBuilding: async (lat, lng) => pick(scenes, lat, lng), v1, defaultPitch: 6 });
  const p = rm.emptyProject(); p.defaultPitch = 6; p.waste = 10;
  const info = rm.applyAutoTrace(p, res);
  return {
    info: { ...info, radius: layers.radius },
    facets: p.facets.map((f) => ({ name: f.name, pitch: f.pitch, azimuth: f.azimuth, path: f.path })),
    edges: p.edges.map((e) => ({ type: e.type, pitch: e.pitch, path: e.path })),
    others: p.otherSolar.map((o) => o.name), totals: snapshot(rm.computeTotals(p), p.facets, p.edges),
  };
}

const { browser, page } = await openTool({ solar: async (url) => solar(url) });
try {
  await loadEngineInPage(page);
  const orig = await page.evaluate(async ({ scenes, snapSrc }) => {
    const snapshot = (0, eval)('(' + snapSrc + ')');
    const out = [];
    for (const s of scenes) for (const v1 of [false, true]) {
      state.facets = []; state.edges = []; state.solar = s.main; state.otherSolar = []; state.defaultPitch = 6; state.waste = 10;
      const info = await autoTraceRoof({ quiet: true, v1 });
      out.push({
        info: { structures: info.structures, facets: info.facets, edges: info.edges, mainSqft: info.mainSqft, unassignedPct: info.unassignedPct, planes: info.planes, datum: info.datum, size: info.size, radius: info.radius },
        facets: state.facets.map((f) => ({ name: f.name, pitch: f.pitch, azimuth: f.azimuth, path: pathToLiteral(f.shape) })),
        edges: state.edges.map((e) => ({ type: e.type, pitch: e.pitch, path: pathToLiteral(e.shape) })),
        others: state.otherSolar.map((o) => o.name), totals: snapshot(computeTotals(), state.facets, state.edges),
      });
    }
    return out;
  }, { scenes: sceneData, snapSrc: snapshotTotals.toString() });
  const inPage = await page.evaluate(async ({ scenes, src, pickSrc, snapSrc }) => {
    const run = (0, eval)('(' + src + ')'), pick = (0, eval)(pickSrc), snapshot = (0, eval)('(' + snapSrc + ')');
    const out = [];
    for (const s of scenes) for (const v1 of [false, true]) out.push(await run(window.__rm, s, v1, (...a) => fetch(...a), pick, scenes, snapshot));
    return out;
  }, { scenes: sceneData, src: portTrace.toString(), pickSrc: pickBuildingSource(), snapSrc: snapshotTotals.toString() });

  let k = 0, values = 0;
  for (const s of scenes) for (const v1 of [false, true]) {
    const o = orig[k], label = `${s.name} (${v1 ? 'v1 Solar planes' : 'v2 height model'})`;
    values += countLeaves(o);
    const dPage = diff(inPage[k], o, 0);
    check(`${label}: port in Chromium bit-identical`, !dPage.length, dPage.slice(0, 6).join('; '));
    const mine = await portTrace(rm, sceneData.find((x) => x.name === s.name), v1, nodeFetch, pick, sceneData, snapshotTotals);
    const dNode = diff(mine, o, 1e-9);
    check(`${label}: port in node within 1e-9`, !dNode.length, dNode.slice(0, 6).join('; '));
    const bt = o.totals.byType;
    console.log(`  ${label}: ${o.info.structures} structure(s), ${o.facets.length} facets, ${o.edges.length} lines (${Object.entries(bt).filter(([, v]) => v.count).map(([t, v]) => `${v.count} ${t}`).join(', ')}), ${Math.round(o.totals.sloped)} sqft, pitch ${o.totals.predominant}/12${o.others.length ? ', outbuildings ' + o.others.join(' ') : ''} -> page ${dPage.length ? 'DIFF' : 'identical'}, node ${dNode.length ? 'DIFF' : 'identical'}`);
    check(`${label}: traced something`, o.facets.length > 0 && o.edges.length > 0);
    k++;
  }
  console.log(`auto-trace parity: ${k} traces, ${values} compared values each`);
  // sanity of the synthetic scenes themselves (the original's own answers)
  const gable = orig[0], hip = orig[2], lh = orig[4];
  check('gable: 2 facets at 6/12 with a ridge', gable.facets.length === 2 && gable.facets.every((f) => f.pitch === 6) && gable.totals.byType.ridge.count === 1, JSON.stringify(gable.facets.map((f) => f.pitch)));
  check('hip: 4 facets with 4 hips and a ridge', hip.facets.length === 4 && hip.totals.byType.hip.count === 4 && hip.totals.byType.ridge.count === 1, JSON.stringify(hip.totals.byType));
  check('L-shaped house: valleys found and the shed traced as a second structure', lh.totals.byType.valley.count >= 1 && lh.info.structures === 2 && lh.others.includes('buildings/lshed'), JSON.stringify({ v: lh.totals.byType.valley.count, s: lh.info.structures, o: lh.others }));
} finally {
  await browser.close();
}
summary('parity-autotrace');
