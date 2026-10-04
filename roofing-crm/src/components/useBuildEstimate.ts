'use client';

import { useRouter } from 'next/navigation';
import { useCRMStore } from '@/store';
import { createEstimateFromRoofReport, useEstimatorHydrated, useEstimatorStore } from '@/store/estimator';
import { generateId } from '@/lib/utils';
import type { RoofReport } from '@/types';

// Roof report -> estimate / proposal. One action shared by Roof Measure, the
// Roof Reports list and the lead page.

export type EstimateTarget = 'estimate' | 'proposal';

export const estimatePath = (id: string, target: EstimateTarget) =>
  target === 'proposal' ? `/estimator/${id}/proposal` : `/estimator/${id}`;

// Builds a new, saved estimate from the report (same mapping as the
// estimator's own "Apply to this estimate"), records it on the report and
// opens the estimate or straight to its customer proposal.
export function useBuildEstimate() {
  const router = useRouter();
  const { homeowners, currentUser, updateRoofReport, addActivity } = useCRMStore();

  return (report: RoofReport, target: EstimateTarget = 'estimate') => {
    // Latest copy: the report may have gained estimates since the caller read it.
    const current = useCRMStore.getState().roofReports.find((r) => r.id === report.id) || report;
    const owner = homeowners.find((h) => h.id === current.homeownerId);
    const { id, number } = createEstimateFromRoofReport(current, {
      name: owner ? `${owner.firstName} ${owner.lastName}` : current.address,
      phone: owner?.phone,
      email: owner?.email,
    });
    const now = new Date().toISOString();
    updateRoofReport(current.id, { estimates: [...current.estimates, { id, number, createdAt: now }] });
    addActivity({
      id: generateId(),
      leadId: current.leadId,
      userId: currentUser?.id || '',
      type: 'document',
      description: `Estimate ${number} built from roof report for ${current.address}`,
      createdAt: now,
    });
    router.push(estimatePath(id, target));
    return { id, number };
  };
}

// The newest estimate built from this report that still exists in the
// estimator (it may have been deleted there), or null.
export function useLatestReportEstimate(report: RoofReport | undefined) {
  const hydrated = useEstimatorHydrated();
  const estimates = useEstimatorStore((s) => s.estimates);
  if (!report || !hydrated) return null;
  for (let i = report.estimates.length - 1; i >= 0; i--) {
    const e = report.estimates[i];
    if (e.id && estimates.some((x) => x.id === e.id)) return { id: e.id, number: e.number };
  }
  return null;
}
