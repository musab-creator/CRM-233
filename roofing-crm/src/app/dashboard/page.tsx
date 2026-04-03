'use client';

import { useMemo } from 'react';
import AppShell from '@/components/AppShell';
import { useCRMStore } from '@/store';
import { formatCurrency, formatDate, formatDateTime, getLeadStatusLabel } from '@/lib/utils';
import {
  Users,
  Shield,
  Home,
  DollarSign,
  ClipboardCheck,
  TrendingUp,
  Calendar,
  Activity,
  FileText,
} from 'lucide-react';
import type { LeadStatus } from '@/types';

function getActivityIcon(type: string) {
  switch (type) {
    case 'call':
      return <Activity className="h-4 w-4 text-green-600" />;
    case 'email':
      return <FileText className="h-4 w-4 text-blue-600" />;
    case 'inspection':
      return <ClipboardCheck className="h-4 w-4 text-purple-600" />;
    case 'claim_update':
      return <Shield className="h-4 w-4 text-orange-600" />;
    case 'status_change':
      return <TrendingUp className="h-4 w-4 text-indigo-600" />;
    case 'document':
      return <FileText className="h-4 w-4 text-gray-600" />;
    case 'note':
      return <FileText className="h-4 w-4 text-amber-600" />;
    default:
      return <Activity className="h-4 w-4 text-gray-500" />;
  }
}

function relativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateStr);
}

export default function DashboardPage() {
  const currentUser = useCRMStore((s) => s.currentUser);
  const leads = useCRMStore((s) => s.leads);
  const homeowners = useCRMStore((s) => s.homeowners);
  const inspections = useCRMStore((s) => s.inspections);
  const activities = useCRMStore((s) => s.activities);
  const getDashboardStats = useCRMStore((s) => s.getDashboardStats);

  const stats = useMemo(() => getDashboardStats(), [getDashboardStats]);

  const recentActivities = useMemo(
    () =>
      [...activities]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5),
    [activities],
  );

  const upcomingInspections = useMemo(
    () =>
      inspections
        .filter((i) => i.status === 'scheduled')
        .sort((a, b) => new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime())
        .slice(0, 5),
    [inspections],
  );

  const pipelineSummary = useMemo(() => {
    const counts: Partial<Record<LeadStatus, number>> = {};
    for (const lead of leads) {
      if (lead.status !== 'completed' && lead.status !== 'lost') {
        counts[lead.status] = (counts[lead.status] || 0) + 1;
      }
    }
    return Object.entries(counts).sort(([, a], [, b]) => b - a);
  }, [leads]);

  const homeownerMap = useMemo(() => {
    const map = new Map<string, (typeof homeowners)[number]>();
    for (const h of homeowners) {
      map.set(h.id, h);
    }
    return map;
  }, [homeowners]);

  const insuranceCount = stats.activeInsuranceJobs;
  const retailCount = stats.activeRetailJobs;
  const totalJobs = insuranceCount + retailCount || 1;
  const insurancePct = Math.round((insuranceCount / totalJobs) * 100);
  const retailPct = 100 - insurancePct;

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const kpiCards = [
    {
      label: 'Total Active Leads',
      value: stats.totalLeads,
      sub: `+${stats.newLeadsThisWeek} this week`,
      icon: Users,
      gradient: 'bg-gradient-to-br from-orange-500 to-orange-600',
    },
    {
      label: 'Insurance Jobs',
      value: stats.activeInsuranceJobs,
      sub: 'Active',
      icon: Shield,
      gradient: 'bg-gradient-to-br from-blue-500 to-blue-600',
    },
    {
      label: 'Retail Jobs',
      value: stats.activeRetailJobs,
      sub: 'Active',
      icon: Home,
      gradient: 'bg-gradient-to-br from-emerald-500 to-emerald-600',
    },
    {
      label: 'Revenue Pipeline',
      value: formatCurrency(stats.revenuePipeline),
      sub: 'Estimated value',
      icon: DollarSign,
      gradient: 'bg-gradient-to-br from-purple-500 to-purple-600',
    },
    {
      label: 'Pending Claims',
      value: stats.pendingClaims,
      sub: 'Awaiting resolution',
      icon: ClipboardCheck,
      gradient: 'bg-gradient-to-br from-amber-500 to-amber-600',
    },
    {
      label: 'Conversion Rate',
      value: `${stats.conversionRate.toFixed(1)}%`,
      sub: 'All-time',
      icon: TrendingUp,
      gradient: 'bg-gradient-to-br from-rose-500 to-rose-600',
    },
  ];

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Welcome back, {currentUser?.name?.split(' ')[0] ?? 'User'}
            </h1>
            <p className="text-sm text-gray-500">{today}</p>
          </div>
          {currentUser?.role && (
            <span className="inline-flex items-center rounded-full bg-orange-100 px-3 py-1 text-sm font-medium text-orange-800 capitalize">
              {currentUser.role.replace('_', ' ')}
            </span>
          )}
        </div>

        {/* KPI Stats Grid */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {kpiCards.map((card) => {
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

        {/* Two-column layout */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left column - wider */}
          <div className="lg:col-span-2 space-y-6">
            {/* Recent Activity */}
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Activity className="h-5 w-5 text-orange-500" />
                Recent Activity
              </h2>
              {recentActivities.length === 0 ? (
                <p className="text-sm text-gray-500">No recent activity.</p>
              ) : (
                <ul className="space-y-3">
                  {recentActivities.map((act) => (
                    <li key={act.id} className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100">
                        {getActivityIcon(act.type)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-800">{act.description}</p>
                        <p className="text-xs text-gray-400">
                          {formatDateTime(act.createdAt)} &middot; {relativeTime(act.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Insurance vs Retail Split */}
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Shield className="h-5 w-5 text-orange-500" />
                Insurance vs Retail Split
              </h2>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="mb-2 flex justify-between text-sm">
                    <span className="font-medium text-blue-700">Insurance ({insurancePct}%)</span>
                    <span className="font-medium text-emerald-700">Retail ({retailPct}%)</span>
                  </div>
                  <div className="h-4 w-full overflow-hidden rounded-full bg-gray-100">
                    <div className="flex h-full">
                      <div
                        className="bg-blue-500 transition-all"
                        style={{ width: `${insurancePct}%` }}
                      />
                      <div
                        className="bg-emerald-500 transition-all"
                        style={{ width: `${retailPct}%` }}
                      />
                    </div>
                  </div>
                  <div className="mt-2 flex justify-between text-xs text-gray-500">
                    <span>{insuranceCount} jobs</span>
                    <span>{retailCount} jobs</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="space-y-6">
            {/* Upcoming Inspections */}
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Calendar className="h-5 w-5 text-orange-500" />
                Upcoming Inspections
              </h2>
              {upcomingInspections.length === 0 ? (
                <p className="text-sm text-gray-500">No upcoming inspections.</p>
              ) : (
                <ul className="space-y-3">
                  {upcomingInspections.map((insp) => {
                    const ho = homeownerMap.get(insp.homeownerId);
                    return (
                      <li key={insp.id} className="rounded-lg border border-gray-100 p-3">
                        <p className="text-sm font-medium text-gray-900">
                          {ho ? `${ho.firstName} ${ho.lastName}` : 'Unknown'}
                        </p>
                        <p className="text-xs text-gray-500">
                          {formatDate(insp.scheduledDate)}
                        </p>
                        {ho && (
                          <p className="mt-1 text-xs text-gray-400 truncate">
                            {ho.address}, {ho.city}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Pipeline Summary */}
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold text-gray-900 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-orange-500" />
                Pipeline Summary
              </h2>
              {pipelineSummary.length === 0 ? (
                <p className="text-sm text-gray-500">No active leads in pipeline.</p>
              ) : (
                <ul className="space-y-2">
                  {pipelineSummary.map(([status, count]) => (
                    <li key={status} className="flex items-center justify-between text-sm">
                      <span className="text-gray-600 truncate">
                        {getLeadStatusLabel(status as LeadStatus)}
                      </span>
                      <span className="ml-2 shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800">
                        {count}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
