'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEstimatorHydrated, useEstimatorStore, useEstimatorUser } from '@/store/estimator';
import { deepClone, estimateTotals, setPath, type Estimate, type EstimateTotals } from '@/lib/estimator';

// The editing pattern every estimate page uses, like the original estimator:
// edits change a working copy; nothing is stored until Save.
export function useWorkingEstimate(id: string) {
  const hydrated = useEstimatorHydrated();
  const user = useEstimatorUser();
  const pricing = useEstimatorStore((s) => s.pricing);
  const openEstimate = useEstimatorStore((s) => s.openEstimate);
  const saveEstimate = useEstimatorStore((s) => s.saveEstimate);

  const [est, setEst] = useState<Estimate | null>(null);
  const [dirty, setDirty] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    const copy = openEstimate(id, user);
    /* eslint-disable react-hooks/set-state-in-effect */
    setEst(copy);
    setNotFound(!copy);
    setDirty(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [hydrated, id, user, openEstimate]);

  // Change one field by dotted path, e.g. update('roof.sections.0.pitch', 7).
  const update = useCallback((path: string, value: unknown) => {
    setEst((prev) => {
      if (!prev) return prev;
      const next = deepClone(prev);
      setPath(next, path, value);
      next.updatedAt = new Date().toISOString();
      return next;
    });
    setDirty(true);
  }, []);

  // Structural edits (add/remove sections, runs, lines): mutate a copy.
  const edit = useCallback((fn: (draft: Estimate) => void) => {
    setEst((prev) => {
      if (!prev) return prev;
      const next = deepClone(prev);
      fn(next);
      next.updatedAt = new Date().toISOString();
      return next;
    });
    setDirty(true);
  }, []);

  const save = useCallback(() => {
    if (!est) return null;
    const stored = saveEstimate(est, user);
    setEst(deepClone(stored));
    setDirty(false);
    return stored;
  }, [est, saveEstimate, user]);

  const totals: EstimateTotals | null = useMemo(() => (est ? estimateTotals(est, pricing) : null), [est, pricing]);

  return { hydrated, est, totals, pricing, user, dirty, notFound, update, edit, save };
}
