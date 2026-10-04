'use client';

import { use } from 'react';
import EstimateFrame from '@/components/estimator/workspace/EstimateFrame';
import RoofCalculator from '@/components/estimator/workspace/RoofCalculator';

export default function RoofCalculatorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <EstimateFrame id={id} view="roof">
      {(ws) => <RoofCalculator ws={ws} />}
    </EstimateFrame>
  );
}
