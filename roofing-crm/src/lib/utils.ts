import { type LeadStatus, type ClaimStatus, type ClaimType, type PolicyType } from '@/types';

export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(date: string): string {
  return new Date(date).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export function formatPhone(phone: string): string {
  return phone;
}

export function getLeadStatusLabel(status: LeadStatus): string {
  const labels: Record<LeadStatus, string> = {
    new: 'New Lead',
    contacted: 'Contacted',
    inspection_scheduled: 'Inspection Scheduled',
    inspection_complete: 'Inspection Complete',
    policy_reviewed: 'Policy Reviewed',
    contingency_sent: 'Contingency Sent',
    contingency_signed: 'Contingency Signed',
    claim_filed: 'Claim Filed',
    adjuster_scheduled: 'Adjuster Scheduled',
    adjuster_met: 'Adjuster Met',
    approved: 'Approved',
    supplement_needed: 'Supplement Needed',
    job_sold: 'Job Sold',
    in_production: 'In Production',
    completed: 'Completed',
    lost: 'Lost',
    retail_estimate_sent: 'Estimate Sent',
    retail_approved: 'Approved',
  };
  return labels[status] || status;
}

export function getLeadStatusColor(status: LeadStatus): string {
  const colors: Record<LeadStatus, string> = {
    new: 'bg-blue-100 text-blue-800',
    contacted: 'bg-indigo-100 text-indigo-800',
    inspection_scheduled: 'bg-purple-100 text-purple-800',
    inspection_complete: 'bg-violet-100 text-violet-800',
    policy_reviewed: 'bg-cyan-100 text-cyan-800',
    contingency_sent: 'bg-amber-100 text-amber-800',
    contingency_signed: 'bg-yellow-100 text-yellow-800',
    claim_filed: 'bg-orange-100 text-orange-800',
    adjuster_scheduled: 'bg-teal-100 text-teal-800',
    adjuster_met: 'bg-sky-100 text-sky-800',
    approved: 'bg-green-100 text-green-800',
    supplement_needed: 'bg-rose-100 text-rose-800',
    job_sold: 'bg-emerald-100 text-emerald-800',
    in_production: 'bg-lime-100 text-lime-800',
    completed: 'bg-green-200 text-green-900',
    lost: 'bg-gray-200 text-gray-600',
    retail_estimate_sent: 'bg-amber-100 text-amber-800',
    retail_approved: 'bg-green-100 text-green-800',
  };
  return colors[status] || 'bg-gray-100 text-gray-800';
}

export function getClaimStatusLabel(status: ClaimStatus): string {
  const labels: Record<ClaimStatus, string> = {
    filed: 'Filed',
    acknowledged: 'Acknowledged',
    adjuster_assigned: 'Adjuster Assigned',
    inspection_scheduled: 'Inspection Scheduled',
    inspection_complete: 'Inspection Complete',
    under_review: 'Under Review',
    approved: 'Approved',
    partial_approved: 'Partially Approved',
    denied: 'Denied',
    supplement_filed: 'Supplement Filed',
    supplement_approved: 'Supplement Approved',
    closed: 'Closed',
  };
  return labels[status] || status;
}

export function getClaimStatusColor(status: ClaimStatus): string {
  const colors: Record<ClaimStatus, string> = {
    filed: 'bg-blue-100 text-blue-800',
    acknowledged: 'bg-indigo-100 text-indigo-800',
    adjuster_assigned: 'bg-purple-100 text-purple-800',
    inspection_scheduled: 'bg-cyan-100 text-cyan-800',
    inspection_complete: 'bg-teal-100 text-teal-800',
    under_review: 'bg-amber-100 text-amber-800',
    approved: 'bg-green-100 text-green-800',
    partial_approved: 'bg-yellow-100 text-yellow-800',
    denied: 'bg-red-100 text-red-800',
    supplement_filed: 'bg-orange-100 text-orange-800',
    supplement_approved: 'bg-emerald-100 text-emerald-800',
    closed: 'bg-gray-200 text-gray-600',
  };
  return colors[status] || 'bg-gray-100 text-gray-800';
}

export function getClaimTypeLabel(type: ClaimType): string {
  return type === 'hail' ? 'Hail' : type === 'wind' ? 'Wind' : 'Hail & Wind';
}

export function getPolicyTypeLabel(type: PolicyType): string {
  return type === 'ACV' ? 'Actual Cash Value (ACV)' : 'Replacement Cost Value (RCV)';
}

export function getPolicyTypeBadge(type: PolicyType): string {
  return type === 'RCV' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800';
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export function getInsurancePipelineStages(): LeadStatus[] {
  return [
    'new', 'contacted', 'inspection_scheduled', 'inspection_complete',
    'policy_reviewed', 'contingency_sent', 'contingency_signed',
    'claim_filed', 'adjuster_scheduled', 'adjuster_met',
    'approved', 'supplement_needed', 'job_sold', 'in_production', 'completed'
  ];
}

export function getRetailPipelineStages(): LeadStatus[] {
  return ['new', 'contacted', 'inspection_scheduled', 'inspection_complete', 'retail_estimate_sent', 'retail_approved', 'job_sold', 'in_production', 'completed'];
}
