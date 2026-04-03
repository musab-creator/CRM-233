"use client";

import { useCRMStore } from "@/lib/store";
import { formatCurrency, getStageName, getStageColor } from "@/lib/utils";
import {
  Users,
  Briefcase,
  DollarSign,
  TrendingUp,
  Shield,
  Home,
  AlertCircle,
  FileCheck,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";

export function Dashboard() {
  const { getDashboardKPIs, jobs, claims, setCurrentView, setSelectedJobId } = useCRMStore();
  const kpis = getDashboardKPIs();

  const statCards = [
    { label: "Total Leads", value: kpis.totalLeads, icon: Users, color: "text-blue-600", bg: "bg-blue-50", change: "+12%", up: true },
    { label: "Active Jobs", value: kpis.activeJobs, icon: Briefcase, color: "text-purple-600", bg: "bg-purple-50", change: "+8%", up: true },
    { label: "Revenue (YTD)", value: formatCurrency(kpis.totalRevenue), icon: DollarSign, color: "text-green-600", bg: "bg-green-50", change: "+23%", up: true },
    { label: "Close Rate", value: `${kpis.closeRate.toFixed(1)}%`, icon: TrendingUp, color: "text-amber-600", bg: "bg-amber-50", change: "+3%", up: true },
    { label: "Insurance Jobs", value: kpis.insuranceJobs, icon: Shield, color: "text-indigo-600", bg: "bg-indigo-50", change: "80%", up: true },
    { label: "Retail Jobs", value: kpis.retailJobs, icon: Home, color: "text-teal-600", bg: "bg-teal-50", change: "20%", up: false },
    { label: "Pending Claims", value: kpis.pendingClaims, icon: AlertCircle, color: "text-orange-600", bg: "bg-orange-50", change: "3 new", up: true },
    { label: "Supplements Pending", value: kpis.supplementsPending, icon: FileCheck, color: "text-pink-600", bg: "bg-pink-50", change: "$8.5k", up: true },
  ];

  const recentJobs = jobs.slice(0, 5);

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="stat-card">
              <div className="flex items-center justify-between">
                <div className={`rounded-lg p-2 ${stat.bg}`}>
                  <Icon className={`h-5 w-5 ${stat.color}`} />
                </div>
                <div className={`flex items-center gap-1 text-xs font-medium ${stat.up ? "text-green-600" : "text-gray-500"}`}>
                  {stat.change}
                  {stat.up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                </div>
              </div>
              <div className="mt-3">
                <p className="text-2xl font-bold text-gray-900">{stat.value}</p>
                <p className="text-sm text-gray-500">{stat.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Revenue Chart Placeholder */}
        <div className="card lg:col-span-2">
          <div className="card-header flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Revenue Overview</h3>
            <div className="flex gap-2">
              <button className="rounded-md bg-brand-50 px-3 py-1 text-xs font-medium text-brand-600">Monthly</button>
              <button className="rounded-md px-3 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50">Quarterly</button>
            </div>
          </div>
          <div className="card-body">
            <div className="flex items-end gap-2 h-48">
              {kpis.revenueByMonth.map((item, i) => {
                const maxVal = Math.max(...kpis.revenueByMonth.map(r => r.amount));
                const height = (item.amount / maxVal) * 100;
                return (
                  <div key={item.month} className="flex flex-1 flex-col items-center gap-1">
                    <span className="text-[10px] text-gray-400">{formatCurrency(item.amount)}</span>
                    <div
                      className="w-full rounded-t-md bg-gradient-to-t from-brand-500 to-brand-400 transition-all hover:from-brand-600 hover:to-brand-500"
                      style={{ height: `${height}%`, minHeight: "4px" }}
                    />
                    <span className="text-[10px] text-gray-500">{item.month}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Pipeline Breakdown */}
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-gray-900">Pipeline Breakdown</h3>
          </div>
          <div className="card-body space-y-3">
            {kpis.jobsByStage.map((item) => {
              const total = kpis.jobsByStage.reduce((sum, s) => sum + s.count, 0);
              const pct = ((item.count / total) * 100).toFixed(0);
              return (
                <div key={item.stage}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">{item.stage}</span>
                    <span className="font-medium text-gray-900">{item.count}</span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full bg-brand-400"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Lead Sources */}
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-gray-900">Lead Sources</h3>
          </div>
          <div className="card-body">
            <div className="space-y-3">
              {kpis.leadsBySource.map((item) => {
                const total = kpis.leadsBySource.reduce((sum, s) => sum + s.count, 0);
                const pct = ((item.count / total) * 100).toFixed(0);
                const colors = [
                  "bg-blue-400", "bg-green-400", "bg-purple-400", "bg-orange-400",
                  "bg-pink-400", "bg-cyan-400", "bg-amber-400", "bg-gray-400",
                ];
                const i = kpis.leadsBySource.indexOf(item);
                return (
                  <div key={item.source} className="flex items-center gap-3">
                    <div className={`h-3 w-3 rounded-full ${colors[i % colors.length]}`} />
                    <span className="flex-1 text-sm text-gray-600">{item.source}</span>
                    <span className="text-sm font-medium text-gray-900">{item.count}</span>
                    <span className="text-xs text-gray-400 w-8 text-right">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Rep Performance */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Sales Rep Performance</h3>
            <button className="text-xs text-brand-600 hover:text-brand-700 font-medium">View All</button>
          </div>
          <div className="card-body">
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="pb-3 font-medium">Rep</th>
                  <th className="pb-3 font-medium text-center">Leads</th>
                  <th className="pb-3 font-medium text-center">Closed</th>
                  <th className="pb-3 font-medium text-right">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {kpis.repPerformance.map((rep, i) => (
                  <tr key={rep.name}>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-600">
                          {i + 1}
                        </div>
                        <span className="text-sm font-medium text-gray-900">{rep.name}</span>
                      </div>
                    </td>
                    <td className="py-2.5 text-center text-sm text-gray-600">{rep.leads}</td>
                    <td className="py-2.5 text-center text-sm text-gray-600">{rep.closed}</td>
                    <td className="py-2.5 text-right text-sm font-medium text-gray-900">
                      {formatCurrency(rep.revenue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Recent Activity / Jobs */}
      <div className="card">
        <div className="card-header flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Recent Jobs</h3>
          <button
            onClick={() => setCurrentView("pipeline")}
            className="text-xs text-brand-600 hover:text-brand-700 font-medium"
          >
            View Pipeline
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="table-header px-6 py-3">Job</th>
                <th className="table-header px-6 py-3">Type</th>
                <th className="table-header px-6 py-3">Stage</th>
                <th className="table-header px-6 py-3">Amount</th>
                <th className="table-header px-6 py-3">Assigned</th>
                <th className="table-header px-6 py-3">Priority</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {recentJobs.map((job) => (
                <tr
                  key={job.id}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <td className="table-cell">
                    <div>
                      <p className="font-medium text-gray-900">{job.title}</p>
                      <p className="text-xs text-gray-500">{job.contact.firstName} {job.contact.lastName}</p>
                    </div>
                  </td>
                  <td className="table-cell">
                    <span className={`badge ${job.type === "insurance" ? "bg-indigo-100 text-indigo-700" : "bg-teal-100 text-teal-700"}`}>
                      {job.type === "insurance" ? "Insurance" : "Retail"}
                    </span>
                  </td>
                  <td className="table-cell">
                    <span className={`badge ${getStageColor(job.stage)}`}>
                      {getStageName(job.stage)}
                    </span>
                  </td>
                  <td className="table-cell font-medium text-gray-900">
                    {formatCurrency(job.estimateAmount || job.retailPrice || 0)}
                  </td>
                  <td className="table-cell text-gray-600">{job.assignedTo}</td>
                  <td className="table-cell">
                    <span className={`badge ${
                      job.priority === "urgent" ? "bg-red-100 text-red-700" :
                      job.priority === "high" ? "bg-orange-100 text-orange-700" :
                      job.priority === "medium" ? "bg-yellow-100 text-yellow-700" :
                      "bg-gray-100 text-gray-700"
                    }`}>
                      {job.priority}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Financial Summary */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="card">
          <div className="card-body text-center">
            <p className="text-sm text-gray-500">ACV Collected</p>
            <p className="text-2xl font-bold text-green-600 mt-1">{formatCurrency(kpis.acvCollected)}</p>
            <p className="text-xs text-gray-400 mt-1">Initial insurance payments received</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body text-center">
            <p className="text-sm text-gray-500">Depreciation Pending</p>
            <p className="text-2xl font-bold text-amber-600 mt-1">{formatCurrency(kpis.depreciationPending)}</p>
            <p className="text-xs text-gray-400 mt-1">RCV holdback awaiting release</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body text-center">
            <p className="text-sm text-gray-500">Avg. Job Value</p>
            <p className="text-2xl font-bold text-brand-600 mt-1">{formatCurrency(kpis.avgJobValue)}</p>
            <p className="text-xs text-gray-400 mt-1">Across all completed jobs</p>
          </div>
        </div>
      </div>
    </div>
  );
}
