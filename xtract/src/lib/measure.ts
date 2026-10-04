import type {
  BuildingInsights,
  Edge,
  EdgeType,
  Facet,
  MaterialLine,
  Pt,
  RoofMeasurements,
  SolarRoofSegment,
  WasteRow,
} from "./types";

// Turns Google Solar API roof planes into a contractor roof report.
//
// What the Solar API measures directly (high confidence): sloped area,
// footprint area, pitch and azimuth of every plane.
// What we derive (estimates): each plane is modelled as a quadrilateral
// whose plan width and run are solved from its bounding box. Neighbouring
// planes are then classified as ridge / hip / valley pairs to produce the
// linear measurements. These are labelled as estimates in the report.

const SQFT_PER_M2 = 10.7639;
const FT_PER_M = 3.28084;

export const WASTE_COLUMNS = [0, 8, 11, 13, 15, 18, 23];

const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function degreesToPitch(deg: number): number {
  return Math.round(12 * Math.tan((deg * Math.PI) / 180));
}

export function compassDirection(azimuth: number): string {
  const a = ((azimuth % 360) + 360) % 360;
  return DIRECTIONS[Math.round(a / 45) % 8];
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

const add = (p: Pt, q: Pt): Pt => [p[0] + q[0], p[1] + q[1]];
const sub = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]];
const mul = (p: Pt, k: number): Pt => [p[0] * k, p[1] * k];
const dot = (p: Pt, q: Pt) => p[0] * q[0] + p[1] * q[1];
const len = (p: Pt) => Math.hypot(p[0], p[1]);

interface Plane {
  idx: number;
  seg: SolarRoofSegment;
  center: Pt; // feet, plan
  u: Pt; // unit downslope direction (plan)
  v: Pt; // unit lateral direction (plan)
  width: number; // plan width along the eave, feet
  run: number; // plan run eave → top, feet
  tan: number; // tan(pitch)
  rect: Pt[];
  sides: { left: EdgeType | null; right: EdgeType | null };
  ridgePartner: number | null;
  eaveReduction: number;
}

function toLocal(origin: { latitude: number; longitude: number }) {
  const mPerDegLat = 110_540;
  const mPerDegLng = 111_320 * Math.cos((origin.latitude * Math.PI) / 180);
  return (p: { latitude: number; longitude: number }): Pt => [
    (p.longitude - origin.longitude) * mPerDegLng * FT_PER_M,
    (p.latitude - origin.latitude) * mPerDegLat * FT_PER_M,
  ];
}

/**
 * Solve a plane's plan width W and run R from its axis-aligned bounding box:
 *   dx = W|cos θ| + R|sin θ|,  dy = W|sin θ| + R|cos θ|
 * Falls back to the footprint area when the system is ill-conditioned (θ≈45°).
 */
function solveWidthRun(dx: number, dy: number, azimuth: number, groundAreaFt: number) {
  const t = (azimuth * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  const det = c * c - s * s;
  let W: number;
  let R: number;
  if (Math.abs(det) > 0.3) {
    W = (dx * c - dy * s) / det;
    R = (dy * c - dx * s) / det;
  } else {
    // Diagonal plane: use the footprint and the bbox diagonal as a ratio hint.
    const side = Math.sqrt(groundAreaFt);
    W = side * 1.4;
    R = side / 1.4;
  }
  if (!(W > 1) || !(R > 1)) {
    const side = Math.sqrt(Math.max(groundAreaFt, 1));
    W = side;
    R = side;
  }
  return { W, R };
}

function segmentDistance(p1: Pt, p2: Pt, q1: Pt, q2: Pt): number {
  const pointSeg = (p: Pt, a: Pt, b: Pt) => {
    const ab = sub(b, a);
    const l2 = dot(ab, ab) || 1;
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    return len(sub(p, add(a, mul(ab, t))));
  };
  return Math.min(pointSeg(p1, q1, q2), pointSeg(p2, q1, q2), pointSeg(q1, p1, p2), pointSeg(q2, p1, p2));
}

function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyDistance(a: Pt[], b: Pt[]): number {
  if (a.some((p) => pointInPoly(p, b)) || b.some((p) => pointInPoly(p, a))) return 0;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      best = Math.min(best, segmentDistance(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length]));
    }
  }
  return best;
}

function suggestWaste(facets: number, valleys: number): number {
  if (facets <= 4 && valleys === 0) return 11;
  if (facets <= 10) return 13;
  if (facets <= 20) return 15;
  return 18;
}

export function measureRoof(insights: BuildingInsights): RoofMeasurements {
  const segments = insights.solarPotential.roofSegmentStats.filter((s) => s.stats.areaMeters2 > 0.5);
  if (segments.length === 0) throw new Error("No roof planes found for this building");

  const project = toLocal(insights.center);

  const planes: Plane[] = segments.map((seg, idx) => {
    const t = (seg.azimuthDegrees * Math.PI) / 180;
    const u: Pt = [Math.sin(t), Math.cos(t)];
    const v: Pt = [Math.cos(t), -Math.sin(t)];
    const sw = project(seg.boundingBox.sw);
    const ne = project(seg.boundingBox.ne);
    const { W, R } = solveWidthRun(
      Math.abs(ne[0] - sw[0]),
      Math.abs(ne[1] - sw[1]),
      seg.azimuthDegrees,
      seg.stats.groundAreaMeters2 * SQFT_PER_M2,
    );
    const center = project(seg.center);
    const eaveMid = add(center, mul(u, R / 2));
    const rect: Pt[] = [
      add(eaveMid, mul(v, -W / 2)),
      add(eaveMid, mul(v, W / 2)),
      add(add(eaveMid, mul(v, W / 2)), mul(u, -R)),
      add(add(eaveMid, mul(v, -W / 2)), mul(u, -R)),
    ];
    return {
      idx,
      seg,
      center,
      u,
      v,
      width: W,
      run: R,
      tan: Math.tan((seg.pitchDegrees * Math.PI) / 180),
      rect,
      sides: { left: null, right: null },
      ridgePartner: null,
      eaveReduction: 0,
    };
  });

  // --- Classify neighbouring plane pairs -------------------------------
  let hipLen = 0;
  let valleyLen = 0;
  const ridgeCandidates: { i: number; j: number; dist: number }[] = [];

  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      const a = planes[i];
      const b = planes[j];
      const tol = Math.max(2.5, 0.08 * Math.min(a.run, b.run));
      if (polyDistance(a.rect, b.rect) > tol) continue;
      const diff = angleDiff(a.seg.azimuthDegrees, b.seg.azimuthDegrees);

      if (Math.abs(diff - 180) <= 30) {
        ridgeCandidates.push({ i, j, dist: len(sub(a.center, b.center)) });
      } else if (Math.abs(diff - 90) <= 30) {
        const d = sub(b.center, a.center);
        const bUpslopeOfA = dot(d, a.u) < 0;
        const aUpslopeOfB = dot(mul(d, -1), b.u) < 0;
        const type: EdgeType = bUpslopeOfA && aUpslopeOfB ? "hip" : "valley";
        const r = Math.min(a.run, b.run);
        const rise = r * ((a.tan + b.tan) / 2);
        const length = Math.sqrt(2 * r * r + rise * rise);
        if (type === "hip") hipLen += length;
        else valleyLen += length;

        // Record which side of each plane the shared edge sits on.
        for (const [p, other] of [
          [a, b],
          [b, a],
        ] as const) {
          const side = dot(sub(other.center, p.center), p.v) >= 0 ? "right" : "left";
          if (p.sides[side] === null) p.sides[side] = type;
          else if (type === "valley") p.eaveReduction += r; // valley meets mid-eave
        }
      }
    }
  }

  // Greedy one-to-one ridge pairing, closest pairs first.
  ridgeCandidates.sort((x, y) => x.dist - y.dist);
  for (const { i, j } of ridgeCandidates) {
    if (planes[i].ridgePartner === null && planes[j].ridgePartner === null) {
      planes[i].ridgePartner = j;
      planes[j].ridgePartner = i;
    }
  }

  // --- Build facet polygons & edges -------------------------------------
  const edges: Edge[] = [];
  const facets: Facet[] = [];
  const lengths: Record<EdgeType, number> = { eave: 0, rake: 0, ridge: 0, hip: 0, valley: 0, flash: 0 };
  const topWidths = new Map<number, { a: Pt; b: Pt; w: number }>();

  for (const p of planes) {
    const { width: W, run: R } = p;
    const inset = (side: EdgeType | null, at: "top" | "bottom") =>
      (side === "hip" && at === "top") || (side === "valley" && at === "bottom") ? R : 0;
    const eaveMid = add(p.center, mul(p.u, R / 2));
    const local = (s: number, t: number): Pt => add(add(eaveMid, mul(p.v, s)), mul(p.u, -t));

    let bl = -W / 2 + inset(p.sides.left, "bottom");
    let br = W / 2 - inset(p.sides.right, "bottom");
    let tl = -W / 2 + inset(p.sides.left, "top");
    let tr = W / 2 - inset(p.sides.right, "top");
    if (br < bl) bl = br = (bl + br) / 2;
    if (tr < tl) tl = tr = (tl + tr) / 2;

    const poly: Pt[] = [local(bl, 0), local(br, 0), local(tr, R), local(tl, R)];
    const pitchDeg = p.seg.pitchDegrees;
    const areaSqFt = p.seg.stats.areaMeters2 * SQFT_PER_M2;

    facets.push({
      id: p.idx + 1,
      pitch: degreesToPitch(pitchDeg),
      pitchDegrees: pitchDeg,
      azimuth: p.seg.azimuthDegrees,
      direction: compassDirection(p.seg.azimuthDegrees),
      areaSqFt,
      polygon: poly,
      label: local((bl + br + tl + tr) / 4, R * 0.45),
    });

    // Eave (true horizontal length).
    const eave = Math.max(0, br - bl - p.eaveReduction);
    if (eave > 0.5) {
      edges.push({ type: "eave", a: poly[0], b: poly[1], lengthFt: eave });
      lengths.eave += eave;
    }

    // Side edges: rakes are owned by one plane; hips/valleys are shared and
    // were already totalled above, so they're drawn but not re-summed.
    const slopeLen = (dx: number) => Math.sqrt(R * R + dx * dx + (R * p.tan) ** 2);
    const sideEdge = (side: EdgeType | null, a: Pt, b: Pt, dx: number) => {
      const type: EdgeType = side ?? "rake";
      const l = slopeLen(dx);
      edges.push({ type, a, b, lengthFt: l });
      if (type === "rake") lengths.rake += l;
    };
    sideEdge(p.sides.left, poly[0], poly[3], tl - bl);
    sideEdge(p.sides.right, poly[1], poly[2], tr - br);

    const top = tr - tl;
    if (top > 0.5) topWidths.set(p.idx, { a: poly[3], b: poly[2], w: top });
  }

  // Ridges: shared top edge of opposing pairs (counted once). Tops with no
  // partner meet a wall or higher roof — counted as headwall flashing.
  const done = new Set<number>();
  for (const p of planes) {
    const top = topWidths.get(p.idx);
    if (!top || done.has(p.idx)) continue;
    const partner = p.ridgePartner;
    if (partner !== null) {
      const other = topWidths.get(partner);
      const w = other ? Math.min(top.w, other.w) : 0;
      done.add(p.idx).add(partner);
      if (w > 0.5) {
        edges.push({ type: "ridge", a: top.a, b: top.b, lengthFt: w });
        lengths.ridge += w;
      }
    } else {
      edges.push({ type: "flash", a: top.a, b: top.b, lengthFt: top.w });
      lengths.flash += top.w;
    }
  }

  lengths.hip = hipLen;
  lengths.valley = valleyLen;

  // --- Totals ---------------------------------------------------------------
  const totalArea = facets.reduce((s, f) => s + f.areaSqFt, 0);
  const footprint = segments.reduce((s, x) => s + x.stats.groundAreaMeters2 * SQFT_PER_M2, 0);

  const byPitch = new Map<number, number>();
  for (const f of facets) byPitch.set(f.pitch, (byPitch.get(f.pitch) ?? 0) + f.areaSqFt);
  const pitchBreakdown = [...byPitch.entries()]
    .map(([pitch, areaSqFt]) => ({ pitch, areaSqFt, percent: (areaSqFt / totalArea) * 100 }))
    .sort((a, b) => b.areaSqFt - a.areaSqFt);

  const r = (n: number) => Math.round(n);
  const roundedLengths = Object.fromEntries(
    Object.entries(lengths).map(([k, v]) => [k, r(v)]),
  ) as Record<EdgeType, number>;

  const suggestedWastePct = suggestWaste(facets.length, roundedLengths.valley);
  const wasteTable: WasteRow[] = WASTE_COLUMNS.map((pct) => {
    const areaSqFt = r(totalArea * (1 + pct / 100));
    return { pct, areaSqFt, squares: Math.ceil(areaSqFt / 100) };
  });

  const derived = {
    dripEdge: roundedLengths.eave + roundedLengths.rake,
    // Florida practice: starter along the full perimeter (FBC R905.2.8.5).
    starter: roundedLengths.eave + roundedLengths.rake,
    ridgeCap: roundedLengths.ridge + roundedLengths.hip,
    leakBarrier: roundedLengths.valley,
  };

  const suggested = wasteTable.find((w) => w.pct === suggestedWastePct)!;
  const materials: MaterialLine[] = [
    {
      item: "Architectural shingles",
      qty: suggested.squares * 3,
      unit: "bundles",
      basis: `${suggested.squares} SQ at ${suggestedWastePct}% waste, 3 bundles/SQ`,
    },
    {
      item: "Synthetic underlayment",
      qty: Math.ceil(suggested.areaSqFt / 1000),
      unit: "rolls",
      basis: "10 SQ (1,000 sq ft) per roll",
    },
    {
      item: "Starter strip",
      qty: Math.ceil(derived.starter / 120),
      unit: "bundles",
      basis: `${derived.starter} LF eaves + rakes, 120 LF/bundle`,
    },
    {
      item: "Hip & ridge cap",
      qty: Math.ceil(derived.ridgeCap / 25),
      unit: "bundles",
      basis: `${derived.ridgeCap} LF ridges + hips, 25 LF/bundle`,
    },
    {
      item: "Drip edge",
      qty: Math.ceil(derived.dripEdge / 10),
      unit: "10' pcs",
      basis: `${derived.dripEdge} LF eaves + rakes`,
    },
  ];
  if (derived.leakBarrier > 0) {
    materials.push({
      item: "Leak barrier (valleys)",
      qty: Math.ceil(derived.leakBarrier / 50),
      unit: "rolls",
      basis: `${derived.leakBarrier} LF valleys, 36" × 50' roll`,
    });
  }

  const complexity = facets.length <= 4 ? "Simple" : facets.length <= 12 ? "Moderate" : "Complex";

  return {
    totalAreaSqFt: r(totalArea),
    footprintSqFt: r(footprint),
    facetCount: facets.length,
    predominantPitch: pitchBreakdown[0].pitch,
    pitchBreakdown,
    facets,
    edges,
    lengths: roundedLengths,
    derived,
    complexity,
    suggestedWastePct,
    wasteTable,
    materials,
  };
}
