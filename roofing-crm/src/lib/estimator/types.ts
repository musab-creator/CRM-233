// Data shapes for the Diversity Roofing estimator.
//
// Estimates and the price book keep the exact field names the original
// single-file estimator (public/tools/estimator.html) stored in
// localStorage["dr_estimator_v1"], so estimates made there load here
// unchanged. Numeric fields are typed as numbers, but older saves and form
// inputs can hold numeric strings or blanks; every calculation coerces with
// toNumber() exactly like the original did.

// ==================== PRICE BOOK ====================

export interface CompanyInfo {
  name: string;
  legal: string;
  addr: string;
  city: string;
  phone: string;
  email: string;
  web: string;
  license: string;
  tagline: string;
}

export interface Targets {
  minMargin: number; // gross margin floor, %
  goodMargin: number; // healthy gross margin, %
  quoteValidDays: number;
  staleAfterDays: number; // warn when pricing.version is older than this
  maxDiscountPct: number;
  depositPct: number;
}

export type PriceTier = 'competitive' | 'standard' | 'high' | 'custom';

export interface Manufacturer {
  label: string;
  competitive: number; // $/square
  standard: number;
  high: number;
  min: number; // approved custom-price range
  max: number;
  products: string[];
  colors: string[];
}

export interface RoofRules {
  pitchFreeUpTo: number; // no pitch surcharge up to this rise/12
  pitchStep: number; // $/sq per pitch point above pitchFreeUpTo
  story2: number; // $/sq
  story3: number; // $/sq, three stories and up
  peelStick: number; // $/sq
  defaultWaste: number; // %
  tearOffExtraLayer: number;
  deckingSheet: number;
  repairEach: number;
  permit: number;
  dumpster: number;
  delivery: number;
  dripEdgeLF: number;
  starterLF: number;
  ridgeCapLF: number;
  valleyLF: number;
  flashingLF: number;
  pipeBootEach: number;
  ventEach: number;
  skylightEach: number;
  chimneyEach: number;
  flatRoofSq: number;
  taxRate: number;
  taxOn: TaxOn;
}

export type GutterSize = 'g6' | 'g7';

export interface GutterProduct {
  label: string;
  sell: number; // $/LF
  min: number; // minimum selling $/LF
  costLo: number;
  costHi: number;
}

export interface GutterRules {
  g6: GutterProduct;
  g7: GutterProduct;
  laborOnly: { options: number[]; def: number; min: number };
  removalLF: number;
  guardLF: number;
  downspouts: Record<string, number>; // size ("2x3", "3x4", "4x5") -> $/LF
  miterInside: number;
  miterOutside: number;
  endCap: number;
  outlet: number;
  elbow: number;
  splashBlock: number;
  undergroundEach: number;
  fasciaLF: number;
  soffitLF: number;
  story2LF: number;
  difficultLF: number;
  colors: string[];
  taxRate: number;
}

export type CommissionBasis = 'contract' | 'profit';
export type OverheadBasis = 'pct' | 'flat';

export interface CostRules {
  materialPerSq: number;
  laborPerSq: number;
  steepPerSq: number; // per pitch point above pitchFreeUpTo, per square
  story2PerSq: number;
  story3PerSq: number;
  peelStickPerSq: number;
  tearOffLayerPerSq: number;
  deckingSheet: number;
  repairEach: number;
  dumpster: number;
  permitService: number;
  permitFee: number;
  noc: number;
  delivery: number;
  g6PerLF: number;
  g7PerLF: number;
  guardPerLF: number;
  gutterRemovalLF: number;
  gutterLaborOnlyLF: number;
  downspoutPerLF: number;
  gutterAccessoryPct: number; // accessory cost as % of its selling price
  commissionBasis: CommissionBasis;
  commissionPct: number;
  overheadBasis: OverheadBasis;
  overheadPct: number;
  overheadFlat: number;
  financingPct: number;
}

export interface PriceBook {
  version: string; // YYYY-MM-DD the pricing was last verified
  company: CompanyInfo;
  targets: Targets;
  mfrs: Record<string, Manufacturer>;
  roof: RoofRules;
  gutter: GutterRules;
  cost: CostRules;
}

// ==================== ESTIMATE ====================

export type EstimateScope = 'roof' | 'gutter' | 'both';
export type EstimateStatus = 'draft' | 'sent' | 'accepted' | 'lost' | 'completed';
export type TaxOn = 'none' | 'total';
export type PeelStickMode = 'none' | 'full' | 'partial';
export type GutterMode = 'new' | 'labor' | 'material';
export type Confidence = 'rough' | 'measured' | 'verified';
export type ContractType = 'cash' | 'insurance';

export interface Customer {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
}

export interface RoofSection {
  id: string;
  name: string;
  measured: number; // squares, before waste
  waste: number; // %
  billableOverride: number; // > 0 replaces measured + waste
  mfr: string; // key of PriceBook.mfrs
  tier: PriceTier;
  custom: number; // $/sq when tier is "custom"
  product: string;
  color: string;
  pitch: number; // rise per 12
  stories: number;
  psMode: PeelStickMode;
  psSquares: number; // when psMode is "partial"
}

export interface GutterRun {
  id: string;
  name: string;
  size: GutterSize;
  lf: number;
  mode: GutterMode;
  sellOverride: number; // > 0 replaces the price-book $/LF
  laborRate: number; // $/LF when mode is "labor"
  color: string;
  stories: number;
  difficult: boolean;
  removal: boolean;
  guards: boolean;
  guardLF: number; // 0 = guards over the full run
}

export type RoofItemKey =
  | 'tearoff' | 'decking' | 'repairs' | 'permit' | 'dumpster' | 'delivery'
  | 'dripedge' | 'starter' | 'ridge' | 'valley' | 'flashing' | 'boots'
  | 'vents' | 'skylight' | 'chimney' | 'flat';

export type GutterItemKey =
  | 'ds' | 'miterIn' | 'miterOut' | 'endcap' | 'outlet' | 'elbow'
  | 'splash' | 'ugd' | 'fascia' | 'soffit';

export interface DownspoutMeta {
  size: string; // key of PriceBook.gutter.downspouts
  count: number;
  len: number; // feet per drop
}

// A switchable line item. Nothing is billed unless `on` is true.
export interface LineItem<K extends string = string> {
  k: K;
  label: string;
  unit: string;
  qty: number;
  rate: number;
  on: boolean;
  meta?: DownspoutMeta; // downspouts only: qty = count × len
}

// Upgrades, discounts (positive numbers, subtracted) and manual adjustments
// (either sign; a blank label raises a warning).
export interface AmountLine {
  label: string;
  amount: number;
}

export interface RoofScope {
  sections: RoofSection[];
  items: LineItem<RoofItemKey>[];
  upgrades: AmountLine[];
  discounts: AmountLine[];
  adjustments: AmountLine[];
  taxOn: TaxOn;
  taxRate: number;
}

export interface GutterScope {
  runs: GutterRun[];
  items: LineItem<GutterItemKey>[];
  upgrades: AmountLine[];
  discounts: AmountLine[];
  adjustments: AmountLine[];
}

export type CostKey =
  | 'material' | 'labor' | 'dumpster' | 'permit' | 'delivery' | 'repairs'
  | 'decking' | 'gutter' | 'overhead' | 'financing' | 'commission' | 'other';

// A blank, null or missing override means "use the calculated figure".
export type CostOverrides = Partial<Record<CostKey, number | string | null>>;

export interface Actuals {
  material?: number | string;
  labor?: number | string;
  other?: number | string;
}

export interface Revision {
  at: string; // ISO timestamp
  who: string;
  from: number; // selling price before
  to: number; // selling price after
}

// A file attached to an estimate. `data` is a data: URL.
export interface ReportAttachment {
  name: string;
  size: number;
  kind: 'image' | 'pdf' | 'file';
  data?: string;
  added: string; // YYYY-MM-DD
  takeoff?: ReportTakeoff;
  deviceOnly?: boolean;
}

export interface InsuranceDetails {
  carrier: string;
  claim: string;
  acv: number | string;
  depreciation: number | string;
  deductible: number | string;
  upgradesAmt: number | string;
  contractor: string;
  contractorPhone: string;
}

export interface Proposal {
  depositPct: number;
  exclusions: string[];
  allowances: string[];
  notes: string;
  contractType: ContractType;
  coverPhoto: string; // data: URL of an attached photo, '' = first photo / none
  pay: { sign: number; delivery: number }; // % of the price, cash jobs
  deckingAllowance: number; // $/sheet
  warrantyYears: number;
  ins: InsuranceDetails;
}

// The measurement summary stored on an estimate once a roof report has been
// applied to it.
export interface EstimateTakeoff {
  vendor: string | null;
  from: string;
  address: string;
  total: number; // sq ft
  pitched: number;
  flat: number;
  pitch: number;
  facets: number;
  eaves: number; // LF
  eavesRakes: number;
  valleys: number;
  hipsRidges: number;
  penetrations: number | null; // null = not on the report
  waste: number; // %
}

export interface Estimate {
  id: string;
  number: string; // "DR-1001"
  status: EstimateStatus;
  createdAt: string;
  updatedAt: string;
  date: string; // YYYY-MM-DD
  validDays: number;
  scope: EstimateScope;
  customer: Customer;
  roof: RoofScope;
  gutter: GutterScope;
  costs: { overrides: CostOverrides; notes: string };
  reports: ReportAttachment[];
  actuals: Actuals;
  revisions: Revision[];
  proposal: Proposal;
  takeoff?: EstimateTakeoff;
  confidence?: Confidence | '';
  ownerId?: string; // CRM user id ("mgr" or a PIN profile id on estimates from the old estimator)
  ownerName?: string;
}

// ==================== ROOF REPORT TAKEOFF ====================

// Measurements read from a roof report, in the shape the estimator's
// "Apply to this estimate" consumes. Lengths in LF, areas in sq ft.
export interface ReportTakeoff {
  vendor: string | null; // "Roofr", "GAF QuickMeasure", "EagleView", "Roof Measure"...
  address: string;
  total: number;
  pitched: number;
  flat: number;
  pitch: number;
  twoStoryArea: number;
  eaves: number;
  rakes: number;
  valleys: number;
  hipsRidges: number;
  eavesRakes: number;
  facets: number;
  penetrations: number | null;
  waste: number;
  // Wall + step flashing. The original estimator's parser never read it; the
  // CRM's parser does, and applyTakeoff() loads it onto the flashing item.
  flashing?: number;
  ok: boolean;
}

// ==================== CALCULATED TOTALS ====================

export interface SectionTotals {
  id: string;
  name: string;
  billable: number; // squares
  price: number; // $/sq for the manufacturer + tier
  pitchSurcharge: number; // $/sq
  storySurcharge: number; // $/sq
  psSquares: number; // peel-and-stick squares
  base: number; // billable × price
  pitchAmt: number;
  storyAmt: number;
  psAmt: number;
  total: number;
  section: RoofSection;
}

export interface PricedItem<K extends string = string> extends LineItem<K> {
  total: number;
}

export interface RoofTotals {
  sections: SectionTotals[];
  sectionsTotal: number;
  base: number;
  pitch: number;
  story: number;
  ps: number;
  billable: number;
  measured: number;
  psSquares: number;
  items: PricedItem<RoofItemKey>[];
  itemsTotal: number;
  upgrades: number;
  discounts: number;
  adjustments: number;
  subtotal: number;
  steepSqPoints: number; // Σ billable × pitch points above the free pitch
  twoStorySq: number;
  threeStorySq: number;
}

export interface RunTotals {
  id: string;
  name: string;
  lf: number;
  rate: number; // $/LF
  base: number;
  removal: number;
  guardLF: number;
  guards: number;
  story: number;
  difficult: number;
  total: number;
  run: GutterRun;
}

export interface GutterTotals {
  runs: RunTotals[];
  runsTotal: number;
  lf: number;
  guardLF: number;
  items: PricedItem<GutterItemKey>[]; // downspout qty is count × len
  itemsTotal: number;
  upgrades: number;
  discounts: number;
  adjustments: number;
  subtotal: number;
  removalLF: number;
  twoStoryLF: number;
  difficultLF: number;
  materialLF: number;
  laborOnlyLF: number;
}

// Internal cost the rules produce before overrides.
export interface AutoCosts {
  material: number;
  labor: number;
  dumpster: number;
  permit: number;
  delivery: number;
  repairs: number;
  decking: number;
  gutter: number;
}

// Internal cost after overrides, plus overhead, financing and commission.
export interface CostBreakdown extends AutoCosts {
  other: number;
  overhead: number;
  financing: number;
  commission: number;
}

export interface EstimateTotals {
  roof: RoofTotals;
  gutter: GutterTotals;
  preTax: number;
  tax: number;
  taxRate: number;
  sell: number; // total selling price
  autoCosts: AutoCosts;
  costs: CostBreakdown;
  totalCost: number;
  grossProfit: number;
  margin: number; // gross margin %, unrounded
  markup: number; // markup on cost %, unrounded
  effectivePerSquare: number; // roof subtotal ÷ billable squares
  effectivePerLF: number; // gutter subtotal ÷ LF
  addOns: number; // line items + upgrades, both scopes
  discounts: number;
  adjustments: number;
}

// The cost side as a function of price, used to solve "what it has to sell for".
export interface CostStructure {
  direct: number; // every cost that does not scale with price
  overheadRate: number; // fraction of price
  financingRate: number;
  commissionRate: number; // fraction of price, or of profit when mode is "profit"
  mode: CommissionBasis;
  // Price that lands at the given margin (a fraction, 0.3 = 30%); NaN when unreachable.
  solve: (margin: number) => number;
}

export interface MarginTarget {
  margin: number; // %
  price: number;
  delta: number; // price − current sell
  perSquare: number;
  perLF: number;
}

export type WarningLevel = 'bad' | 'warn';

export interface EstimateWarning {
  level: WarningLevel;
  title: string;
  detail: string;
  managerOnly?: boolean; // hidden from reps
}

export type Tone = 'ok' | 'warn' | 'bad' | 'navy' | 'gold' | 'mut';

// ==================== STORE RECORDS ====================

export interface AuditEntry {
  id: string;
  at: string; // ISO timestamp
  who: string;
  path: string; // dotted price-book path, or "(all pricing rules)"
  before: unknown;
  after: unknown;
}

export interface EstimatorData {
  pricing: PriceBook;
  estimates: Estimate[];
  audit: AuditEntry[];
  seq: number; // next estimate number
}

// The CRM user an action runs as. Managers see every estimate and the
// cost/margin side; sales reps see their own estimates and selling prices.
export interface EstimatorUser {
  id: string;
  name: string;
  role: 'manager' | 'sales_rep';
}
