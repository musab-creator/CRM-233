"use client";

import { useState } from "react";
import { useCRMStore } from "@/lib/store";
import { getStageName, getStageColor, formatCurrency, formatDate } from "@/lib/utils";
import type { PipelineStage, Job } from "@/types";
import {
  GripVertical,
  ChevronRight,
  MapPin,
  Phone,
  Shield,
  Home,
  Calendar,
  Filter,
  LayoutGrid,
  List,
} from "lucide-react";

const INSURANCE_STAGES: PipelineStage[] = [
  "new_lead",
  "contact_made",
  "inspection_scheduled",
  "inspection_complete",
  "contingency_sent",
  "contingency_signed",
  "claim_filed",
  "adjuster_scheduled",
  "adjuster_met",
  "estimate_received",
  "supplement_needed",
  "supplement_submitted",
  "approved",
  "material_ordered",
  "work_scheduled",
  "in_progress",
  "work_complete",
  "invoiced",
  "acv_collected",
  "depreciation_released",
  "collected",
  "closed",
];

const RETAIL_STAGES: PipelineStage[] = [
  "new_lead",
  "contact_made",
  "inspection_scheduled",
  "inspection_complete",
  "work_scheduled",
  "in_progress",
  "work_complete",
  "invoiced",
  "collected",
  "closed",
];

const VISIBLE_STAGES: PipelineStage[] = [
  "new_lead",
  "inspection_scheduled",
  "contingency_signed",
  "claim_filed",
  "adjuster_met",
  "approved",
  "in_progress",
  "work_complete",
  "collected",
];

export function Pipeline() {
  const { jobs, moveJob, setSelectedJobId } = useCRMStore();
  const [viewMode, setViewMode] = useState<"kanban" | "list">("kanban");
  const [filterType, setFilterType] = useState<"all" | "insurance" | "retail">("all");
  const [draggedJob, setDraggedJob] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<PipelineStage | null>(null);

  const filteredJobs = jobs.filter((j) => filterType === "all" || j.type === filterType);

  const getJobsForStage = (stage: PipelineStage) =>
    filteredJobs.filter((j) => j.stage === stage);

  const handleDragStart = (e: React.DragEvent, jobId: string) => {
    setDraggedJob(jobId);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, stage: PipelineStage) => {
    e.preventDefault();
    setDragOverStage(stage);
  };

  const handleDrop = (e: React.DragEvent, stage: PipelineStage) => {
    e.preventDefault();
    if (draggedJob) {
      moveJob(draggedJob, stage);
    }
    setDraggedJob(null);
    setDragOverStage(null);
  };

  const handleDragEnd = () => {
    setDraggedJob(null);
    setDragOverStage(null);
  };

  const JobCard = ({ job }: { job: Job }) => (
    <div
      draggable
      onDragStart={(e) => handleDragStart(e, job.id)}
      onDragEnd={handleDragEnd}
      onClick={() => setSelectedJobId(job.id)}
      className={`kanban-card ${draggedJob === job.id ? "opacity-50" : ""}`}
    >
      <div className="flex items-start justify-between mb-2">
        <span className={`badge text-[10px] ${job.type === "insurance" ? "bg-indigo-100 text-indigo-700" : "bg-teal-100 text-teal-700"}`}>
          {job.type === "insurance" ? <Shield className="h-3 w-3 mr-1" /> : <Home className="h-3 w-3 mr-1" />}
          {job.type}
        </span>
        <span className={`badge text-[10px] ${
          job.priority === "urgent" ? "bg-red-100 text-red-700" :
          job.priority === "high" ? "bg-orange-100 text-orange-700" :
          "bg-gray-100 text-gray-600"
        }`}>
          {job.priority}
        </span>
      </div>
      <h4 className="text-sm font-medium text-gray-900 mb-1 line-clamp-1">{job.title}</h4>
      <div className="flex items-center gap-1 text-xs text-gray-500 mb-2">
        <MapPin className="h-3 w-3" />
        <span className="truncate">{job.contact.address}, {job.contact.city}</span>
      </div>
      {(job.estimateAmount || job.retailPrice) && (
        <p className="text-sm font-semibold text-gray-900">
          {formatCurrency(job.estimateAmount || job.retailPrice || 0)}
        </p>
      )}
      {job.inspectionDate && (
        <div className="flex items-center gap-1 text-xs text-gray-400 mt-1">
          <Calendar className="h-3 w-3" />
          <span>{formatDate(job.inspectionDate)}</span>
        </div>
      )}
      <div className="flex items-center gap-1 mt-2 pt-2 border-t border-gray-100">
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-100 text-[8px] font-bold text-brand-600">
          {job.contact.firstName[0]}{job.contact.lastName[0]}
        </div>
        <span className="text-xs text-gray-500">{job.contact.firstName} {job.contact.lastName}</span>
      </div>
    </div>
  );

  if (viewMode === "list") {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {(["all", "insurance", "retail"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  filterType === t ? "bg-brand-500 text-white" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
                }`}
              >
                {t === "all" ? "All Jobs" : t === "insurance" ? "Insurance" : "Retail"}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setViewMode("kanban")} className="btn-secondary">
              <LayoutGrid className="h-4 w-4" /> Kanban
            </button>
            <button onClick={() => setViewMode("list")} className="btn-primary">
              <List className="h-4 w-4" /> List
            </button>
          </div>
        </div>

        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="table-header px-6 py-3">Job</th>
                <th className="table-header px-6 py-3">Contact</th>
                <th className="table-header px-6 py-3">Type</th>
                <th className="table-header px-6 py-3">Stage</th>
                <th className="table-header px-6 py-3">Amount</th>
                <th className="table-header px-6 py-3">Priority</th>
                <th className="table-header px-6 py-3">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filteredJobs.map((job) => (
                <tr key={job.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelectedJobId(job.id)}>
                  <td className="table-cell font-medium text-gray-900">{job.title}</td>
                  <td className="table-cell text-gray-600">{job.contact.firstName} {job.contact.lastName}</td>
                  <td className="table-cell">
                    <span className={`badge ${job.type === "insurance" ? "bg-indigo-100 text-indigo-700" : "bg-teal-100 text-teal-700"}`}>
                      {job.type}
                    </span>
                  </td>
                  <td className="table-cell">
                    <span className={`badge ${getStageColor(job.stage)}`}>{getStageName(job.stage)}</span>
                  </td>
                  <td className="table-cell font-medium">{formatCurrency(job.estimateAmount || job.retailPrice || 0)}</td>
                  <td className="table-cell">
                    <span className={`badge ${
                      job.priority === "urgent" ? "bg-red-100 text-red-700" :
                      job.priority === "high" ? "bg-orange-100 text-orange-700" :
                      "bg-gray-100 text-gray-600"
                    }`}>{job.priority}</span>
                  </td>
                  <td className="table-cell text-gray-500">{formatDate(job.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {(["all", "insurance", "retail"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                filterType === t ? "bg-brand-500 text-white" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
              }`}
            >
              {t === "all" ? "All Jobs" : t === "insurance" ? "Insurance" : "Retail"}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setViewMode("kanban")} className="btn-primary">
            <LayoutGrid className="h-4 w-4" /> Kanban
          </button>
          <button onClick={() => setViewMode("list")} className="btn-secondary">
            <List className="h-4 w-4" /> List
          </button>
        </div>
      </div>

      <div className="pipeline-scroll flex gap-4 pb-4">
        {VISIBLE_STAGES.map((stage) => {
          const stageJobs = getJobsForStage(stage);
          const isOver = dragOverStage === stage;
          return (
            <div
              key={stage}
              onDragOver={(e) => handleDragOver(e, stage)}
              onDragLeave={() => setDragOverStage(null)}
              onDrop={(e) => handleDrop(e, stage)}
              className={`kanban-column ${isOver ? "ring-2 ring-brand-400 bg-brand-50/50" : ""}`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className={`badge ${getStageColor(stage)}`}>{getStageName(stage)}</span>
                  <span className="text-xs font-medium text-gray-400">{stageJobs.length}</span>
                </div>
              </div>
              <div className="flex flex-col gap-2 min-h-[100px]">
                {stageJobs.map((job) => (
                  <JobCard key={job.id} job={job} />
                ))}
                {stageJobs.length === 0 && (
                  <div className="flex items-center justify-center h-24 rounded-lg border-2 border-dashed border-gray-200 text-xs text-gray-400">
                    Drop jobs here
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
