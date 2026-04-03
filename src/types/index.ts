// ============================================================
// Roofing CRM Type Definitions
// ============================================================

// --- User & Auth ---
export type UserRole = "manager" | "sales_rep" | "admin";

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  avatar?: string;
  team?: string;
  createdAt: string;
}

// --- Contacts / Homeowners ---
export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  insuranceCompany?: string;
  policyNumber?: string;
  claimNumber?: string;
  source: LeadSource;
  assignedTo?: string;
  notes: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type LeadSource =
  | "door_knock"
  | "referral"
  | "website"
  | "social_media"
  | "storm_chase"
  | "google_ads"
  | "facebook_ads"
  | "yard_sign"
  | "home_show"
  | "other";

// --- Insurance Policy ---
export type PolicyType = "ACV" | "RCV";
export type ClaimType = "hail" | "wind" | "hail_and_wind" | "other";

export interface InsurancePolicy {
  id: string;
  contactId: string;
  carrier: string;
  policyNumber: string;
  policyType: PolicyType;
  deductible: number;
  deductibleType: "flat" | "percentage";
  effectiveDate: string;
  expirationDate: string;
  dateOfLoss?: string;
  roofAge?: number;
  rcvAmount?: number;
  acvAmount?: number;
  depreciationAmount?: number;
  claimType?: ClaimType;
  rawPdfUrl?: string;
  parsedData?: Record<string, string>;
  createdAt: string;
}

// --- Pipeline / Jobs ---
export type PipelineStage =
  | "new_lead"
  | "contact_made"
  | "inspection_scheduled"
  | "inspection_complete"
  | "contingency_sent"
  | "contingency_signed"
  | "claim_filed"
  | "adjuster_scheduled"
  | "adjuster_met"
  | "estimate_received"
  | "supplement_needed"
  | "supplement_submitted"
  | "approved"
  | "material_ordered"
  | "work_scheduled"
  | "in_progress"
  | "work_complete"
  | "final_inspection"
  | "invoiced"
  | "acv_collected"
  | "depreciation_released"
  | "collected"
  | "closed";

export type JobType = "insurance" | "retail";

export interface Job {
  id: string;
  contactId: string;
  contact: Contact;
  type: JobType;
  stage: PipelineStage;
  title: string;
  description: string;
  assignedTo: string;
  priority: "low" | "medium" | "high" | "urgent";
  // Insurance-specific
  insurancePolicy?: InsurancePolicy;
  claimNumber?: string;
  adjusterName?: string;
  adjusterPhone?: string;
  adjusterEmail?: string;
  dateOfLoss?: string;
  stormType?: ClaimType;
  // Financials
  estimateAmount?: number;
  acvPayment?: number;
  depreciationHoldback?: number;
  supplementAmount?: number;
  deductibleAmount?: number;
  retailPrice?: number;
  // Scheduling
  inspectionDate?: string;
  adjusterDate?: string;
  workStartDate?: string;
  workEndDate?: string;
  // Meta
  companyCamProjectId?: string;
  photos: string[];
  documents: Document[];
  notes: Note[];
  activities: Activity[];
  createdAt: string;
  updatedAt: string;
}

export interface Document {
  id: string;
  name: string;
  type: "contingency" | "policy" | "estimate" | "supplement" | "invoice" | "photo_report" | "other";
  url: string;
  createdAt: string;
}

export interface Note {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface Activity {
  id: string;
  type: "stage_change" | "note" | "email" | "call" | "sms" | "document" | "photo" | "payment";
  description: string;
  authorId?: string;
  authorName?: string;
  metadata?: Record<string, string>;
  createdAt: string;
}

// --- Contingency Agreement ---
export interface ContingencyAgreement {
  id: string;
  jobId: string;
  contactId: string;
  // Homeowner info
  homeownerName: string;
  propertyAddress: string;
  homeownerPhone: string;
  homeownerEmail: string;
  // Insurance info
  insuranceCompany: string;
  policyNumber: string;
  claimNumber?: string;
  dateOfLoss?: string;
  deductible: number;
  policyType: PolicyType;
  // Sales rep questions
  hasInteriorLeaks: boolean;
  claimType: ClaimType;
  hasOutsideStructures: boolean;
  outsideStructuresDescription?: string;
  // Administrative use
  adminNotes: string;
  salesRepId: string;
  salesRepName: string;
  // Status
  status: "draft" | "sent" | "viewed" | "signed" | "expired";
  docuSignEnvelopeId?: string;
  signedAt?: string;
  sentAt?: string;
  createdAt: string;
}

// --- Claims Tracking ---
export type ClaimStatus =
  | "not_filed"
  | "filed"
  | "under_review"
  | "adjuster_assigned"
  | "adjuster_scheduled"
  | "adjuster_inspected"
  | "estimate_received"
  | "supplement_needed"
  | "supplement_submitted"
  | "supplement_approved"
  | "approved"
  | "denied"
  | "closed";

export interface Claim {
  id: string;
  jobId: string;
  contactId: string;
  claimNumber: string;
  carrier: string;
  adjusterName: string;
  adjusterPhone: string;
  adjusterEmail: string;
  dateOfLoss: string;
  dateFiled: string;
  status: ClaimStatus;
  stormType: ClaimType;
  acvAmount?: number;
  rcvAmount?: number;
  depreciationAmount?: number;
  supplementAmount?: number;
  deductible: number;
  followUps: FollowUp[];
  createdAt: string;
  updatedAt: string;
}

export interface FollowUp {
  id: string;
  type: "email" | "phone" | "text";
  to: string;
  subject?: string;
  body: string;
  sentAt: string;
  response?: string;
  respondedAt?: string;
}

// --- Storm Lookup ---
export interface StormEvent {
  id: string;
  date: string;
  type: ClaimType;
  hailSize?: string;
  windSpeed?: string;
  location: string;
  county: string;
  state: string;
  severity: "minor" | "moderate" | "severe" | "catastrophic";
  source: string;
  recommended: boolean;
}

// --- CompanyCam ---
export interface CompanyCamProject {
  id: string;
  name: string;
  address: string;
  photos: CompanyCamPhoto[];
  createdAt: string;
}

export interface CompanyCamPhoto {
  id: string;
  url: string;
  thumbnailUrl: string;
  caption?: string;
  tags: string[];
  takenAt: string;
}

// --- Marketing ---
export type CampaignType = "door_knock" | "direct_mail" | "digital_ads" | "social_media" | "referral_program" | "yard_signs" | "event";

export interface Campaign {
  id: string;
  name: string;
  type: CampaignType;
  status: "draft" | "active" | "paused" | "completed";
  budget: number;
  spent: number;
  leadsGenerated: number;
  jobsClosed: number;
  revenue: number;
  roi: number;
  startDate: string;
  endDate?: string;
  assignedTo: string;
  notes: string;
  createdAt: string;
}

// --- Dashboard KPIs ---
export interface DashboardKPIs {
  totalLeads: number;
  activeJobs: number;
  closedJobs: number;
  totalRevenue: number;
  avgJobValue: number;
  closeRate: number;
  insuranceJobs: number;
  retailJobs: number;
  pendingClaims: number;
  supplementsPending: number;
  acvCollected: number;
  depreciationPending: number;
  monthlyLeads: { month: string; count: number }[];
  revenueByMonth: { month: string; amount: number }[];
  jobsByStage: { stage: string; count: number }[];
  leadsBySource: { source: string; count: number }[];
  repPerformance: { name: string; leads: number; closed: number; revenue: number }[];
}
