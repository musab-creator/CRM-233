import { create } from 'zustand';
import type {
  User, Lead, Homeowner, InsurancePolicy, Claim, Inspection,
  ContingencyAgreement, Campaign, Activity, DashboardStats, StormEvent
} from '@/types';
import { mockLeads, mockHomeowners, mockPolicies, mockClaims, mockInspections,
  mockContingencies, mockCampaigns, mockActivities, mockUsers, mockStormEvents } from '@/lib/mock-data';

interface CRMStore {
  // Auth
  currentUser: User | null;
  users: User[];
  setCurrentUser: (user: User | null) => void;

  // Leads
  leads: Lead[];
  addLead: (lead: Lead) => void;
  updateLead: (id: string, updates: Partial<Lead>) => void;
  deleteLead: (id: string) => void;

  // Homeowners
  homeowners: Homeowner[];
  addHomeowner: (homeowner: Homeowner) => void;
  updateHomeowner: (id: string, updates: Partial<Homeowner>) => void;

  // Policies
  policies: InsurancePolicy[];
  addPolicy: (policy: InsurancePolicy) => void;
  updatePolicy: (id: string, updates: Partial<InsurancePolicy>) => void;

  // Claims
  claims: Claim[];
  addClaim: (claim: Claim) => void;
  updateClaim: (id: string, updates: Partial<Claim>) => void;

  // Inspections
  inspections: Inspection[];
  addInspection: (inspection: Inspection) => void;
  updateInspection: (id: string, updates: Partial<Inspection>) => void;

  // Contingencies
  contingencies: ContingencyAgreement[];
  addContingency: (contingency: ContingencyAgreement) => void;
  updateContingency: (id: string, updates: Partial<ContingencyAgreement>) => void;

  // Campaigns
  campaigns: Campaign[];
  addCampaign: (campaign: Campaign) => void;
  updateCampaign: (id: string, updates: Partial<Campaign>) => void;

  // Activities
  activities: Activity[];
  addActivity: (activity: Activity) => void;

  // Storm events
  stormEvents: StormEvent[];

  // Dashboard
  getDashboardStats: () => DashboardStats;
}

export const useCRMStore = create<CRMStore>((set, get) => ({
  // Auth
  currentUser: mockUsers[0],
  users: mockUsers,
  setCurrentUser: (user) => set({ currentUser: user }),

  // Leads
  leads: mockLeads,
  addLead: (lead) => set((s) => ({ leads: [...s.leads, lead] })),
  updateLead: (id, updates) => set((s) => ({
    leads: s.leads.map((l) => l.id === id ? { ...l, ...updates, updatedAt: new Date().toISOString() } : l)
  })),
  deleteLead: (id) => set((s) => ({ leads: s.leads.filter((l) => l.id !== id) })),

  // Homeowners
  homeowners: mockHomeowners,
  addHomeowner: (homeowner) => set((s) => ({ homeowners: [...s.homeowners, homeowner] })),
  updateHomeowner: (id, updates) => set((s) => ({
    homeowners: s.homeowners.map((h) => h.id === id ? { ...h, ...updates } : h)
  })),

  // Policies
  policies: mockPolicies,
  addPolicy: (policy) => set((s) => ({ policies: [...s.policies, policy] })),
  updatePolicy: (id, updates) => set((s) => ({
    policies: s.policies.map((p) => p.id === id ? { ...p, ...updates } : p)
  })),

  // Claims
  claims: mockClaims,
  addClaim: (claim) => set((s) => ({ claims: [...s.claims, claim] })),
  updateClaim: (id, updates) => set((s) => ({
    claims: s.claims.map((c) => c.id === id ? { ...c, ...updates, updatedAt: new Date().toISOString() } : c)
  })),

  // Inspections
  inspections: mockInspections,
  addInspection: (inspection) => set((s) => ({ inspections: [...s.inspections, inspection] })),
  updateInspection: (id, updates) => set((s) => ({
    inspections: s.inspections.map((i) => i.id === id ? { ...i, ...updates } : i)
  })),

  // Contingencies
  contingencies: mockContingencies,
  addContingency: (contingency) => set((s) => ({ contingencies: [...s.contingencies, contingency] })),
  updateContingency: (id, updates) => set((s) => ({
    contingencies: s.contingencies.map((c) => c.id === id ? { ...c, ...updates } : c)
  })),

  // Campaigns
  campaigns: mockCampaigns,
  addCampaign: (campaign) => set((s) => ({ campaigns: [...s.campaigns, campaign] })),
  updateCampaign: (id, updates) => set((s) => ({
    campaigns: s.campaigns.map((c) => c.id === id ? { ...c, ...updates } : c)
  })),

  // Activities
  activities: mockActivities,
  addActivity: (activity) => set((s) => ({ activities: [activity, ...s.activities] })),

  // Storm events
  stormEvents: mockStormEvents,

  // Dashboard
  getDashboardStats: () => {
    const state = get();
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    return {
      totalLeads: state.leads.length,
      newLeadsThisWeek: state.leads.filter(l => new Date(l.createdAt) > weekAgo).length,
      activeInsuranceJobs: state.leads.filter(l => l.jobType === 'insurance' && !['completed', 'lost'].includes(l.status)).length,
      activeRetailJobs: state.leads.filter(l => l.jobType === 'retail' && !['completed', 'lost'].includes(l.status)).length,
      pendingInspections: state.inspections.filter(i => i.status === 'scheduled').length,
      pendingClaims: state.claims.filter(c => !['approved', 'denied', 'closed'].includes(c.status)).length,
      pendingContingencies: state.contingencies.filter(c => c.status === 'pending_signature').length,
      closedThisMonth: state.leads.filter(l => l.status === 'completed' && new Date(l.updatedAt) > monthStart).length,
      revenueThisMonth: state.leads
        .filter(l => l.status === 'completed' && new Date(l.updatedAt) > monthStart)
        .reduce((sum, l) => sum + (l.actualValue || 0), 0),
      revenuePipeline: state.leads
        .filter(l => !['completed', 'lost'].includes(l.status))
        .reduce((sum, l) => sum + (l.estimatedValue || 0), 0),
      conversionRate: state.leads.length > 0
        ? (state.leads.filter(l => l.status === 'completed').length / state.leads.length) * 100
        : 0,
      avgClaimTime: 14.5,
    };
  },
}));
