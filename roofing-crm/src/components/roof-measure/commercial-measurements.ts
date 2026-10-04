import type { RoofMeasurements } from '@/types';
import { commercialTotals, type CommercialModel, type CommercialOptions } from '@/lib/roof-measure/commercial';

// A commercial measurement in the CRM's RoofMeasurements fields (the engine
// maps only the residential totals). Low-slope area is the flat area, steep
// sections the pitched area; open roof edges (edge metal) stand in for eaves /
// drip edge, parapets plus walls between levels for flashing, and detected
// rooftop units, curbs and vents are the penetrations.
const round2 = (n: number) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

export function commercialMeasurements(M: CommercialModel, opts: CommercialOptions): RoofMeasurements {
  const T = commercialTotals(M, opts);
  const steep = M.sections.filter((s) => s.steep).sort((a, b) => b.slopedM2 - a.slopedM2);
  return {
    totalSqFt: round2(T.totalSF),
    pitchedSqFt: round2(T.steepSF),
    flatSqFt: round2(T.lowSF),
    twoStorySqFt: 0,
    pitch: T.steepSF > T.lowSF && steep.length ? Math.round(steep[0].slope * 12) : 0,
    facets: M.sections.length,
    eaves: round2(T.edgeLF),
    rakes: 0,
    valleys: 0,
    hipsRidges: 0,
    eavesRakes: round2(T.edgeLF),
    flashing: round2(T.parLF + T.wallLF),
    penetrations: T.pens.length,
    wastePct: Number.isFinite(opts.waste) ? opts.waste : 10,
  };
}
