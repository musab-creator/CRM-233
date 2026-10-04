import type { PriceBook } from './types';

// The estimator's built-in price book (verified 2026-08-24). A manager's
// saved edits are deep-merged over a fresh copy of this on load, so a rule
// added here later reaches price books saved before it existed.
export function defaultPriceBook(): PriceBook {
  return {
    version: '2026-08-24',
    company: {
      name: 'Diversity Contracting',
      legal: 'Diversity Contracting LLC',
      addr: '10151 Deerwood Park Blvd, Suite 250, Building 200',
      city: 'Jacksonville, FL 32256',
      phone: '(904) 862-6885',
      email: 'jacksonville@diversity-roofing.com',
      web: 'diversity-roofing.com',
      license: 'Licensed & Insured',
      tagline: 'Protecting homes. Respecting people.',
    },
    targets: {
      minMargin: 30,
      goodMargin: 40,
      quoteValidDays: 30,
      staleAfterDays: 120,
      maxDiscountPct: 10,
      depositPct: 50,
    },
    mfrs: {
      IKO: {
        label: 'IKO',
        competitive: 550,
        standard: 560,
        high: 570,
        min: 550,
        max: 570,
        products: ['Cambridge', 'Dynasty', 'Nordic'],
        colors: ['Weatherwood', 'Dual Black', 'Driftshake', 'Harvard Slate', 'Frostone Grey'],
      },
      OC: {
        label: 'Owens Corning',
        competitive: 580,
        standard: 600,
        high: 620,
        min: 580,
        max: 620,
        products: ['TruDefinition Duration', 'Duration Designer', 'Oakridge', 'Duration STORM'],
        colors: ['Onyx Black', 'Estate Gray', 'Driftwood', 'Desert Tan', 'Sand Dune'],
      },
    },
    roof: {
      pitchFreeUpTo: 6,
      pitchStep: 20,
      story2: 20,
      story3: 40,
      peelStick: 40,
      defaultWaste: 15,
      tearOffExtraLayer: 45,
      deckingSheet: 95,
      repairEach: 150,
      permit: 350,
      dumpster: 600,
      delivery: 150,
      dripEdgeLF: 3.5,
      starterLF: 2.25,
      ridgeCapLF: 7,
      valleyLF: 8.5,
      flashingLF: 9,
      pipeBootEach: 85,
      ventEach: 145,
      skylightEach: 650,
      chimneyEach: 750,
      flatRoofSq: 850,
      taxRate: 0,
      taxOn: 'none',
    },
    gutter: {
      g6: { label: '6" Seamless K-Style', sell: 12, min: 12, costLo: 6.5, costHi: 7 },
      g7: { label: '7" Seamless / Box', sell: 20, min: 20, costLo: 12, costHi: 12.5 },
      laborOnly: { options: [4, 4.5, 5], def: 4.5, min: 4 },
      removalLF: 2,
      guardLF: 9,
      downspouts: { '2x3': 9, '3x4': 12, '4x5': 16 },
      miterInside: 35,
      miterOutside: 35,
      endCap: 8,
      outlet: 12,
      elbow: 12,
      splashBlock: 25,
      undergroundEach: 185,
      fasciaLF: 14,
      soffitLF: 12,
      story2LF: 1.5,
      difficultLF: 2,
      colors: ['White', 'Almond', 'Musket Brown', 'Bronze', 'Black', 'Clay', 'Royal Brown', 'Mill Finish'],
      taxRate: 0,
    },
    cost: {
      materialPerSq: 175,
      laborPerSq: 95,
      steepPerSq: 0,
      story2PerSq: 10,
      story3PerSq: 20,
      peelStickPerSq: 32,
      tearOffLayerPerSq: 25,
      deckingSheet: 66,
      repairEach: 75,
      dumpster: 525,
      permitService: 75,
      permitFee: 225,
      noc: 25,
      delivery: 142,
      g6PerLF: 6.75,
      g7PerLF: 12.25,
      guardPerLF: 4.5,
      gutterRemovalLF: 1,
      gutterLaborOnlyLF: 2.75,
      downspoutPerLF: 4.5,
      gutterAccessoryPct: 45,
      commissionBasis: 'contract',
      commissionPct: 10,
      overheadBasis: 'pct',
      overheadPct: 10,
      overheadFlat: 1800,
      financingPct: 0,
    },
  };
}

export const DEFAULT_EXCLUSIONS = [
  'Structural repair, truss or rafter work, and any concealed damage discovered after tear-off',
  'Mold, asbestos, or other hazardous-material remediation',
  'Interior repairs, painting, or drywall',
  'Solar panel detach and reset unless listed as a line item',
  'Permit fees beyond the allowance shown, and any engineering required by the building department',
  'Landscaping restoration and driveway protection beyond normal care',
];

export const DEFAULT_ALLOWANCES = [
  'Decking replacement is billed per sheet at the rate shown; only sheets actually replaced are charged',
  'Rotted fascia or sub-fascia discovered at tear-off is billed at the per-foot rate shown',
  'Permit allowance is an estimate; the actual municipal fee is billed at cost if it exceeds the allowance',
];

// Printed on new insurance proposals until the rep fills them in.
export const DEFAULT_INSURANCE_CONTRACTOR = 'Diversity Contracting';
export const DEFAULT_INSURANCE_CONTRACTOR_PHONE = '904-979-0556';

// First estimate number when nothing has been saved yet ("DR-1001").
export const FIRST_ESTIMATE_SEQ = 1001;
