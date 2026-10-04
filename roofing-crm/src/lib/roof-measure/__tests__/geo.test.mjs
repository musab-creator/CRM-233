// geo.ts against reference values of Google's spherical formulas (radius 6378137 m).
// Run: node --experimental-strip-types --import ./src/lib/roof-measure/__tests__/register.mjs src/lib/roof-measure/__tests__/geo.test.mjs
import * as G from '../geo.ts';
import { check, summary } from './helpers/assert.mjs';

const R = 6378137;
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

// Independent reference: L'Huilier spherical excess of the fan triangles (Google's older computeArea implementation).
function lhuilierArea(path) {
  const ang = (a, b) => G.computeAngleBetween(a, b);
  const excess = (a, b, c) => {
    const d = [ang(a, b), ang(b, c), ang(c, a)]; const s = (d[0] + d[1] + d[2]) / 2;
    let z = Math.tan(s / 2); for (const x of d) z *= Math.tan((s - x) / 2);
    return 4 * Math.atan(Math.sqrt(Math.abs(z)));
  };
  const toV = (p) => { const la = p.lat * Math.PI / 180, lo = p.lng * Math.PI / 180; return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]; };
  const sign = (a, b, c) => { const A = toV(a), B = toV(b), C = toV(c); const det = A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0]); return det > 0 ? 1 : -1; };
  let total = 0;
  for (let i = 1; i < path.length - 1; i++) total += sign(path[0], path[i], path[i + 1]) * excess(path[0], path[i], path[i + 1]);
  return Math.abs(total) * R * R;
}

// 1. octant: exactly pi R^2 / 2
const octant = [{ lat: 0, lng: 0 }, { lat: 0, lng: 90 }, { lat: 90, lng: 0 }];
check('octant area = pi R^2 / 2', rel(G.computeArea(octant), Math.PI * R * R / 2) < 1e-12, G.computeArea(octant));
check('octant signed area is positive counter-clockwise', G.computeSignedArea(octant) > 0 && G.computeSignedArea([...octant].reverse()) < 0);

// 2. 1 deg x 1 deg box at the equator (great-circle edges)
const box = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }];
const boxRef = lhuilierArea(box);
check('1x1 degree equator box matches the spherical-excess reference (1e-9)', rel(G.computeArea(box), boxRef) < 1e-9, `${G.computeArea(box)} vs ${boxRef}`);
const latBand = R * R * (Math.PI / 180) * Math.sin(Math.PI / 180); // the top edge's great circle bulges north: slightly larger
check('1x1 degree box within 0.01% of the latitude-band area', rel(G.computeArea(box), latBand) < 1e-4 && G.computeArea(box) > latBand, `${G.computeArea(box)} vs ${latBand}`);

// 3. a ~40 ft square at Jacksonville built with computeOffset
const jax = { lat: 30.3322, lng: -81.6557 };
const side = 40 / G.FT_PER_M;
const a = jax, b = G.computeOffset(a, side, 90), c = G.computeOffset(b, side, 0), d = G.computeOffset(a, side, 0);
const sq = [a, b, c, d];
const sqft = G.computeArea(sq) * G.SQFT_PER_M2;
check('40 ft square at Jacksonville = 1600 sqft (0.01%)', Math.abs(sqft - 1600) / 1600 < 1e-4, sqft);
check('40 ft square matches the spherical-excess reference (1e-6)', rel(G.computeArea(sq), lhuilierArea(sq)) < 1e-6, `${G.computeArea(sq)} vs ${lhuilierArea(sq)}`);
check('40 ft square sides measure 40 ft', [[a, b], [b, c], [a, d]].every(([p, q]) => Math.abs(G.segFt(p, q) - 40) < 1e-6));
check('perimeter (computeLength closed) = 160 ft', Math.abs(G.computeLength([...sq, sq[0]]) * G.FT_PER_M - 160) < 0.01, G.computeLength([...sq, sq[0]]) * G.FT_PER_M);

// 4. distances and headings
check('1 degree of longitude at the equator = R pi / 180', rel(G.computeDistanceBetween({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }), R * Math.PI / 180) < 1e-12);
check('quarter meridian = R pi / 2', rel(G.computeDistanceBetween({ lat: 0, lng: 0 }, { lat: 90, lng: 0 }), R * Math.PI / 2) < 1e-12);
check('heading east = 90, north = 0', Math.abs(G.computeHeading(jax, b) - 90) < 1e-6 && Math.abs(G.computeHeading(jax, d)) < 1e-9);
const off = G.computeOffset(jax, 1234.5, 37);
check('computeOffset round trip (distance, heading)', Math.abs(G.computeDistanceBetween(jax, off) - 1234.5) < 1e-6 && Math.abs(G.computeHeading(jax, off) - 37) < 1e-6);
const mid = G.interpolate({ lat: 0, lng: 0 }, { lat: 0, lng: 90 }, 0.5);
check('interpolate halfway along the equator', Math.abs(mid.lat) < 1e-12 && Math.abs(mid.lng - 45) < 1e-12);

// 5. containsLocation
const sqC = G.centroid(sq);
check('containsLocation: centre inside', G.containsLocation(sqC, sq));
check('containsLocation: outside point', !G.containsLocation(G.computeOffset(c, 2, 45), sq));
check('containsLocation: a vertex counts as inside', G.containsLocation(sq[2], sq));
check('containsLocation: concave L shape notch is outside', (() => {
  const L = [a, G.computeOffset(a, 20, 90), G.computeOffset(G.computeOffset(a, 20, 90), 10, 0), G.computeOffset(G.computeOffset(a, 10, 90), 10, 0), G.computeOffset(G.computeOffset(a, 10, 90), 20, 0), G.computeOffset(a, 20, 0)];
  return !G.containsLocation(G.computeOffset(G.computeOffset(a, 15, 90), 15, 0), L) && G.containsLocation(G.computeOffset(G.computeOffset(a, 5, 90), 15, 0), L);
})());

// 6. the tool's planar helpers
check('pointSegM: point 5 m north of an east-west segment', Math.abs(G.pointSegM(G.computeOffset(G.computeOffset(a, 5, 90), 5, 0), a, b) - 5) < 0.02, G.pointSegM(G.computeOffset(G.computeOffset(a, 5, 90), 5, 0), a, b));
check('offsetLatLng 12 m north (flat-earth, within 1%)', Math.abs(G.computeDistanceBetween(jax, G.offsetLatLng(jax.lat, jax.lng, 12, 0)) - 12) < 0.12);
check('centroid of the square is its middle', G.computeDistanceBetween(sqC, G.computeOffset(G.computeOffset(a, side / 2, 90), side / 2, 0)) < 0.01);

summary('geo');
