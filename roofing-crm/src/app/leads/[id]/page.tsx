'use client';

import AppShell from '@/components/AppShell';
import StatusBadge from '@/components/StatusBadge';
import { useCRMStore } from '@/store';
import {
  formatCurrency, formatDate, formatDateTime,
  getLeadStatusLabel, getLeadStatusColor, getClaimTypeLabel,
  getPolicyTypeLabel, getPolicyTypeBadge, getClaimStatusLabel, getClaimStatusColor
} from '@/lib/utils';
import { use } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, User, MapPin, Phone, Mail, Shield, FileText,
  Camera, FileSignature, ClipboardCheck, Calendar, DollarSign,
  MessageSquare, Edit, ChevronRight
} from 'lucide-react';
import type { LeadStatus } from '@/types';

export default function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { leads, homeowners, policies, claims, inspections, contingencies, users, activities, updateLead } = useCRMStore();

  const lead = leads.find(l => l.id === id);
  if (!lead) {
    return (
      <AppShell>
        <div className="text-center py-20">
          <p className="text-gray-500">Lead not found</p>
          <Link href="/leads" className="text-orange-600 hover:underline text-sm mt-2 inline-block">Back to Leads</Link>
        </div>
      </AppShell>
    );
  }

  const homeowner = homeowners.find(h => h.id === lead.homeownerId);
  const policy = lead.policyId ? policies.find(p => p.id === lead.policyId) : null;
  const claim = lead.claimId ? claims.find(c => c.id === lead.claimId) : null;
  const assignedUser = users.find(u => u.id === lead.assignedTo);
  const leadInspections = inspections.filter(i => i.leadId === lead.id);
  const leadContingency = lead.contingencyId ? contingencies.find(c => c.id === lead.contingencyId) : null;
  const leadActivities = activities.filter(a => a.leadId === lead.id).slice(0, 10);

  const insuranceStatuses: LeadStatus[] = [
    'new', 'contacted', 'inspection_scheduled', 'inspection_complete',
    'policy_reviewed', 'contingency_sent', 'contingency_signed',
    'claim_filed', 'adjuster_scheduled', 'adjuster_met',
    'approved', 'job_sold', 'in_production', 'completed'
  ];
  const currentStageIndex = insuranceStatuses.indexOf(lead.status);

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto">
        {/* Back button and header */}
        <div className="flex items-center gap-4 mb-6">
          <Link href="/leads" className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">
                {homeowner ? `${homeowner.firstName} ${homeowner.lastName}` : 'Unknown'}
              </h1>
              <StatusBadge
                label={getLeadStatusLabel(lead.status)}
                colorClass={getLeadStatusColor(lead.status)}
                size="md"
              />
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                lead.jobType === 'insurance' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
              }`}>
                {lead.jobType === 'insurance' ? 'Insurance' : 'Retail'}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1">
              Assigned to {assignedUser?.name || 'Unassigned'} &middot; Created {formatDate(lead.createdAt)}
            </p>
          </div>
          {lead.estimatedValue && (
            <div className="text-right">
              <p className="text-sm text-gray-500">Estimated Value</p>
              <p className="text-2xl font-bold text-green-600">{formatCurrency(lead.estimatedValue)}</p>
            </div>
          )}
        </div>

        {/* Progress bar for insurance jobs */}
        {lead.jobType === 'insurance' && currentStageIndex >= 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700">Insurance Job Pipeline</h3>
              <span className="text-xs text-gray-500">Stage {currentStageIndex + 1} of {insuranceStatuses.length}</span>
            </div>
            <div className="flex gap-1">
              {insuranceStatuses.map((status, i) => (
                <div
                  key={status}
                  className={`h-2 flex-1 rounded-full ${
                    i <= currentStageIndex ? 'bg-orange-500' : 'bg-gray-200'
                  }`}
                  title={getLeadStatusLabel(status)}
                />
              ))}
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-[10px] text-gray-400">New</span>
              <span className="text-[10px] text-gray-400">Completed</span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-6">
          {/* Left column - Main info */}
          <div className="col-span-2 space-y-6">
            {/* Homeowner Info */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <User className="w-4 h-4" /> Homeowner Information
              </h2>
              {homeowner && (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-gray-400" />
                    <span>{homeowner.address}, {homeowner.city}, {homeowner.state} {homeowner.zip}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4 text-gray-400" />
                    <span>{homeowner.phone}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4 text-gray-400" />
                    <span>{homeowner.email}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-gray-400" />
                    <span>Added {formatDate(homeowner.createdAt)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Policy Info (Insurance only) */}
            {policy && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <Shield className="w-4 h-4" /> Insurance Policy
                  </h2>
                  <Link href={`/policies`} className="text-xs text-orange-600 hover:underline flex items-center gap-1">
                    View Full Policy <ChevronRight className="w-3 h-3" />
                  </Link>
                </div>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-gray-500 text-xs">Carrier</p>
                    <p className="font-medium">{policy.carrier}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Policy #</p>
                    <p className="font-medium">{policy.policyNumber}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Type</p>
                    <StatusBadge label={policy.policyType} colorClass={getPolicyTypeBadge(policy.policyType)} />
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Deductible</p>
                    <p className="font-medium">{policy.deductibleType === 'flat' ? formatCurrency(policy.deductible) : `${policy.deductible}%`}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Dwelling Coverage</p>
                    <p className="font-medium">{formatCurrency(policy.dwellingCoverage)}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Date of Loss</p>
                    <p className="font-medium">{formatDate(policy.bestDateOfLoss)}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Claim Info */}
            {claim && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <ClipboardCheck className="w-4 h-4" /> Insurance Claim
                  </h2>
                  <StatusBadge label={getClaimStatusLabel(claim.status)} colorClass={getClaimStatusColor(claim.status)} />
                </div>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-gray-500 text-xs">Claim #</p>
                    <p className="font-medium">{claim.claimNumber}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Adjuster</p>
                    <p className="font-medium">{claim.adjusterName || 'TBD'}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Claim Type</p>
                    <p className="font-medium">{getClaimTypeLabel(claim.claimType)}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Date Filed</p>
                    <p className="font-medium">{formatDate(claim.dateFiled)}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Follow-ups Sent</p>
                    <p className="font-medium">{claim.followUps.length}</p>
                  </div>
                  {claim.approvedAmount && (
                    <div>
                      <p className="text-gray-500 text-xs">Approved Amount</p>
                      <p className="font-medium text-green-600">{formatCurrency(claim.approvedAmount)}</p>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex gap-2">
                  <Link href="/claims" className="px-3 py-1.5 bg-orange-600 text-white rounded-lg text-xs font-medium hover:bg-orange-700">
                    View in Claims Tracker
                  </Link>
                </div>
              </div>
            )}

            {/* Notes */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Notes</h2>
              <p className="text-sm text-gray-600">{lead.notes || 'No notes yet.'}</p>
            </div>
          </div>

          {/* Right column - Actions & Activity */}
          <div className="space-y-6">
            {/* Quick Actions */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Quick Actions</h2>
              <div className="space-y-2">
                {!policy && lead.jobType === 'insurance' && (
                  <Link href="/policies?new=true" className="flex items-center gap-2 w-full px-3 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm hover:bg-blue-100 transition-colors">
                    <Shield className="w-4 h-4" /> Upload Policy
                  </Link>
                )}
                {policy && !leadContingency && (
                  <Link href={`/contingency?policyId=${policy.id}`} className="flex items-center gap-2 w-full px-3 py-2 bg-orange-50 text-orange-700 rounded-lg text-sm hover:bg-orange-100 transition-colors">
                    <FileSignature className="w-4 h-4" /> Generate Contingency
                  </Link>
                )}
                {!claim && policy && (
                  <Link href="/claims?new=true" className="flex items-center gap-2 w-full px-3 py-2 bg-purple-50 text-purple-700 rounded-lg text-sm hover:bg-purple-100 transition-colors">
                    <FileText className="w-4 h-4" /> File Claim
                  </Link>
                )}
                <Link href="/inspections?new=true" className="flex items-center gap-2 w-full px-3 py-2 bg-teal-50 text-teal-700 rounded-lg text-sm hover:bg-teal-100 transition-colors">
                  <Camera className="w-4 h-4" /> Schedule Inspection
                </Link>
                <button className="flex items-center gap-2 w-full px-3 py-2 bg-green-50 text-green-700 rounded-lg text-sm hover:bg-green-100 transition-colors">
                  <MessageSquare className="w-4 h-4" /> Send Text to Homeowner
                </button>
              </div>
            </div>

            {/* Status Update */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Update Status</h2>
              <select
                value={lead.status}
                onChange={(e) => updateLead(lead.id, { status: e.target.value as LeadStatus })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                {(lead.jobType === 'insurance' ? [
                  'new', 'contacted', 'inspection_scheduled', 'inspection_complete',
                  'policy_reviewed', 'contingency_sent', 'contingency_signed',
                  'claim_filed', 'adjuster_scheduled', 'adjuster_met',
                  'approved', 'supplement_needed', 'job_sold', 'in_production', 'completed', 'lost'
                ] : [
                  'new', 'contacted', 'inspection_scheduled', 'inspection_complete',
                  'retail_estimate_sent', 'retail_approved', 'job_sold', 'in_production', 'completed', 'lost'
                ]).map(s => (
                  <option key={s} value={s}>{getLeadStatusLabel(s as LeadStatus)}</option>
                ))}
              </select>
            </div>

            {/* Inspections */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <Camera className="w-4 h-4" /> Inspections ({leadInspections.length})
              </h2>
              {leadInspections.length === 0 ? (
                <p className="text-sm text-gray-400">No inspections yet</p>
              ) : (
                <div className="space-y-2">
                  {leadInspections.map(insp => (
                    <div key={insp.id} className="p-2 bg-gray-50 rounded-lg text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{formatDate(insp.scheduledDate)}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          insp.status === 'completed' || insp.status === 'report_generated'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-blue-100 text-blue-700'
                        }`}>
                          {insp.status.replace('_', ' ')}
                        </span>
                      </div>
                      {insp.findings && <p className="text-gray-500 mt-1">{insp.findings}</p>}
                      <p className="text-gray-400 mt-1">{insp.photos.length} photos</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Activity Feed */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Recent Activity</h2>
              {leadActivities.length === 0 ? (
                <p className="text-sm text-gray-400">No activity yet</p>
              ) : (
                <div className="space-y-3">
                  {leadActivities.map(act => (
                    <div key={act.id} className="flex gap-2 text-xs">
                      <div className="w-1.5 h-1.5 rounded-full bg-orange-400 mt-1.5 flex-shrink-0" />
                      <div>
                        <p className="text-gray-700">{act.description}</p>
                        <p className="text-gray-400 mt-0.5">{formatDateTime(act.createdAt)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
