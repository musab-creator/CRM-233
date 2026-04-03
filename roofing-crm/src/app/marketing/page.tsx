'use client';

import { useState, useMemo } from 'react';
import AppShell from '@/components/AppShell';
import { useCRMStore } from '@/store';
import { formatCurrency, formatDate, generateId } from '@/lib/utils';
import type { Campaign } from '@/types';
import {
  Megaphone,
  DollarSign,
  Users,
  Target,
  TrendingUp,
  Plus,
  X,
  Pencil,
  BarChart3,
  CalendarRange,
  MapPin,
  ChevronRight,
} from 'lucide-react';

const CAMPAIGN_TYPE_LABELS: Record<Campaign['type'], string> = {
  door_knock: 'Door Knock',
  direct_mail: 'Direct Mail',
  digital_ad: 'Digital Ad',
  social_media: 'Social Media',
  email: 'Email',
  sms_blast: 'SMS Blast',
  referral_program: 'Referral Program',
};

const CAMPAIGN_TYPE_COLORS: Record<Campaign['type'], string> = {
  door_knock: 'bg-amber-100 text-amber-800',
  direct_mail: 'bg-blue-100 text-blue-800',
  digital_ad: 'bg-purple-100 text-purple-800',
  social_media: 'bg-pink-100 text-pink-800',
  email: 'bg-cyan-100 text-cyan-800',
  sms_blast: 'bg-teal-100 text-teal-800',
  referral_program: 'bg-green-100 text-green-800',
};

const STATUS_COLORS: Record<Campaign['status'], string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-800',
  paused: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-blue-100 text-blue-800',
};

const LEAD_SOURCE_LABELS: Record<string, string> = {
  door_knock: 'Door Knock',
  referral: 'Referral',
  website: 'Website',
  social_media: 'Social Media',
  storm_chaser: 'Storm Chaser',
  marketing_campaign: 'Marketing Campaign',
  companycam: 'CompanyCam',
  other: 'Other',
};

const LEAD_SOURCE_COLORS: Record<string, string> = {
  door_knock: 'bg-amber-500',
  referral: 'bg-green-500',
  website: 'bg-blue-500',
  social_media: 'bg-pink-500',
  storm_chaser: 'bg-red-500',
  marketing_campaign: 'bg-purple-500',
  companycam: 'bg-cyan-500',
  other: 'bg-gray-400',
};

interface CampaignFormData {
  name: string;
  type: Campaign['type'];
  budget: string;
  startDate: string;
  endDate: string;
  targetArea: string;
  targetZipCodes: string;
  description: string;
}

const EMPTY_FORM: CampaignFormData = {
  name: '',
  type: 'digital_ad',
  budget: '',
  startDate: '',
  endDate: '',
  targetArea: '',
  targetZipCodes: '',
  description: '',
};

export default function MarketingPage() {
  const campaigns = useCRMStore((s) => s.campaigns);
  const leads = useCRMStore((s) => s.leads);
  const addCampaign = useCRMStore((s) => s.addCampaign);
  const currentUser = useCRMStore((s) => s.currentUser);

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<CampaignFormData>(EMPTY_FORM);

  // ---- Computed stats ----
  const activeCampaigns = useMemo(
    () => campaigns.filter((c) => c.status === 'active'),
    [campaigns],
  );

  const totalBudget = useMemo(
    () => campaigns.reduce((sum, c) => sum + c.budget, 0),
    [campaigns],
  );

  const totalSpent = useMemo(
    () => campaigns.reduce((sum, c) => sum + c.spent, 0),
    [campaigns],
  );

  const totalLeadsGenerated = useMemo(
    () => campaigns.reduce((sum, c) => sum + c.leadsGenerated, 0),
    [campaigns],
  );

  const costPerLead = totalLeadsGenerated > 0 ? totalSpent / totalLeadsGenerated : 0;

  // ---- Lead source breakdown ----
  const leadSourceBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const lead of leads) {
      counts[lead.source] = (counts[lead.source] || 0) + 1;
    }
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a);
  }, [leads]);

  const maxLeadSourceCount = useMemo(
    () => Math.max(...leadSourceBreakdown.map(([, count]) => count), 1),
    [leadSourceBreakdown],
  );

  // ---- ROI metrics ----
  const roiMetrics = useMemo(() => {
    const marketingLeads = leads.filter(
      (l) => l.source === 'marketing_campaign' || l.source === 'social_media' || l.source === 'website',
    );
    const closedJobs = marketingLeads.filter((l) => l.status === 'completed');
    const revenue = closedJobs.reduce((sum, l) => sum + (l.actualValue || 0), 0);
    const roi = totalSpent > 0 ? ((revenue - totalSpent) / totalSpent) * 100 : 0;

    return {
      totalSpent,
      leadsGenerated: totalLeadsGenerated,
      jobsClosed: closedJobs.length,
      revenue,
      roi,
    };
  }, [leads, totalSpent, totalLeadsGenerated]);

  // ---- Handlers ----
  function openNewCampaignModal() {
    setForm(EMPTY_FORM);
    setShowModal(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.budget) return;

    const campaign: Campaign = {
      id: generateId(),
      name: form.name.trim(),
      type: form.type,
      status: 'draft',
      budget: parseFloat(form.budget) || 0,
      spent: 0,
      leadsGenerated: 0,
      startDate: form.startDate || new Date().toISOString(),
      endDate: form.endDate || undefined,
      targetArea: form.targetArea.trim() || undefined,
      targetZipCodes: form.targetZipCodes
        ? form.targetZipCodes.split(',').map((z) => z.trim()).filter(Boolean)
        : undefined,
      description: form.description.trim(),
      createdBy: currentUser?.id || '',
    };

    addCampaign(campaign);
    setShowModal(false);
  }

  // ---- Overview stat cards ----
  const overviewCards = [
    {
      label: 'Total Campaigns',
      value: campaigns.length,
      sub: `${activeCampaigns.length} active`,
      icon: Megaphone,
      gradient: 'bg-gradient-to-br from-orange-500 to-orange-600',
    },
    {
      label: 'Total Budget / Spent',
      value: formatCurrency(totalSpent),
      sub: `of ${formatCurrency(totalBudget)} budgeted`,
      icon: DollarSign,
      gradient: 'bg-gradient-to-br from-blue-500 to-blue-600',
    },
    {
      label: 'Leads Generated',
      value: totalLeadsGenerated,
      sub: 'Across all campaigns',
      icon: Users,
      gradient: 'bg-gradient-to-br from-emerald-500 to-emerald-600',
    },
    {
      label: 'Cost Per Lead',
      value: formatCurrency(costPerLead),
      sub: 'Avg across campaigns',
      icon: Target,
      gradient: 'bg-gradient-to-br from-purple-500 to-purple-600',
    },
  ];

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Marketing &amp; Campaigns</h1>
            <p className="text-sm text-gray-500">Track campaigns, lead sources, and marketing ROI</p>
          </div>
          <button
            onClick={openNewCampaignModal}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-orange-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Campaign
          </button>
        </div>

        {/* Overview Stats */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {overviewCards.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.label}
                className={`${card.gradient} rounded-xl p-5 text-white shadow-sm`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-white/80">{card.label}</p>
                    <p className="mt-1 text-2xl font-bold">{card.value}</p>
                    <p className="mt-1 text-xs text-white/70">{card.sub}</p>
                  </div>
                  <Icon className="h-8 w-8 text-white/40" />
                </div>
              </div>
            );
          })}
        </div>

        {/* ROI Summary + Lead Source Breakdown */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* ROI Summary */}
          <div className="rounded-xl bg-white p-6 shadow-sm border border-orange-100">
            <div className="flex items-center gap-2 mb-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-100">
                <TrendingUp className="h-5 w-5 text-orange-600" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900">ROI Summary</h2>
            </div>

            <div className="mb-5">
              <div className="text-center rounded-lg bg-gradient-to-br from-orange-50 to-orange-100 p-5 border border-orange-200">
                <p className="text-sm font-medium text-orange-700 mb-1">Marketing ROI</p>
                <p className={`text-4xl font-bold ${roiMetrics.roi >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                  {roiMetrics.roi >= 0 ? '+' : ''}{roiMetrics.roi.toFixed(1)}%
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg bg-gray-50 p-3">
                <p className="text-xs text-gray-500">Total Spend</p>
                <p className="text-lg font-bold text-gray-900">{formatCurrency(roiMetrics.totalSpent)}</p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <p className="text-xs text-gray-500">Leads Generated</p>
                <p className="text-lg font-bold text-gray-900">{roiMetrics.leadsGenerated}</p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <p className="text-xs text-gray-500">Jobs Closed</p>
                <p className="text-lg font-bold text-gray-900">{roiMetrics.jobsClosed}</p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <p className="text-xs text-gray-500">Revenue</p>
                <p className="text-lg font-bold text-gray-900">{formatCurrency(roiMetrics.revenue)}</p>
              </div>
            </div>
          </div>

          {/* Lead Source Breakdown */}
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100">
                <BarChart3 className="h-5 w-5 text-blue-600" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900">Lead Source Breakdown</h2>
            </div>

            {leadSourceBreakdown.length === 0 ? (
              <p className="text-sm text-gray-500">No leads yet.</p>
            ) : (
              <div className="space-y-3">
                {leadSourceBreakdown.map(([source, count]) => {
                  const pct = (count / maxLeadSourceCount) * 100;
                  return (
                    <div key={source}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-gray-700">
                          {LEAD_SOURCE_LABELS[source] || source}
                        </span>
                        <span className="text-sm font-semibold text-gray-900">{count}</span>
                      </div>
                      <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
                        <div
                          className={`h-full rounded-full transition-all ${LEAD_SOURCE_COLORS[source] || 'bg-gray-400'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Campaigns Table */}
        <div className="rounded-xl bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">All Campaigns</h2>
            <span className="text-sm text-gray-500">{campaigns.length} campaigns</span>
          </div>

          {campaigns.length === 0 ? (
            <div className="p-10 text-center">
              <Megaphone className="mx-auto h-12 w-12 text-gray-300" />
              <p className="mt-3 text-sm text-gray-500">No campaigns yet. Create your first campaign to get started.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {campaigns.map((campaign) => {
                const spendPct = campaign.budget > 0 ? Math.min((campaign.spent / campaign.budget) * 100, 100) : 0;
                const cpl = campaign.leadsGenerated > 0 ? campaign.spent / campaign.leadsGenerated : 0;

                return (
                  <div key={campaign.id} className="px-6 py-4 hover:bg-gray-50/50 transition-colors">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        {/* Row 1: Name + badges */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-semibold text-gray-900">{campaign.name}</h3>
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CAMPAIGN_TYPE_COLORS[campaign.type]}`}>
                            {CAMPAIGN_TYPE_LABELS[campaign.type]}
                          </span>
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[campaign.status]}`}>
                            {campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1)}
                          </span>
                        </div>

                        {/* Row 2: Meta info */}
                        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-500">
                          <span className="inline-flex items-center gap-1">
                            <CalendarRange className="h-3.5 w-3.5" />
                            {formatDate(campaign.startDate)}
                            {campaign.endDate && (
                              <>
                                <ChevronRight className="h-3 w-3" />
                                {formatDate(campaign.endDate)}
                              </>
                            )}
                          </span>
                          {campaign.targetArea && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3.5 w-3.5" />
                              {campaign.targetArea}
                            </span>
                          )}
                          {campaign.targetZipCodes && campaign.targetZipCodes.length > 0 && (
                            <span className="text-gray-400">
                              Zips: {campaign.targetZipCodes.join(', ')}
                            </span>
                          )}
                        </div>

                        {/* Row 3: Budget bar + metrics */}
                        <div className="mt-3 flex items-center gap-6">
                          <div className="flex-1 max-w-xs">
                            <div className="flex justify-between text-xs mb-1">
                              <span className="text-gray-500">
                                {formatCurrency(campaign.spent)} of {formatCurrency(campaign.budget)}
                              </span>
                              <span className="font-medium text-gray-700">{spendPct.toFixed(0)}%</span>
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  spendPct >= 90 ? 'bg-red-500' : spendPct >= 70 ? 'bg-amber-500' : 'bg-orange-500'
                                }`}
                                style={{ width: `${spendPct}%` }}
                              />
                            </div>
                          </div>

                          <div className="text-center">
                            <p className="text-lg font-bold text-gray-900">{campaign.leadsGenerated}</p>
                            <p className="text-xs text-gray-500">Leads</p>
                          </div>

                          <div className="text-center">
                            <p className="text-lg font-bold text-orange-600">{formatCurrency(cpl)}</p>
                            <p className="text-xs text-gray-500">Cost/Lead</p>
                          </div>
                        </div>
                      </div>

                      <button className="mt-1 shrink-0 rounded-lg border border-gray-200 p-2 text-gray-400 hover:text-orange-600 hover:border-orange-300 transition-colors">
                        <Pencil className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* New Campaign Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowModal(false)}
          />

          {/* Modal */}
          <div className="relative z-10 w-full max-w-lg rounded-xl bg-white p-6 shadow-xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-gray-900">New Campaign</h2>
              <button
                onClick={() => setShowModal(false)}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Campaign Name</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  placeholder="e.g. Spring Hail Season Door Knocking"
                />
              </div>

              {/* Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as Campaign['type'] })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                >
                  {Object.entries(CAMPAIGN_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>

              {/* Budget */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Budget ($)</label>
                <input
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value={form.budget}
                  onChange={(e) => setForm({ ...form, budget: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  placeholder="5000"
                />
              </div>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  />
                </div>
              </div>

              {/* Target Area */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Target Area</label>
                <input
                  type="text"
                  value={form.targetArea}
                  onChange={(e) => setForm({ ...form, targetArea: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  placeholder="e.g. North Dallas suburbs"
                />
              </div>

              {/* Target Zip Codes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Target Zip Codes</label>
                <input
                  type="text"
                  value={form.targetZipCodes}
                  onChange={(e) => setForm({ ...form, targetZipCodes: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  placeholder="75001, 75002, 75003"
                />
                <p className="mt-1 text-xs text-gray-400">Comma separated</p>
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none resize-none"
                  placeholder="Campaign goals, strategy, notes..."
                />
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-orange-700 transition-colors"
                >
                  Create Campaign
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}
