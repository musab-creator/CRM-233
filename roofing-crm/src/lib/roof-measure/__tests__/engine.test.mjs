// Node-only checks of the parts the parity tests do not cover: the CRM mapping, the model helpers, drawing
// support, Solar API helpers, address lookups and the /relay/jaxepics route.
// Run: node --experimental-strip-types --import ./src/lib/roof-measure/__tests__/register.mjs src/lib/roof-measure/__tests__/engine.test.mjs
import * as rm from '../index.ts';
import { totalsToMeasurements } from './fixtures/roof-measure-bridge.ts';
import { GET, POST } from '../../../app/relay/jaxepics/route.ts';
import { randomRoof, fakeSolar } from './helpers/roofs.mjs';
import { check, diff, summary } from './helpers/assert.mjs';

// ---------------------------------------------------------------- CRM mapping = roof-measure-bridge.ts on the same totals
let same = 0;
for (let i = 0; i < 100; i++) {
  const R = randomRoof(5000 + i);
  const p = rm.emptyProject(); p.defaultPitch = R.defaultPitch;
  for (const f of R.facets) rm.addFacet(p, f.path, f.pitch, f.name, f.flags);
  for (const e of R.edges) rm.addEdge(p, e.type, e.path, e.pitch);
  const t = rm.computeTotals(p);
  if (!diff(rm.toRoofMeasurements(t, p.defaultPitch), totalsToMeasurements(t, p.defaultPitch), 0).length) same++;
}
check('toRoofMeasurements equals the bridge mapping on 100 roofs', same === 100, same);

// ---------------------------------------------------------------- model
{
  const p = rm.emptyProject();
  const sq = (x) => [{ lat: 30.3, lng: -81.6 + x }, { lat: 30.3, lng: -81.5999 + x }, { lat: 30.3001, lng: -81.5999 + x }];
  const a = rm.addFacet(p, sq(0), 6), b = rm.addFacet(p, sq(0.001), 6, 'Porch'), c = rm.addFacet(p, sq(0.002), 6);
  rm.addEdge(p, 'eave', sq(0).slice(0, 2));
  check('facets get F<n> names and unique ids', a.name === 'F1' && c.name === 'F3' && new Set([a.id, b.id, c.id, p.edges[0].id]).size === 4);
  rm.removeItem(p, 'facet', a.id);
  check('deleting a facet renumbers auto-named facets only', p.facets.map((f) => f.name).join() === 'Porch,F2');
  let threw = false; try { rm.parseProjectJSON('{"app":"other"}'); } catch (e) { threw = /Not a Roof Measure file/.test(e.message); }
  check('importing a non Roof Measure file fails like the tool', threw);
  const back = rm.restoreProject({ app: 'roof-measure', version: 2, location: { lat: 30.1, lng: -81.2 }, facets: [{ path: sq(0), pitch: 4, excluded: 1 }], edges: [{ type: 'gutter', path: sq(0).slice(0, 2), pitch: 3 }] });
  check('restore: coordinates as address, unknown line type -> unspecified, flags coerced', back.address === '30.100000, -81.200000' && back.edges[0].type === 'unspecified' && back.edges[0].pitch === 3 && back.facets[0].excluded === true && back.facets[0].name === 'F1');
  const list = rm.parseSavedProjects(JSON.stringify({ old: { savedAt: '2024-01-01T00:00:00Z', facets: [] }, newer: { savedAt: '2025-01-01T00:00:00Z', facets: [] } }));
  check('saved roofs list newest first', list.map((x) => x.name).join() === 'newer,old');
}

// ---------------------------------------------------------------- drawing support
{
  const toPixel = (q) => ({ x: (q.lng + 81.6) * 1e6, y: (30.3 - q.lat) * 1e6 }); // 1 px = 1e-6 degree
  const verts = [{ lat: 30.3, lng: -81.6 }, { lat: 30.30002, lng: -81.59998 }];
  const near = rm.snapToVertex({ lat: 30.300005, lng: -81.599995 }, verts, toPixel);
  const far = { lat: 30.30005, lng: -81.59995 };
  check('snapToVertex: snaps within 12 px, keeps the point otherwise', near === verts[0] && rm.snapToVertex(far, verts, toPixel) === far);
  const pts = [verts[0], { lat: 30.3, lng: -81.5999 }, { lat: 30.3001, lng: -81.5999 }];
  check('draftClickAction: close on first point, ignore double-click, add otherwise', rm.draftClickAction('facet', pts, verts[0], toPixel) === 'finish' && rm.draftClickAction('facet', pts, { lat: 30.3001, lng: -81.599899 }, toPixel) === 'ignore' && rm.draftClickAction('eave', pts, verts[0], toPixel) === 'add');
  const dl = rm.draftLabels('facet', pts, { lat: 30.30005, lng: -81.6 }, 6);
  check('draftLabels: rubber band, 2 segments, facet area', dl.length === 4 && dl[3].cls === 'facet' && /sf plan/.test(dl[3].html));
  check('drawingHint', rm.drawingHint('facet', pts, true).startsWith('Facet: 3 points') && rm.drawingHint('select', null, false).startsWith('Enter an address'));
  check('TOOL_KEYS', rm.TOOL_KEYS.t === 'step' && rm.TOOL_KEYS.p === 'parapet');
}

// ---------------------------------------------------------------- Solar API helpers
{
  const main = fakeSolar(1, { lat: 30.3, lng: -81.6 });
  const s = rm.solarSummaryOf(main);
  check('solarSummaryOf: planes largest first, sqft, date', s.segs.every((g, i) => !i || s.segs[i - 1].area >= g.area) && Math.abs(s.total - main.solarPotential.wholeRoofStats.areaMeters2 * rm.SQFT_PER_M2) < 1e-9 && /^2024-\d\d-\d\d$/.test(s.imageryDate));
  check('24 scan probes', rm.scanProbePoints({ lat: 30.3, lng: -81.6 }).length === 24);
  const seen = [];
  const found = await rm.scanStructures({ lat: 30.3, lng: -81.6 }, main.name, async (lat, lng) => {
    seen.push([lat, lng]);
    if (seen.length % 5 === 0) throw new rm.SolarApiError('No Solar API coverage', 404);
    return seen.length % 3 === 0 ? { name: 'buildings/shed' } : seen.length % 4 === 0 ? { name: 'buildings/garage' } : { name: main.name };
  });
  check('scanStructures: other buildings once each, main and failures skipped', seen.length === 24 && found.map((b) => b.name).sort().join() === 'buildings/garage,buildings/shed');
  const urls = [];
  const fake = async (url) => { urls.push(url); return new Response(JSON.stringify({ error: { message: 'Denied' } }), { status: 403 }); };
  let msg = ''; try { await rm.fetchBuildingInsights(30.3, -81.6, 'K&Y', fake); } catch (e) { msg = e.message + ' ' + e.status; }
  check('fetchBuildingInsights: key in the URL, API error message', urls[0].includes('buildingInsights:findClosest?location.latitude=30.3&location.longitude=-81.6&requiredQuality=LOW&key=K%26Y') && msg === 'Denied 403', msg);
  check('autoTraceRadius', rm.autoTraceRadius(main) >= 15 && rm.autoTraceRadius(main) <= 100);
}

// ---------------------------------------------------------------- address lookups
{
  check('parseLatLngInput', JSON.stringify(rm.parseLatLngInput(' 30.5, -81.25 ')) === '{"lat":30.5,"lng":-81.25}' && rm.parseLatLngInput('30.5 N') === null);
  check('wantsSuggestions', rm.wantsSuggestions('12 M') && !rm.wantsSuggestions('12') && !rm.wantsSuggestions('30.1, -81.2'));
  const results = [
    { formatted_address: 'route', types: ['route'], geometry: { location: { lat: 1, lng: 2 } } },
    { formatted_address: 'interp', types: ['street_address'], geometry: { location_type: 'RANGE_INTERPOLATED', location: { lat: 1, lng: 2 } } },
    { formatted_address: 'premise', types: ['premise'], geometry: { location: { lat: 1, lng: 2 } } },
  ];
  check('pickReverseAddress: premise before an interpolated address', rm.pickReverseAddress(results) === 'premise');
  check('pickReverseAddress: rooftop street address first', rm.pickReverseAddress([...results, { formatted_address: 'roof', types: ['street_address'], geometry: { location_type: 'ROOFTOP', location: { lat: 1, lng: 2 } } }]) === 'roof');
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('places:autocomplete')) return new Response('{}', { status: 403 });
    if (String(url).includes('/suggest?')) return new Response(JSON.stringify({ suggestions: [{ text: '1 Main St, Jacksonville, FL', magicKey: 'mk' }] }));
    if (String(url).includes('findAddressCandidates')) return new Response(JSON.stringify({ candidates: [{ address: '1 MAIN ST', location: { x: -81.6, y: 30.3 } }] }));
    return new Response('{}', { status: 404 });
  };
  const sug = await rm.suggestAddresses('1 Main', { apiKey: 'k', near: { lat: 30.3, lng: -81.6 }, fetch: fake });
  check('suggestAddresses: Places refused -> Esri suggestions near the map', sug.source === 'esri' && sug.items[0].magicKey === 'mk' && calls[1].url.includes('location=-81.6%2C30.3'), JSON.stringify(sug));
  check('Places request: key header, US only, 50 km bias', calls[0].init.headers['X-Goog-Api-Key'] === 'k' && JSON.parse(calls[0].init.body).locationBias.circle.radius === 50000);
  const place = await rm.resolveSuggestion(sug.items[0], { fetch: fake });
  check('resolveSuggestion (Esri)', place && place.address === '1 MAIN ST' && place.location.lat === 30.3);
  const g = await rm.geocodeAddress('30.25, -81.5', 'k', fake);
  check('geocodeAddress: coordinates as typed', g.location.lat === 30.25 && g.address === '30.25, -81.5');
}

// ---------------------------------------------------------------- /relay/jaxepics
{
  const realFetch = globalThis.fetch;
  const upstream = [];
  globalThis.fetch = async (url, init) => { upstream.push({ url: String(url), init }); if (String(url).includes('fail')) return new Response('x', { status: 500 }); return new Response('{"values":[]}'); };
  try {
    const cols = await GET(new Request('http://crm.test/relay/jaxepics?op=columns'));
    check('relay: columns -> fixed upstream GET', cols.status === 200 && upstream[0].url === 'https://jaxepicsapi.coj.net/api/AdvancedSearches/GetColumns/82');
    const adv = await POST(new Request('http://crm.test/relay/jaxepics?op=advanced', { method: 'POST', body: '{"TableId":82}' }));
    check('relay: advanced search -> fixed upstream POST with the body', adv.status === 200 && upstream[1].url.startsWith('https://jaxepicsapi.coj.net/api/AdvancedSearches/Advanced?page=1&pageSize=500') && upstream[1].init.body === '{"TableId":82}' && upstream[1].init.method === 'POST');
    const addr = await POST(new Request('http://crm.test/relay/jaxepics?op=address&page=2&term=' + encodeURIComponent('100 N MAIN ST'), { method: 'POST', body: '{}' }));
    check('relay: address search page and term', addr.status === 200 && upstream[2].url.endsWith('page=2&pageSize=100&filter=&sortActive=Title&sortDirection=desc&forSpreadSheet=false&SearchTerm=100%20N%20MAIN%20ST'));
    const n = upstream.length;
    const bad = [
      await GET(new Request('http://crm.test/relay/jaxepics?op=advanced')),
      await POST(new Request('http://crm.test/relay/jaxepics?op=other', { method: 'POST', body: '{}' })),
      await POST(new Request('http://crm.test/relay/jaxepics?op=address&page=9&term=x', { method: 'POST', body: '{}' })),
      await POST(new Request('http://crm.test/relay/jaxepics?op=advanced', { method: 'POST', body: 'x'.repeat(20001) })),
      await POST(new Request('http://crm.test/relay/jaxepics?op=advanced', { method: 'POST', body: 'not json' })),
    ];
    check('relay: bad requests -> 502 without calling upstream', bad.every((r) => r.status === 502) && upstream.length === n);
    globalThis.fetch = async () => new Response('x', { status: 500 });
    const down = await GET(new Request('http://crm.test/relay/jaxepics?op=columns'));
    check('relay: upstream failure -> 502 {"error":"relay failed"}', down.status === 502 && (await down.json()).error === 'relay failed');
  } finally { globalThis.fetch = realFetch; }
}

summary('engine');
