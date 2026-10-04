'use client';

import { use } from 'react';
import { useWorkingEstimate } from '@/components/estimator/useWorkingEstimate';
import EstimateOutputFrame from '@/components/estimator/outputs/EstimateOutputFrame';
import ProposalDocument from '@/components/estimator/outputs/ProposalDocument';
import ProposalSetup from '@/components/estimator/outputs/ProposalSetup';

// Customer proposal: setup controls on screen, then the printable document.
// Printing hides the CRM chrome and the controls and prints Letter pages.
export default function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const working = useWorkingEstimate(id);
  return (
    <EstimateOutputFrame
      id={id}
      title="Customer proposal"
      subtitle="Nothing on these pages reveals cost, profit, markup, commission or internal warnings."
      working={working}
      canSave
      document
    >
      {({ est, pricing, totals, edit }) => (
        <>
          <div className="no-print mb-5">
            <ProposalSetup est={est} pricing={pricing} edit={edit} />
          </div>
          <ProposalDocument est={est} pricing={pricing} totals={totals} />
        </>
      )}
    </EstimateOutputFrame>
  );
}
