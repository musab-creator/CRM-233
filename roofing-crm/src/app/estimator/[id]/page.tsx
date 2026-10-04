'use client';

import { use } from 'react';
import EstimateFrame from '@/components/estimator/workspace/EstimateFrame';
import CombinedEstimate from '@/components/estimator/workspace/CombinedEstimate';

// Combined estimate: the review screen (customer, scope, reports, recap,
// cost and margin panels for managers, proposal terms).
export default function CombinedEstimatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <EstimateFrame id={id} view="combined">
      {(ws) => <CombinedEstimate ws={ws} />}
    </EstimateFrame>
  );
}
