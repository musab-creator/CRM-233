'use client';

import { useState } from 'react';
import AppShell from '@/components/AppShell';
import StatusBadge from '@/components/StatusBadge';
import { useCRMStore } from '@/store';
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  getClaimStatusLabel,
  getClaimStatusColor,
  getClaimTypeLabel,
  generateId,
} from '@/lib/utils';
import type { Claim, ClaimStatus, ClaimFollowUp } from '@/types';
import {
  Plus,
  FileText,
  Shield,
  Clock,
  Search,
  CheckCircle,
  Send,
  Mail,
  Phone,
  ChevronDown,
  ChevronUp,
  X,
  AlertCircle,
  DollarSign,
  User,
  Building,
} from 'lucide-react';

const CLAIM_STATUSES: ClaimStatus[] = [
  'filed',
  'acknowledged',
  'adjuster_assigned',
  'inspection_scheduled',
  'inspection_complete',
  'under_review',
  'approved',
  'partial_approved',
  'denied',
  'supplement_filed',
  'supplement_approved',
  'closed',
];

export default function ClaimsPage() {
  const {
    claims,
    homeowners,
    leads,
    policies,
    currentUser,
    addClaim,
    updateClaim,
    addActivity,
  } = useCRMStore();

  const [expandedClaimId, setExpandedClaimId] = useState<string | null>(null);
  const [showNewClaimModal, setShowNewClaimModal] = useState(false);
  const [emailPanel, setEmailPanel] = useState<{ claimId: string; target: 'adjuster' | 'carrier' } | null>(null);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [emailSent, setEmailSent] = useState(false);

  // New claim form state
  const [newClaimLeadId, setNewClaimLeadId] = useState('');
  const [newClaimNumber, setNewClaimNumber] = useState('');
  const [newClaimType, setNewClaimType] = useState<'hail' | 'wind' | 'hail_and_wind'>('hail');
  const [newAdjusterName, setNewAdjusterName] = useState('');
  const [newAdjusterEmail, setNewAdjusterEmail] = useState('');
  const [newAdjusterPhone, setNewAdjusterPhone] = useState('');
  const [newClaimNotes, setNewClaimNotes] = useState('');

  const getHomeowner = (homeownerId: string) =>
    homeowners.find((h) => h.id === homeownerId);

  const getHomeownerName = (homeownerId: string) => {
    const ho = getHomeowner(homeownerId);
    return ho ? `${ho.firstName} ${ho.lastName}` : 'Unknown';
  };

  // Stats
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const activeClaims = claims.filter(
    (c) => !['approved', 'denied', 'closed', 'supplement_approved'].includes(c.status)
  );
  const awaitingAdjuster = claims.filter(
    (c) => c.status === 'filed' || c.status === 'acknowledged'
  );
  const underReview = claims.filter((c) => c.status === 'under_review');
  const approvedThisMonth = claims.filter(
    (c) =>
      (c.status === 'approved' || c.status === 'partial_approved' || c.status === 'supplement_approved') &&
      new Date(c.updatedAt) >= monthStart
  );

  // Leads that have policies (for new claim modal)
  const leadsWithPolicies = leads.filter((l) => l.policyId);

  const selectedLead = leads.find((l) => l.id === newClaimLeadId);
  const selectedPolicy = selectedLead?.policyId
    ? policies.find((p) => p.id === selectedLead.policyId)
    : null;

  // Open follow-up email panel
  const openEmailPanel = (claim: Claim, target: 'adjuster' | 'carrier') => {
    const hoName = getHomeownerName(claim.homeownerId);
    const repName = currentUser?.name ?? 'Your Representative';

    if (target === 'adjuster') {
      setEmailSubject(`Follow Up - Claim ${claim.claimNumber} - ${hoName} Residence`);
      setEmailBody(
        `Dear ${claim.adjusterName || 'Claims Adjuster'},\n\n` +
        `I am writing to follow up on Claim #${claim.claimNumber} for the ${hoName} residence. ` +
        `This claim was filed on ${formatDate(claim.dateFiled)} for ${getClaimTypeLabel(claim.claimType).toLowerCase()} damage.\n\n` +
        `We would appreciate an update on the current status of this claim and any next steps required from our end. ` +
        `If an inspection has not yet been scheduled, we kindly request that one be arranged at the earliest convenience.\n\n` +
        `Please feel free to contact me directly if you need any additional information or documentation.\n\n` +
        `Thank you for your prompt attention to this matter.\n\n` +
        `Best regards,\n${repName}\nStormShield Roofing`
      );
    } else {
      setEmailSubject(`Follow Up - Claim ${claim.claimNumber} - ${hoName} Residence`);
      setEmailBody(
        `To Whom It May Concern,\n\n` +
        `I am writing on behalf of our client, ${hoName}, regarding Claim #${claim.claimNumber} ` +
        `filed with ${claim.carrier} on ${formatDate(claim.dateFiled)}.\n\n` +
        `This claim pertains to ${getClaimTypeLabel(claim.claimType).toLowerCase()} damage sustained at the insured property. ` +
        `We are requesting an update on the claim status and would like to ensure all necessary steps are being taken for a timely resolution.\n\n` +
        `If any additional documentation or information is required, please do not hesitate to reach out.\n\n` +
        `We look forward to hearing from you soon.\n\n` +
        `Best regards,\n${repName}\nStormShield Roofing`
      );
    }

    setEmailPanel({ claimId: claim.id, target });
    setEmailSent(false);
  };

  const handleSendEmail = (claim: Claim) => {
    if (!emailPanel) return;

    const sentTo =
      emailPanel.target === 'adjuster'
        ? claim.adjusterEmail || claim.adjusterName || 'Adjuster'
        : `${claim.carrier} Claims Department`;

    const followUp: ClaimFollowUp = {
      id: generateId(),
      claimId: claim.id,
      type: 'email',
      sentAt: new Date().toISOString(),
      sentTo,
      subject: emailSubject,
      body: emailBody,
      status: 'sent',
    };

    updateClaim(claim.id, {
      followUps: [...claim.followUps, followUp],
    });

    addActivity({
      id: generateId(),
      claimId: claim.id,
      leadId: claim.leadId,
      userId: currentUser?.id ?? '',
      type: 'email',
      description: `Follow-up email sent to ${sentTo} for claim ${claim.claimNumber}`,
      createdAt: new Date().toISOString(),
    });

    setEmailSent(true);
    setTimeout(() => {
      setEmailPanel(null);
      setEmailSent(false);
    }, 3000);
  };

  const handleStatusChange = (claim: Claim, newStatus: ClaimStatus) => {
    updateClaim(claim.id, { status: newStatus });
    addActivity({
      id: generateId(),
      claimId: claim.id,
      leadId: claim.leadId,
      userId: currentUser?.id ?? '',
      type: 'claim_update',
      description: `Claim ${claim.claimNumber} status changed to ${getClaimStatusLabel(newStatus)}`,
      createdAt: new Date().toISOString(),
    });
  };

  const handleNewClaim = () => {
    if (!selectedLead || !selectedPolicy || !newClaimNumber) return;

    const newClaim: Claim = {
      id: generateId(),
      leadId: selectedLead.id,
      homeownerId: selectedLead.homeownerId,
      policyId: selectedPolicy.id,
      claimNumber: newClaimNumber,
      carrier: selectedPolicy.carrier,
      adjusterName: newAdjusterName || undefined,
      adjusterEmail: newAdjusterEmail || undefined,
      adjusterPhone: newAdjusterPhone || undefined,
      status: 'filed',
      claimType: newClaimType,
      dateOfLoss: selectedPolicy.bestDateOfLoss,
      dateFiled: new Date().toISOString(),
      followUps: [],
      notes: newClaimNotes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    addClaim(newClaim);
    addActivity({
      id: generateId(),
      claimId: newClaim.id,
      leadId: selectedLead.id,
      userId: currentUser?.id ?? '',
      type: 'claim_update',
      description: `New claim ${newClaimNumber} filed with ${selectedPolicy.carrier}`,
      createdAt: new Date().toISOString(),
    });

    // Reset form
    setShowNewClaimModal(false);
    setNewClaimLeadId('');
    setNewClaimNumber('');
    setNewClaimType('hail');
    setNewAdjusterName('');
    setNewAdjusterEmail('');
    setNewAdjusterPhone('');
    setNewClaimNotes('');
  };

  const claimTypeBadgeColor = (type: string) => {
    if (type === 'hail') return 'bg-sky-100 text-sky-800';
    if (type === 'wind') return 'bg-violet-100 text-violet-800';
    return 'bg-indigo-100 text-indigo-800';
  };

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Claims Tracker</h1>
            <p className="mt-1 text-sm text-gray-500">
              Track insurance claims filed with carriers, follow up with adjusters, and monitor approvals.
            </p>
          </div>
          <button
            onClick={() => setShowNewClaimModal(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-orange-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            File New Claim
          </button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-100">
                <FileText className="h-5 w-5 text-orange-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Total Active Claims</p>
                <p className="text-2xl font-bold text-gray-900">{activeClaims.length}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
                <Clock className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Awaiting Adjuster</p>
                <p className="text-2xl font-bold text-gray-900">{awaitingAdjuster.length}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100">
                <Search className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Under Review</p>
                <p className="text-2xl font-bold text-gray-900">{underReview.length}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
                <DollarSign className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Approved This Month</p>
                <p className="text-2xl font-bold text-gray-900">{approvedThisMonth.length}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Claims Table */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          {claims.length === 0 ? (
            <div className="p-12 text-center">
              <Shield className="mx-auto h-12 w-12 text-gray-300" />
              <h3 className="mt-3 text-lg font-semibold text-gray-900">No claims filed yet</h3>
              <p className="mt-1 text-sm text-gray-500">
                File your first insurance claim to start tracking.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Claim #
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Homeowner
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Carrier
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Adjuster
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Date Filed
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Approved Amt
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {claims.map((claim) => {
                    const isExpanded = expandedClaimId === claim.id;
                    const isEmailOpen = emailPanel?.claimId === claim.id;

                    return (
                      <tr key={claim.id} className="group">
                        <td colSpan={9} className="p-0">
                          {/* Main Row */}
                          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto_auto] items-center">
                            <div className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">
                              {claim.claimNumber}
                            </div>
                            <div className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                              {getHomeownerName(claim.homeownerId)}
                            </div>
                            <div className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                              {claim.carrier}
                            </div>
                            <div className="px-4 py-3 whitespace-nowrap">
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${claimTypeBadgeColor(claim.claimType)}`}
                              >
                                {getClaimTypeLabel(claim.claimType)}
                              </span>
                            </div>
                            <div className="px-4 py-3 whitespace-nowrap">
                              <StatusBadge
                                label={getClaimStatusLabel(claim.status)}
                                colorClass={getClaimStatusColor(claim.status)}
                              />
                            </div>
                            <div className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                              {claim.adjusterName || <span className="text-gray-400 italic">Unassigned</span>}
                            </div>
                            <div className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
                              {formatDate(claim.dateFiled)}
                            </div>
                            <div className="px-4 py-3 text-sm font-medium whitespace-nowrap">
                              {claim.approvedAmount != null ? (
                                <span className="text-green-700">{formatCurrency(claim.approvedAmount)}</span>
                              ) : (
                                <span className="text-gray-400">-</span>
                              )}
                            </div>
                            <div className="px-4 py-3 whitespace-nowrap">
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => setExpandedClaimId(isExpanded ? null : claim.id)}
                                  className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                                >
                                  {isExpanded ? (
                                    <ChevronUp className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  )}
                                  Details
                                </button>
                                <button
                                  onClick={() => openEmailPanel(claim, 'adjuster')}
                                  className="inline-flex items-center gap-1 rounded-lg bg-orange-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow hover:bg-orange-700 transition-colors"
                                >
                                  <Send className="h-3.5 w-3.5" />
                                  Follow-Up
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Expanded Detail Panel */}
                          {isExpanded && (
                            <div className="border-t border-gray-200 bg-gray-50">
                              <div className="p-5 space-y-5">
                                {/* Claim Details Grid */}
                                <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                                  {/* Claim Info */}
                                  <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
                                    <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                                      <FileText className="h-4 w-4 text-orange-600" />
                                      Claim Information
                                    </h4>
                                    <div className="space-y-2 text-sm">
                                      <div className="flex justify-between">
                                        <span className="text-gray-500">Claim Number</span>
                                        <span className="font-medium text-gray-900">{claim.claimNumber}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-gray-500">Carrier</span>
                                        <span className="font-medium text-gray-900">{claim.carrier}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-gray-500">Claim Type</span>
                                        <span className="font-medium text-gray-900">
                                          {getClaimTypeLabel(claim.claimType)}
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-gray-500">Date of Loss</span>
                                        <span className="font-medium text-gray-900">{formatDate(claim.dateOfLoss)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-gray-500">Date Filed</span>
                                        <span className="font-medium text-gray-900">{formatDate(claim.dateFiled)}</span>
                                      </div>
                                      {claim.approvedAmount != null && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-500">Approved Amount</span>
                                          <span className="font-semibold text-green-700">
                                            {formatCurrency(claim.approvedAmount)}
                                          </span>
                                        </div>
                                      )}
                                      {claim.supplementAmount != null && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-500">Supplement Amount</span>
                                          <span className="font-semibold text-orange-700">
                                            {formatCurrency(claim.supplementAmount)}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  {/* Adjuster Info */}
                                  <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
                                    <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                                      <User className="h-4 w-4 text-orange-600" />
                                      Adjuster Details
                                    </h4>
                                    {claim.adjusterName ? (
                                      <div className="space-y-2 text-sm">
                                        <div className="flex justify-between">
                                          <span className="text-gray-500">Name</span>
                                          <span className="font-medium text-gray-900">{claim.adjusterName}</span>
                                        </div>
                                        {claim.adjusterEmail && (
                                          <div className="flex justify-between">
                                            <span className="text-gray-500">Email</span>
                                            <span className="font-medium text-gray-900">{claim.adjusterEmail}</span>
                                          </div>
                                        )}
                                        {claim.adjusterPhone && (
                                          <div className="flex justify-between">
                                            <span className="text-gray-500">Phone</span>
                                            <span className="font-medium text-gray-900">{claim.adjusterPhone}</span>
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      <p className="text-sm text-gray-400 italic">
                                        No adjuster assigned yet.
                                      </p>
                                    )}

                                    {/* Status Update */}
                                    <div className="pt-3 border-t border-gray-100">
                                      <label className="block text-xs font-medium text-gray-500 mb-1">
                                        Update Status
                                      </label>
                                      <select
                                        value={claim.status}
                                        onChange={(e) =>
                                          handleStatusChange(claim, e.target.value as ClaimStatus)
                                        }
                                        className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                                      >
                                        {CLAIM_STATUSES.map((s) => (
                                          <option key={s} value={s}>
                                            {getClaimStatusLabel(s)}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                  </div>

                                  {/* Follow-Up Actions */}
                                  <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 space-y-3">
                                    <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                                      <Mail className="h-4 w-4 text-orange-600" />
                                      Follow-Up Actions
                                    </h4>
                                    <div className="space-y-2">
                                      <button
                                        onClick={() => openEmailPanel(claim, 'adjuster')}
                                        className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-orange-700 transition-colors"
                                      >
                                        <Send className="h-4 w-4" />
                                        Send Follow-Up Email to Adjuster
                                      </button>
                                      <button
                                        onClick={() => openEmailPanel(claim, 'carrier')}
                                        className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-orange-300 bg-white px-4 py-2.5 text-sm font-semibold text-orange-700 hover:bg-orange-50 transition-colors"
                                      >
                                        <Building className="h-4 w-4" />
                                        Send Follow-Up to Carrier
                                      </button>
                                    </div>
                                    {claim.notes && (
                                      <div className="pt-2 border-t border-orange-200">
                                        <p className="text-xs font-medium text-gray-500 mb-1">Notes</p>
                                        <p className="text-sm text-gray-700">{claim.notes}</p>
                                      </div>
                                    )}
                                  </div>
                                </div>

                                {/* Follow-Up History */}
                                <div className="rounded-lg border border-gray-200 bg-white p-4">
                                  <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 mb-3">
                                    <Clock className="h-4 w-4 text-orange-600" />
                                    Follow-Up History
                                    {claim.followUps.length > 0 && (
                                      <span className="ml-1 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
                                        {claim.followUps.length}
                                      </span>
                                    )}
                                  </h4>
                                  {claim.followUps.length === 0 ? (
                                    <p className="text-sm text-gray-400 italic">
                                      No follow-ups sent yet. Send a follow-up to the adjuster or carrier to keep the claim moving.
                                    </p>
                                  ) : (
                                    <div className="space-y-3">
                                      {claim.followUps.map((fu) => (
                                        <div
                                          key={fu.id}
                                          className="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3"
                                        >
                                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-100">
                                            {fu.type === 'email' ? (
                                              <Mail className="h-4 w-4 text-orange-600" />
                                            ) : fu.type === 'phone' ? (
                                              <Phone className="h-4 w-4 text-orange-600" />
                                            ) : (
                                              <Send className="h-4 w-4 text-orange-600" />
                                            )}
                                          </div>
                                          <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                              <span className="text-sm font-medium text-gray-900">
                                                {fu.type.charAt(0).toUpperCase() + fu.type.slice(1)} to {fu.sentTo}
                                              </span>
                                              <span
                                                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                                                  fu.status === 'replied'
                                                    ? 'bg-green-100 text-green-800'
                                                    : fu.status === 'read'
                                                      ? 'bg-blue-100 text-blue-800'
                                                      : fu.status === 'delivered'
                                                        ? 'bg-indigo-100 text-indigo-800'
                                                        : 'bg-gray-100 text-gray-700'
                                                }`}
                                              >
                                                {fu.status.charAt(0).toUpperCase() + fu.status.slice(1)}
                                              </span>
                                            </div>
                                            {fu.subject && (
                                              <p className="mt-0.5 text-xs text-gray-500">
                                                Subject: {fu.subject}
                                              </p>
                                            )}
                                            <p className="mt-1 text-xs text-gray-500">
                                              {formatDateTime(fu.sentAt)}
                                            </p>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Email Compose Panel */}
                              {isEmailOpen && (
                                <div className="border-t border-orange-200 bg-orange-50 p-5">
                                  <div className="max-w-2xl">
                                    <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                                      <Mail className="h-4 w-4 text-orange-600" />
                                      {emailPanel.target === 'adjuster'
                                        ? 'Email Follow-Up to Adjuster'
                                        : 'Email Follow-Up to Carrier'}
                                    </h4>
                                    <div className="mt-3 flex items-center gap-4 text-sm text-gray-700">
                                      <span className="font-medium">
                                        To:{' '}
                                        {emailPanel.target === 'adjuster'
                                          ? claim.adjusterEmail || claim.adjusterName || 'Adjuster'
                                          : `${claim.carrier} Claims Dept.`}
                                      </span>
                                    </div>

                                    {emailSent ? (
                                      <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-100 border border-green-200 p-4 text-sm font-medium text-green-800">
                                        <CheckCircle className="h-5 w-5 text-green-600" />
                                        Follow-up email sent successfully!
                                      </div>
                                    ) : (
                                      <>
                                        <div className="mt-3">
                                          <label className="block text-xs font-medium text-gray-600 mb-1">
                                            Subject
                                          </label>
                                          <input
                                            type="text"
                                            value={emailSubject}
                                            onChange={(e) => setEmailSubject(e.target.value)}
                                            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                                          />
                                        </div>
                                        <div className="mt-3">
                                          <label className="block text-xs font-medium text-gray-600 mb-1">
                                            Message
                                          </label>
                                          <textarea
                                            rows={8}
                                            value={emailBody}
                                            onChange={(e) => setEmailBody(e.target.value)}
                                            className="w-full rounded-lg border border-gray-300 p-3 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none resize-y"
                                          />
                                        </div>
                                        <div className="mt-3 flex items-center gap-2">
                                          <button
                                            onClick={() => handleSendEmail(claim)}
                                            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-orange-700 transition-colors"
                                          >
                                            <Send className="h-4 w-4" />
                                            Send Email
                                          </button>
                                          <button
                                            onClick={() => setEmailPanel(null)}
                                            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* New Claim Modal */}
        {showNewClaimModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-lg font-bold text-gray-900">File New Claim</h2>
                <button
                  onClick={() => {
                    setShowNewClaimModal(false);
                    setNewClaimLeadId('');
                    setNewClaimNumber('');
                    setNewClaimType('hail');
                    setNewAdjusterName('');
                    setNewAdjusterEmail('');
                    setNewAdjusterPhone('');
                    setNewClaimNotes('');
                  }}
                  className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <p className="text-sm text-gray-500 mb-5">
                Select a lead with a policy to file a new insurance claim.
              </p>

              <div className="space-y-4">
                {/* Lead Select */}
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Select Lead <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={newClaimLeadId}
                    onChange={(e) => setNewClaimLeadId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  >
                    <option value="">Select a lead with a policy...</option>
                    {leadsWithPolicies.map((lead) => {
                      const ho = getHomeowner(lead.homeownerId);
                      if (!ho) return null;
                      return (
                        <option key={lead.id} value={lead.id}>
                          {ho.firstName} {ho.lastName} - {ho.address}
                        </option>
                      );
                    })}
                  </select>
                  {leadsWithPolicies.length === 0 && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-amber-600">
                      <AlertCircle className="h-3 w-3" />
                      No leads with policies found. Add a policy to a lead first.
                    </p>
                  )}
                </div>

                {/* Claim Number */}
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Claim Number <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={newClaimNumber}
                    onChange={(e) => setNewClaimNumber(e.target.value)}
                    placeholder="e.g., CLM-2026-001234"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  />
                </div>

                {/* Carrier (auto-filled) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700">Carrier</label>
                  <input
                    type="text"
                    value={selectedPolicy?.carrier ?? ''}
                    readOnly
                    placeholder="Auto-filled from policy"
                    className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 outline-none"
                  />
                </div>

                {/* Claim Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700">Claim Type</label>
                  <select
                    value={newClaimType}
                    onChange={(e) =>
                      setNewClaimType(e.target.value as 'hail' | 'wind' | 'hail_and_wind')
                    }
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  >
                    <option value="hail">Hail</option>
                    <option value="wind">Wind</option>
                    <option value="hail_and_wind">Hail &amp; Wind</option>
                  </select>
                </div>

                {/* Date of Loss (auto-filled) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700">Date of Loss</label>
                  <input
                    type="text"
                    value={selectedPolicy ? formatDate(selectedPolicy.bestDateOfLoss) : ''}
                    readOnly
                    placeholder="Auto-filled from policy"
                    className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 outline-none"
                  />
                </div>

                {/* Adjuster Info (optional) */}
                <div className="border-t border-gray-200 pt-4">
                  <p className="text-sm font-medium text-gray-700 mb-3">
                    Adjuster Information{' '}
                    <span className="text-gray-400 font-normal">(optional)</span>
                  </p>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600">Adjuster Name</label>
                      <input
                        type="text"
                        value={newAdjusterName}
                        onChange={(e) => setNewAdjusterName(e.target.value)}
                        placeholder="e.g., John Smith"
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600">Adjuster Email</label>
                      <input
                        type="email"
                        value={newAdjusterEmail}
                        onChange={(e) => setNewAdjusterEmail(e.target.value)}
                        placeholder="adjuster@carrier.com"
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600">Adjuster Phone</label>
                      <input
                        type="tel"
                        value={newAdjusterPhone}
                        onChange={(e) => setNewAdjusterPhone(e.target.value)}
                        placeholder="(555) 123-4567"
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                      />
                    </div>
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-sm font-medium text-gray-700">Notes</label>
                  <textarea
                    rows={3}
                    value={newClaimNotes}
                    onChange={(e) => setNewClaimNotes(e.target.value)}
                    placeholder="Any additional notes about this claim..."
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none resize-y"
                  />
                </div>
              </div>

              <div className="mt-6 flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    setShowNewClaimModal(false);
                    setNewClaimLeadId('');
                    setNewClaimNumber('');
                    setNewClaimType('hail');
                    setNewAdjusterName('');
                    setNewAdjusterEmail('');
                    setNewAdjusterPhone('');
                    setNewClaimNotes('');
                  }}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleNewClaim}
                  disabled={!newClaimLeadId || !newClaimNumber || !selectedPolicy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-orange-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <FileText className="h-4 w-4" />
                  File Claim
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
