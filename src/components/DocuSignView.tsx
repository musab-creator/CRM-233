"use client";

import { useState } from "react";
import { useCRMStore } from "@/lib/store";
import { formatDate, formatDateTime } from "@/lib/utils";
import {
  PenTool,
  Send,
  CheckCircle,
  Clock,
  Eye,
  FileText,
  Settings,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  Plus,
} from "lucide-react";

interface Envelope {
  id: string;
  documentName: string;
  recipientName: string;
  recipientEmail: string;
  status: "sent" | "delivered" | "viewed" | "signed" | "declined" | "expired";
  sentAt: string;
  completedAt?: string;
  type: "contingency" | "contract" | "supplement" | "change_order";
}

const mockEnvelopes: Envelope[] = [
  {
    id: "env-1",
    documentName: "Contingency Agreement - Martinez",
    recipientName: "Robert Martinez",
    recipientEmail: "robert.martinez@email.com",
    status: "signed",
    sentAt: "2024-03-17T10:00:00Z",
    completedAt: "2024-03-17T14:30:00Z",
    type: "contingency",
  },
  {
    id: "env-2",
    documentName: "Contingency Agreement - Thompson",
    recipientName: "Jennifer Thompson",
    recipientEmail: "jen.thompson@email.com",
    status: "signed",
    sentAt: "2024-03-20T09:00:00Z",
    completedAt: "2024-03-22T10:00:00Z",
    type: "contingency",
  },
  {
    id: "env-3",
    documentName: "Contingency Agreement - Garcia",
    recipientName: "Maria Garcia",
    recipientEmail: "maria.garcia@email.com",
    status: "viewed",
    sentAt: "2024-03-24T08:00:00Z",
    type: "contingency",
  },
  {
    id: "env-4",
    documentName: "Supplement Authorization - Martinez",
    recipientName: "Robert Martinez",
    recipientEmail: "robert.martinez@email.com",
    status: "sent",
    sentAt: "2024-04-01T11:00:00Z",
    type: "supplement",
  },
];

export function DocuSignView() {
  const [showConfig, setShowConfig] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(true);
  const [filterStatus, setFilterStatus] = useState("all");

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "signed": return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "viewed": return <Eye className="h-4 w-4 text-blue-500" />;
      case "sent": case "delivered": return <Send className="h-4 w-4 text-amber-500" />;
      case "declined": return <AlertCircle className="h-4 w-4 text-red-500" />;
      case "expired": return <Clock className="h-4 w-4 text-gray-500" />;
      default: return <Clock className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "signed": return "bg-green-100 text-green-700";
      case "viewed": return "bg-blue-100 text-blue-700";
      case "sent": case "delivered": return "bg-amber-100 text-amber-700";
      case "declined": return "bg-red-100 text-red-700";
      case "expired": return "bg-gray-100 text-gray-700";
      default: return "bg-gray-100 text-gray-700";
    }
  };

  const filtered = mockEnvelopes.filter((e) =>
    filterStatus === "all" || e.status === filterStatus
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <PenTool className="h-6 w-6 text-blue-500" />
            DocuSign Integration
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Send documents for electronic signature and track signing status
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowConfig(!showConfig)} className="btn-secondary">
            <Settings className="h-4 w-4" /> Configure
          </button>
          <button className="btn-secondary">
            <RefreshCw className="h-4 w-4" /> Sync
          </button>
          <button className="btn-primary">
            <Plus className="h-4 w-4" /> New Envelope
          </button>
        </div>
      </div>

      {/* Connection Status */}
      <div className={`rounded-lg p-3 flex items-center gap-3 ${connected ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
        <div className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"} animate-pulse`} />
        <p className={`text-sm font-medium ${connected ? "text-green-700" : "text-red-700"}`}>
          {connected ? "Connected to DocuSign" : "Not connected - configure API credentials"}
        </p>
      </div>

      {/* Config Panel */}
      {showConfig && (
        <div className="card card-body space-y-4">
          <h3 className="text-sm font-semibold">DocuSign API Configuration</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Integration Key</label>
              <input type="password" className="input" placeholder="Enter DocuSign integration key..." />
            </div>
            <div>
              <label className="label">Account ID</label>
              <input className="input" placeholder="Enter DocuSign account ID..." />
            </div>
            <div>
              <label className="label">API Base URL</label>
              <select className="input">
                <option>Production (docusign.net)</option>
                <option>Sandbox (docusign.net)</option>
              </select>
            </div>
            <div>
              <label className="label">Default Sender Name</label>
              <input className="input" placeholder="Apex Roofing Solutions" />
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary">Save & Connect</button>
            <button onClick={() => setShowConfig(false)} className="btn-secondary">Cancel</button>
          </div>
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="stat-card">
          <p className="text-xs text-gray-500">Total Sent</p>
          <p className="text-2xl font-bold mt-1">{mockEnvelopes.length}</p>
        </div>
        <div className="stat-card">
          <p className="text-xs text-gray-500">Signed</p>
          <p className="text-2xl font-bold text-green-600 mt-1">
            {mockEnvelopes.filter((e) => e.status === "signed").length}
          </p>
        </div>
        <div className="stat-card">
          <p className="text-xs text-gray-500">Awaiting</p>
          <p className="text-2xl font-bold text-amber-600 mt-1">
            {mockEnvelopes.filter((e) => ["sent", "delivered", "viewed"].includes(e.status)).length}
          </p>
        </div>
        <div className="stat-card">
          <p className="text-xs text-gray-500">Sign Rate</p>
          <p className="text-2xl font-bold text-brand-600 mt-1">
            {((mockEnvelopes.filter((e) => e.status === "signed").length / mockEnvelopes.length) * 100).toFixed(0)}%
          </p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {["all", "sent", "viewed", "signed", "declined"].map((status) => (
          <button
            key={status}
            onClick={() => setFilterStatus(status)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize ${
              filterStatus === status ? "bg-brand-500 text-white" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
            }`}
          >
            {status === "all" ? "All" : status}
          </button>
        ))}
      </div>

      {/* Envelopes Table */}
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="table-header px-6 py-3">Document</th>
              <th className="table-header px-6 py-3">Recipient</th>
              <th className="table-header px-6 py-3">Type</th>
              <th className="table-header px-6 py-3">Status</th>
              <th className="table-header px-6 py-3">Sent</th>
              <th className="table-header px-6 py-3">Completed</th>
              <th className="table-header px-6 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.map((envelope) => (
              <tr key={envelope.id} className="hover:bg-gray-50">
                <td className="table-cell">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-gray-400" />
                    <span className="font-medium text-gray-900">{envelope.documentName}</span>
                  </div>
                </td>
                <td className="table-cell">
                  <div>
                    <p className="text-sm">{envelope.recipientName}</p>
                    <p className="text-xs text-gray-500">{envelope.recipientEmail}</p>
                  </div>
                </td>
                <td className="table-cell">
                  <span className="badge bg-gray-100 text-gray-600 capitalize">{envelope.type.replace("_", " ")}</span>
                </td>
                <td className="table-cell">
                  <div className="flex items-center gap-1.5">
                    {getStatusIcon(envelope.status)}
                    <span className={`badge ${getStatusColor(envelope.status)} capitalize`}>{envelope.status}</span>
                  </div>
                </td>
                <td className="table-cell text-gray-500 text-xs">{formatDateTime(envelope.sentAt)}</td>
                <td className="table-cell text-gray-500 text-xs">
                  {envelope.completedAt ? formatDateTime(envelope.completedAt) : "-"}
                </td>
                <td className="table-cell">
                  <div className="flex gap-2">
                    <button className="text-xs text-brand-600 hover:text-brand-800 font-medium">View</button>
                    {envelope.status !== "signed" && (
                      <button className="text-xs text-amber-600 hover:text-amber-800 font-medium">Resend</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
