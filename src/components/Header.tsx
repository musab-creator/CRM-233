"use client";

import { useCRMStore } from "@/lib/store";
import { Bell, Search, Plus, Menu } from "lucide-react";
import { useState } from "react";

export function Header() {
  const { currentView, setSidebarOpen, sidebarOpen, setCurrentView } = useCRMStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);

  const viewTitles: Record<string, string> = {
    dashboard: "Dashboard",
    pipeline: "Job Pipeline",
    contacts: "Contacts & Homeowners",
    "policy-analyzer": "Insurance Policy Analyzer",
    contingency: "Contingency Agreement Generator",
    claims: "Claims Tracker",
    companycam: "CompanyCam Integration",
    marketing: "Marketing & Campaigns",
    "storm-lookup": "Storm History Lookup",
    docusign: "DocuSign Integration",
    settings: "Settings & Integrations",
  };

  const notifications = [
    { id: 1, text: "Adjuster Tom Reynolds responded to claim CLM-2024-001", time: "2 hours ago", unread: true },
    { id: 2, text: "Contingency signed by Jennifer Thompson", time: "4 hours ago", unread: true },
    { id: 3, text: "New lead from Google Ads - Michael Davis", time: "Yesterday", unread: false },
    { id: 4, text: "Supplement approved for Garcia property (+$8,500)", time: "Yesterday", unread: false },
    { id: 5, text: "Weather alert: Hail storm forecasted for Collin County", time: "2 days ago", unread: false },
  ];

  const unreadCount = notifications.filter((n) => n.unread).length;

  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div className="flex items-center gap-4">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="lg:hidden p-2 text-gray-500 hover:text-gray-700"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h2 className="text-lg font-semibold text-gray-900">
          {viewTitles[currentView] || "Dashboard"}
        </h2>
      </div>

      <div className="flex items-center gap-3">
        {/* Search */}
        <div className="relative">
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5">
            <Search className="h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search contacts, jobs, claims..."
              className="w-64 bg-transparent text-sm outline-none placeholder:text-gray-400"
            />
            <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border border-gray-200 bg-white px-1.5 text-[10px] font-medium text-gray-400">
              <span>⌘</span>K
            </kbd>
          </div>
        </div>

        {/* New button */}
        <div className="relative">
          <button
            onClick={() => setShowNewMenu(!showNewMenu)}
            className="btn-primary"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New</span>
          </button>
          {showNewMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowNewMenu(false)} />
              <div className="absolute right-0 top-full z-20 mt-2 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                {[
                  { label: "New Contact", view: "contacts" },
                  { label: "New Job", view: "pipeline" },
                  { label: "Analyze Policy", view: "policy-analyzer" },
                  { label: "New Contingency", view: "contingency" },
                  { label: "Track Claim", view: "claims" },
                  { label: "New Campaign", view: "marketing" },
                ].map((item) => (
                  <button
                    key={item.view}
                    onClick={() => {
                      setCurrentView(item.view);
                      setShowNewMenu(false);
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Notifications */}
        <div className="relative">
          <button
            onClick={() => setShowNotifications(!showNotifications)}
            className="relative rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </button>
          {showNotifications && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowNotifications(false)} />
              <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-lg border border-gray-200 bg-white shadow-lg">
                <div className="border-b border-gray-100 px-4 py-3">
                  <h3 className="text-sm font-semibold">Notifications</h3>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.map((notif) => (
                    <div
                      key={notif.id}
                      className={`px-4 py-3 border-b border-gray-50 hover:bg-gray-50 cursor-pointer ${
                        notif.unread ? "bg-blue-50/50" : ""
                      }`}
                    >
                      <p className="text-sm text-gray-700">{notif.text}</p>
                      <p className="text-xs text-gray-400 mt-1">{notif.time}</p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
