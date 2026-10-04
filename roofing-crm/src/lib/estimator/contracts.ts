// Contract conditions printed on the customer proposal. Generated from the
// original estimator's data; edit by hand from here on.

export interface ContractTerm {
  title: string;
  body: string;
}

// Insurance restoration agreement ("Green Sheet" terms).
export const INSURANCE_CONTRACT_TERMS: ContractTerm[] = [
  {
    title: 'Insurance Contingency & Contract Formation',
    body: 'This Agreement is expressly contingent upon insurance approval for covered loss. In the event the claim is denied in full, this Agreement shall be void and of no force or effect, and Owner shall owe no payment. Upon approval of any portion of the claim, this Agreement shall immediately become valid, binding, and enforceable.',
  },
  {
    title: 'Scope of Work Defined by Insurance Approval',
    body: 'The scope of work shall consist of all repairs and/or replacement approved by the insurance carrier, including any supplements, revisions, depreciation releases, or additional payments issued at any time. Any upgrades or non-covered items must be authorized separately in writing.',
  },
  {
    title: 'Absolute Payment Obligation',
    body: 'Owner agrees that payment in full of the total contract price is mandatory and shall consist of: the insurance deductible; and all insurance proceeds issued for the work, including ACV, RCV, depreciation, and supplements. Payment is due upon substantial completion of the work and/or release of insurance funds, whichever occurs later. Failure to pay constitutes a material breach of contract.',
  },
  {
    title: 'Assignment of Post-Loss Benefits & Co-Payee Authorization',
    body: 'Owner hereby assigns to Diversity Contracting LLC the post-loss insurance benefits necessary to perform the work and authorizes the insurer to issue all claim payments naming Diversity Contracting LLC as a co-payee. If any proceeds are issued solely to Owner, Owner shall endorse and deliver such funds to Diversity Contracting LLC within three (3) business days of receipt.',
  },
  {
    title: 'Authorization to Communicate, Negotiate & Supplement',
    body: 'Owner expressly authorizes Diversity Contracting LLC to communicate directly with the insurance carrier, attend inspections, review and revise estimates, submit supplements, and negotiate scope and pricing consistent with policy coverage and prevailing market rates.',
  },
  {
    title: 'Supplements & Additional Insurance Proceeds',
    body: 'Owner acknowledges that all additional insurance proceeds issued at any time for the covered loss are part of this Agreement and are owed exclusively to Diversity Contracting LLC, regardless of timing or method of payment.',
  },
  {
    title: 'Cancellation & Liquidated Damages',
    body: 'Owner may cancel this Agreement within three (3) business days of execution. If Owner cancels after this period and Diversity Contracting LLC has performed inspections, documentation, adjuster meetings, or insurance negotiations, Owner agrees to pay liquidated damages equal to the greater of $2,000 or fifteen percent (15%) of the insurance-approved replacement cost. The parties agree this amount is reasonable compensation and not a penalty.',
  },
  {
    title: 'Pre-Existing Conditions & Waiver of Claims',
    body: 'Diversity Contracting LLC shall not be responsible for damages arising from pre-existing, hidden, latent, or structural conditions, including but not limited to decking, framing, ventilation, flashing, skylights, or prior repairs. Owner waives all claims for consequential or incidental damages.',
  },
  {
    title: 'Limitation of Liability',
    body: 'Diversity Contracting LLC shall not be liable for: weather events, acts of God, or unforeseen conditions; interior damage caused by unexpected weather during construction; damage to landscaping, driveways, gutters, siding, paint, or interior finishes incidental to construction; delays caused by material shortages, labor availability, or third parties.',
  },
  {
    title: 'Warranty Limitations',
    body: 'Labor warranties apply only to work performed by Diversity Contracting LLC and are void if any third party alters or repairs the roof after completion. Warranties do not cover damage caused by storms, structural movement, or improper use.',
  },
  {
    title: 'Interest, Collection Costs & Attorney\'s Fees',
    body: 'Any unpaid balance shall accrue interest at 1.5% per month. Owner agrees to pay all collection costs, including reasonable attorney\'s fees, court costs, arbitration fees, and appellate fees, whether or not litigation is initiated.',
  },
  {
    title: 'Construction Lien Rights',
    body: 'Owner acknowledges that under Florida law, failure to pay in full authorizes Diversity Contracting LLC to record a construction lien against the property. Owner understands that a lien may result in legal action, foreclosure, and forced sale of the property to satisfy the debt.',
  },
  {
    title: 'Venue, Governing Law & Jury Waiver',
    body: 'This Agreement shall be governed by the laws of the State of Florida. Venue shall lie exclusively in the county where the property is located. Owner knowingly and voluntarily waives the right to a jury trial.',
  },
  {
    title: 'Entire Agreement & Severability',
    body: 'This Agreement constitutes the entire agreement between the parties and supersedes all prior discussions. If any provision is held unenforceable, the remainder shall remain in full force and effect.',
  },
];

// Cash / retail proposal. The "Payment Obligation" body is rewritten per
// estimate from its payment schedule; see proposalContractTerms().
export const CASH_CONTRACT_TERMS: ContractTerm[] = [
  {
    title: 'Scope of Work',
    body: 'The scope of work consists solely of the items listed in this proposal. Any additional work outside this scope requires written approval and will be priced separately before it is performed.',
  },
  {
    title: 'Payment Obligation',
    body: 'Payment in full of the total contract price is mandatory. The deposit is due at project start and the balance is due upon substantial completion. A project timeline will be provided once the initial deposit payment is received. Failure to pay constitutes a material breach of contract.',
  },
  {
    title: 'Change Orders',
    body: 'Changes to material, color, or scope after material has been ordered may carry restocking and re-delivery charges. All change orders must be in writing and signed by both parties.',
  },
  {
    title: 'Cancellation',
    body: 'Owner may cancel this Agreement within three (3) business days of execution without penalty. After this period, if material has been ordered or work scheduled, Owner agrees to pay the actual costs incurred plus a restocking fee of fifteen percent (15%) of the contract price.',
  },
  {
    title: 'Pre-Existing Conditions & Waiver of Claims',
    body: 'Diversity Contracting LLC shall not be responsible for damages arising from pre-existing, hidden, latent, or structural conditions, including but not limited to decking, framing, ventilation, flashing, skylights, or prior repairs. Rotten or damaged decking discovered at tear-off is replaced at the per-sheet rate listed in this proposal. Owner waives all claims for consequential or incidental damages.',
  },
  {
    title: 'Limitation of Liability',
    body: 'Diversity Contracting LLC shall not be liable for: weather events, acts of God, or unforeseen conditions; interior damage caused by unexpected weather during construction; damage to landscaping, driveways, gutters, siding, paint, or interior finishes incidental to construction; delays caused by material shortages, labor availability, or third parties.',
  },
  {
    title: 'Warranty',
    body: 'Diversity Contracting LLC provides a ten (10) year workmanship warranty on labor. Shingle systems carry the manufacturer\'s limited lifetime material warranty per the selected product. Labor warranties apply only to work performed by Diversity Contracting LLC and are void if any third party alters or repairs the roof after completion. Warranties do not cover damage caused by storms, structural movement, or improper use.',
  },
  {
    title: 'Color Selection',
    body: 'Shingle and gutter color photographs are provided as visual examples only. Actual installed appearance may vary with lighting, roof slope and surrounding structures. Final color selection is confirmed in writing prior to material ordering.',
  },
  {
    title: 'Interest, Collection Costs & Attorney\'s Fees',
    body: 'Any unpaid balance shall accrue interest at 1.5% per month. Owner agrees to pay all collection costs, including reasonable attorney\'s fees, court costs, arbitration fees, and appellate fees, whether or not litigation is initiated.',
  },
  {
    title: 'Construction Lien Rights',
    body: 'Owner acknowledges that under Florida law, failure to pay in full authorizes Diversity Contracting LLC to record a construction lien against the property. Owner understands that a lien may result in legal action, foreclosure, and forced sale of the property to satisfy the debt.',
  },
  {
    title: 'Venue, Governing Law & Jury Waiver',
    body: 'This Agreement shall be governed by the laws of the State of Florida. Venue shall lie exclusively in the county where the property is located. Owner knowingly and voluntarily waives the right to a jury trial.',
  },
  {
    title: 'Entire Agreement & Severability',
    body: 'This Agreement constitutes the entire agreement between the parties and supersedes all prior discussions. If any provision is held unenforceable, the remainder shall remain in full force and effect.',
  },
];
