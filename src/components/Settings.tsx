"use client";

import { useState } from "react";
import {
  Settings as SettingsIcon,
  User,
  Users,
  Link,
  Bell,
  Shield,
  Camera,
  PenTool,
  Cloud,
  Mail,
  MessageSquare,
  CheckCircle,
  AlertCircle,
  ExternalLink,
} from "lucide-react";

interface Integration {
  id: string;
  name: string;
  description: string;
  icon: typeof Camera;
  connected: boolean;
  color: string;
}

export function Settings() {
  const [activeTab, setActiveTab] = useState("company");

  const integrations: Integration[] = [
    { id: "companycam", name: "CompanyCam", description: "Photo documentation & inspection reports", icon: Camera, connected: true, color: "text-orange-500" },
    { id: "docusign", name: "DocuSign", description: "Electronic signatures for contracts", icon: PenTool, connected: true, color: "text-blue-500" },
    { id: "hailtrace", name: "HailTrace", description: "Storm history & date of loss lookup", icon: Cloud, connected: false, color: "text-purple-500" },
    { id: "google_drive", name: "Google Drive", description: "Document storage & contingency templates", icon: Link, connected: true, color: "text-green-500" },
    { id: "email", name: "Email (SMTP)", description: "Automated email follow-ups to adjusters", icon: Mail, connected: true, color: "text-red-500" },
    { id: "sms", name: "SMS / Text (Twilio)", description: "Text message follow-ups to homeowners", icon: MessageSquare, connected: false, color: "text-cyan-500" },
  ];

  const tabs = [
    { id: "company", label: "Company", icon: Shield },
    { id: "profile", label: "Profile", icon: User },
    { id: "team", label: "Team", icon: Users },
    { id: "integrations", label: "Integrations", icon: Link },
    { id: "notifications", label: "Notifications", icon: Bell },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Settings & Integrations</h2>
        <p className="text-sm text-gray-500 mt-1">Manage your CRM configuration and integrations</p>
      </div>

      <div className="flex gap-6">
        {/* Settings Nav */}
        <div className="w-48 shrink-0 space-y-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.id ? "bg-brand-50 text-brand-600" : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1">
          {activeTab === "company" && (
            <div className="card card-body space-y-6">
              <h3 className="text-lg font-semibold">Company Settings</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="label">Company Name</label>
                  <input className="input" defaultValue="Apex Roofing Solutions" />
                </div>
                <div>
                  <label className="label">Phone</label>
                  <input className="input" defaultValue="(555) 123-4567" />
                </div>
                <div>
                  <label className="label">Email</label>
                  <input className="input" defaultValue="info@apexroofing.com" />
                </div>
                <div>
                  <label className="label">License Number</label>
                  <input className="input" defaultValue="ROF-2024-12345" />
                </div>
                <div className="md:col-span-2">
                  <label className="label">Address</label>
                  <input className="input" defaultValue="100 Main Street, Suite 200, Dallas, TX 75201" />
                </div>
                <div>
                  <label className="label">Default Deductible Handling</label>
                  <select className="input">
                    <option>Collected at project start</option>
                    <option>Collected upon completion</option>
                    <option>Split payments</option>
                  </select>
                </div>
                <div>
                  <label className="label">Contingency Cancellation Fee</label>
                  <select className="input">
                    <option>10% of approved amount</option>
                    <option>15% of approved amount</option>
                    <option>20% of approved amount</option>
                    <option>Flat fee - $500</option>
                  </select>
                </div>
              </div>

              <div className="pt-4 border-t border-gray-100">
                <h4 className="text-sm font-medium text-gray-900 mb-3">Company Logo</h4>
                <div className="flex items-center gap-4">
                  <div className="h-20 w-20 rounded-lg bg-brand-500 flex items-center justify-center">
                    <Shield className="h-10 w-10 text-white" />
                  </div>
                  <button className="btn-secondary">Upload Logo</button>
                </div>
              </div>

              <div className="flex justify-end">
                <button className="btn-primary">Save Changes</button>
              </div>
            </div>
          )}

          {activeTab === "profile" && (
            <div className="card card-body space-y-6">
              <h3 className="text-lg font-semibold">Profile Settings</h3>
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 rounded-full bg-brand-100 flex items-center justify-center text-xl font-bold text-brand-600">
                  MJ
                </div>
                <button className="btn-secondary">Change Photo</button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="label">Full Name</label>
                  <input className="input" defaultValue="Mike Johnson" />
                </div>
                <div>
                  <label className="label">Email</label>
                  <input className="input" defaultValue="mike@apexroofing.com" />
                </div>
                <div>
                  <label className="label">Phone</label>
                  <input className="input" defaultValue="(555) 123-4567" />
                </div>
                <div>
                  <label className="label">Role</label>
                  <select className="input">
                    <option>Manager</option>
                    <option>Sales Rep</option>
                    <option>Admin</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end">
                <button className="btn-primary">Save Profile</button>
              </div>
            </div>
          )}

          {activeTab === "team" && (
            <div className="card card-body space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Team Members</h3>
                <button className="btn-primary"><Users className="h-4 w-4" /> Invite Member</button>
              </div>
              <div className="space-y-3">
                {[
                  { name: "Mike Johnson", email: "mike@apexroofing.com", role: "Manager", status: "active" },
                  { name: "Carlos Mendez", email: "carlos@apexroofing.com", role: "Sales Rep", status: "active" },
                  { name: "Sarah Torres", email: "sarah@apexroofing.com", role: "Sales Rep", status: "active" },
                  { name: "James Walker", email: "james@apexroofing.com", role: "Sales Rep", status: "active" },
                  { name: "Lisa Roberts", email: "lisa@apexroofing.com", role: "Sales Rep", status: "invited" },
                ].map((member) => (
                  <div key={member.email} className="flex items-center gap-4 p-3 rounded-lg border border-gray-200">
                    <div className="h-10 w-10 rounded-full bg-brand-100 flex items-center justify-center text-sm font-bold text-brand-600">
                      {member.name.split(" ").map(n => n[0]).join("")}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">{member.name}</p>
                      <p className="text-xs text-gray-500">{member.email}</p>
                    </div>
                    <span className="badge bg-gray-100 text-gray-600">{member.role}</span>
                    <span className={`badge ${member.status === "active" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                      {member.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === "integrations" && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Integrations</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {integrations.map((integration) => {
                  const Icon = integration.icon;
                  return (
                    <div key={integration.id} className="card card-body">
                      <div className="flex items-start gap-3">
                        <div className="rounded-lg bg-gray-50 p-2">
                          <Icon className={`h-6 w-6 ${integration.color}`} />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-semibold text-gray-900">{integration.name}</h4>
                            {integration.connected ? (
                              <CheckCircle className="h-4 w-4 text-green-500" />
                            ) : (
                              <AlertCircle className="h-4 w-4 text-gray-400" />
                            )}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">{integration.description}</p>
                        </div>
                        <button className={integration.connected ? "btn-secondary" : "btn-primary"}>
                          {integration.connected ? "Configure" : "Connect"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === "notifications" && (
            <div className="card card-body space-y-6">
              <h3 className="text-lg font-semibold">Notification Preferences</h3>
              {[
                { label: "New lead assigned", desc: "Get notified when a new lead is assigned to you" },
                { label: "Claim status update", desc: "When an insurance claim changes status" },
                { label: "Adjuster response", desc: "When an adjuster responds to a follow-up" },
                { label: "Contingency signed", desc: "When a homeowner signs a contingency agreement" },
                { label: "Payment received", desc: "When an ACV or depreciation payment is received" },
                { label: "Storm alert", desc: "When severe weather is forecasted in your service area" },
                { label: "Supplement approved", desc: "When a supplement is approved by the carrier" },
              ].map((pref) => (
                <div key={pref.label} className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{pref.label}</p>
                    <p className="text-xs text-gray-500">{pref.desc}</p>
                  </div>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-1.5 text-xs text-gray-500">
                      <input type="checkbox" defaultChecked className="h-4 w-4 rounded text-brand-500" />
                      Email
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-500">
                      <input type="checkbox" defaultChecked className="h-4 w-4 rounded text-brand-500" />
                      Push
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-500">
                      <input type="checkbox" className="h-4 w-4 rounded text-brand-500" />
                      SMS
                    </label>
                  </div>
                </div>
              ))}
              <div className="flex justify-end">
                <button className="btn-primary">Save Preferences</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
