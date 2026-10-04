'use client';

import EstimatorShell, { useIsEstimatorManager } from '@/components/estimator/EstimatorShell';
import { VIEWS, type EstimatorView } from '@/lib/estimator';
import { useEstimatorHydrated } from '@/store/estimator';
import { Loading, ManagerOnly } from './ui';

// Frame for the manager-only records screens (history, market, admin
// pricing): title and subtitle from the estimator's screen list, a notice
// for reps, and content once saved estimator data is loaded.
export default function ManagerPage({ view, children }: { view: EstimatorView; children: () => React.ReactNode }) {
  const meta = VIEWS.find((v) => v.view === view)!;
  const isManager = useIsEstimatorManager();
  const hydrated = useEstimatorHydrated();
  return (
    <EstimatorShell title={meta.title} subtitle={meta.subtitle}>
      {!isManager ? <ManagerOnly what={meta.title} /> : !hydrated ? <Loading /> : children()}
    </EstimatorShell>
  );
}
