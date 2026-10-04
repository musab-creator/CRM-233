'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { landingViewFor, type EstimateScope } from '@/lib/estimator';
import { useEstimatorStore, useEstimatorUser } from '@/store/estimator';
import { estimateHref } from './parts';
import { toast } from './feedback';

// Open / duplicate / start estimates from the list screens.
export function useEstimateActions() {
  const router = useRouter();
  const user = useEstimatorUser();
  const estimates = useEstimatorStore((s) => s.estimates);
  const createEstimate = useEstimatorStore((s) => s.createEstimate);
  const saveEstimate = useEstimatorStore((s) => s.saveEstimate);
  const duplicateEstimate = useEstimatorStore((s) => s.duplicateEstimate);

  // Reopened estimates land on the combined page (gutter-only jobs on the gutter calculator).
  const openHref = useCallback(
    (id: string) => {
      const est = estimates.find((e) => e.id === id);
      return estimateHref(id, est ? landingViewFor(est, false) : 'combined');
    },
    [estimates],
  );

  // A new estimate is saved straight away so it has an address, then opens
  // on its first screen (roof calculator, or gutter calculator for gutter-only).
  const create = useCallback(
    (scope: EstimateScope) => {
      const saved = saveEstimate(createEstimate(scope), user);
      toast('Started ' + saved.number);
      router.push(estimateHref(saved.id, landingViewFor(saved, true)));
    },
    [createEstimate, saveEstimate, user, router],
  );

  // The copy is saved straight away and opens on the combined page, like the original.
  const duplicate = useCallback(
    (id: string) => {
      const copy = duplicateEstimate(id, user);
      if (!copy) return;
      const saved = saveEstimate(copy, user);
      toast('Duplicated as ' + saved.number);
      router.push(estimateHref(saved.id, 'combined'));
    },
    [duplicateEstimate, saveEstimate, user, router],
  );

  return { openHref, create, duplicate };
}
