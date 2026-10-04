import type { BrandMaterialGroup, MaterialLine } from "./types";

// Brand-specific coverage per unit. Values reproduce the reference
// Diversity Roofing report (1912 Grove Bluff Rd) exactly — see
// materials.test.ts — and match manufacturer published coverage where
// listed (e.g. GAF Pro-Start 120.33 LF, Seal-A-Ridge 25 LF, CertainTeed
// Shadow Ridge 30 LF, Owens Corning DecoRidge 20 LF).
export const BRANDS = ["IKO", "CertainTeed", "GAF", "Owens Corning", "Atlas"] as const;

const SHINGLES: [string, number][] = [
  ["IKO - Cambridge", 33.3],
  ["CertainTeed - Landmark", 32.8],
  ["GAF - Timberline", 32.8],
  ["Owens Corning - Duration", 32.8],
  ["Atlas - Pristine", 33.0],
];
const STARTER: [string, number][] = [
  ["IKO - Leading Edge Plus", 123],
  ["CertainTeed - SwiftStart", 116],
  ["GAF - Pro-Start", 120.33],
  ["Owens Corning - Starter Strip", 105],
  ["Atlas - Pro-Cut", 140],
];
const ICE_WATER: [string, number][] = [
  ["IKO - StormShield", 66.7],
  ["CertainTeed - WinterGuard", 66.7],
  ["GAF - WeatherWatch", 66.7],
  ["Owens Corning - WeatherLock", 75],
  ["Atlas - Weathermaster", 66.7],
];
const SYNTHETIC: [string, number][] = [
  ["IKO - Stormtite", 1000],
  ["CertainTeed - RoofRunner", 1000],
  ["GAF - Deck-Armor", 1000],
  ["Owens Corning - RhinoRoof", 1000],
  ["Atlas - Summit", 1000],
];
const CAPPING: [string, number][] = [
  ["IKO - Hip and Ridge", 40],
  ["CertainTeed - Shadow Ridge", 30],
  ["GAF - Seal-A-Ridge", 25],
  ["Owens Corning - DecoRidge", 20],
  ["Atlas - Pro-Cut H&R", 31],
];

/** Material waste columns: 0%, 10%, the recommended %, 15% (plus 20% if needed). */
export function materialWasteColumns(recommended: number): number[] {
  const cols = [...new Set([0, 10, recommended, 15])].sort((a, b) => a - b);
  if (cols.length < 4) cols.push(20);
  return cols;
}

export interface MaterialInputs {
  pitchedAreaSqFt: number; // exact, unrounded
  eaves: number;
  rakes: number;
  ridges: number;
  hips: number;
  valleys: number;
  flashing: number; // wall + step flashing
}

// Small epsilon so 32.8 × 183 = 6002.4 doesn't become 184 through float noise.
const up = (x: number) => Math.ceil(x - 1e-9);

export function brandMaterials(i: MaterialInputs, wasteCols: number[]): BrandMaterialGroup[] {
  const at = (base: number) => wasteCols.map((w) => base * (1 + w / 100));
  const group = (label: string, base: number, baseUnit: string, unit: string, table: [string, number][]) => ({
    label,
    base,
    baseUnit,
    rows: table.map(([product, cover]) => ({ product, unit, qty: at(base).map((q) => up(q / cover)) })),
  });
  const eavesRakes = i.eaves + i.rakes;
  return [
    group("Shingle (total sqft)", i.pitchedAreaSqFt, "sqft", "bundle", SHINGLES),
    group("Starter (eaves + rakes)", eavesRakes, "ft", "bundle", STARTER),
    group("Ice and Water (eaves + valleys + flashings)", i.eaves + i.valleys + i.flashing, "ft", "roll", ICE_WATER),
    group("Synthetic (total sqft; no laps)", i.pitchedAreaSqFt, "sqft", "roll", SYNTHETIC),
    group("Capping (hips + ridges)", i.hips + i.ridges, "ft", "bundle", CAPPING),
    {
      label: "Other",
      base: 0,
      baseUnit: "",
      rows: [
        // Valley metal and drip edge are cut to length, so no waste is added.
        { product: "8' Valley (no laps)", unit: "sheet", qty: wasteCols.map(() => up(i.valleys / 8)) },
        { product: "10' Drip Edge (eaves + rakes; no laps)", unit: "sheet", qty: wasteCols.map(() => up(eavesRakes / 10)) },
      ],
    },
  ];
}

/** Short generic order list (GAF reference products) at the recommended waste. */
export function quickMaterials(i: MaterialInputs, wastePct: number): MaterialLine[] {
  const k = 1 + wastePct / 100;
  const area = i.pitchedAreaSqFt * k;
  const lines: MaterialLine[] = [
    { item: "Architectural shingles", qty: up(area / 32.8), unit: "bundles", basis: `${Math.round(area).toLocaleString()} sq ft at ${wastePct}% waste` },
    { item: "Synthetic underlayment", qty: up(area / 1000), unit: "rolls", basis: "10 SQ (1,000 sq ft) per roll" },
    { item: "Starter strip", qty: up(((i.eaves + i.rakes) * k) / 120.33), unit: "bundles", basis: "eaves + rakes, 120.33 LF/bundle" },
    { item: "Hip & ridge cap", qty: up(((i.hips + i.ridges) * k) / 25), unit: "bundles", basis: "hips + ridges, 25 LF/bundle" },
    { item: "Ice & water", qty: up(((i.eaves + i.valleys + i.flashing) * k) / 66.7), unit: "rolls", basis: "eaves + valleys + flashings, 66.7 LF/roll" },
    { item: "Drip edge", qty: up((i.eaves + i.rakes) / 10), unit: "10' pcs", basis: "eaves + rakes, no laps" },
  ];
  if (i.valleys > 0) lines.push({ item: "Valley metal", qty: up(i.valleys / 8), unit: "8' sheets", basis: "valleys, no laps" });
  return lines;
}
