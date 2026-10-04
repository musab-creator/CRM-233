import raw from "./data/sample-roof-model.json";
import type { PolygonRoofModel } from "./types";

// The supplied Diversity Roofing sample (3436 State Rd 13 N, Jacksonville).
// Plan outlines are traced to scale and each facet carries its surveyed
// pitch; vertex heights are illustrative. We recover the drawing scale from
// the facet areas in the source report and the slope direction from the
// illustrative heights (direction only — the pitch comes from the source).
export const SAMPLE_PROPERTY = {
  address: "3436 State Rd 13 N, Jacksonville, FL 32259",
  lat: 30.0354363,
  lng: -81.6663906,
  imageryDate: "2016-02-11",
  builtYear: 2012,
  parcel: "0011200000",
  county: "St. Johns",
  // Totals from the source report, used to validate the engine.
  reference: {
    areaSqFt: 8150,
    facets: 35,
    pitch: 5,
    lengths: { eave: 449 + 10 / 12, rake: 135 + 5 / 12, ridge: 131 + 5 / 12, hip: 412 + 10 / 12, valley: 238 + 10 / 12, flash: 10.5, step: 130.5, transition: 30 + 11 / 12, parapet: 0, unspecified: 23 + 8 / 12 },
  },
};

type Vec = [number, number, number];

function newell(poly: Vec[]): Vec {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1, z1] = poly[i];
    const [x2, y2, z2] = poly[(i + 1) % poly.length];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  return [nx, ny, nz];
}

export function sampleRoofModel(): PolygonRoofModel {
  // Model y grows downward (image convention); flip so +y is north.
  const V = (raw.vertices as Vec[]).map(([x, y, z]) => [x, -y, z] as Vec);
  // Scale (ft per model unit) that best fits the source facet areas.
  let num = 0;
  let den = 0;
  for (const f of raw.facets) {
    const plan = Math.abs(newell(f.vertices.map((i) => V[i]))[2]) / 2;
    num += f.area;
    den += plan * Math.sqrt(1 + (f.pitch / 12) ** 2);
  }
  const s = Math.sqrt(num / den);
  return {
    facets: raw.facets.map((f) => {
      const poly = f.vertices.map((i) => V[i]);
      let [nx, ny, nz] = newell(poly);
      if (nz < 0) [nx, ny, nz] = [-nx, -ny, -nz];
      // Downslope direction is the horizontal part of the upward normal.
      const azimuth = ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360;
      return { id: f.id, pitch: f.pitch, azimuth, polygon: poly.map(([x, y]) => [x * s, y * s] as [number, number]) };
    }),
  };
}
