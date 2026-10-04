'use client';

import { useRouter } from 'next/navigation';
import { useCRMStore } from '@/store';
import { createEstimateFromRoofReport } from '@/store/estimator';
import { generateId } from '@/lib/utils';
import type { RoofReport } from '@/types';

// Turns a saved roof report into a new, saved estimate in the native
// estimator and opens it.
export function useBuildEstimate() {
  const router = useRouter();
  const { homeowners, currentUser, updateRoofReport, addActivity } = useCRMStore();

  return (report: RoofReport) => {
    const owner = homeowners.find((h) => h.id === report.homeownerId);
    const { id, number } = createEstimateFromRoofReport(report, {
      name: owner ? `${owner.firstName} ${owner.lastName}` : report.address,
      phone: owner?.phone,
      email: owner?.email,
    });
    const now = new Date().toISOString();
    updateRoofReport(report.id, { estimates: [...report.estimates, { number, createdAt: now }] });
    addActivity({
      id: generateId(),
      leadId: report.leadId,
      userId: currentUser?.id || '',
      type: 'document',
      description: `Estimate ${number} built from roof report for ${report.address}`,
      createdAt: now,
    });
    router.push(`/estimator/${id}`);
  };
}
