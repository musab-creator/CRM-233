// ==================== CORE TYPES ====================

export type UserRole = 'manager' | 'sales_rep';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  phone: string;
  avatar?: string;
  teamId?: string;
}

export type JobType = 'insurance' | 'retail';
export type PolicyType = 'ACV' | 'RCV';
export type ClaimType = 'hail' | 'wind' | 'hail_and_wind';
export type LeadSource = 'door_knock' | 'referral' | 'website' | 'social_media' | 'storm_chaser' | 'marketing_campaign' | 'companycam' | 'other';

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'inspection_scheduled'
  | 'inspection_complete'
  | 'policy_reviewed'
  | 'contingency_sent'
  | 'contingency_signed'
  | 'claim_filed'
  | 'adjuster_scheduled'
  | 'adjuster_met'
  | 'approved'
  | 'supplement_needed'
  | 'job_sold'
  | 'in_production'
  | 'completed'
  | 'lost'
  | 'retail_estimate_sent'
  | 'retail_approved';

export interface Lead {
  id: string;
  homeownerId: string;
  assignedTo: string;
  jobType: JobType;
  status: LeadStatus;
  source: LeadSource;
  notes: string;
  createdAt: string;
  updatedAt: string;
  inspectionDate?: string;
  inspectionReportId?: string;
  policyId?: string;
  claimId?: string;
  contingencyId?: string;
  estimatedValue?: number;
  actualValue?: number;
}

export interface Homeowner {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  propertyType: 'residential' | 'commercial';
  notes?: string;
  createdAt: string;
}

// ==================== INSURANCE POLICY ====================

export interface InsurancePolicy {
  id: string;
  homeownerId: string;
  leadId: string;
  carrier: string;
  policyNumber: string;
  policyType: PolicyType; // ACV or RCV
  deductible: number;
  deductibleType: 'flat' | 'percentage';
  effectiveDate: string;
  expirationDate: string;
  bestDateOfLoss: string;
  dwellingCoverage: number;
  otherStructuresCoverage: number;
  personalPropertyCoverage: number;
  lossOfUseCoverage: number;
  windHailDeductible?: number;
  hasWindCoverage: boolean;
  hasHailCoverage: boolean;
  rawText?: string;
  uploadedAt: string;
  analyzedAt?: string;
  pdfUrl?: string;
}

// ==================== STORM DATA ====================

export interface StormEvent {
  id: string;
  date: string;
  type: ClaimType;
  severity: 'minor' | 'moderate' | 'severe' | 'catastrophic';
  location: string;
  zipCodes: string[];
  hailSize?: string;
  windSpeed?: string;
  description: string;
  source: string;
}

export interface StormLookupResult {
  events: StormEvent[];
  recommendedDateOfLoss: string;
  recommendedClaimType: ClaimType;
  confidence: number;
  reasoning: string;
}

// ==================== CONTINGENCY AGREEMENT ====================

export interface ContingencyAgreement {
  id: string;
  leadId: string;
  homeownerId: string;
  policyId: string;
  // Derived from policy
  homeownerName: string;
  homeownerAddress: string;
  homeownerCity: string;
  homeownerState: string;
  homeownerZip: string;
  homeownerPhone: string;
  homeownerEmail: string;
  insuranceCarrier: string;
  policyNumber: string;
  policyType: PolicyType;
  deductible: number;
  dateOfLoss: string;
  claimType: ClaimType;
  // Sales rep questions
  hasInteriorLeaks: boolean;
  isHailOrWindClaim: ClaimType;
  hasOutsideStructures: boolean;
  outsideStructuresDescription?: string;
  // Admin use
  adminNotes: string;
  salesRepId: string;
  salesRepName: string;
  // Status
  status: 'draft' | 'pending_signature' | 'signed' | 'expired';
  generatedAt: string;
  sentAt?: string;
  signedAt?: string;
  docusignEnvelopeId?: string;
}

// ==================== CLAIMS ====================

export type ClaimStatus =
  | 'filed'
  | 'acknowledged'
  | 'adjuster_assigned'
  | 'inspection_scheduled'
  | 'inspection_complete'
  | 'under_review'
  | 'approved'
  | 'partial_approved'
  | 'denied'
  | 'supplement_filed'
  | 'supplement_approved'
  | 'closed';

export interface Claim {
  id: string;
  leadId: string;
  homeownerId: string;
  policyId: string;
  claimNumber: string;
  carrier: string;
  adjusterName?: string;
  adjusterEmail?: string;
  adjusterPhone?: string;
  status: ClaimStatus;
  claimType: ClaimType;
  dateOfLoss: string;
  dateFiled: string;
  approvedAmount?: number;
  supplementAmount?: number;
  followUps: ClaimFollowUp[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimFollowUp {
  id: string;
  claimId: string;
  type: 'email' | 'phone' | 'text';
  sentAt: string;
  sentTo: string;
  subject?: string;
  body: string;
  status: 'sent' | 'delivered' | 'read' | 'replied';
}

// ==================== INSPECTIONS (CompanyCam) ====================

export interface Inspection {
  id: string;
  leadId: string;
  homeownerId: string;
  projectId?: string; // CompanyCam project ID
  scheduledDate: string;
  completedDate?: string;
  photos: InspectionPhoto[];
  reportUrl?: string;
  notes: string;
  findings: string;
  damageType?: ClaimType;
  damageSeverity?: 'minor' | 'moderate' | 'severe';
  status: 'scheduled' | 'in_progress' | 'completed' | 'report_generated';
}

export interface InspectionPhoto {
  id: string;
  url: string;
  caption: string;
  category: 'overview' | 'damage' | 'measurements' | 'details';
  takenAt: string;
}

// ==================== MARKETING ====================

export interface Campaign {
  id: string;
  name: string;
  type: 'door_knock' | 'direct_mail' | 'digital_ad' | 'social_media' | 'email' | 'sms_blast' | 'referral_program';
  status: 'draft' | 'active' | 'paused' | 'completed';
  budget: number;
  spent: number;
  leadsGenerated: number;
  startDate: string;
  endDate?: string;
  targetArea?: string;
  targetZipCodes?: string[];
  description: string;
  createdBy: string;
}

// ==================== ACTIVITY LOG ====================

export interface Activity {
  id: string;
  leadId?: string;
  claimId?: string;
  userId: string;
  type: 'note' | 'call' | 'email' | 'text' | 'status_change' | 'document' | 'inspection' | 'claim_update';
  description: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ==================== DASHBOARD STATS ====================

export interface DashboardStats {
  totalLeads: number;
  newLeadsThisWeek: number;
  activeInsuranceJobs: number;
  activeRetailJobs: number;
  pendingInspections: number;
  pendingClaims: number;
  pendingContingencies: number;
  closedThisMonth: number;
  revenueThisMonth: number;
  revenuePipeline: number;
  conversionRate: number;
  avgClaimTime: number;
}
