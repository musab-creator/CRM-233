import { test } from "node:test";
import assert from "node:assert/strict";
import { brandMaterials, materialWasteColumns } from "./materials";

// Inputs and expected quantities copied from the reference Diversity Roofing
// report for 1912 Grove Bluff Rd (5,993 sq ft, 23 facets, 13% recommended).
const ft = (f: number, i: number) => f + i / 12;
const inputs = {
  pitchedAreaSqFt: 5993.4,
  eaves: ft(174, 4),
  rakes: ft(162, 5),
  ridges: ft(58, 7),
  hips: ft(221, 9),
  valleys: ft(183, 1),
  flashing: ft(0, 7) + ft(34, 5),
};

test("waste columns match the reference report", () => {
  assert.deepEqual(materialWasteColumns(13), [0, 10, 13, 15]);
  assert.deepEqual(materialWasteColumns(10), [0, 10, 15, 20]);
});

test("brand quantities reproduce the reference report exactly", () => {
  const groups = brandMaterials(inputs, [0, 10, 13, 15]);
  const table = Object.fromEntries(groups.flatMap((g) => g.rows.map((r) => [r.product, r.qty])));
  const expected: Record<string, number[]> = {
    "IKO - Cambridge": [180, 198, 204, 207],
    "CertainTeed - Landmark": [183, 201, 207, 211],
    "GAF - Timberline": [183, 201, 207, 211],
    "Owens Corning - Duration": [183, 201, 207, 211],
    "Atlas - Pristine": [182, 200, 206, 209],
    "IKO - Leading Edge Plus": [3, 4, 4, 4],
    "CertainTeed - SwiftStart": [3, 4, 4, 4],
    "GAF - Pro-Start": [3, 4, 4, 4],
    "Owens Corning - Starter Strip": [4, 4, 4, 4],
    "Atlas - Pro-Cut": [3, 3, 3, 3],
    "IKO - StormShield": [6, 7, 7, 7],
    "CertainTeed - WinterGuard": [6, 7, 7, 7],
    "GAF - WeatherWatch": [6, 7, 7, 7],
    "Owens Corning - WeatherLock": [6, 6, 6, 7],
    "Atlas - Weathermaster": [6, 7, 7, 7],
    "IKO - Stormtite": [6, 7, 7, 7],
    "GAF - Deck-Armor": [6, 7, 7, 7],
    "IKO - Hip and Ridge": [8, 8, 8, 9],
    "CertainTeed - Shadow Ridge": [10, 11, 11, 11],
    "GAF - Seal-A-Ridge": [12, 13, 13, 13],
    "Owens Corning - DecoRidge": [15, 16, 16, 17],
    "Atlas - Pro-Cut H&R": [10, 10, 11, 11],
    "8' Valley (no laps)": [23, 23, 23, 23],
    "10' Drip Edge (eaves + rakes; no laps)": [34, 34, 34, 34],
  };
  for (const [product, qty] of Object.entries(expected)) assert.deepEqual(table[product], qty, product);
});
