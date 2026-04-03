import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(date: string): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function getStageName(stage: string): string {
  const names: Record<string, string> = {
    new_lead: "New Lead",
    contact_made: "Contact Made",
    inspection_scheduled: "Inspection Scheduled",
    inspection_complete: "Inspection Complete",
    contingency_sent: "Contingency Sent",
    contingency_signed: "Contingency Signed",
    claim_filed: "Claim Filed",
    adjuster_scheduled: "Adjuster Scheduled",
    adjuster_met: "Adjuster Met",
    estimate_received: "Estimate Received",
    supplement_needed: "Supplement Needed",
    supplement_submitted: "Supplement Submitted",
    approved: "Approved",
    material_ordered: "Material Ordered",
    work_scheduled: "Work Scheduled",
    in_progress: "In Progress",
    work_complete: "Work Complete",
    final_inspection: "Final Inspection",
    invoiced: "Invoiced",
    acv_collected: "ACV Collected",
    depreciation_released: "Depreciation Released",
    collected: "Collected",
    closed: "Closed",
  };
  return names[stage] || stage;
}

export function getStageColor(stage: string): string {
  const colors: Record<string, string> = {
    new_lead: "bg-yellow-100 text-yellow-800",
    contact_made: "bg-blue-100 text-blue-800",
    inspection_scheduled: "bg-indigo-100 text-indigo-800",
    inspection_complete: "bg-purple-100 text-purple-800",
    contingency_sent: "bg-violet-100 text-violet-800",
    contingency_signed: "bg-fuchsia-100 text-fuchsia-800",
    claim_filed: "bg-cyan-100 text-cyan-800",
    adjuster_scheduled: "bg-sky-100 text-sky-800",
    adjuster_met: "bg-teal-100 text-teal-800",
    estimate_received: "bg-emerald-100 text-emerald-800",
    supplement_needed: "bg-orange-100 text-orange-800",
    supplement_submitted: "bg-amber-100 text-amber-800",
    approved: "bg-green-100 text-green-800",
    material_ordered: "bg-lime-100 text-lime-800",
    work_scheduled: "bg-teal-100 text-teal-800",
    in_progress: "bg-blue-100 text-blue-800",
    work_complete: "bg-green-100 text-green-800",
    final_inspection: "bg-emerald-100 text-emerald-800",
    invoiced: "bg-lime-100 text-lime-800",
    acv_collected: "bg-green-100 text-green-800",
    depreciation_released: "bg-emerald-100 text-emerald-800",
    collected: "bg-green-100 text-green-800",
    closed: "bg-gray-100 text-gray-800",
  };
  return colors[stage] || "bg-gray-100 text-gray-800";
}

export function getClaimStatusName(status: string): string {
  const names: Record<string, string> = {
    not_filed: "Not Filed",
    filed: "Filed",
    under_review: "Under Review",
    adjuster_assigned: "Adjuster Assigned",
    adjuster_scheduled: "Adjuster Scheduled",
    adjuster_inspected: "Adjuster Inspected",
    estimate_received: "Estimate Received",
    supplement_needed: "Supplement Needed",
    supplement_submitted: "Supplement Submitted",
    supplement_approved: "Supplement Approved",
    approved: "Approved",
    denied: "Denied",
    closed: "Closed",
  };
  return names[status] || status;
}

export function getSourceName(source: string): string {
  const names: Record<string, string> = {
    door_knock: "Door Knock",
    referral: "Referral",
    website: "Website",
    social_media: "Social Media",
    storm_chase: "Storm Chase",
    google_ads: "Google Ads",
    facebook_ads: "Facebook Ads",
    yard_sign: "Yard Sign",
    home_show: "Home Show",
    other: "Other",
  };
  return names[source] || source;
}

export function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}
