import type { Facet, RoofMeasurements } from "./types";

// Builds a 3D roof for the viewer from measured facets. Each facet is a plane
// with known pitch and direction; plane offsets are solved so neighbouring
// facets meet at shared vertices (BFS over the facet graph), then each
// connected roof is set on walls of a nominal height. Heights are derived
// for visualisation — the report's numbers come from the 2D measurements.

export interface Roof3D {
  facets: { id: number; pitch: number; area: number; direction: string; pts: [number, number, number][] }[];
  walls: [number, number, number][][]; // quads
  extent: number;
}

const WALL_FT = 10;
const TOL = 0.5;

const key = (p: [number, number]) => `${Math.round(p[0] / TOL)},${Math.round(p[1] / TOL)}`;

export function buildRoof3D(m: Pick<RoofMeasurements, "facets">): Roof3D | null {
  const facets: Facet[] = m.facets.filter((f) => f.polygon.length >= 3);
  if (!facets.length) return null;

  const slope = facets.map((f) => {
    const a = (f.azimuth * Math.PI) / 180;
    return { tan: f.pitch / 12, u: [Math.sin(a), Math.cos(a)] as const };
  });
  const plane = (i: number, p: [number, number]) => -slope[i].tan * (p[0] * slope[i].u[0] + p[1] * slope[i].u[1]);

  // Vertex → facets touching it (snapped).
  const touch = new Map<string, Set<number>>();
  facets.forEach((f, i) =>
    f.polygon.forEach((p) => {
      const k = key(p);
      if (!touch.has(k)) touch.set(k, new Set());
      touch.get(k)!.add(i);
    }),
  );
  const shared = (i: number, j: number) => facets[i].polygon.filter((p) => touch.get(key(p))?.has(j));

  // Solve plane offsets component by component.
  const z0: (number | undefined)[] = facets.map(() => undefined);
  const component: number[] = facets.map(() => -1);
  const order = facets.map((_, i) => i).sort((a, b) => facets[b].areaSqFt - facets[a].areaSqFt);
  let comp = 0;
  for (const start of order) {
    if (z0[start] !== undefined) continue;
    z0[start] = 0;
    component[start] = comp;
    const queue = [start];
    while (queue.length) {
      const i = queue.shift()!;
      const neighbours = new Set<number>();
      facets[i].polygon.forEach((p) => touch.get(key(p))?.forEach((j) => j !== i && neighbours.add(j)));
      for (const j of neighbours) {
        if (z0[j] !== undefined) continue;
        const pts = shared(i, j);
        if (pts.length < 2) continue; // touching at a corner only
        z0[j] = pts.reduce((s, p) => s + z0[i]! + plane(i, p) - plane(j, p), 0) / pts.length;
        component[j] = comp;
        queue.push(j);
      }
    }
    comp++;
  }

  // Lift each component so its lowest point sits on the wall tops.
  const height = (i: number, p: [number, number]) => z0[i]! + plane(i, p);
  for (let c = 0; c < comp; c++) {
    let low = Infinity;
    facets.forEach((f, i) => component[i] === c && f.polygon.forEach((p) => (low = Math.min(low, height(i, p)))));
    facets.forEach((_, i) => component[i] === c && (z0[i] = z0[i]! - low + WALL_FT));
  }

  // Normalise to a ~8-unit model centred on the origin.
  const all = facets.flatMap((f) => f.polygon);
  const minX = Math.min(...all.map((p) => p[0]));
  const maxX = Math.max(...all.map((p) => p[0]));
  const minY = Math.min(...all.map((p) => p[1]));
  const maxY = Math.max(...all.map((p) => p[1]));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const s = 8 / Math.max(maxX - minX, maxY - minY, 1);
  const P = (x: number, y: number, z: number): [number, number, number] => [+((x - cx) * s).toFixed(3), +(z * s).toFixed(3), +(-(y - cy) * s).toFixed(3)];

  const walls: Roof3D["walls"] = [];
  facets.forEach((f, i) => {
    const n = f.polygon.length;
    for (let k = 0; k < n; k++) {
      const a = f.polygon[k];
      const b = f.polygon[(k + 1) % n];
      const ta = touch.get(key(a))!;
      const tb = touch.get(key(b))!;
      const sharedWith = [...ta].some((j) => j !== i && tb.has(j));
      if (sharedWith) continue;
      walls.push([P(a[0], a[1], height(i, a) - 0.4), P(b[0], b[1], height(i, b) - 0.4), P(b[0], b[1], 0), P(a[0], a[1], 0)]);
    }
  });

  return {
    facets: facets.map((f, i) => ({
      id: f.id,
      pitch: f.pitch,
      area: Math.round(f.areaSqFt),
      direction: f.direction,
      pts: f.polygon.map((p) => P(p[0], p[1], height(i, p))),
    })),
    walls,
    extent: 8,
  };
}
