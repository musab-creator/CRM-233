import type { ContractType, Estimate, EstimateTotals, PriceBook, Proposal, ReportAttachment } from './types';
import type { ContractTerm } from './contracts';
import { CASH_CONTRACT_TERMS, INSURANCE_CONTRACT_TERMS } from './contracts';
import { DEFAULT_INSURANCE_CONTRACTOR_PHONE } from './defaults';
import { addDays, round2, toNumber } from './format';
import { measurementConfidence } from './takeoff';

// The customer proposal's numbers and generated wording, from the
// original's proposal screen.

// Fills proposal fields missing on estimates saved by older versions
// (the original patched these onto the estimate when the proposal opened).
export function normalizeProposal(proposal: Proposal, pricing: PriceBook): Proposal {
  return {
    ...proposal,
    contractType: proposal.contractType || 'cash',
    pay: proposal.pay || { sign: 0, delivery: toNumber(proposal.depositPct) || 50 },
    ins: proposal.ins || {
      carrier: '',
      claim: '',
      acv: '',
      depreciation: '',
      deductible: '',
      upgradesAmt: '',
      contractor: pricing.company.name,
      contractorPhone: DEFAULT_INSURANCE_CONTRACTOR_PHONE,
    },
  };
}

// Cash jobs: % at signing, % on material delivery, balance on completion.
export function paymentSchedule(sell: number, pay: Proposal['pay']) {
  const atSigning = round2((sell * toNumber(pay.sign)) / 100);
  const onDelivery = round2((sell * toNumber(pay.delivery)) / 100);
  return {
    signPct: toNumber(pay.sign),
    deliveryPct: toNumber(pay.delivery),
    balancePct: 100 - toNumber(pay.sign) - toNumber(pay.delivery),
    atSigning,
    onDelivery,
    balance: round2(sell - atSigning - onDelivery),
  };
}

// Insurance jobs: ACV + depreciation + deductible + upgrades the owner pays.
export function insuranceTotal(ins: Proposal['ins']): number {
  return round2(toNumber(ins.acv) + toNumber(ins.depreciation) + toNumber(ins.deductible) + toNumber(ins.upgradesAmt));
}

// Contract conditions for the proposal. On cash jobs the "Payment Obligation"
// term is rewritten from the estimate's payment schedule.
export function proposalContractTerms(contractType: ContractType, pay: Proposal['pay']): ContractTerm[] {
  if (contractType === 'insurance') return INSURANCE_CONTRACT_TERMS;
  return CASH_CONTRACT_TERMS.map((term) => {
    if (term.title !== 'Payment Obligation') return term;
    const parts = [
      toNumber(pay.sign) > 0 ? `${toNumber(pay.sign)}% is due at signing` : 'no payment is due at signing',
      `${toNumber(pay.delivery)}% is due on material delivery`,
      'and the balance is due upon substantial completion',
    ];
    return {
      title: term.title,
      body: `Payment in full of the total contract price is mandatory. On this Agreement ${parts.join(', ')}. A project timeline is provided once material is scheduled. Failure to pay constitutes a material breach of contract.`,
    };
  });
}

// "Scope of work" bullets, generated from what is priced.
export function scopeOfWork(est: Estimate, pricing: PriceBook, totals: EstimateTotals): string[] {
  const out: string[] = [];
  totals.roof.sections.filter((s) => s.total > 0).forEach((row) => {
    const brand = pricing.mfrs[row.section.mfr]?.label ?? row.section.mfr;
    const where = String(row.section.name || '').replace(/\s*—.*$/, '').trim().toLowerCase();
    out.push(`Complete tear-off of all existing roofing on the ${where} down to the deck, and haul-away`);
    out.push(
      `${brand}${row.section.product ? ' ' + row.section.product : ''} architectural shingles${row.section.color ? ' in ' + row.section.color : ''}, installed to manufacturer specification`,
    );
    if (row.psSquares > 0) out.push(`Self-adhered peel-and-stick underlayment over ${row.psSquares.toFixed(2)} squares`);
  });
  totals.roof.items.filter((i) => i.on && i.total > 0).forEach((i) => out.push(`${i.label} — ${toNumber(i.qty)} ${i.unit}`));
  totals.gutter.runs.filter((r) => r.total > 0).forEach((row) => {
    const product = pricing.gutter[row.run.size] || { label: row.run.size };
    const work = row.run.mode === 'labor' ? 'labor only' : row.run.mode === 'material' ? 'material supplied only' : 'supplied and installed';
    out.push(`${product.label}${row.run.color ? ' in ' + row.run.color : ''} — ${row.lf.toFixed(0)} linear feet, ${work}`);
    if (row.run.removal) out.push('Removal and disposal of the existing gutter system');
    if (row.guardLF) out.push(`Gutter guards over ${row.guardLF.toFixed(0)} linear feet`);
  });
  totals.gutter.items.filter((i) => i.on && i.total > 0).forEach((i) => out.push(`${i.label} — ${toNumber(i.qty)} ${i.unit}`));
  out.push('Full site clean-up, magnetic nail sweep, and debris haul-away on completion');
  return out;
}

// The product line under the price ("IKO Cambridge · Owens Corning"),
// de-duplicated, dropping a bare brand when a "brand product" is listed.
export function productHeadline(pricing: PriceBook, totals: EstimateTotals): string {
  const names = totals.roof.sections
    .filter((s) => s.total > 0)
    .map((s) => (pricing.mfrs[s.section.mfr]?.label ?? s.section.mfr) + (s.section.product ? ' ' + s.section.product : ''))
    .filter((v, i, all) => all.indexOf(v) === i);
  return names.filter((n) => !names.some((o) => o !== n && o.startsWith(n))).join(' · ') || 'Seamless aluminium';
}

export function proposalTitle(scope: Estimate['scope']): string {
  return scope === 'both' ? 'Complete roof + gutter replacement' : scope === 'roof' ? 'Complete roof replacement' : 'Seamless gutter system';
}

// Everything the proposal prints that is computed rather than typed in.
export function proposalFigures(est: Estimate, pricing: PriceBook, totals: EstimateTotals) {
  const proposal = normalizeProposal(est.proposal, pricing);
  const insurance = proposal.contractType === 'insurance';
  const insTotal = insuranceTotal(proposal.ins);
  const photos = (est.reports || []).filter((r): r is ReportAttachment & { data: string } => r.kind === 'image' && !!r.data);
  return {
    proposal,
    insurance,
    payments: paymentSchedule(totals.sell, proposal.pay),
    insuranceTotal: insTotal,
    // The headline price: the insurance total once entered, else the selling price.
    headlinePrice: insurance && insTotal ? insTotal : totals.sell,
    coverPhoto: proposal.coverPhoto || (photos[0] ? photos[0].data : ''),
    photos,
    sections: totals.roof.sections.filter((s) => s.total > 0),
    runs: totals.gutter.runs.filter((r) => r.total > 0),
    roofItems: totals.roof.items.filter((i) => i.on && i.total > 0),
    gutterItems: totals.gutter.items.filter((i) => i.on && i.total > 0),
    upgrades: [...est.roof.upgrades, ...est.gutter.upgrades].filter((u) => toNumber(u.amount) !== 0),
    discounts: [...est.roof.discounts, ...est.gutter.discounts].filter((d) => toNumber(d.amount) !== 0),
    scopeOfWork: scopeOfWork(est, pricing, totals),
    productHeadline: productHeadline(pricing, totals),
    title: proposalTitle(est.scope),
    terms: proposalContractTerms(proposal.contractType, proposal.pay),
    warrantyYears: toNumber(proposal.warrantyYears) || 10,
    deckingAllowance: toNumber(proposal.deckingAllowance) || 85,
    expiresOn: addDays(est.date, est.validDays),
    // Rough (hand-typed) quantities print a "preliminary measurements" notice.
    preliminary: measurementConfidence(est) === 'rough',
  };
}

// Fixed proposal copy.
export const PROPOSAL_PROCESS_STEPS: [title: string, detail: string][] = [
  ['Permit and notice of commencement', 'We pull the municipal roofing permit and record the NOC before any material is delivered.'],
  ['Property protection', 'Tarps over landscaping and pool cages, plywood against the walls where debris will land, driveway protected under the dump trailer.'],
  ['Tear-off', 'All existing roofing removed down to the bare deck. No shingle-over.'],
  ['Deck inspection', 'Every sheet of decking is walked and sounded. Rotten sheets are photographed before they are replaced.'],
  ['Re-nail to code', 'Deck re-nailed to the current Florida Building Code schedule where required by the permit.'],
  ['Underlayment and metal', 'Synthetic or self-adhered underlayment as specified, new drip edge on eaves and rakes, valley metal, and new pipe boots.'],
  ['Shingle installation', "Starter course, field shingles and hip-and-ridge cap installed to the manufacturer's published nailing pattern."],
  ['Ventilation', 'Intake and exhaust ventilation confirmed and replaced as listed on the pricing page.'],
  ['Gutter', 'Seamless gutter run on site, hung with hidden hangers, outlets and downspouts set to drain away from the foundation.'],
  ['Clean-up and final inspection', 'Full magnetic nail sweep, debris hauled, and the municipal final inspection scheduled and passed.'],
];

export function whyChooseUs(warrantyYears: number): string[] {
  return [
    'Licensed and insured Florida roofing contractor — certificate on request',
    'Measured takeoff on every job, so the quantity you are charged for is the quantity installed',
    'Permit and notice of commencement handled by us, start to finish',
    `${warrantyYears}-year workmanship warranty, transferable once to the next owner`,
    'Manufacturer limited lifetime material warranty on the shingle system',
    'One point of contact from first inspection through final inspection',
  ];
}

export const PROPOSAL_NEXT_STEPS = [
  'Sign below — a signed copy comes back to you by email the same day.',
  'We pull the permit and record the notice of commencement.',
  'You confirm colour in writing; material is ordered and a delivery date is set.',
  'Install, clean-up, and the municipal final inspection.',
];
