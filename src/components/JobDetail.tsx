"use client";

import { useCRMStore } from "@/lib/store";
import { formatCurrency, formatDate, formatDateTime, getStageName, getStageColor } from "@/lib/utils";
import type { PipelineStage } from "@/types";
import {
  ArrowLeft,
  MapPin,
  Phone,
  Mail,
  Calendar,
  DollarSign,
  Shield,
  Home,
  User,
  FileText,
  Camera,
  Clock,
  MessageSquare,
  Send,
  ChevronRight,
  Edit3,
} from "lucide-react";
import { useState } from "react";

const STAGES: PipelineStage[] = [
  "new_lead", "contact_made", "inspection_scheduled", "inspection_complete",
  "contingency_sent", "contingency_signed", "claim_filed", "adjuster_scheduled",
  "adjuster_met", "estimate_received", "supplement_needed", "supplement_submitted",
  "approved", "material_ordered", "work_scheduled", "in_progress",
  "work_complete", "invoiced", "acv_collected", "depreciation_released", "collected", "closed",
];

export function JobDetail() {
  const { jobs, selectedJobId, setSelectedJobId, moveJob, updateJob } = useCRMStore();
  const [newNote, setNewNote] = useState("");
  const [activeTab, setActiveTab] = useState<"overview" | "activity" | "documents" | "financials">("overview");

  const job = jobs.find((j) => j.id === selectedJobId);
  if (!job) return null;

  const currentStageIdx = STAGES.indexOf(job.stage);

  const addNote = () => {
    if (!newNote.trim()) return;
    updateJob(job.id, {
      notes: [...job.notes, {
        id: `n-${Date.now()}`,
        content: newNote,
        authorId: "user-1",
        authorName: "Mike Johnson",
        createdAt: new Date().toISOString(),
      }],
      activities: [...job.activities, {
        id: `a-${Date.now()}`,
        type: "note",
        description: newNote,
        authorName: "Mike Johnson",
        createdAt: new Date().toISOString(),
      }],
    });
    setNewNote("");
  };

  return (
    <div className="space-y-6">
      {/* Back & Title */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => setSelectedJobId(null)}
          className="rounded-lg p-2 hover:bg-gray-100"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold text-gray-900">{job.title}</h2>
            <span className={`badge ${job.type === "insurance" ? "bg-indigo-100 text-indigo-700" : "bg-teal-100 text-teal-700"}`}>
              {job.type === "insurance" ? <Shield className="h-3 w-3 mr-1" /> : <Home className="h-3 w-3 mr-1" />}
              {job.type}
            </span>
            <span className={`badge ${getStageColor(job.stage)}`}>{getStageName(job.stage)}</span>
          </div>
          <p className="text-sm text-gray-500 mt-1">{job.description}</p>
        </div>
      </div>

      {/* Stage Progress */}
      <div className="card card-body overflow-x-auto">
        <div className="flex items-center gap-1 min-w-max">
          {STAGES.filter((_, i) => i % 2 === 0 || i <= currentStageIdx).slice(0, 12).map((stage, i) => {
            const stageIdx = STAGES.indexOf(stage);
            const isPast = stageIdx < currentStageIdx;
            const isCurrent = stageIdx === currentStageIdx;
            return (
              <div key={stage} className="flex items-center">
                <button
                  onClick={() => moveJob(job.id, stage)}
                  className={`rounded-full px-3 py-1 text-[10px] font-medium whitespace-nowrap transition-colors ${
                    isCurrent ? "bg-brand-500 text-white" :
                    isPast ? "bg-green-100 text-green-700" :
                    "bg-gray-100 text-gray-400 hover:bg-gray-200"
                  }`}
                >
                  {getStageName(stage)}
                </button>
                {i < 11 && <ChevronRight className="h-3 w-3 text-gray-300 mx-1" />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {(["overview", "activity", "documents", "financials"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
              activeTab === tab ? "border-brand-500 text-brand-600" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Contact Info */}
          <div className="card card-body space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <User className="h-4 w-4 text-brand-500" /> Homeowner
            </h3>
            <div className="space-y-2 text-sm">
              <p className="font-medium text-gray-900">{job.contact.firstName} {job.contact.lastName}</p>
              <p className="flex items-center gap-2 text-gray-600"><Phone className="h-3 w-3" />{job.contact.phone}</p>
              <p className="flex items-center gap-2 text-gray-600"><Mail className="h-3 w-3" />{job.contact.email}</p>
              <p className="flex items-center gap-2 text-gray-600"><MapPin className="h-3 w-3" />{job.contact.address}, {job.contact.city}, {job.contact.state} {job.contact.zip}</p>
            </div>

            {/* Quick Actions */}
            <div className="pt-3 border-t border-gray-100 space-y-2">
              <button className="w-full btn-secondary justify-center"><Phone className="h-4 w-4" /> Call</button>
              <button className="w-full btn-secondary justify-center"><MessageSquare className="h-4 w-4" /> Text</button>
              <button className="w-full btn-secondary justify-center"><Mail className="h-4 w-4" /> Email</button>
            </div>
          </div>

          {/* Insurance / Job Details */}
          <div className="card card-body space-y-4 lg:col-span-2">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              {job.type === "insurance" ? <Shield className="h-4 w-4 text-indigo-500" /> : <Home className="h-4 w-4 text-teal-500" />}
              {job.type === "insurance" ? "Insurance Details" : "Job Details"}
            </h3>
            {job.type === "insurance" ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Claim Number</p>
                  <p className="font-medium">{job.claimNumber || "Pending"}</p>
                </div>
                <div>
                  <p className="text-gray-500">Date of Loss</p>
                  <p className="font-medium">{job.dateOfLoss ? formatDate(job.dateOfLoss) : "N/A"}</p>
                </div>
                <div>
                  <p className="text-gray-500">Storm Type</p>
                  <p className="font-medium capitalize">{job.stormType || "N/A"}</p>
                </div>
                <div>
                  <p className="text-gray-500">Adjuster</p>
                  <p className="font-medium">{job.adjusterName || "Not assigned"}</p>
                </div>
                {job.adjusterPhone && (
                  <div>
                    <p className="text-gray-500">Adjuster Phone</p>
                    <p className="font-medium">{job.adjusterPhone}</p>
                  </div>
                )}
                {job.adjusterEmail && (
                  <div>
                    <p className="text-gray-500">Adjuster Email</p>
                    <p className="font-medium">{job.adjusterEmail}</p>
                  </div>
                )}
                <div>
                  <p className="text-gray-500">Inspection Date</p>
                  <p className="font-medium">{job.inspectionDate ? formatDate(job.inspectionDate) : "N/A"}</p>
                </div>
                <div>
                  <p className="text-gray-500">Adjuster Date</p>
                  <p className="font-medium">{job.adjusterDate ? formatDate(job.adjusterDate) : "N/A"}</p>
                </div>
                <div>
                  <p className="text-gray-500">Priority</p>
                  <span className={`badge ${
                    job.priority === "urgent" ? "bg-red-100 text-red-700" :
                    job.priority === "high" ? "bg-orange-100 text-orange-700" :
                    "bg-gray-100 text-gray-600"
                  }`}>{job.priority}</span>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Retail Price</p>
                  <p className="text-xl font-bold text-gray-900">{formatCurrency(job.retailPrice || 0)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Work Start</p>
                  <p className="font-medium">{job.workStartDate ? formatDate(job.workStartDate) : "TBD"}</p>
                </div>
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="card lg:col-span-3">
            <div className="card-header">
              <h3 className="text-sm font-semibold">Notes</h3>
            </div>
            <div className="card-body space-y-3">
              {job.notes.map((note) => (
                <div key={note.id} className="flex gap-3 p-3 rounded-lg bg-gray-50">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-600">
                    {note.authorName.split(" ").map(n => n[0]).join("")}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{note.authorName}</span>
                      <span className="text-xs text-gray-400">{formatDateTime(note.createdAt)}</span>
                    </div>
                    <p className="text-sm text-gray-700 mt-1">{note.content}</p>
                  </div>
                </div>
              ))}
              <div className="flex gap-3 pt-3 border-t border-gray-100">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  className="input flex-1"
                  rows={2}
                />
                <button onClick={addNote} disabled={!newNote.trim()} className="btn-primary self-end">
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "activity" && (
        <div className="card card-body">
          <div className="space-y-4">
            {job.activities.map((activity, i) => (
              <div key={activity.id} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className={`rounded-full p-2 ${
                    activity.type === "stage_change" ? "bg-blue-100" :
                    activity.type === "note" ? "bg-gray-100" :
                    activity.type === "photo" ? "bg-green-100" :
                    activity.type === "document" ? "bg-purple-100" :
                    "bg-gray-100"
                  }`}>
                    {activity.type === "stage_change" ? <ChevronRight className="h-4 w-4 text-blue-600" /> :
                     activity.type === "note" ? <Edit3 className="h-4 w-4 text-gray-600" /> :
                     activity.type === "photo" ? <Camera className="h-4 w-4 text-green-600" /> :
                     activity.type === "document" ? <FileText className="h-4 w-4 text-purple-600" /> :
                     <Clock className="h-4 w-4 text-gray-600" />}
                  </div>
                  {i < job.activities.length - 1 && <div className="w-0.5 flex-1 bg-gray-200 mt-1" />}
                </div>
                <div className="pb-6 flex-1">
                  <p className="text-sm text-gray-900">{activity.description}</p>
                  <p className="text-xs text-gray-400 mt-1">{formatDateTime(activity.createdAt)}</p>
                  {activity.authorName && (
                    <p className="text-xs text-gray-500 mt-0.5">by {activity.authorName}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "financials" && job.type === "insurance" && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="stat-card border-l-4 border-l-green-500">
              <p className="text-xs text-gray-500">Estimate / RCV</p>
              <p className="text-2xl font-bold text-green-600 mt-1">{formatCurrency(job.estimateAmount || 0)}</p>
            </div>
            <div className="stat-card border-l-4 border-l-amber-500">
              <p className="text-xs text-gray-500">ACV Payment</p>
              <p className="text-2xl font-bold text-amber-600 mt-1">{formatCurrency(job.acvPayment || 0)}</p>
            </div>
            <div className="stat-card border-l-4 border-l-red-500">
              <p className="text-xs text-gray-500">Depreciation Holdback</p>
              <p className="text-2xl font-bold text-red-500 mt-1">{formatCurrency(job.depreciationHoldback || 0)}</p>
            </div>
            <div className="stat-card border-l-4 border-l-blue-500">
              <p className="text-xs text-gray-500">Deductible</p>
              <p className="text-2xl font-bold text-blue-600 mt-1">{formatCurrency(job.deductibleAmount || 0)}</p>
            </div>
          </div>
          {job.supplementAmount && (
            <div className="stat-card border-l-4 border-l-purple-500 max-w-xs">
              <p className="text-xs text-gray-500">Supplement Amount</p>
              <p className="text-2xl font-bold text-purple-600 mt-1">{formatCurrency(job.supplementAmount)}</p>
            </div>
          )}
          <div className="card card-body">
            <h3 className="text-sm font-semibold mb-4">Payment Summary</h3>
            <div className="space-y-2 text-sm max-w-md">
              <div className="flex justify-between"><span className="text-gray-600">RCV Amount</span><span className="font-medium">{formatCurrency(job.estimateAmount || 0)}</span></div>
              {job.supplementAmount && (
                <div className="flex justify-between"><span className="text-gray-600">+ Supplement</span><span className="font-medium text-purple-600">+{formatCurrency(job.supplementAmount)}</span></div>
              )}
              <div className="flex justify-between"><span className="text-gray-600">- Deductible (Homeowner)</span><span className="font-medium text-red-600">-{formatCurrency(job.deductibleAmount || 0)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600">- Depreciation (Held)</span><span className="font-medium text-red-600">-{formatCurrency(job.depreciationHoldback || 0)}</span></div>
              <div className="border-t border-gray-200 pt-2 flex justify-between">
                <span className="font-medium">Initial ACV Check</span>
                <span className="font-bold text-green-600">{formatCurrency((job.acvPayment || 0) - (job.deductibleAmount || 0))}</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>Depreciation Released After Work</span>
                <span>+{formatCurrency(job.depreciationHoldback || 0)}</span>
              </div>
              <div className="border-t border-gray-200 pt-2 flex justify-between">
                <span className="font-bold">Total Contractor Payment</span>
                <span className="font-bold text-gray-900">{formatCurrency((job.estimateAmount || 0) + (job.supplementAmount || 0) - (job.deductibleAmount || 0))}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "financials" && job.type === "retail" && (
        <div className="stat-card max-w-xs border-l-4 border-l-teal-500">
          <p className="text-xs text-gray-500">Retail Price</p>
          <p className="text-3xl font-bold text-teal-600 mt-1">{formatCurrency(job.retailPrice || 0)}</p>
        </div>
      )}

      {activeTab === "documents" && (
        <div className="card card-body text-center py-12">
          <FileText className="h-12 w-12 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No documents uploaded yet</p>
          <button className="btn-primary mt-4 mx-auto">Upload Document</button>
        </div>
      )}
    </div>
  );
}
