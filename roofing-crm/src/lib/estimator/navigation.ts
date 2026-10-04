// The estimator's screens, their headings and the price-book fields the
// admin page edits, as the original estimator laid them out.

export type EstimatorView =
  | 'dash' | 'new' | 'roof' | 'gutter' | 'combined' | 'saved' | 'history' | 'market' | 'admin'
  | 'proposal' | 'jobcost';

export type ViewGroup = 'Work' | 'Estimate' | 'Records' | 'Output';

export interface ViewMeta {
  view: EstimatorView;
  group: ViewGroup;
  title: string;
  subtitle: string;
  icon: string;
}

export const VIEWS: ViewMeta[] = [
  { view: 'dash', group: 'Work', title: 'Dashboard', subtitle: 'Pipeline, margin health and the current price table.', icon: '◧' },
  { view: 'new', group: 'Work', title: 'New estimate', subtitle: 'Pick a scope and start. Everything can be changed later.', icon: '＋' },
  {
    view: 'roof',
    group: 'Estimate',
    title: 'Roof calculator',
    subtitle: 'Divide the roof into sections whenever slope, story height, shingle product or underlayment changes.',
    icon: '⌂',
  },
  {
    view: 'gutter',
    group: 'Estimate',
    title: 'Gutter calculator',
    subtitle: 'Downspouts, guards, fascia work and removal are priced separately from the per-foot gutter price.',
    icon: '⌐',
  },
  { view: 'combined', group: 'Estimate', title: 'Combined estimate', subtitle: 'Price, internal cost and profit on one screen.', icon: '∑' },
  { view: 'saved', group: 'Records', title: 'Saved estimates', subtitle: 'Reopen, duplicate or revise any estimate.', icon: '▤' },
  {
    view: 'history',
    group: 'Records',
    title: 'Historical pricing',
    subtitle: 'What the paid invoices and completed jobs actually show, and how far to trust each figure.',
    icon: '◔',
  },
  {
    view: 'market',
    group: 'Records',
    title: 'Market benchmark',
    subtitle: 'Jacksonville 2026 pricing per square and per linear foot, and where ours sits.',
    icon: '◎',
  },
  { view: 'admin', group: 'Records', title: 'Admin pricing', subtitle: 'Every rule the calculator uses. Changes are logged.', icon: '⚙' },
  { view: 'proposal', group: 'Output', title: 'Customer proposal', subtitle: '', icon: '▣' },
  { view: 'jobcost', group: 'Output', title: 'Internal job cost', subtitle: '', icon: '$' },
];

// Screens a sales rep cannot open.
export const MANAGER_ONLY_VIEWS: EstimatorView[] = ['history', 'market', 'admin', 'jobcost'];

// Screens that need an estimate open; the original started a blank one when
// you navigated to them with none open.
export const ESTIMATE_VIEWS: EstimatorView[] = ['roof', 'gutter', 'combined', 'proposal', 'jobcost'];

export function viewsFor(isManager: boolean): ViewMeta[] {
  return VIEWS.filter((v) => isManager || !MANAGER_ONLY_VIEWS.includes(v.view));
}

// ==================== ADMIN PRICING FIELDS ====================

export interface AdminField {
  path: string; // dotted price-book path, for updatePricing()
  label: string;
  options?: [value: string, label: string][]; // select fields; others are numeric
}

export interface AdminFieldGroup {
  title: string;
  fields: AdminField[];
  note?: string;
}

const mfrFields = (key: string): AdminField[] => [
  { path: `mfrs.${key}.competitive`, label: 'Competitive' },
  { path: `mfrs.${key}.standard`, label: 'Standard (default)' },
  { path: `mfrs.${key}.high`, label: 'High' },
  { path: `mfrs.${key}.min`, label: 'Range minimum' },
  { path: `mfrs.${key}.max`, label: 'Range maximum' },
];

// Manufacturer groups are per price-book manufacturer ("<label> — dollars per square").
export function manufacturerFieldGroups(mfrs: Record<string, { label: string }>): AdminFieldGroup[] {
  return Object.keys(mfrs).map((key) => ({ title: `${mfrs[key].label} — dollars per square`, fields: mfrFields(key) }));
}

export const MANUFACTURER_RANGE_NOTE =
  'A custom price below the range minimum raises a blocking warning on the estimate. Above the maximum it raises a caution.';

export const ADMIN_FIELD_GROUPS: AdminFieldGroup[] = [
  {
    title: 'Roof add-on rules',
    fields: [
      { path: 'roof.pitchFreeUpTo', label: 'No surcharge up to (pitch)' },
      { path: 'roof.pitchStep', label: '$ per square, per pitch point above' },
      { path: 'roof.story2', label: 'Two-story surcharge $/sq' },
      { path: 'roof.story3', label: 'Three-plus story surcharge $/sq' },
      { path: 'roof.peelStick', label: 'Peel-and-stick $/sq' },
      { path: 'roof.defaultWaste', label: 'Default waste %' },
    ],
  },
  {
    title: 'Roofing optional line-item pricing',
    note: 'These accessory prices are seeded starting points, not figures found in your records. Set them from your own recent contracts before quoting.',
    fields: [
      { path: 'roof.tearOffExtraLayer', label: 'Extra tear-off layer $/sq' },
      { path: 'roof.deckingSheet', label: 'Decking $/sheet' },
      { path: 'roof.repairEach', label: 'Repairs $ each' },
      { path: 'roof.permit', label: 'Permit $' },
      { path: 'roof.dumpster', label: 'Dumpster $' },
      { path: 'roof.delivery', label: 'Delivery $' },
      { path: 'roof.dripEdgeLF', label: 'Drip edge $/LF' },
      { path: 'roof.starterLF', label: 'Starter $/LF' },
      { path: 'roof.ridgeCapLF', label: 'Ridge cap $/LF' },
      { path: 'roof.valleyLF', label: 'Valley $/LF' },
      { path: 'roof.flashingLF', label: 'Flashing $/LF' },
      { path: 'roof.pipeBootEach', label: 'Pipe boot $ each' },
      { path: 'roof.ventEach', label: 'Ventilation $ each' },
      { path: 'roof.skylightEach', label: 'Skylight $ each' },
      { path: 'roof.chimneyEach', label: 'Chimney $ each' },
      { path: 'roof.flatRoofSq', label: 'Flat roof $/sq' },
    ],
  },
  {
    title: '6" Seamless K-Style',
    fields: [
      { path: 'gutter.g6.sell', label: 'Default selling $/LF' },
      { path: 'gutter.g6.min', label: 'Minimum selling $/LF' },
      { path: 'gutter.g6.costLo', label: 'Estimated cost low $/LF' },
      { path: 'gutter.g6.costHi', label: 'Estimated cost high $/LF' },
    ],
  },
  {
    title: '7" Seamless / Box',
    fields: [
      { path: 'gutter.g7.sell', label: 'Default selling $/LF' },
      { path: 'gutter.g7.min', label: 'Minimum selling $/LF' },
      { path: 'gutter.g7.costLo', label: 'Estimated cost low $/LF' },
      { path: 'gutter.g7.costHi', label: 'Estimated cost high $/LF' },
    ],
  },
  {
    title: 'Labor-only & add-ons',
    fields: [
      { path: 'gutter.laborOnly.def', label: 'Labor-only default $/LF' },
      { path: 'gutter.laborOnly.min', label: 'Labor-only minimum $/LF' },
      { path: 'gutter.removalLF', label: 'Removal & disposal $/LF' },
      { path: 'gutter.guardLF', label: 'Gutter guards $/LF' },
      { path: 'gutter.story2LF', label: 'Two-story $/LF' },
      { path: 'gutter.difficultLF', label: 'Difficult access $/LF' },
      { path: 'gutter.downspouts.2x3', label: 'Downspout 2×3 $/LF' },
      { path: 'gutter.downspouts.3x4', label: 'Downspout 3×4 $/LF' },
      { path: 'gutter.downspouts.4x5', label: 'Downspout 4×5 $/LF' },
      { path: 'gutter.miterInside', label: 'Inside miter $ ea' },
      { path: 'gutter.miterOutside', label: 'Outside miter $ ea' },
      { path: 'gutter.endCap', label: 'End cap $ ea' },
      { path: 'gutter.outlet', label: 'Outlet $ ea' },
      { path: 'gutter.elbow', label: 'Elbow $ ea' },
      { path: 'gutter.splashBlock', label: 'Splash block $ ea' },
      { path: 'gutter.undergroundEach', label: 'Underground drain $ ea' },
      { path: 'gutter.fasciaLF', label: 'Fascia repair $/LF' },
      { path: 'gutter.soffitLF', label: 'Soffit repair $/LF' },
    ],
  },
  {
    title: 'Internal cost assumptions',
    note: 'Your records show two commission plans and two overhead conventions running at the same time. Whichever you pick here is applied to every estimate — that is the point of setting it in one place.',
    fields: [
      { path: 'cost.materialPerSq', label: 'Material $/billable sq' },
      { path: 'cost.laborPerSq', label: 'Labor $/billable sq' },
      { path: 'cost.steepPerSq', label: 'Steep labor $/sq per pitch point' },
      { path: 'cost.story2PerSq', label: 'Two-story labor $/sq' },
      { path: 'cost.story3PerSq', label: 'Three-plus story labor $/sq' },
      { path: 'cost.peelStickPerSq', label: 'Peel-and-stick material $/sq' },
      { path: 'cost.tearOffLayerPerSq', label: 'Extra tear-off layer $/sq' },
      { path: 'cost.deckingSheet', label: 'Decking $/sheet all-in' },
      { path: 'cost.repairEach', label: 'Repair $ each' },
      { path: 'cost.dumpster', label: 'Dumpster $' },
      { path: 'cost.permitService', label: 'Permit service $' },
      { path: 'cost.permitFee', label: 'Municipal permit fee $' },
      { path: 'cost.noc', label: 'NOC recording $' },
      { path: 'cost.delivery', label: 'Delivery $' },
      { path: 'cost.g6PerLF', label: '6" gutter cost $/LF' },
      { path: 'cost.g7PerLF', label: '7" gutter cost $/LF' },
      { path: 'cost.guardPerLF', label: 'Gutter guard cost $/LF' },
      { path: 'cost.gutterRemovalLF', label: 'Gutter removal cost $/LF' },
      { path: 'cost.gutterLaborOnlyLF', label: 'Gutter labor-only cost $/LF' },
      { path: 'cost.downspoutPerLF', label: 'Downspout cost $/LF' },
      { path: 'cost.gutterAccessoryPct', label: 'Gutter accessory cost as % of its price' },
      {
        path: 'cost.commissionBasis',
        label: 'Commission basis',
        options: [['contract', '% of contract'], ['profit', '% of job profit']],
      },
      { path: 'cost.commissionPct', label: 'Commission %' },
      { path: 'cost.overheadBasis', label: 'Overhead basis', options: [['pct', '% of contract'], ['flat', 'Flat $ per job']] },
      { path: 'cost.overheadPct', label: 'Overhead %' },
      { path: 'cost.overheadFlat', label: 'Overhead flat $' },
      { path: 'cost.financingPct', label: 'Financing / card fee %' },
    ],
  },
  {
    title: 'Targets & thresholds',
    fields: [
      { path: 'targets.minMargin', label: 'Minimum gross margin %' },
      { path: 'targets.goodMargin', label: 'Healthy gross margin %' },
      { path: 'targets.maxDiscountPct', label: 'Maximum discount %' },
      { path: 'targets.depositPct', label: 'Default deposit %' },
      { path: 'targets.quoteValidDays', label: 'Quote valid for (days)' },
      { path: 'targets.staleAfterDays', label: 'Warn pricing stale after (days)' },
    ],
  },
];

// Text fields on "Company details on the proposal" (paths under `company.`).
export const COMPANY_FIELDS: AdminField[] = [
  { path: 'company.name', label: 'Name' },
  { path: 'company.legal', label: 'Legal entity' },
  { path: 'company.addr', label: 'Address' },
  { path: 'company.city', label: 'City' },
  { path: 'company.phone', label: 'Phone' },
  { path: 'company.email', label: 'Email' },
  { path: 'company.web', label: 'Website' },
  { path: 'company.license', label: 'License' },
  { path: 'company.tagline', label: 'Tagline' },
];
