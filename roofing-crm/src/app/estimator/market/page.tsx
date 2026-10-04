'use client';

import ManagerPage from '@/components/estimator/outputs/ManagerPage';
import MarketBenchmark from '@/components/estimator/outputs/MarketBenchmark';
import { useEstimatorStore } from '@/store/estimator';

export default function MarketBenchmarkPage() {
  const pricing = useEstimatorStore((s) => s.pricing);
  return <ManagerPage view="market">{() => <MarketBenchmark pricing={pricing} />}</ManagerPage>;
}
