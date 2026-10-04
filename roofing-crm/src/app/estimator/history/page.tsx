'use client';

import ManagerPage from '@/components/estimator/outputs/ManagerPage';
import HistoricalPricing from '@/components/estimator/outputs/HistoricalPricing';

export default function HistoricalPricingPage() {
  return <ManagerPage view="history">{() => <HistoricalPricing />}</ManagerPage>;
}
