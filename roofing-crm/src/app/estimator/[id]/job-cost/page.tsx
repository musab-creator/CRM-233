'use client';

import { use } from 'react';
import EstimatorShell, { EstimateTabs, useIsEstimatorManager } from '@/components/estimator/EstimatorShell';
import { useWorkingEstimate } from '@/components/estimator/useWorkingEstimate';
import EstimateOutputFrame from '@/components/estimator/outputs/EstimateOutputFrame';
import JobCostReport from '@/components/estimator/outputs/JobCostReport';
import { ManagerOnly } from '@/components/estimator/outputs/ui';

const TITLE = 'Internal job-cost report';
const SUBTITLE = 'Internal only. Do not send this to the customer.';

// Internal job cost (managers only; reps see a notice).
export default function JobCostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isManager = useIsEstimatorManager();
  const working = useWorkingEstimate(id);
  if (!isManager) {
    return (
      <EstimatorShell title={TITLE} subtitle={SUBTITLE}>
        <EstimateTabs id={id} />
        <ManagerOnly what="The internal job-cost report" />
      </EstimatorShell>
    );
  }
  return (
    <EstimateOutputFrame id={id} title={TITLE} subtitle={SUBTITLE} working={working}>
      {({ est, pricing, totals }) => <JobCostReport est={est} pricing={pricing} totals={totals} />}
    </EstimateOutputFrame>
  );
}
