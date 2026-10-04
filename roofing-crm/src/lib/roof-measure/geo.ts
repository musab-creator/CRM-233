// Spherical geometry for Roof Measure, matching the formulas of Google Maps'
// geometry library (google.maps.geometry.spherical / .poly) so areas and
// lengths come out the same as in the original tool, plus the tool's own
// small planar helpers (pointSegM, centroid, ...). Points are plain {lat, lng}.

export interface LatLng {
  lat: number;
  lng: number;
}

export const EARTH_RADIUS_M = 6378137;
export const SQFT_PER_M2 = 10.7639104;
export const FT_PER_M = 3.28084;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;
const mod = (x: number, m: number) => ((x % m) + m) % m;
const wrap = (n: number, min: number, max: number) => (n >= min && n < max ? n : mod(n - min, max - min) + min);

// ------------------------------------------------------------------ google.maps.geometry.spherical

// Central angle between two points (haversine), in radians.
export function computeAngleBetween(from: LatLng, to: LatLng): number {
  const lat1 = toRad(from.lat), lat2 = toRad(to.lat);
  const dLat = lat1 - lat2, dLng = toRad(from.lng) - toRad(to.lng);
  return 2 * Math.asin(Math.sqrt(Math.pow(Math.sin(dLat / 2), 2) + Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dLng / 2), 2)));
}

export function computeDistanceBetween(from: LatLng, to: LatLng, radius = EARTH_RADIUS_M): number {
  return computeAngleBetween(from, to) * radius;
}

export function computeLength(path: LatLng[], radius = EARTH_RADIUS_M): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += computeDistanceBetween(path[i - 1], path[i], radius);
  return total;
}

// Signed area of the triangle (north pole, p1, p2) on the unit sphere, from tan((pi/2 - lat)/2).
function polarTriangleArea(tan1: number, lng1: number, tan2: number, lng2: number): number {
  const deltaLng = lng1 - lng2;
  const t = tan1 * tan2;
  return 2 * Math.atan2(t * Math.sin(deltaLng), 1 + t * Math.cos(deltaLng));
}

// Signed area of a closed path (counter-clockwise positive), square metres.
export function computeSignedArea(path: LatLng[], radius = EARTH_RADIUS_M): number {
  const size = path.length;
  if (size < 3) return 0;
  let total = 0;
  const prev = path[size - 1];
  let prevTanLat = Math.tan((Math.PI / 2 - toRad(prev.lat)) / 2);
  let prevLng = toRad(prev.lng);
  for (const point of path) {
    const tanLat = Math.tan((Math.PI / 2 - toRad(point.lat)) / 2);
    const lng = toRad(point.lng);
    total += polarTriangleArea(tanLat, lng, prevTanLat, prevLng);
    prevTanLat = tanLat;
    prevLng = lng;
  }
  return total * (radius * radius);
}

export function computeArea(path: LatLng[], radius = EARTH_RADIUS_M): number {
  return Math.abs(computeSignedArea(path, radius));
}

// Initial heading from one point to another, degrees in [-180, 180).
export function computeHeading(from: LatLng, to: LatLng): number {
  const lat1 = toRad(from.lat), lat2 = toRad(to.lat);
  const dLng = toRad(to.lng) - toRad(from.lng);
  const heading = toDeg(Math.atan2(Math.sin(dLng) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)));
  return wrap(heading, -180, 180);
}

// Point reached by travelling `distance` metres from `from` on `heading` degrees.
export function computeOffset(from: LatLng, distance: number, heading: number, radius = EARTH_RADIUS_M): LatLng {
  const d = distance / radius;
  const h = toRad(heading);
  const lat = toRad(from.lat), lng = toRad(from.lng);
  const cosD = Math.cos(d), sinD = Math.sin(d), sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLat2 = cosD * sinLat + sinD * cosLat * Math.cos(h);
  const dLng = Math.atan2(sinD * cosLat * Math.sin(h), cosD - sinLat * sinLat2);
  return { lat: toDeg(Math.asin(sinLat2)), lng: toDeg(lng + dLng) };
}

// Point a fraction of the way along the great circle from `from` to `to`.
export function interpolate(from: LatLng, to: LatLng, fraction: number): LatLng {
  const lat1 = toRad(from.lat), lng1 = toRad(from.lng), lat2 = toRad(to.lat), lng2 = toRad(to.lng);
  const angle = computeAngleBetween(from, to);
  if (angle < 1e-6) return { lat: from.lat + fraction * (to.lat - from.lat), lng: from.lng + fraction * (to.lng - from.lng) };
  const a = Math.sin((1 - fraction) * angle) / Math.sin(angle), b = Math.sin(fraction * angle) / Math.sin(angle);
  const x = a * Math.cos(lat1) * Math.cos(lng1) + b * Math.cos(lat2) * Math.cos(lng2);
  const y = a * Math.cos(lat1) * Math.sin(lng1) + b * Math.cos(lat2) * Math.sin(lng2);
  const z = a * Math.sin(lat1) + b * Math.sin(lat2);
  return { lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), lng: toDeg(Math.atan2(y, x)) };
}

// ------------------------------------------------------------------ google.maps.geometry.poly

const mercator = (lat: number) => Math.log(Math.tan(lat * 0.5 + Math.PI / 4));
const mercatorLatRhumb = (lat1: number, lat2: number, lng2: number, lng3: number) => (mercator(lat1) * (lng2 - lng3) + mercator(lat2) * lng3) / lng2;
const tanLatGC = (lat1: number, lat2: number, lng2: number, lng3: number) => (Math.tan(lat1) * Math.sin(lng2 - lng3) + Math.tan(lat2) * Math.sin(lng3)) / Math.sin(lng2);

// Does the segment (lat1, 0)-(lat2, lng2) cross the meridian through (lat3, lng3) south of the point? (longitudes relative to the segment start)
function crossesBelow(lat1: number, lat2: number, lng2: number, lat3: number, lng3: number, geodesic: boolean): boolean {
  if ((lng3 >= 0 && lng3 >= lng2) || (lng3 < 0 && lng3 < lng2)) return false;
  if (lat3 <= -Math.PI / 2) return false;
  if (lat1 <= -Math.PI / 2 || lat2 <= -Math.PI / 2 || lat1 >= Math.PI / 2 || lat2 >= Math.PI / 2) return false;
  if (lng2 <= -Math.PI) return false;
  const linearLat = (lat1 * (lng2 - lng3) + lat2 * lng3) / lng2;
  if (lat1 >= 0 && lat2 >= 0 && lat3 < linearLat) return false;
  if (lat1 <= 0 && lat2 <= 0 && lat3 >= linearLat) return true;
  if (lat3 >= Math.PI / 2) return true;
  return geodesic ? Math.tan(lat3) >= tanLatGC(lat1, lat2, lng2, lng3) : mercator(lat3) >= mercatorLatRhumb(lat1, lat2, lng2, lng3);
}

// Point-in-polygon on the sphere: crossing count with rhumb-line edges (the
// tool's facet polygons are drawn with geodesic: false). A point equal to a
// vertex counts as inside.
export function containsLocation(point: LatLng, polygon: LatLng[], geodesic = false): boolean {
  const size = polygon.length;
  if (size === 0) return false;
  const lat3 = toRad(point.lat), lng3 = toRad(point.lng);
  const prev = polygon[size - 1];
  let lat1 = toRad(prev.lat), lng1 = toRad(prev.lng);
  let crossings = 0;
  for (const p2 of polygon) {
    const dLng3 = wrap(lng3 - lng1, -Math.PI, Math.PI);
    if (lat3 === lat1 && dLng3 === 0) return true;
    const lat2 = toRad(p2.lat), lng2 = toRad(p2.lng);
    if (crossesBelow(lat1, lat2, wrap(lng2 - lng1, -Math.PI, Math.PI), lat3, dLng3, geodesic)) crossings++;
    lat1 = lat2;
    lng1 = lng2;
  }
  return (crossings & 1) !== 0;
}

// ------------------------------------------------------------------ Roof Measure's own helpers

export const midpoint = (a: LatLng, b: LatLng): LatLng => ({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
export const distM = (a: LatLng, b: LatLng) => computeDistanceBetween(a, b);
export const segFt = (a: LatLng, b: LatLng) => computeDistanceBetween(a, b) * FT_PER_M;

// Planar polygon centroid, computed relative to the first vertex to avoid cancellation on raw lat/lng.
export function centroid(path: LatLng[]): LatLng {
  const o = path[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < path.length; i++) {
    const p = path[i], q = path[(i + 1) % path.length];
    const px = p.lng - o.lng, py = p.lat - o.lat, qx = q.lng - o.lng, qy = q.lat - o.lat;
    const cross = px * qy - qx * py;
    a += cross; cx += (px + qx) * cross; cy += (py + qy) * cross;
  }
  if (Math.abs(a) < 1e-18) return { lat: path.reduce((s, p) => s + p.lat, 0) / path.length, lng: path.reduce((s, p) => s + p.lng, 0) / path.length };
  a *= 0.5;
  return { lng: o.lng + cx / (6 * a), lat: o.lat + cy / (6 * a) };
}

// Distance (m) from point p to segment a-b, planar approximation at roof scale.
export function pointSegM(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos((a.lat * Math.PI) / 180);
  const bx = (b.lng - a.lng) * k, by = b.lat - a.lat, px = (p.lng - a.lng) * k, py = p.lat - a.lat;
  const l2 = bx * bx + by * by;
  let t = l2 ? (px * bx + py * by) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - t * bx, dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy) * 111320;
}

// Point `meters` away on compass bearing `bearingDeg` (flat-earth, as the structure scan uses).
export function offsetLatLng(lat: number, lng: number, meters: number, bearingDeg: number): LatLng {
  const b = (bearingDeg * Math.PI) / 180;
  return { lat: lat + (meters * Math.cos(b)) / 110540, lng: lng + (meters * Math.sin(b)) / (111320 * Math.cos((lat * Math.PI) / 180)) };
}

// True when segment a-b already runs along one of the polylines (within 0.4 m at both ends).
export function coveredByEdge(a: LatLng, b: LatLng, edgePaths: LatLng[][]): boolean {
  const close = (p: LatLng, q: LatLng) => distM(p, q) < 0.4;
  for (const path of edgePaths) for (let i = 1; i < path.length; i++) {
    const p = path[i - 1], q = path[i];
    if ((close(a, p) && close(b, q)) || (close(a, q) && close(b, p))) return true;
  }
  return false;
}

// Both endpoints within 0.4 m of the same polyline segment.
export function segOnPolyline(a: LatLng, b: LatLng, poly: LatLng[]): boolean {
  for (let i = 1; i < poly.length; i++) if (pointSegM(a, poly[i - 1], poly[i]) < 0.4 && pointSegM(b, poly[i - 1], poly[i]) < 0.4) return true;
  return false;
}
