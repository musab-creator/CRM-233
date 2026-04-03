"use client";

import { useState } from "react";
import { useCRMStore } from "@/lib/store";
import { formatCurrency, formatDate, formatDateTime, getClaimStatusName, generateId } from "@/lib/utils";
import type { ClaimStatus } from "@/types";
import {
  Search,
  Send,
  Mail,
  Phone,
  MessageSquare,
  Clock,
  CheckCircle,
  AlertCircle,
  DollarSign,
  FileText,
  ChevronDown,
  ChevronUp,
  Plus,
  Filter,
} from "lucide-react";

export function ClaimsTracker() {
  const { claims, updateClaim, contacts } = useCRMStore();
  const [expandedClaim, setExpandedClaim] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [showFollowUpModal, setShowFollowUpModal] = useState<string | null>(null);
  const [followUpType, setFollowUpType] = useState<"email" | "phone" | "text">("email");
  const [followUpSubject, setFollowUpSubject] = useState("");
  const [followUpBody, setFollowUpBody] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  const filteredClaims = claims.filter((c) => {
    if (filterStatus !== "all" && c.status !== filterStatus) return false;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      return (
        c.claimNumber.toLowerCase().includes(term) ||
        c.carrier.toLowerCase().includes(term) ||
        c.adjusterName.toLowerCase().includes(term)
      );
    }
    return true;
  });

  const getStatusColor = (status: ClaimStatus) => {
    const colors: Record<string, string> = {
      not_filed: "bg-gray-100 text-gray-700",
      filed: "bg-blue-100 text-blue-700",
      under_review: "bg-cyan-100 text-cyan-700",
      adjuster_assigned: "bg-indigo-100 text-indigo-700",
      adjuster_scheduled: "bg-purple-100 text-purple-700",
      adjuster_inspected: "bg-violet-100 text-violet-700",
      estimate_received: "bg-teal-100 text-teal-700",
      supplement_needed: "bg-orange-100 text-orange-700",
      supplement_submitted: "bg-amber-100 text-amber-700",
      supplement_approved: "bg-lime-100 text-lime-700",
      approved: "bg-green-100 text-green-700",
      denied: "bg-red-100 text-red-700",
      closed: "bg-gray-100 text-gray-700",
    };
    return colors[status] || "bg-gray-100 text-gray-700";
  };

  const generateFollowUpEmail = (claimId: string) => {
    const claim = claims.find((c) => c.id === claimId);
    if (!claim) return;
    const contact = contacts.find((c) => c.id === claim.contactId);

    setFollowUpSubject(`Claim ${claim.claimNumber} - Status Update Request`);
    setFollowUpBody(
      `Dear ${claim.adjusterName},\n\nI am writing to follow up on claim ${claim.claimNumber} for the property located at ${
        contact?.address || "the insured property"
      }, ${contact?.city || ""}, ${contact?.state || ""} ${contact?.zip || ""}.\n\nThe claim was filed on ${formatDate(
        claim.dateFiled
      )} for ${claim.stormType} damage with a date of loss of ${formatDate(
        claim.dateOfLoss
      )}.\n\nCould you please provide an update on the current status of this claim? We would like to schedule the adjuster inspection at the earliest convenience.\n\nThank you for your prompt attention to this matter.\n\nBest regards,\nApex Roofing Solutions\n(555) 123-4567`
    );
    setShowFollowUpModal(claimId);
  };

  const sendFollowUp = () => {
    if (!showFollowUpModal) return;
    const claim = claims.find((c) => c.id === showFollowUpModal);
    if (!claim) return;

    const newFollowUp = {
      id: generateId(),
      type: followUpType,
      to: claim.adjusterEmail,
      subject: followUpSubject,
      body: followUpBody,
      sentAt: new Date().toISOString(),
    };

    updateClaim(showFollowUpModal, {
      followUps: [...claim.followUps, newFollowUp],
      updatedAt: new Date().toISOString(),
    });

    setShowFollowUpModal(null);
    setFollowUpSubject("");
    setFollowUpBody("");
  };

  const statusOptions: { value: string; label: string }[] = [
    { value: "all", label: "All Claims" },
    { value: "filed", label: "Filed" },
    { value: "under_review", label: "Under Review" },
    { value: "adjuster_assigned", label: "Adjuster Assigned" },
    { value: "estimate_received", label: "Estimate Received" },
    { value: "supplement_needed", label: "Supplement Needed" },
    { value: "supplement_submitted", label: "Supplement Submitted" },
    { value: "approved", label: "Approved" },
    { value: "denied", label: "Denied" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Claims Tracker</h2>
          <p className="text-sm text-gray-500 mt-1">
            Track insurance claims and send automated follow-ups to adjusters
          </p>
        </div>
        <button className="btn-primary">
          <Plus className="h-4 w-4" /> New Claim
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by claim #, carrier, or adjuster..."
            className="input pl-10"
          />
        </div>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="input w-auto"
        >
          {statusOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Claims Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="stat-card">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-blue-500" />
            <span className="text-sm text-gray-500">Active Claims</span>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-2">
            {claims.filter((c) => !["approved", "denied", "closed"].includes(c.status)).length}
          </p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-500" />
            <span className="text-sm text-gray-500">Total RCV</span>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-2">
            {formatCurrency(claims.reduce((sum, c) => sum + (c.rcvAmount || 0), 0))}
          </p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-orange-500" />
            <span className="text-sm text-gray-500">Supplements</span>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-2">
            {formatCurrency(claims.reduce((sum, c) => sum + (c.supplementAmount || 0), 0))}
          </p>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-purple-500" />
            <span className="text-sm text-gray-500">Follow-ups Sent</span>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-2">
            {claims.reduce((sum, c) => sum + c.followUps.length, 0)}
          </p>
        </div>
      </div>

      {/* Claims List */}
      <div className="space-y-3">
        {filteredClaims.map((claim) => {
          const isExpanded = expandedClaim === claim.id;
          const contact = contacts.find((c) => c.id === claim.contactId);
          return (
            <div key={claim.id} className="card">
              {/* Claim Header */}
              <div
                className="px-6 py-4 flex items-center gap-4 cursor-pointer hover:bg-gray-50"
                onClick={() => setExpandedClaim(isExpanded ? null : claim.id)}
              >
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-6 gap-4 items-center">
                  <div>
                    <p className="text-sm font-bold text-gray-900">{claim.claimNumber}</p>
                    <p className="text-xs text-gray-500">{contact?.firstName} {contact?.lastName}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Carrier</p>
                    <p className="text-sm font-medium">{claim.carrier}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Adjuster</p>
                    <p className="text-sm font-medium">{claim.adjusterName}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Date of Loss</p>
                    <p className="text-sm font-medium">{formatDate(claim.dateOfLoss)}</p>
                  </div>
                  <div>
                    <span className={`badge ${getStatusColor(claim.status)}`}>
                      {getClaimStatusName(claim.status)}
                    </span>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-gray-900">
                      {formatCurrency(claim.rcvAmount || 0)}
                    </p>
                    <p className="text-xs text-gray-500">RCV</p>
                  </div>
                </div>
                {isExpanded ? (
                  <ChevronUp className="h-5 w-5 text-gray-400 shrink-0" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-gray-400 shrink-0" />
                )}
              </div>

              {/* Expanded Details */}
              {isExpanded && (
                <div className="border-t border-gray-100 px-6 py-4 space-y-4">
                  {/* Financial Details */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                    <div className="p-3 rounded-lg bg-green-50">
                      <p className="text-xs text-gray-500">RCV Amount</p>
                      <p className="text-lg font-bold text-green-600">{formatCurrency(claim.rcvAmount || 0)}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-amber-50">
                      <p className="text-xs text-gray-500">ACV Amount</p>
                      <p className="text-lg font-bold text-amber-600">{formatCurrency(claim.acvAmount || 0)}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-red-50">
                      <p className="text-xs text-gray-500">Depreciation</p>
                      <p className="text-lg font-bold text-red-500">{formatCurrency(claim.depreciationAmount || 0)}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-blue-50">
                      <p className="text-xs text-gray-500">Deductible</p>
                      <p className="text-lg font-bold text-blue-600">{formatCurrency(claim.deductible)}</p>
                    </div>
                    {claim.supplementAmount && (
                      <div className="p-3 rounded-lg bg-purple-50">
                        <p className="text-xs text-gray-500">Supplement</p>
                        <p className="text-lg font-bold text-purple-600">{formatCurrency(claim.supplementAmount)}</p>
                      </div>
                    )}
                  </div>

                  {/* Adjuster Info & Actions */}
                  <div className="flex flex-col sm:flex-row gap-4 items-start">
                    <div className="flex-1 p-3 rounded-lg bg-gray-50">
                      <h4 className="text-sm font-medium text-gray-900 mb-2">Adjuster Contact</h4>
                      <div className="space-y-1 text-sm">
                        <p className="flex items-center gap-2"><Users className="h-3 w-3" /> {claim.adjusterName}</p>
                        {claim.adjusterPhone && (
                          <p className="flex items-center gap-2"><Phone className="h-3 w-3" /> {claim.adjusterPhone}</p>
                        )}
                        <p className="flex items-center gap-2"><Mail className="h-3 w-3" /> {claim.adjusterEmail}</p>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          generateFollowUpEmail(claim.id);
                        }}
                        className="btn-primary"
                      >
                        <Mail className="h-4 w-4" /> Send Follow-Up Email
                      </button>
                      <button className="btn-secondary">
                        <Phone className="h-4 w-4" /> Log Phone Call
                      </button>
                      <button className="btn-secondary">
                        <MessageSquare className="h-4 w-4" /> Send Text
                      </button>
                    </div>
                  </div>

                  {/* Follow-up History */}
                  {claim.followUps.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-900 mb-3">Follow-Up History</h4>
                      <div className="space-y-3">
                        {claim.followUps.map((fu) => (
                          <div key={fu.id} className="flex gap-3 p-3 rounded-lg border border-gray-200">
                            <div className={`rounded-full p-2 h-fit ${
                              fu.type === "email" ? "bg-blue-100" : fu.type === "phone" ? "bg-green-100" : "bg-purple-100"
                            }`}>
                              {fu.type === "email" ? <Mail className="h-4 w-4 text-blue-600" /> :
                               fu.type === "phone" ? <Phone className="h-4 w-4 text-green-600" /> :
                               <MessageSquare className="h-4 w-4 text-purple-600" />}
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-medium text-gray-900">{fu.subject || `${fu.type} to ${fu.to}`}</p>
                                <span className="text-xs text-gray-400">{formatDateTime(fu.sentAt)}</span>
                              </div>
                              <p className="text-sm text-gray-600 mt-1 whitespace-pre-line line-clamp-3">{fu.body}</p>
                              {fu.response && (
                                <div className="mt-2 p-2 rounded bg-green-50 border border-green-200">
                                  <p className="text-xs font-medium text-green-700">Response:</p>
                                  <p className="text-sm text-green-800">{fu.response}</p>
                                  <p className="text-xs text-green-600 mt-1">{fu.respondedAt ? formatDateTime(fu.respondedAt) : ""}</p>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Status Update */}
                  <div className="flex items-center gap-3 pt-3 border-t border-gray-100">
                    <label className="text-sm font-medium text-gray-700">Update Status:</label>
                    <select
                      value={claim.status}
                      onChange={(e) => updateClaim(claim.id, { status: e.target.value as ClaimStatus, updatedAt: new Date().toISOString() })}
                      className="input w-auto"
                    >
                      {statusOptions.filter((o) => o.value !== "all").map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Follow-Up Modal */}
      {showFollowUpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
            <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Send Follow-Up</h3>
              <button onClick={() => setShowFollowUpModal(null)} className="text-gray-400 hover:text-gray-600">&times;</button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="flex gap-2">
                {(["email", "phone", "text"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setFollowUpType(t)}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize ${
                      followUpType === t ? "bg-brand-500 text-white" : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {followUpType === "email" && (
                <div>
                  <label className="label">Subject</label>
                  <input value={followUpSubject} onChange={(e) => setFollowUpSubject(e.target.value)} className="input" />
                </div>
              )}
              <div>
                <label className="label">Message</label>
                <textarea
                  value={followUpBody}
                  onChange={(e) => setFollowUpBody(e.target.value)}
                  className="input"
                  rows={8}
                />
              </div>
            </div>
            <div className="border-t border-gray-100 px-6 py-4 flex justify-end gap-3">
              <button onClick={() => setShowFollowUpModal(null)} className="btn-secondary">Cancel</button>
              <button onClick={sendFollowUp} className="btn-primary">
                <Send className="h-4 w-4" /> Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Users(props: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
    </svg>
  );
}
