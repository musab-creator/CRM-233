import { create } from "zustand";
import type {
  User,
  Contact,
  Job,
  Claim,
  Campaign,
  InsurancePolicy,
  ContingencyAgreement,
  StormEvent,
  PipelineStage,
  DashboardKPIs,
} from "@/types";
import { generateId } from "./utils";
import { mockContacts, mockJobs, mockClaims, mockCampaigns, mockStormEvents } from "./mock-data";

interface CRMStore {
  // Current user
  currentUser: User;
  // Data
  contacts: Contact[];
  jobs: Job[];
  claims: Claim[];
  campaigns: Campaign[];
  stormEvents: StormEvent[];
  contingencies: ContingencyAgreement[];
  policies: InsurancePolicy[];
  // UI state
  sidebarOpen: boolean;
  currentView: string;
  selectedJobId: string | null;
  selectedContactId: string | null;
  // Actions
  setSidebarOpen: (open: boolean) => void;
  setCurrentView: (view: string) => void;
  setSelectedJobId: (id: string | null) => void;
  setSelectedContactId: (id: string | null) => void;
  addContact: (contact: Contact) => void;
  updateContact: (id: string, data: Partial<Contact>) => void;
  addJob: (job: Job) => void;
  updateJob: (id: string, data: Partial<Job>) => void;
  moveJob: (id: string, stage: PipelineStage) => void;
  addClaim: (claim: Claim) => void;
  updateClaim: (id: string, data: Partial<Claim>) => void;
  addCampaign: (campaign: Campaign) => void;
  updateCampaign: (id: string, data: Partial<Campaign>) => void;
  addContingency: (contingency: ContingencyAgreement) => void;
  addPolicy: (policy: InsurancePolicy) => void;
  getDashboardKPIs: () => DashboardKPIs;
}

export const useCRMStore = create<CRMStore>((set, get) => ({
  currentUser: {
    id: "user-1",
    name: "Mike Johnson",
    email: "mike@apexroofing.com",
    phone: "(555) 123-4567",
    role: "manager",
    team: "Sales",
    createdAt: "2024-01-01",
  },

  contacts: mockContacts,
  jobs: mockJobs,
  claims: mockClaims,
  campaigns: mockCampaigns,
  stormEvents: mockStormEvents,
  contingencies: [],
  policies: [],

  sidebarOpen: true,
  currentView: "dashboard",
  selectedJobId: null,
  selectedContactId: null,

  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setCurrentView: (view) => set({ currentView: view, selectedJobId: null, selectedContactId: null }),
  setSelectedJobId: (id) => set({ selectedJobId: id }),
  setSelectedContactId: (id) => set({ selectedContactId: id }),

  addContact: (contact) =>
    set((state) => ({ contacts: [...state.contacts, contact] })),

  updateContact: (id, data) =>
    set((state) => ({
      contacts: state.contacts.map((c) => (c.id === id ? { ...c, ...data } : c)),
    })),

  addJob: (job) => set((state) => ({ jobs: [...state.jobs, job] })),

  updateJob: (id, data) =>
    set((state) => ({
      jobs: state.jobs.map((j) => (j.id === id ? { ...j, ...data } : j)),
    })),

  moveJob: (id, stage) =>
    set((state) => ({
      jobs: state.jobs.map((j) =>
        j.id === id
          ? {
              ...j,
              stage,
              updatedAt: new Date().toISOString(),
              activities: [
                ...j.activities,
                {
                  id: generateId(),
                  type: "stage_change" as const,
                  description: `Moved to ${stage}`,
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : j
      ),
    })),

  addClaim: (claim) => set((state) => ({ claims: [...state.claims, claim] })),

  updateClaim: (id, data) =>
    set((state) => ({
      claims: state.claims.map((c) => (c.id === id ? { ...c, ...data } : c)),
    })),

  addCampaign: (campaign) =>
    set((state) => ({ campaigns: [...state.campaigns, campaign] })),

  updateCampaign: (id, data) =>
    set((state) => ({
      campaigns: state.campaigns.map((c) =>
        c.id === id ? { ...c, ...data } : c
      ),
    })),

  addContingency: (contingency) =>
    set((state) => ({ contingencies: [...state.contingencies, contingency] })),

  addPolicy: (policy) =>
    set((state) => ({ policies: [...state.policies, policy] })),

  getDashboardKPIs: () => {
    const state = get();
    const jobs = state.jobs;
    const insuranceJobs = jobs.filter((j) => j.type === "insurance");
    const retailJobs = jobs.filter((j) => j.type === "retail");
    const closedJobs = jobs.filter((j) => j.stage === "closed" || j.stage === "collected");
    const totalRevenue = closedJobs.reduce(
      (sum, j) => sum + (j.estimateAmount || j.retailPrice || 0),
      0
    );

    return {
      totalLeads: state.contacts.length,
      activeJobs: jobs.filter((j) => j.stage !== "closed" && j.stage !== "collected").length,
      closedJobs: closedJobs.length,
      totalRevenue,
      avgJobValue: closedJobs.length > 0 ? totalRevenue / closedJobs.length : 0,
      closeRate: state.contacts.length > 0 ? (closedJobs.length / state.contacts.length) * 100 : 0,
      insuranceJobs: insuranceJobs.length,
      retailJobs: retailJobs.length,
      pendingClaims: state.claims.filter((c) => c.status !== "approved" && c.status !== "denied" && c.status !== "closed").length,
      supplementsPending: state.claims.filter((c) => c.status === "supplement_needed" || c.status === "supplement_submitted").length,
      acvCollected: jobs.reduce((sum, j) => sum + (j.acvPayment || 0), 0),
      depreciationPending: jobs.reduce((sum, j) => sum + (j.depreciationHoldback || 0), 0),
      monthlyLeads: [
        { month: "Jan", count: 45 }, { month: "Feb", count: 52 },
        { month: "Mar", count: 68 }, { month: "Apr", count: 85 },
        { month: "May", count: 120 }, { month: "Jun", count: 95 },
        { month: "Jul", count: 88 }, { month: "Aug", count: 76 },
        { month: "Sep", count: 65 }, { month: "Oct", count: 58 },
        { month: "Nov", count: 42 }, { month: "Dec", count: 35 },
      ],
      revenueByMonth: [
        { month: "Jan", amount: 125000 }, { month: "Feb", amount: 148000 },
        { month: "Mar", amount: 195000 }, { month: "Apr", amount: 267000 },
        { month: "May", amount: 345000 }, { month: "Jun", amount: 298000 },
        { month: "Jul", amount: 278000 }, { month: "Aug", amount: 256000 },
        { month: "Sep", amount: 210000 }, { month: "Oct", amount: 185000 },
        { month: "Nov", amount: 145000 }, { month: "Dec", amount: 112000 },
      ],
      jobsByStage: [
        { stage: "New Lead", count: 23 }, { stage: "Inspection", count: 15 },
        { stage: "Contingency", count: 12 }, { stage: "Claim Filed", count: 18 },
        { stage: "Adjusting", count: 8 }, { stage: "Approved", count: 14 },
        { stage: "In Progress", count: 6 }, { stage: "Complete", count: 45 },
      ],
      leadsBySource: [
        { source: "Door Knock", count: 156 }, { source: "Referral", count: 89 },
        { source: "Storm Chase", count: 78 }, { source: "Google Ads", count: 65 },
        { source: "Facebook", count: 45 }, { source: "Website", count: 38 },
        { source: "Yard Sign", count: 22 }, { source: "Other", count: 15 },
      ],
      repPerformance: [
        { name: "Carlos M.", leads: 45, closed: 28, revenue: 385000 },
        { name: "Sarah T.", leads: 38, closed: 22, revenue: 310000 },
        { name: "James W.", leads: 42, closed: 19, revenue: 265000 },
        { name: "Lisa R.", leads: 35, closed: 17, revenue: 248000 },
        { name: "Derek P.", leads: 30, closed: 15, revenue: 210000 },
      ],
    };
  },
}));
