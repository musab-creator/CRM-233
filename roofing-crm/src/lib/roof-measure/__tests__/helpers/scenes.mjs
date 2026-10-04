// Synthetic Solar API scenes: a roof mask and a 10 cm height model (DSM) as UTM GeoTIFFs, plus the
// buildingInsights responses Google would return for the buildings in them.
import proj4 from 'proj4';
import { writeGeoTiff } from './tiff.mjs';
import { rng } from './roofs.mjs';

const UTM17 = '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs';
const EPSG = 32617;
const DATUM = 25; // DSM heights sit 25 m above the plane heights in buildingInsights (ellipsoid vs sea level)
const toLL = (E, N) => { const p = proj4(UTM17, 'EPSG:4326', [E, N]); return { lat: p[1], lng: p[0] }; };
const deg = (r) => r * 180 / Math.PI;

// A roof part in its own frame: a along the length (rotated rot degrees from east), b across.
function part(kind, cu, cv, W, D, slope, eave, rotDeg) {
  const r = rotDeg * Math.PI / 180, ax = [Math.cos(r), Math.sin(r)], bx = [-Math.sin(r), Math.cos(r)];
  const frame = (u, v) => { const du = u - cu, dv = v - cv; return [du * ax[0] + dv * ax[1], du * bx[0] + dv * bx[1]]; };
  const inside = (u, v) => { const [a, b] = frame(u, v); return Math.abs(a) <= W / 2 && Math.abs(b) <= D / 2; };
  const z = (u, v) => {
    const [a, b] = frame(u, v);
    if (kind === 'gable') return eave + slope * (D / 2 - Math.abs(b));
    if (kind === 'hip') return eave + slope * Math.min(W / 2 - Math.abs(a), D / 2 - Math.abs(b));
    if (kind === 'shed') return eave + slope * (b + D / 2);
    return eave;
  };
  const world = (a, b) => [cu + a * ax[0] + b * bx[0], cv + a * ax[1] + b * bx[1]];
  // planes as the Solar API describes them: centre, down-slope azimuth, pitch, height at centre, box, ground area
  const plane = (ca, cb, downA, downB, area, corners) => ({ ca, cb, down: [downA * ax[0] + downB * bx[0], downA * ax[1] + downB * bx[1]], area, corners });
  let planes = [];
  if (kind === 'gable') planes = [plane(0, D / 4, 0, 1, W * D / 2, [[-W / 2, 0], [W / 2, D / 2]]), plane(0, -D / 4, 0, -1, W * D / 2, [[-W / 2, -D / 2], [W / 2, 0]])];
  if (kind === 'hip') planes = [plane(0, D / 3, 0, 1, W * D / 4, [[-W / 2, 0], [W / 2, D / 2]]), plane(0, -D / 3, 0, -1, W * D / 4, [[-W / 2, -D / 2], [W / 2, 0]]), plane(W / 2 - D / 6, 0, 1, 0, W * D / 4, [[W / 2 - D / 2, -D / 2], [W / 2, D / 2]]), plane(-W / 2 + D / 6, 0, -1, 0, W * D / 4, [[-W / 2, -D / 2], [-W / 2 + D / 2, D / 2]])];
  if (kind === 'shed') planes = [plane(0, 0, 0, -1, W * D, [[-W / 2, -D / 2], [W / 2, D / 2]])];
  if (kind === 'flat') planes = [{ ...plane(0, 0, 0, -1, W * D, [[-W / 2, -D / 2], [W / 2, D / 2]]), flat: true }];
  return { inside, z, world, planes, slope, corners: [world(-W / 2, -D / 2), world(W / 2, -D / 2), world(W / 2, D / 2), world(-W / 2, D / 2)] };
}

function insights(name, cE, cN, parts, date) {
  const segs = [];
  for (const p of parts) for (const pl of p.planes) {
    const [cu, cv] = p.world(pl.ca, pl.cb); const c = toLL(cE + cu, cN + cv);
    const cs = pl.corners.map(([a, b]) => p.world(a, b)); const box = [[Math.min(...cs.map((q) => q[0])), Math.min(...cs.map((q) => q[1]))], [Math.max(...cs.map((q) => q[0])), Math.max(...cs.map((q) => q[1]))]];
    const sw = toLL(cE + box[0][0], cN + box[0][1]), ne = toLL(cE + box[1][0], cN + box[1][1]);
    const slope = pl.flat ? 0 : p.slope;
    segs.push({ pitchDegrees: deg(Math.atan(slope)), azimuthDegrees: (deg(Math.atan2(pl.down[0], pl.down[1])) + 360) % 360, stats: { areaMeters2: pl.area * Math.sqrt(1 + slope * slope), groundAreaMeters2: pl.area }, center: { latitude: c.lat, longitude: c.lng }, boundingBox: { sw: { latitude: sw.lat, longitude: sw.lng }, ne: { latitude: ne.lat, longitude: ne.lng } }, planeHeightAtCenterMeters: p.z(cu, cv) });
  }
  const all = parts.flatMap((p) => p.corners);
  const sw = toLL(cE + Math.min(...all.map((q) => q[0])), cN + Math.min(...all.map((q) => q[1]))), ne = toLL(cE + Math.max(...all.map((q) => q[0])), cN + Math.max(...all.map((q) => q[1])));
  const c = toLL(cE + (Math.min(...all.map((q) => q[0])) + Math.max(...all.map((q) => q[0]))) / 2, cN + (Math.min(...all.map((q) => q[1])) + Math.max(...all.map((q) => q[1]))) / 2);
  return {
    name, center: { latitude: c.lat, longitude: c.lng }, imageryDate: date, imageryQuality: 'HIGH',
    boundingBox: { sw: { latitude: sw.lat, longitude: sw.lng }, ne: { latitude: ne.lat, longitude: ne.lng } },
    solarPotential: { wholeRoofStats: { areaMeters2: segs.reduce((s, x) => s + x.stats.areaMeters2, 0), groundAreaMeters2: segs.reduce((s, x) => s + x.stats.groundAreaMeters2, 0) }, roofSegmentStats: segs },
  };
}

// Rasterises a scene: mask (uint8) and DSM (float32) around a UTM centre, half-size `half` m at 0.1 m pixels.
function rasterise(id, cE, cN, half, buildings, extraZ, seed) {
  const px = 0.1, w = Math.round(2 * half / px), h = w; const r = rng(seed);
  const mask = new Uint8Array(w * h), dsm = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = -half + (x + 0.5) * px, v = half - (y + 0.5) * px; const i = y * w + x;
    let z = null;
    for (const b of buildings) for (const p of b) if (p.inside(u, v)) { const zz = p.z(u, v); if (z == null || zz > z) z = zz; }
    const ex = extraZ ? extraZ(u, v, z) : null;
    if (ex && ex.mask != null) { mask[i] = ex.mask; z = ex.z; }
    else mask[i] = z != null ? 1 : 0;
    dsm[i] = DATUM + (z != null ? z + (r() - 0.5) * 0.01 : 2 + (r() - 0.5) * 0.04);
  }
  const originE = cE - half, originN = cN + half;
  return { id, w, h, mask: writeGeoTiff({ width: w, height: h, data: mask, float: false, originE, originN, px, epsg: EPSG }), dsm: writeGeoTiff({ width: w, height: h, data: dsm, float: true, originE, originN, px, epsg: EPSG }) };
}

export function residentialScenes() {
  const date = { year: 2024, month: 3, day: 9 };
  const scenes = [];
  {
    const cE = 435000, cN = 3356000; const main = [part('gable', 0, 0, 12, 9, 0.5, 5, 0)];
    scenes.push({ name: 'gable', cE, cN, main: insights('buildings/gable', cE, cN, main, date), sheds: [], ...rasterise('gable', cE, cN, 16, [main], null, 11) });
  }
  {
    const cE = 436000, cN = 3356000; const main = [part('hip', 0, 0, 14, 10, 7 / 12, 5, 20)];
    scenes.push({ name: 'hip (rotated 20 deg)', cE, cN, main: insights('buildings/hip', cE, cN, main, date), sheds: [], ...rasterise('hip', cE, cN, 17, [main], null, 12) });
  }
  {
    const cE = 437000, cN = 3356000;
    const main = [part('gable', -3, 0, 14, 8, 0.5, 5, 0), part('gable', 2, -6, 12, 8, 0.5, 5, 90)];
    const shed = [part('shed', 13, 9, 4, 3, 0.25, 2.5, 0)];
    scenes.push({ name: 'L-shaped house + shed', cE, cN, main: insights('buildings/lhouse', cE, cN, main, date), sheds: [{ c: [13, 9], resp: insights('buildings/lshed', cE, cN, shed, date) }], ...rasterise('lhouse', cE, cN, 24, [main, shed], null, 13) });
  }
  return scenes;
}

// A commercial building: 50 x 30 m low-slope roof with parapets, a higher section, rooftop units, a vent and a courtyard.
export function commercialScene() {
  const cE = 438000, cN = 3356000, half = 40;
  const roof = (u, v) => {
    if (Math.abs(u) > 25 || Math.abs(v) > 15) return null;
    if (u > -14 && u < -6 && v > -3 && v < 5) return { court: true };
    const edge = Math.min(25 - Math.abs(u), 15 - Math.abs(v));
    let z = 8 + 0.01 * (v + 15);
    if (u > 12) z = 10 + 0.01 * (v + 15);
    if (edge < 0.3) return { z: z + 0.9 };
    for (const [x0, y0, x1, y1, hh] of [[-2, -8, 0, -6.5, 1.2], [4, 4, 6, 5.5, 1.3], [-20, 6, -18.2, 7.4, 1.1]]) if (u >= x0 && u <= x1 && v >= y0 && v <= y1) return { z: z + hh };
    if (u >= 8 && u <= 8.4 && v >= -10 && v <= -9.6) return { z: z + 0.6 };
    return { z };
  };
  const extraZ = (u, v) => { const r = roof(u, v); if (!r || r.court) return { mask: 0, z: null }; return { mask: 1, z: r.z }; };
  const ras = rasterise('commercial', cE, cN, half, [], extraZ, 21);
  const sw = toLL(cE - 25, cN - 15), ne = toLL(cE + 25, cN + 15), c = toLL(cE, cN);
  const bi = { name: 'buildings/commercial', center: { latitude: c.lat, longitude: c.lng }, imageryDate: { year: 2023, month: 11, day: 2 }, imageryQuality: 'HIGH', boundingBox: { sw: { latitude: sw.lat, longitude: sw.lng }, ne: { latitude: ne.lat, longitude: ne.lng } }, solarPotential: { wholeRoofStats: { areaMeters2: 1400, groundAreaMeters2: 1400 }, roofSegmentStats: [] } };
  return { name: 'commercial', cE, cN, bi, target: { lat: c.lat + 0.00002, lng: c.lng - 0.00003 }, ...ras };
}

// The buildingInsights lookup the scenes answer (same rule in the browser route, the page and node).
export function pickBuildingSource() {
  return `(scenes, lat, lng) => {
    for (const s of scenes) for (const sh of s.sheds) {
      const c = sh.resp.center; const dE = (lng - c.longitude) * 111320 * Math.cos(c.latitude * Math.PI / 180), dN = (lat - c.latitude) * 110540;
      if (Math.hypot(dE, dN) < 6) return sh.resp;
    }
    let best = null, bd = Infinity;
    for (const s of scenes) { const c = s.main.center; const d = Math.hypot(lat - c.latitude, lng - c.longitude); if (d < bd) { bd = d; best = s.main; } }
    return best;
  }`;
}
