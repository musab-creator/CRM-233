// Pricing research shown on the estimator's "Historical pricing" and
// "Market benchmark" pages. Generated from the original estimator's data;
// edit by hand from here on.

export interface HistoricalPricePoint {
  category: string;
  item: string;
  amount: string; // what the records show
  source: string;
  date: string;
  jobs: number; // how many jobs/invoices back it (0 = none)
  recommended: string;
  confidence: number; // 0-100
  note: string;
}

export const HISTORICAL_PRICING: HistoricalPricePoint[] = [
  {
    category: 'Roofing labor',
    item: 'Subcontract re-roof labor',
    amount: '$95.00 / square',
    source: 'Paid subcontractor invoices — High Caliber Roofing LLC',
    date: 'Oct 13 2025 – Jun 15 2026',
    jobs: 28,
    recommended: '$95.00 / sq',
    confidence: 92,
    note: 'Flat across 28 invoices with zero variance, and it ties exactly to the Crew line on the job breakdowns. The prompt\'s Gonzalez $65/sq and Pedro $70/sq could not be confirmed — Pedro and Gonzales appear only as crew names with bundle counts, never a rate.',
  },
  {
    category: 'Roofing labor',
    item: 'Two-story labor surcharge',
    amount: '$10.00 / square',
    source: 'Paid subcontractor invoices',
    date: 'Dec 18 2025 – May 17 2026',
    jobs: 4,
    recommended: '$10.00 / sq',
    confidence: 70,
    note: 'Six instances total: $5/sq once (Oct 2025), $10/sq four times, $25/sq once (Inv 773, a 6-sq line that looks like a billing error that was paid).',
  },
  {
    category: 'Roofing labor',
    item: 'Steep-slope labor charge',
    amount: 'not found',
    source: '—',
    date: '—',
    jobs: 0,
    recommended: '$0.00 until confirmed',
    confidence: 15,
    note: 'No invoice carries a steep, pitch, or slope line. The prompt\'s ~$5/sq is unverified. The crew\'s own words suggest the two-story line has been doing double duty for slope: "send roof reports moving forward … we can be more accurate on slope sizes."',
  },
  {
    category: 'Roofing labor',
    item: 'Repairs, per repair',
    amount: 'not found',
    source: '—',
    date: '—',
    jobs: 0,
    recommended: '$75.00 / repair (placeholder)',
    confidence: 15,
    note: 'No per-repair unit charge exists on any invoice. The prompt\'s ~$25 each is unverified — the only $25 figures found were per square (double-layer tear-off).',
  },
  {
    category: 'Roofing labor',
    item: 'Double-layer tear-off',
    amount: '$25.00 / square',
    source: 'Paid subcontractor invoice (2221 Minorcan St)',
    date: 'Feb 17 2026',
    jobs: 1,
    recommended: '$25.00 / sq',
    confidence: 45,
    note: 'Single observation. Treat as a planning figure and confirm with the crew before quoting a heavy tear-off.',
  },
  {
    category: 'Roofing labor',
    item: 'Decking / OSB, installed',
    amount: '$30.00 / sheet labor',
    source: 'Paid subcontractor invoices',
    date: 'Oct 2025 – Jun 2026',
    jobs: 16,
    recommended: '$66.00 / sheet all-in',
    confidence: 85,
    note: '$30 crew labor plus the sheet itself — 15/32" CDX was $36.00/sheet at ABC on 21 Jul 2026 (it has swung $29.75–$38.00 this year).',
  },
  {
    category: 'Material',
    item: 'Delivered material, all-in per installed square',
    amount: '$169 – $181 / sq',
    source: 'Paid ABC Supply invoices reconciled to four completed jobs',
    date: 'Oct 2025 – Jun 2026',
    jobs: 4,
    recommended: '$175.00 / sq',
    confidence: 80,
    note: '95040 Orchid $169.36 · 820 Bent Creek $173.20 · 15617 Lexington Park $176.27 · 3676 Ft Caroline $180.52. Includes underlayment, metal, vents, fasteners, delivery and 7.5% tax.',
  },
  {
    category: 'Material',
    item: 'IKO Cambridge field shingle',
    amount: '$109.00 / sq',
    source: 'ABC Supply rep quote, Branch 507 (Finn McNally)',
    date: 'Aug 13 2026',
    jobs: 1,
    recommended: '$109.00 / sq',
    confidence: 88,
    note: 'Firm written quote added to the account contract. IKO H&R $65/bdl, IKO starter 123LF $55/bdl.',
  },
  {
    category: 'Material',
    item: 'OC TruDefinition Duration field shingle',
    amount: '$119.01 / sq',
    source: 'ABC Supply contract catalogue ($39.67/bundle × 3)',
    date: 'Jun 16 2026',
    jobs: 1,
    recommended: '$119.01 / sq',
    confidence: 78,
    note: 'A 7 Jun catalogue spike to $144/sq was reversed the next day — ignore it. A paid 27 May invoice shows $111.00/sq before the June increase.',
  },
  {
    category: 'Material',
    item: 'Peel-and-stick / self-adhered underlayment',
    amount: '$32.13 / sq',
    source: 'ABC Supply catalogue — Polyglass IR-XE $62.65 per 1.95-sq roll',
    date: 'Jun 8 2026',
    jobs: 1,
    recommended: '$32.00 / sq',
    confidence: 72,
    note: 'Tarco MS300 works out to about $38.38/sq. Because peel-and-stick displaces synthetic underlayment at $6.40/sq, the true incremental cost is roughly $26/sq.',
  },
  {
    category: 'Material',
    item: 'Delivery',
    amount: '$142.00 / delivery',
    source: 'Paid ABC Supply invoice 2009995293-001',
    date: 'May 27 2026',
    jobs: 1,
    recommended: '$142.00',
    confidence: 82,
    note: '$100.00 delivery charge plus the $42.00 monthly fuel surcharge. Shop-drops of full pallets reduce this.',
  },
  {
    category: 'Job cost',
    item: 'Dumpster / roll-off',
    amount: '$400 + $50 per ton over 2 tons',
    source: 'Paid JunkEZ LLC invoices',
    date: 'Jul 13 – Aug 11 2026',
    jobs: 5,
    recommended: '$525.00 typical',
    confidence: 85,
    note: 'Actual all-in totals ran $400–$908.50; $500–$570 is typical for a single haul. Before April 2026 the crew billed it at $417–$634.50 with markup. The prompt\'s $400 dumpster figure matches the base rate but not the delivered cost.',
  },
  {
    category: 'Job cost',
    item: 'Permit — total per job',
    amount: '$90 – $260 municipal + $22–$57 NOC + $75 service',
    source: 'Paid invoices and job breakdowns',
    date: 'Oct 2025 – Aug 2026',
    jobs: 8,
    recommended: '$325.00 all-in',
    confidence: 70,
    note: 'Municipal fee varies by county — Duval, Clay, St. Johns and Nassau all differ. The $75 permitting service fee was disputed in Jan 2026 but kept being billed.',
  },
  {
    category: 'Overhead',
    item: 'Overhead per job',
    amount: '10% of contract  OR  flat $1,800',
    source: 'Job breakdown sheets — two incompatible conventions in use',
    date: 'Oct 2025 – Aug 2026',
    jobs: 12,
    recommended: '10% of contract',
    confidence: 50,
    note: 'On a $41,858 job the two methods differ by $2,386 of stated profit, which is about $1,193 of rep commission. Pick one convention and apply it everywhere.',
  },
  {
    category: 'Overhead',
    item: 'Verified recurring software / insurance',
    amount: '$1,099 / month',
    source: 'Vendor receipts and internal cancellation list',
    date: 'Jul – Aug 2026',
    jobs: 0,
    recommended: '—',
    confidence: 60,
    note: 'GL insurance $434.65 · Roofr ~$276 · Dialpad $252.68 (cancelled) · Active Knocker $56.10 (cancelled) · Replit $20 · Adobe $19.99 · Ramp $29.24. Excludes Regus rent, CompanyCam, Comcast, payroll and vehicles, so true overhead is materially higher.',
  },
  {
    category: 'Commission',
    item: 'Sales commission',
    amount: '25% of profit  OR  10% of contract',
    source: 'Internal closeout emails — two plans running at once',
    date: 'Jul 29 – Aug 15 2026',
    jobs: 5,
    recommended: '10% of contract',
    confidence: 55,
    note: 'Ali and Mark are paid 25% of job profit; Tatjana is paid 10% of the total contract. There is an unresolved dispute and no signed written plan. Older documents describe a 50%-of-profit split.',
  },
  {
    category: 'Gutters',
    item: '6-inch gutter — cost per LF',
    amount: 'not found',
    source: '—',
    date: '—',
    jobs: 0,
    recommended: '$6.75 / LF (your figure)',
    confidence: 20,
    note: 'No $/LF cost appears anywhere in email or Drive. The AMF gutter price sheet dated 1 Jun 2026 is sitting unopened as a PDF attachment; it should settle this.',
  },
  {
    category: 'Gutters',
    item: '7-inch gutter — cost per LF',
    amount: 'not found',
    source: '—',
    date: '—',
    jobs: 0,
    recommended: '$12.25 / LF (your figure)',
    confidence: 20,
    note: 'Same as above. AMF confirmed they fabricate 7" box bevel, but no price was quoted in any readable message.',
  },
  {
    category: 'Gutters',
    item: 'Gutter subcontract job totals',
    amount: '$5,120 · $2,600 · $2,100 · $500',
    source: 'Project Exteriors Inc QuickBooks estimates',
    date: 'Sep 2025 – Feb 2026',
    jobs: 4,
    recommended: '—',
    confidence: 35,
    note: 'Only the $5,120 job is confirmed approved and described as a gutter invoice. None of the four states linear feet, so no $/LF can be derived. Do not average them.',
  },
  {
    category: 'Gutters',
    item: 'Rule-of-thumb value of a full gutter run',
    amount: 'about $2,000',
    source: 'Internal sales training — HOW TO MAXIMIZE YOUR PROFIT',
    date: 'Mar 2 2026',
    jobs: 0,
    recommended: '—',
    confidence: 40,
    note: 'Used for trading against a deductible, not as a price list. At $12/LF that implies roughly 165 LF.',
  },
  {
    category: 'Reference only',
    item: 'Xactimate 6" gutter R&R (carrier pricing)',
    amount: '$13.02 / LF',
    source: 'Carrier price list FLJA8X_FEB26 — NOT company cost',
    date: 'Feb 18 2026',
    jobs: 1,
    recommended: 'reference only',
    confidence: 0,
    note: 'Insurance pricing. Guard/screen R&R $4.09/LF, detach-and-reset $4.28/LF. Never treat carrier or supplement estimates as company cost.',
  },
  {
    category: 'Selling price',
    item: 'Observed cash retail price per square',
    amount: '$554.72 / measured sq',
    source: 'Signed cash green sheet, 15617 Lexington Park Blvd',
    date: 'Oct 3 2025',
    jobs: 1,
    recommended: '—',
    confidence: 45,
    note: '$25,850 ÷ 46.6 measured squares (7/12 pitch, 18 facets). On billable squares it is about $470/sq. A single observation — your $550–$620 table supersedes it.',
  },
  {
    category: 'Selling price',
    item: 'Completed-job gross margin',
    amount: '22.7% – 57.4%, median ≈ 32%',
    source: 'Per-job breakdown sheets',
    date: 'Oct 2025 – Aug 2026',
    jobs: 10,
    recommended: '35% floor / 45% target',
    confidence: 65,
    note: 'Cash jobs land at the bottom (22.7% and 29.5%); insurance jobs with successful supplements run 40–57%. Several sheets have broken formulas, so treat the low end as approximate.',
  },
];

// Summary tiles on the historical pricing page.
export function historicalPricingSummary(points: HistoricalPricePoint[] = HISTORICAL_PRICING) {
  return {
    reviewed: points.length,
    highConfidence: points.filter((p) => p.confidence >= 75).length,
    unverified: points.filter((p) => p.confidence < 45 && p.confidence > 0).length,
    categories: Array.from(new Set(points.map((p) => p.category))),
  };
}

// Confidence bar colour: >= 75 ok, >= 45 warn, else bad.
export function confidenceTone(confidence: number): 'ok' | 'warn' | 'bad' {
  return confidence >= 75 ? 'ok' : confidence >= 45 ? 'warn' : 'bad';
}

export const MARKET_RESEARCHED_ON = '2026-08-24';

export interface RoofMarket {
  unit: string;
  low: number;
  avgLo: number;
  avg: number;
  avgHi: number;
  high: number;
  sqftAvg: number;
  grades: { grade: string; lo: number; avg: number; hi: number; note: string }[];
  brands: { brand: string; lo: number; hi: number; note: string }[];
  adders: { adder: string; market: string; ours: string; verdict: 'below' | 'avg' | 'above'; note: string }[];
  notes: string[];
}

// Jacksonville re-roof pricing per square, Aug 2026.
export const ROOF_MARKET: RoofMarket = {
  unit: 'per square (100 sq ft of roof)',
  low: 425,
  avgLo: 525,
  avg: 610,
  avgHi: 700,
  high: 850,
  sqftAvg: 6.1,
  grades: [
    {
      grade: '3-tab / economy',
      lo: 375,
      avg: 460,
      hi: 550,
      note: 'Shrinking product — several Jax contractors no longer install 3-tab on wind-rating grounds.',
    },
    {
      grade: 'Architectural (market standard)',
      lo: 450,
      avg: 610,
      hi: 850,
      note: 'The band every mainstream Jacksonville quote lands in. Center of eleven 2026 sources: $610/sq ($6.10/sq ft).',
    },
    {
      grade: 'Premium architectural',
      lo: 650,
      avg: 775,
      hi: 950,
      note: 'Duration STORM, UHDZ, Landmark Premium tier.',
    },
    {
      grade: 'Impact-resistant Class 4',
      lo: 700,
      avg: 850,
      hi: 1000,
      note: 'Earns wind-mitigation insurance credits; common FL upsell.',
    },
    {
      grade: 'Designer / luxury',
      lo: 800,
      avg: 1100,
      hi: 1400,
      note: 'Grand Sequoia, Berkshire, Camelot class.',
    },
  ],
  brands: [
    {
      brand: 'IKO Cambridge',
      lo: 425,
      hi: 675,
      note: 'Value tier in this market — matches our $550–570 range near its middle.',
    },
    {
      brand: 'Atlas Pinnacle / Pro-Lam',
      lo: 500,
      hi: 775,
      note: 'Value-to-mid tier; our cheapest material buy right now ($102/sq).',
    },
    {
      brand: 'GAF Timberline HDZ',
      lo: 500,
      hi: 800,
      note: 'WindProven unlimited-wind warranty needs a GAF-certified installer.',
    },
    {
      brand: 'Owens Corning Duration',
      lo: 525,
      hi: 825,
      note: 'Upper-middle tier — our $580–620 range sits low inside it.',
    },
    { brand: 'CertainTeed Landmark PRO', lo: 575, hi: 875, note: 'Top of the mainstream brands.' },
  ],
  adders: [
    {
      adder: 'Steep pitch 7/12',
      market: '+16% (≈ +$95/sq on avg)',
      ours: '+$20/sq',
      verdict: 'below',
      note: 'Market multiplies the whole price; we add a flat step. At 7/12 we are far below market.',
    },
    {
      adder: 'Steep pitch 8/12–10/12',
      market: '+30% (≈ +$180/sq)',
      ours: '+$40 to +$80/sq',
      verdict: 'below',
      note: 'Room to raise: even +$80/sq at 10/12 is less than half the market adder.',
    },
    {
      adder: 'Steep pitch 12/12',
      market: '+50% (≈ +$305/sq)',
      ours: '+$120/sq',
      verdict: 'below',
      note: 'Competitive edge on steep roofs — or money left on the table.',
    },
    {
      adder: 'Two-story',
      market: '+$50–100/sq',
      ours: '+$20/sq',
      verdict: 'below',
      note: 'Market charges 2.5–5× what we do.',
    },
    {
      adder: 'Extra tear-off layer',
      market: '+$100–250/sq',
      ours: '+$45/sq',
      verdict: 'below',
      note: 'Our crew cost alone was $25/sq — a $45 sell is thin.',
    },
    {
      adder: 'Decking, per sheet',
      market: '$75–150',
      ours: '$95',
      verdict: 'avg',
      note: 'Right in the Jacksonville consensus.',
    },
    {
      adder: 'Peel-and-stick / SWR',
      market: '$45–85/sq',
      ours: '+$40/sq',
      verdict: 'below',
      note: 'Just under the market floor. In NE Florida a sealed roof deck is effectively code-standard, so many competitors bury it in the base price.',
    },
    { adder: 'Permit (Duval)', market: '$180–550 all-in', ours: '$350', verdict: 'avg', note: 'Mid-band.' },
    {
      adder: 'Dumpster',
      market: '$340–870, usually bundled',
      ours: '$600',
      verdict: 'avg',
      note: 'Mid-band; our real cost runs ~$525.',
    },
  ],
  notes: [
    'Average Jacksonville architectural re-roof, Aug 2026: $6.10 per sq ft = $610 per square. Fair-market band $525–700/sq.',
    'Below $425/sq is the red-flag zone — quotes there usually hide felt-for-peel-and-stick swaps, no permit, or excluded tear-off.',
    '$425–525/sq is the honest competitive band: value shingle, simple roof, cash job, lean overhead.',
    'Above $850/sq needs premium product or real complexity to justify.',
    'Cash jobs price $450–550/sq; insurance-scope jobs run $650–850/sq against Xactimate line items.',
    'Prices are inflating — suppliers raised shingles 6–10% in April and again in June 2026. Q1 figures already read low.',
  ],
};

interface Band {
  lo: number;
  avg: number;
  hi: number;
  floor?: number;
  note: string;
}

export interface GutterMarket {
  g5: Band;
  g6: Band;
  g7: Band;
  guards: Band;
  ds: { market: string; note: string };
  removal: Band;
  laborOnly: Band;
  fascia: Band;
  jobs: { job: string; low: string; avg: string; high: string }[];
  notes: string[];
}

// Jacksonville gutter pricing per linear foot, Aug 2026.
export const GUTTER_MARKET: GutterMarket = {
  g5: {
    lo: 5.5,
    avg: 7.5,
    hi: 10,
    note: 'Disappearing product in NE FL — at least one major Jax installer refuses to hang 5-inch at all (52 in/yr of rain).',
  },
  g6: {
    lo: 8,
    avg: 10.5,
    hi: 14,
    floor: 7.5,
    note: 'Jacksonville\'s own published floor is $9/LF (Gutter Pro). Below $7.50/LF expect thinner gauge or wide hanger spacing.',
  },
  g7: {
    lo: 12,
    avg: 15,
    hi: 19,
    note: 'No source publishes a 7-inch rate — this is scaled ~1.4× from the 6-inch consensus. Treat as an estimate.',
  },
  guards: {
    lo: 4,
    avg: 10.5,
    hi: 14,
    note: 'Independent installer pricing. National brands (LeafFilter, LeafGuard, HomeCraft) charge $18–70/LF for comparable product — a $1,800–7,000 premium per house.',
  },
  ds: {
    market: '$110–150 per 3x4 drop (≈$10/LF)',
    note: 'Gutter Pro Jacksonville publishes exactly $110/drop — the most reliable local number found.',
  },
  removal: { lo: 0.65, avg: 1.25, hi: 2, note: 'Often waived when bundled with full replacement.' },
  laborOnly: { lo: 4, avg: 5, hi: 6, note: 'Florida-specific sources cluster $4–6/LF.' },
  fascia: {
    lo: 12,
    avg: 18,
    hi: 25,
    note: 'Jacksonville runs far above the national $5–12/LF — wood rot plus hurricane nailing schedules.',
  },
  jobs: [
    { job: '120 LF + 4 drops', low: '$1,300', avg: '$1,850', high: '$2,700' },
    { job: '150 LF + 5 drops', low: '$1,600', avg: '$2,300', high: '$3,400' },
    { job: '200 LF + 6 drops', low: '$2,100', avg: '$3,000', high: '$4,500' },
    { job: '250 LF + 8 drops', low: '$2,600', avg: '$3,800', high: '$5,600' },
  ],
  notes: [
    '6-inch .032 aluminum with 3x4 downspouts is the NE Florida baseline, not an upgrade.',
    'Aluminum is inflating: 25% tariff plus a 10% manufacturer increase hit 2026 coil. Old quotes read low.',
    'Our $12/LF 6-inch default sits above the $10.50 average and inside the fair band — solidly priced, mildly premium.',
    'Our $20/LF 7-inch default is above the derived $19 high — defensible only because nobody publishes 7-inch pricing; quote-check it per job.',
    'Our $9/LF guards are mid-market for independents and 2–6× cheaper than the national brands — a strong sales angle.',
  ],
};

// The benchmark bar's chart range for each comparison on the market page.
export const MARKET_BAR_RANGES = {
  roofPerSquare: { min: 350, max: 950 },
  g6PerLF: { min: 4, max: 22 },
  g7PerLF: { min: 6, max: 24 },
} as const;

// Position (0-100%) of a value on a min..max benchmark bar, clamped.
export function benchmarkBarPosition(value: number, min: number, max: number): number {
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}
