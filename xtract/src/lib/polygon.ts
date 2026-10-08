import { EMPTY_LENGTHS, compassDirection, summarize } from "./measure";
import type { Edge, EdgeType, Facet, PolygonRoofModel, Pt, RoofMeasurements } from "./types";

// Exact measurement from a plan-view facet model (outline + pitch + slope
// direction per facet) — the same model format professional roof reports
// are drawn from. Every quantity follows from geometry:
//
//   facet area   = plan area × √(1 + (pitch/12)²)
//   edge length  = plan length × √(1 + (tan θ · cos α)²), α = edge vs. slope
//   edge type    = from how many facets share it, whether it is level, and
//                  whether each facet rises or falls away from it.

const SNAP = 0.35; // ft — vertices closer than this are the same point
const LEVEL = 0.3; // |cos α| below this → the edge runs level across the slope

type V = Pt;

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];
const len = (a: V) => Math.hypot(a[0], a[1]);

function signedArea(poly: V[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function centroid(poly: V[]): V {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-9) return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const k = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * k;
    cy += (y1 + y2) * k;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** Point well inside the polygon for label placement (centroid, or nearest inner point). */
function labelPoint(poly: V[]): V {
  const c = centroid(poly);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > c[1] !== yj > c[1] && c[0] < ((xj - xi) * (c[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  if (inside) return c;
  // Fall back to the midpoint of the widest horizontal chord through the centroid's y.
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    if (y1 > c[1] !== y2 > c[1]) xs.push(x1 + ((c[1] - y1) * (x2 - x1)) / (y2 - y1));
  }
  xs.sort((a, b) => a - b);
  let best: V = c;
  let bestW = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > bestW) {
      bestW = xs[i + 1] - xs[i];
      best = [(xs[i] + xs[i + 1]) / 2, c[1]];
    }
  }
  return best;
}

interface Side {
  facet: number;
  level: boolean;
  /** true when stepping into the facet from this edge goes downhill */
  high: boolean;
  tan: number;
  cosA: number;
}

export function measurePolygonModel(model: PolygonRoofModel): RoofMeasurements {
  // 1. Snap shared vertices.
  const pts: V[] = [];
  const idOf = (p: V) => {
    for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i][0] - p[0]) < SNAP && Math.abs(pts[i][1] - p[1]) < SNAP) return i;
    pts.push([p[0], p[1]]);
    return pts.length - 1;
  };
  const rings = model.facets.map((f) => {
    const ids = f.polygon.map(idOf).filter((id, i, a) => id !== a[(i + a.length - 1) % a.length]);
    return ids;
  });

  // 2. Split edges at T-junctions so partially shared edges match up.
  const split = rings.map((ring) => {
    const out: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      out.push(a);
      const ab = sub(pts[b], pts[a]);
      const l2 = dot(ab, ab);
      if (l2 < 1e-9) continue;
      const between: { t: number; id: number }[] = [];
      for (let k = 0; k < pts.length; k++) {
        if (k === a || k === b) continue;
        const t = dot(sub(pts[k], pts[a]), ab) / l2;
        if (t <= 0.001 || t >= 0.999) continue;
        const d = len(sub(pts[k], [pts[a][0] + ab[0] * t, pts[a][1] + ab[1] * t]));
        if (d < SNAP) between.push({ t, id: k });
      }
      between.sort((x, y) => x.t - y.t).forEach((x) => out.push(x.id));
    }
    return out;
  });

  // 3. Facets.
  const facets: Facet[] = model.facets.map((f, i) => {
    const poly = split[i].map((id) => pts[id]);
    const plan = Math.abs(signedArea(poly));
    return {
      id: f.id,
      pitch: Math.round(f.pitch),
      pitchDegrees: (Math.atan(f.pitch / 12) * 180) / Math.PI,
      azimuth: f.azimuth,
      direction: compassDirection(f.azimuth),
      areaSqFt: plan * Math.sqrt(1 + (f.pitch / 12) ** 2),
      polygon: poly,
      label: labelPoint(poly),
    };
  });

  // 4. Collect every directed edge with its facet's view of it.
  const edgeMap = new Map<string, { a: number; b: number; sides: Side[] }>();
  split.forEach((ring, fi) => {
    const f = model.facets[fi];
    const ccw = signedArea(ring.map((id) => pts[id])) > 0;
    const t = (f.azimuth * Math.PI) / 180;
    const u: V = f.pitch > 0 ? [Math.sin(t), Math.cos(t)] : [0, 0]; // downslope
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const d = sub(pts[b], pts[a]);
      const L = len(d);
      if (L < 1e-6) continue;
      const dh: V = [d[0] / L, d[1] / L];
      const left: V = [-dh[1], dh[0]];
      const inward: V = ccw ? left : [-left[0], -left[1]];
      const cosA = dot(dh, u);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      const entry = edgeMap.get(key) ?? { a, b, sides: [] };
      entry.sides.push({
        facet: fi,
        level: f.pitch === 0 || Math.abs(cosA) < LEVEL,
        high: dot(inward, u) > 0,
        tan: f.pitch / 12,
        cosA,
      });
      edgeMap.set(key, entry);
    }
  });

  // 5. Classify.
  const lengths = EMPTY_LENGTHS();
  const edges: Edge[] = [];
  for (const { a, b, sides } of edgeMap.values()) {
    const plan = len(sub(pts[b], pts[a]));
    const true3d = sides.reduce((s, x) => s + plan * Math.sqrt(1 + (x.tan * x.cosA) ** 2), 0) / sides.length;
    let type: EdgeType | null;
    if (sides.length === 1) {
      const [s] = sides;
      type = !s.level ? "rake" : s.high && s.tan > 0 ? "flash" : "eave";
    } else if (sides.length === 2) {
      const [p, q] = sides;
      const fp = model.facets[p.facet];
      const fq = model.facets[q.facet];
      const coplanar = Math.abs(fp.pitch - fq.pitch) < 0.5 && Math.abs(((fp.azimuth - fq.azimuth + 540) % 360) - 180) < 5;
      if (coplanar) type = null; // seam inside one plane
      else if (p.tan === 0 || q.tan === 0) type = "transition";
      else if (p.level && q.level) type = p.high && q.high ? "ridge" : p.high !== q.high ? "transition" : "valley";
      else if (p.high && q.high) type = "hip";
      else if (!p.high && !q.high) type = "valley";
      else {
        // One facet rises away from the line, the other falls away, and the
        // line slopes: an upper roof edge sitting over a lower roof that
        // meets the wall. Plan view shows one line; on the roof there are
        // two — the upper eave/rake and the lower step/wall flashing.
        const upper = p.high ? q : p;
        const lower = p.high ? p : q;
        const add = (t: EdgeType, s: Side) => {
          const l = plan * Math.sqrt(1 + (s.tan * s.cosA) ** 2);
          lengths[t] += l;
          edges.push({ type: t, a: pts[a], b: pts[b], lengthFt: l });
        };
        add(upper.level ? "eave" : "rake", upper);
        add(lower.level ? "flash" : "step", lower);
        continue;
      }
    } else {
      type = "unspecified";
    }
    if (!type) continue;
    lengths[type] += true3d;
    edges.push({ type, a: pts[a], b: pts[b], lengthFt: true3d });
  }

  const footprint = facets.reduce((s, f) => s + Math.abs(signedArea(f.polygon)), 0);
  // Parapet walls can't be seen in a plan outline.
  return summarize(facets, edges, lengths, { footprintSqFt: footprint, unmeasured: ["parapet"] });
}
