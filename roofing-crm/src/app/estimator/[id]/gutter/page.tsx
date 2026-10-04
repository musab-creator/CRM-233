'use client';

import { use } from 'react';
import EstimateFrame from '@/components/estimator/workspace/EstimateFrame';
import GutterCalculator from '@/components/estimator/workspace/GutterCalculator';

export default function GutterCalculatorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <EstimateFrame id={id} view="gutter">
      {(ws) => <GutterCalculator ws={ws} />}
    </EstimateFrame>
  );
}
