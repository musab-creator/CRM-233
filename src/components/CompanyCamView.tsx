"use client";

import { useState } from "react";
import { useCRMStore } from "@/lib/store";
import {
  Camera,
  Plus,
  Search,
  ExternalLink,
  Image,
  FileText,
  Send,
  MapPin,
  Calendar,
  CheckCircle,
  Settings,
  RefreshCw,
} from "lucide-react";

interface MockProject {
  id: string;
  name: string;
  address: string;
  photoCount: number;
  lastActivity: string;
  status: "active" | "completed";
  photos: { id: string; url: string; caption: string; date: string }[];
}

const mockProjects: MockProject[] = [
  {
    id: "cc-1",
    name: "Martinez Roof - Hail Damage",
    address: "1234 Oak Street, Dallas, TX",
    photoCount: 24,
    lastActivity: "2024-03-25",
    status: "active",
    photos: [
      { id: "p1", url: "", caption: "Front elevation - overview", date: "2024-03-17" },
      { id: "p2", url: "", caption: "Hail impact - north slope", date: "2024-03-17" },
      { id: "p3", url: "", caption: "Test square - 15 hits counted", date: "2024-03-17" },
      { id: "p4", url: "", caption: "Ridge cap damage", date: "2024-03-17" },
      { id: "p5", url: "", caption: "Gutter damage from hail", date: "2024-03-17" },
      { id: "p6", url: "", caption: "Adjuster meeting documentation", date: "2024-03-25" },
    ],
  },
  {
    id: "cc-2",
    name: "Thompson Wind Damage",
    address: "5678 Maple Avenue, Fort Worth, TX",
    photoCount: 18,
    lastActivity: "2024-03-22",
    status: "active",
    photos: [
      { id: "p7", url: "", caption: "Ridge caps blown off", date: "2024-03-20" },
      { id: "p8", url: "", caption: "North slope - lifted shingles", date: "2024-03-20" },
      { id: "p9", url: "", caption: "Debris in yard", date: "2024-03-20" },
      { id: "p10", url: "", caption: "Close-up of lifted tab", date: "2024-03-20" },
    ],
  },
  {
    id: "cc-3",
    name: "Garcia Multi-Structure",
    address: "3456 Pine Road, Arlington, TX",
    photoCount: 42,
    lastActivity: "2024-04-02",
    status: "active",
    photos: [
      { id: "p11", url: "", caption: "Main roof overview", date: "2024-03-24" },
      { id: "p12", url: "", caption: "Detached garage damage", date: "2024-03-24" },
      { id: "p13", url: "", caption: "Shed roof - severe damage", date: "2024-03-24" },
      { id: "p14", url: "", caption: "Test square - main roof", date: "2024-03-24" },
      { id: "p15", url: "", caption: "Supplement documentation", date: "2024-04-02" },
    ],
  },
];

export function CompanyCamView() {
  const [selectedProject, setSelectedProject] = useState<MockProject | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(true);

  const filtered = mockProjects.filter((p) =>
    !searchTerm || p.name.toLowerCase().includes(searchTerm.toLowerCase()) || p.address.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Camera className="h-6 w-6 text-orange-500" />
            CompanyCam Integration
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Manage inspection photos and generate reports for homeowner follow-ups
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
            <Plus className="h-4 w-4" /> New Project
          </button>
        </div>
      </div>

      {/* Connection Status */}
      <div className={`rounded-lg p-3 flex items-center gap-3 ${connected ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
        <div className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"} animate-pulse`} />
        <p className={`text-sm font-medium ${connected ? "text-green-700" : "text-red-700"}`}>
          {connected ? "Connected to CompanyCam" : "Not connected - configure API key"}
        </p>
        {connected && <span className="text-xs text-green-600 ml-auto">Last synced: 5 minutes ago</span>}
      </div>

      {/* Config Panel */}
      {showConfig && (
        <div className="card card-body space-y-4">
          <h3 className="text-sm font-semibold">CompanyCam API Configuration</h3>
          <div>
            <label className="label">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your CompanyCam API key..."
              className="input"
            />
            <p className="text-xs text-gray-400 mt-1">
              Get your API key from CompanyCam &gt; Settings &gt; Integrations
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary">Save & Connect</button>
            <button onClick={() => setShowConfig(false)} className="btn-secondary">Cancel</button>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search projects..."
          className="input pl-10"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Projects List */}
        <div className="lg:col-span-1 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">Projects ({filtered.length})</h3>
          {filtered.map((project) => (
            <div
              key={project.id}
              onClick={() => setSelectedProject(project)}
              className={`card card-body cursor-pointer hover:shadow-md transition-shadow ${
                selectedProject?.id === project.id ? "ring-2 ring-brand-400" : ""
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">{project.name}</p>
                  <p className="text-xs text-gray-500 flex items-center gap-1 mt-1">
                    <MapPin className="h-3 w-3" /> {project.address}
                  </p>
                </div>
                <span className={`badge ${project.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
                  {project.status}
                </span>
              </div>
              <div className="flex items-center gap-4 mt-3 text-xs text-gray-400">
                <span className="flex items-center gap-1"><Image className="h-3 w-3" /> {project.photoCount} photos</span>
                <span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> {project.lastActivity}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Project Detail */}
        <div className="lg:col-span-2">
          {selectedProject ? (
            <div className="space-y-4">
              <div className="card card-body">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{selectedProject.name}</h3>
                    <p className="text-sm text-gray-500">{selectedProject.address}</p>
                  </div>
                  <div className="flex gap-2">
                    <button className="btn-secondary">
                      <FileText className="h-4 w-4" /> Generate Report
                    </button>
                    <button className="btn-primary">
                      <Send className="h-4 w-4" /> Send to Homeowner
                    </button>
                  </div>
                </div>

                {/* Photo Grid */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {selectedProject.photos.map((photo) => (
                    <div key={photo.id} className="group relative rounded-lg overflow-hidden border border-gray-200 aspect-square bg-gray-100">
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Camera className="h-8 w-8 text-gray-300" />
                      </div>
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 translate-y-full group-hover:translate-y-0 transition-transform">
                        <p className="text-xs text-white font-medium">{photo.caption}</p>
                        <p className="text-[10px] text-gray-300">{photo.date}</p>
                      </div>
                    </div>
                  ))}
                  <div className="rounded-lg border-2 border-dashed border-gray-200 aspect-square flex items-center justify-center cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition-colors">
                    <div className="text-center">
                      <Plus className="h-6 w-6 text-gray-400 mx-auto" />
                      <p className="text-xs text-gray-500 mt-1">Add Photo</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Inspection Report Generator */}
              <div className="card">
                <div className="card-header">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <FileText className="h-4 w-4 text-brand-500" />
                    Inspection Report
                  </h3>
                </div>
                <div className="card-body space-y-3">
                  <p className="text-sm text-gray-600">
                    Generate a professional inspection report from the photos in this project.
                    The report can be sent directly to the homeowner via text message for follow-up.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Report Type</label>
                      <select className="input">
                        <option>Full Inspection Report</option>
                        <option>Damage Summary</option>
                        <option>Before/After Comparison</option>
                        <option>Adjuster Documentation</option>
                      </select>
                    </div>
                    <div>
                      <label className="label">Include Photos</label>
                      <select className="input">
                        <option>All Photos ({selectedProject.photos.length})</option>
                        <option>Damage Photos Only</option>
                        <option>Selected Photos</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="label">Additional Notes</label>
                    <textarea className="input" rows={3} placeholder="Add notes to include in the report..." />
                  </div>
                  <div className="flex gap-3 justify-end">
                    <button className="btn-secondary">
                      <FileText className="h-4 w-4" /> Preview Report
                    </button>
                    <button className="btn-success">
                      <Send className="h-4 w-4" /> Text Report to Homeowner
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="card card-body flex items-center justify-center h-64 text-gray-400">
              <div className="text-center">
                <Camera className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">Select a project to view photos and generate reports</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
