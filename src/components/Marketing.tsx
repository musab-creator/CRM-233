"use client";

import { useState } from "react";
import { useCRMStore } from "@/lib/store";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Megaphone,
  Plus,
  TrendingUp,
  DollarSign,
  Users,
  Target,
  BarChart3,
  ArrowUpRight,
} from "lucide-react";

export function Marketing() {
  const { campaigns, getDashboardKPIs } = useCRMStore();
  const [showNewCampaign, setShowNewCampaign] = useState(false);
  const kpis = getDashboardKPIs();

  const totalBudget = campaigns.reduce((s, c) => s + c.budget, 0);
  const totalSpent = campaigns.reduce((s, c) => s + c.spent, 0);
  const totalLeads = campaigns.reduce((s, c) => s + c.leadsGenerated, 0);
  const totalRevenue = campaigns.reduce((s, c) => s + c.revenue, 0);
  const overallROI = totalSpent > 0 ? ((totalRevenue - totalSpent) / totalSpent * 100).toFixed(0) : "0";

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Marketing & Campaigns</h2>
          <p className="text-sm text-gray-500">Track campaign performance and ROI</p>
        </div>
        <button onClick={() => setShowNewCampaign(true)} className="btn-primary">
          <Plus className="h-4 w-4" /> New Campaign
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="stat-card">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-blue-500" />
            <span className="text-xs text-gray-500">Total Budget</span>
          </div>
          <p className="text-xl font-bold mt-2">{formatCurrency(totalBudget)}</p>
          <p className="text-xs text-gray-400">{formatCurrency(totalSpent)} spent</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-green-500" />
            <span className="text-xs text-gray-500">Total Leads</span>
          </div>
          <p className="text-xl font-bold mt-2">{totalLeads}</p>
          <p className="text-xs text-gray-400">Across all campaigns</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-purple-500" />
            <span className="text-xs text-gray-500">Jobs Closed</span>
          </div>
          <p className="text-xl font-bold mt-2">{campaigns.reduce((s, c) => s + c.jobsClosed, 0)}</p>
          <p className="text-xs text-gray-400">From marketing leads</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-500" />
            <span className="text-xs text-gray-500">Revenue</span>
          </div>
          <p className="text-xl font-bold mt-2">{formatCurrency(totalRevenue)}</p>
          <p className="text-xs text-gray-400">From campaigns</p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-emerald-500" />
            <span className="text-xs text-gray-500">Overall ROI</span>
          </div>
          <p className="text-xl font-bold text-emerald-600 mt-2">{overallROI}%</p>
          <p className="text-xs text-gray-400">Return on investment</p>
        </div>
      </div>

      {/* Lead Source Performance */}
      <div className="card">
        <div className="card-header">
          <h3 className="text-sm font-semibold">Lead Source Performance</h3>
        </div>
        <div className="card-body">
          <div className="flex items-end gap-3 h-48">
            {kpis.leadsBySource.map((source, i) => {
              const max = Math.max(...kpis.leadsBySource.map((s) => s.count));
              const height = (source.count / max) * 100;
              const colors = [
                "from-blue-500 to-blue-400",
                "from-green-500 to-green-400",
                "from-purple-500 to-purple-400",
                "from-orange-500 to-orange-400",
                "from-pink-500 to-pink-400",
                "from-cyan-500 to-cyan-400",
                "from-amber-500 to-amber-400",
                "from-gray-500 to-gray-400",
              ];
              return (
                <div key={source.source} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-xs font-medium text-gray-900">{source.count}</span>
                  <div
                    className={`w-full rounded-t-md bg-gradient-to-t ${colors[i]} transition-all hover:opacity-80`}
                    style={{ height: `${height}%`, minHeight: "8px" }}
                  />
                  <span className="text-[10px] text-gray-500 text-center leading-tight">{source.source}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Campaign Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {campaigns.map((campaign) => {
          const budgetPct = (campaign.spent / campaign.budget * 100).toFixed(0);
          const costPerLead = campaign.leadsGenerated > 0 ? campaign.spent / campaign.leadsGenerated : 0;
          return (
            <div key={campaign.id} className="card">
              <div className="card-header flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">{campaign.name}</h3>
                  <p className="text-xs text-gray-500 capitalize mt-0.5">{campaign.type.replace("_", " ")}</p>
                </div>
                <span className={`badge ${
                  campaign.status === "active" ? "bg-green-100 text-green-700" :
                  campaign.status === "completed" ? "bg-gray-100 text-gray-700" :
                  "bg-amber-100 text-amber-700"
                }`}>
                  {campaign.status}
                </span>
              </div>
              <div className="card-body space-y-4">
                {/* Budget Bar */}
                <div>
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>Budget: {formatCurrency(campaign.budget)}</span>
                    <span>{budgetPct}% used</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100">
                    <div
                      className={`h-full rounded-full ${Number(budgetPct) > 90 ? "bg-red-400" : "bg-brand-400"}`}
                      style={{ width: `${Math.min(Number(budgetPct), 100)}%` }}
                    />
                  </div>
                </div>

                {/* Metrics Grid */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="text-center p-2 rounded-lg bg-blue-50">
                    <p className="text-lg font-bold text-blue-600">{campaign.leadsGenerated}</p>
                    <p className="text-[10px] text-gray-500">Leads</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-green-50">
                    <p className="text-lg font-bold text-green-600">{campaign.jobsClosed}</p>
                    <p className="text-[10px] text-gray-500">Closed</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-purple-50">
                    <p className="text-lg font-bold text-purple-600">{formatCurrency(costPerLead)}</p>
                    <p className="text-[10px] text-gray-500">Cost/Lead</p>
                  </div>
                </div>

                {/* Revenue & ROI */}
                <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                  <div>
                    <p className="text-xs text-gray-500">Revenue</p>
                    <p className="text-lg font-bold text-gray-900">{formatCurrency(campaign.revenue)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500">ROI</p>
                    <p className="text-lg font-bold text-emerald-600 flex items-center gap-1">
                      {campaign.roi.toLocaleString()}%
                      <ArrowUpRight className="h-4 w-4" />
                    </p>
                  </div>
                </div>

                {/* Date Range */}
                <p className="text-xs text-gray-400">
                  {formatDate(campaign.startDate)} {campaign.endDate ? `- ${formatDate(campaign.endDate)}` : "- Ongoing"}
                </p>

                {campaign.notes && (
                  <p className="text-xs text-gray-500 italic">{campaign.notes}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* New Campaign Modal */}
      {showNewCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
            <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">New Campaign</h3>
              <button onClick={() => setShowNewCampaign(false)} className="text-gray-400 hover:text-gray-600">&times;</button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="label">Campaign Name</label>
                <input className="input" placeholder="e.g., Spring Storm Chase 2024" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Type</label>
                  <select className="input">
                    <option value="door_knock">Door Knocking</option>
                    <option value="direct_mail">Direct Mail</option>
                    <option value="digital_ads">Digital Ads</option>
                    <option value="social_media">Social Media</option>
                    <option value="referral_program">Referral Program</option>
                    <option value="yard_signs">Yard Signs</option>
                    <option value="event">Event / Home Show</option>
                  </select>
                </div>
                <div>
                  <label className="label">Budget</label>
                  <input type="number" className="input" placeholder="5000" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Start Date</label>
                  <input type="date" className="input" />
                </div>
                <div>
                  <label className="label">End Date</label>
                  <input type="date" className="input" />
                </div>
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea className="input" rows={3} placeholder="Campaign strategy and notes..." />
              </div>
            </div>
            <div className="border-t border-gray-100 px-6 py-4 flex justify-end gap-3">
              <button onClick={() => setShowNewCampaign(false)} className="btn-secondary">Cancel</button>
              <button onClick={() => setShowNewCampaign(false)} className="btn-primary">Create Campaign</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
