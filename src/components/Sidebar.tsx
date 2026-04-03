"use client";

import { useCRMStore } from "@/lib/store";
import {
  LayoutDashboard,
  Kanban,
  Users,
  FileText,
  FileSignature,
  ClipboardList,
  Camera,
  Megaphone,
  CloudLightning,
  PenTool,
  Settings,
  Shield,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "pipeline", label: "Pipeline", icon: Kanban },
  { id: "contacts", label: "Contacts", icon: Users },
  { id: "policy-analyzer", label: "Policy Analyzer", icon: FileText },
  { id: "contingency", label: "Contingency", icon: FileSignature },
  { id: "claims", label: "Claims Tracker", icon: ClipboardList },
  { id: "companycam", label: "CompanyCam", icon: Camera },
  { id: "storm-lookup", label: "Storm Lookup", icon: CloudLightning },
  { id: "docusign", label: "DocuSign", icon: PenTool },
  { id: "marketing", label: "Marketing", icon: Megaphone },
  { id: "settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const { currentView, setCurrentView, sidebarOpen, setSidebarOpen, setSelectedJobId } =
    useCRMStore();

  return (
    <div
      className={`relative flex flex-col border-r border-gray-200 bg-white transition-all duration-300 ${
        sidebarOpen ? "w-64" : "w-16"
      }`}
    >
      {/* Logo */}
      <div className="flex h-16 items-center gap-3 border-b border-gray-100 px-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500">
          <Shield className="h-5 w-5 text-white" />
        </div>
        {sidebarOpen && (
          <div className="overflow-hidden">
            <h1 className="text-sm font-bold text-gray-900 truncate">Apex Roofing</h1>
            <p className="text-[10px] text-gray-500 truncate">CRM Platform</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => {
                setCurrentView(item.id);
                setSelectedJobId(null);
              }}
              className={`w-full ${isActive ? "sidebar-link-active" : "sidebar-link"}`}
              title={!sidebarOpen ? item.label : undefined}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {sidebarOpen && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="absolute -right-3 top-20 flex h-6 w-6 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 hover:text-gray-700 shadow-sm"
      >
        {sidebarOpen ? (
          <ChevronLeft className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>

      {/* User */}
      <div className="border-t border-gray-100 p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600 text-xs font-bold">
            MJ
          </div>
          {sidebarOpen && (
            <div className="overflow-hidden">
              <p className="text-sm font-medium text-gray-900 truncate">Mike Johnson</p>
              <p className="text-xs text-gray-500 truncate">Manager</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
