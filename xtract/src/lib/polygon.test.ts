import { test } from "node:test";
import assert from "node:assert/strict";
import { measurePolygonModel } from "./polygon";
import { sampleRoofModel, SAMPLE_PROPERTY } from "./sampleModel";
import type { PolygonRoofModel, Pt } from "./types";

const near = (a: number, b: number, tol: number, label: string) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);
const f = (id: number, pitch: number, azimuth: number, polygon: Pt[]) => ({ id, pitch, azimuth, polygon });

test("hip roof: exact eaves, ridge and hips", () => {
  const model: PolygonRoofModel = {
    facets: [
      f(1, 6, 180, [[-30, -15], [30, -15], [15, 0], [-15, 0]]),
      f(2, 6, 0, [[30, 15], [-30, 15], [-15, 0], [15, 0]]),
      f(3, 6, 90, [[30, -15], [30, 15], [15, 0]]),
      f(4, 6, 270, [[-30, 15], [-30, -15], [-15, 0]]),
    ],
  };
  const m = measurePolygonModel(model);
  near(m.exactLengths.eave, 180, 0.01, "eave");
  near(m.exactLengths.ridge, 30, 0.01, "ridge");
  near(m.exactLengths.hip, 90, 0.01, "hip"); // 4 × √(2·15² + 7.5²) = 4 × 22.5
  near(m.exactLengths.rake, 0, 0.01, "rake");
  near(m.totalAreaSqFt, 2012, 1, "area"); // 1800 × √1.25
});

test("gable with a lower-pitch porch: transition and T-junction eave split", () => {
  const model: PolygonRoofModel = {
    facets: [
      f(1, 6, 180, [[-30, -15], [30, -15], [30, 0], [-30, 0]]),
      f(2, 6, 0, [[30, 15], [-30, 15], [-30, 0], [30, 0]]),
      f(3, 3, 180, [[-10, -23], [10, -23], [10, -15], [-10, -15]]),
    ],
  };
  const m = measurePolygonModel(model);
  near(m.exactLengths.transition, 20, 0.01, "transition");
  near(m.exactLengths.eave, 40 + 60 + 20, 0.01, "eave");
  near(m.exactLengths.ridge, 60, 0.01, "ridge");
  near(m.exactLengths.rake, 4 * 15 * Math.sqrt(1.25) + 2 * 8 * Math.sqrt(1 + 1 / 16), 0.01, "rake");
  assert.deepEqual(m.pitchBreakdown.map((p) => p.pitch), [3, 6]);
});

test("cross gable: two valleys meet the wing ridge", () => {
  const model: PolygonRoofModel = {
    facets: [
      f(1, 6, 180, [[-30, -15], [-10, -15], [0, -5], [10, -15], [30, -15], [30, 0], [-30, 0]]),
      f(2, 6, 0, [[30, 15], [-30, 15], [-30, 0], [30, 0]]),
      f(3, 6, 90, [[10, -35], [10, -15], [0, -5], [0, -35]]),
      f(4, 6, 270, [[-10, -15], [-10, -35], [0, -35], [0, -5]]),
    ],
  };
  const m = measurePolygonModel(model);
  near(m.exactLengths.valley, 30, 0.01, "valley"); // 2 × √(2·10² + 5²)
  near(m.exactLengths.ridge, 60 + 30, 0.01, "ridge");
  near(m.exactLengths.eave, 40 + 60 + 40, 0.01, "eave");
  near(m.exactLengths.rake, 4 * 15 * Math.sqrt(1.25) + 2 * Math.sqrt(125), 0.01, "rake");
});

test("supplied sample: matches the source report's area, facets, pitch and waste", () => {
  const m = measurePolygonModel(sampleRoofModel());
  const ref = SAMPLE_PROPERTY.reference;
  near(m.totalAreaSqFt, ref.areaSqFt, ref.areaSqFt * 0.002, "area");
  assert.equal(m.facetCount, ref.facets);
  assert.equal(m.predominantPitch, ref.pitch);
  assert.equal(m.suggestedWastePct, 14);
  // Linear total within 10% of the source (its model heights are illustrative).
  const sum = (x: Record<string, number>) => Object.values(x).reduce((a, b) => a + b, 0);
  near(sum(m.exactLengths), sum(ref.lengths), sum(ref.lengths) * 0.1, "total linear ft");
});
