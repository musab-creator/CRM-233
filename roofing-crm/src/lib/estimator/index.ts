// Diversity Roofing estimator: pricing engine, data and helpers, ported from
// the single-file estimator (public/tools/estimator.html) with identical
// numbers. Persistence, roles and the roof-report handoff live in
// src/store/estimator.ts.
//
//   types       Estimate, PriceBook, EstimateTotals, ... (original field names)
//   format      toNumber, round2, money/percent/date formatting, deepMerge, getPath/setPath
//   defaults    defaultPriceBook(), default proposal exclusions/allowances
//   factories   newEstimate, newRoofSection, newGutterRun, sample estimates
//   calc        estimateTotals (every price, cost and margin), costStructure, priceForMargin
//   warnings    estimateWarnings, pricing staleness
//   takeoff     roof report -> takeoff -> applyTakeoff; measurementConfidence
//   derived     figures the estimator's screens computed (scenarios, breakdowns, dashboard, actuals...)
//   proposal    proposal payment schedule, insurance total, scope wording, contract terms
//   selftest    runSelfTest(), the estimator's built-in checks
//   navigation  screens, manager-only screens, admin price-book fields
//   market      historical pricing evidence and Jacksonville market benchmarks
//   contracts   cash and insurance contract conditions
//
// Tests: src/lib/estimator/__tests__/*.test.ts, run with
//   node --experimental-strip-types <file>

export type * from './types';
export * from './format';
export * from './defaults';
export * from './factories';
export * from './calc';
export * from './warnings';
export * from './takeoff';
export * from './derived';
export * from './proposal';
export * from './selftest';
export * from './navigation';
export * from './market';
export * from './contracts';
