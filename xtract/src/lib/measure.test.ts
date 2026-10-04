import { test } from "node:test";
import assert from "node:assert/strict";
import { measureRoof, degreesToPitch, compassDirection } from "./measure";
import { demoBuildingInsights } from "./solar";
import type { BuildingInsights } from "./types";

const FT = 3.28084;

// A 60' x 30' gable at 6/12, aligned east-west, built by hand.
function gable(): BuildingInsights {
  const lat = 30.3, lng = -81.6;
  const mLat = 110_540, mLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ll = (x: number, y: number) => ({ latitude: lat + y / FT / mLat, longitude: lng + x / FT / mLng });
  const pitch = (Math.atan(6 / 12) * 180) / Math.PI;
  const ground = (60 * 15) / FT / FT;
  const seg = (az: number, y0: number, y1: number) => ({
    pitchDegrees: pitch,
    azimuthDegrees: az,
    stats: { groundAreaMeters2: ground, areaMeters2: ground / Math.cos((pitch * Math.PI) / 180) },
    center: ll(0, (y0 + y1) / 2),
    boundingBox: { sw: ll(-30, y0), ne: ll(30, y1) },
  });
  return {
    center: { latitude: lat, longitude: lng },
    solarPotential: {
      wholeRoofStats: { areaMeters2: 0, groundAreaMeters2: 0 },
      roofSegmentStats: [seg(180, -15, 0), seg(0, 0, 15)],
    },
  };
}

test("pitch and compass helpers", () => {
  assert.equal(degreesToPitch(26.565), 6);
  assert.equal(degreesToPitch(18.435), 4);
  assert.equal(compassDirection(182), "S");
  assert.equal(compassDirection(-45), "NW");
});

test("simple gable: exact area, eaves, ridge and rakes", () => {
  const m = measureRoof(gable());
  // 1800 sq ft footprint / cos(26.565°) = 2012 sq ft
  assert.ok(Math.abs(m.totalAreaSqFt - 2012) <= 2, `area ${m.totalAreaSqFt}`);
  assert.equal(m.facetCount, 2);
  assert.equal(m.predominantPitch, 6);
  assert.ok(Math.abs(m.lengths.eave - 120) <= 1, `eave ${m.lengths.eave}`);
  assert.ok(Math.abs(m.lengths.ridge - 60) <= 1, `ridge ${m.lengths.ridge}`);
  // 4 rakes of 15 / cos(26.565°) = 16.77 ft
  assert.ok(Math.abs(m.lengths.rake - 67) <= 1, `rake ${m.lengths.rake}`);
  assert.equal(m.lengths.hip, 0);
  assert.equal(m.lengths.valley, 0);
  assert.equal(m.suggestedWastePct, 10);
  assert.deepEqual(m.wasteTable.map((w) => w.pct), [7, 9, 10, 12, 14, 17, 19]);
  // squares round up to the tenth, matching measurement-report convention
  assert.equal(m.wasteTable[2].squares, Math.ceil(m.wasteTable[2].areaSqFt / 10) / 10);
});

test("demo roofs are internally consistent for many addresses", () => {
  for (let i = 0; i < 60; i++) {
    const b = demoBuildingInsights(30.3, -81.6, `${100 + i} Main St, Jacksonville, FL`);
    const m = measureRoof(b);
    const footprintFt = b.solarPotential.wholeRoofStats.groundAreaMeters2 * FT * FT;
    assert.ok(m.totalAreaSqFt > footprintFt, "sloped area exceeds footprint");
    assert.ok(m.lengths.eave > 0 && Number.isFinite(m.lengths.eave));
    for (const v of Object.values(m.lengths)) assert.ok(Number.isFinite(v) && v >= 0);
    assert.ok(m.materials.every((x) => x.qty > 0));
    if (m.facetCount === 4) assert.ok(m.lengths.hip > 0, "hip roof has hips");
  }
});

test("hip roof: perimeter eaves and four hips", () => {
  // find a seed that yields a plain 4-plane hip
  for (let i = 0; i < 200; i++) {
    const b = demoBuildingInsights(30.3, -81.6, `hip-${i}`);
    if (b.solarPotential.roofSegmentStats.length !== 4) continue;
    const m = measureRoof(b);
    const segs = b.solarPotential.roofSegmentStats;
    const s = segs.find((x) => x.azimuthDegrees === 180)!;
    const e = segs.find((x) => x.azimuthDegrees === 90)!;
    const mLat = 110_540, mLng = 111_320 * Math.cos((30.3 * Math.PI) / 180);
    const L = (s.boundingBox.ne.longitude - s.boundingBox.sw.longitude) * mLng * FT;
    const D = (e.boundingBox.ne.latitude - e.boundingBox.sw.latitude) * mLat * FT;
    assert.ok(Math.abs(m.lengths.eave - 2 * (L + D)) <= 2, `eave ${m.lengths.eave} vs ${2 * (L + D)}`);
    assert.ok(Math.abs(m.lengths.ridge - (L - D)) <= 2, `ridge ${m.lengths.ridge} vs ${L - D}`);
    const R = D / 2, rise = R * Math.tan((s.pitchDegrees * Math.PI) / 180);
    assert.ok(Math.abs(m.lengths.hip - 4 * Math.sqrt(2 * R * R + rise * rise)) <= 2, `hip ${m.lengths.hip}`);
    assert.equal(m.lengths.rake, 0);
    return;
  }
  assert.fail("no hip seed found");
});

test("L-shaped hip: two valleys and correct eave perimeter", () => {
  for (let i = 0; i < 300; i++) {
    const b = demoBuildingInsights(30.3, -81.6, `L-shape-${i}`);
    if (b.solarPotential.roofSegmentStats.length !== 7) continue; // main hip + wing, no porch
    const m = measureRoof(b);
    const segs = b.solarPotential.roofSegmentStats;
    const mLat = 110_540, mLng = 111_320 * Math.cos((30.3 * Math.PI) / 180);
    const dx = (s: (typeof segs)[0]) => (s.boundingBox.ne.longitude - s.boundingBox.sw.longitude) * mLng * FT;
    const dy = (s: (typeof segs)[0]) => (s.boundingBox.ne.latitude - s.boundingBox.sw.latitude) * mLat * FT;
    const L = dx(segs[0]); // main south trapezoid
    const D = dy(segs[2]); // main east triangle
    const wingE = segs[4];
    const Rw = dx(wingE);
    const wingL = dy(wingE) - Rw;
    const expectedEave = 2 * (L + D) + 2 * wingL;
    assert.ok(Math.abs(m.lengths.eave - expectedEave) <= 3, `eave ${m.lengths.eave} vs ${expectedEave}`);
    const rise = Rw * Math.tan((wingE.pitchDegrees * Math.PI) / 180);
    const valley = Math.sqrt(2 * Rw * Rw + rise * rise);
    assert.ok(Math.abs(m.lengths.valley - 2 * valley) <= 3, `valley ${m.lengths.valley} vs ${2 * valley}`);
    assert.ok(Math.abs(m.lengths.ridge - (L - D + wingL)) <= 3, `ridge ${m.lengths.ridge} vs ${L - D + wingL}`);
    return;
  }
  assert.fail("no L-shape seed found");
});
