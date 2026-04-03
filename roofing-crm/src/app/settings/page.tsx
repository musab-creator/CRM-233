'use client';

import AppShell from '@/components/AppShell';
import { useCRMStore } from '@/store';
import { useState } from 'react';
import {
  Settings, Key, Link2, Bell, Users, Building2,
  CheckCircle, Camera, FileSignature, Mail, MessageSquare
} from 'lucide-react';

interface IntegrationConfig {
  name: string;
  icon: React.ElementType;
  description: string;
  connected: boolean;
  fields: { label: string; placeholder: string; type?: string }[];
}

export default function SettingsPage() {
  const { currentUser, users } = useCRMStore();
  const [activeTab, setActiveTab] = useState<'company' | 'integrations' | 'team' | 'notifications'>('company');
  const [savedMessage, setSavedMessage] = useState('');

  const [companyInfo, setCompanyInfo] = useState({
    name: 'StormShield Roofing',
    phone: '(555) 000-0000',
    email: 'info@stormshieldroofing.com',
    address: '100 Main Street, Dallas, TX 75201',
    license: 'TX-ROF-2024-12345',
    website: 'www.stormshieldroofing.com',
  });

  const integrations: IntegrationConfig[] = [
    {
      name: 'CompanyCam',
      icon: Camera,
      description: 'Sync inspection photos and generate reports from CompanyCam projects.',
      connected: true,
      fields: [
        { label: 'API Key', placeholder: 'Enter CompanyCam API key', type: 'password' },
        { label: 'Company ID', placeholder: 'Your CompanyCam company ID' },
      ],
    },
    {
      name: 'DocuSign',
      icon: FileSignature,
      description: 'Send contingency agreements for electronic signature.',
      connected: true,
      fields: [
        { label: 'Integration Key', placeholder: 'DocuSign integration key', type: 'password' },
        { label: 'Account ID', placeholder: 'DocuSign account ID' },
        { label: 'Base URL', placeholder: 'https://demo.docusign.net' },
      ],
    },
    {
      name: 'Email (SMTP)',
      icon: Mail,
      description: 'Send automated follow-up emails to adjusters and carriers.',
      connected: true,
      fields: [
        { label: 'SMTP Host', placeholder: 'smtp.gmail.com' },
        { label: 'SMTP Port', placeholder: '587' },
        { label: 'Email Address', placeholder: 'claims@stormshieldroofing.com' },
        { label: 'Password', placeholder: 'App password', type: 'password' },
      ],
    },
    {
      name: 'Twilio (SMS)',
      icon: MessageSquare,
      description: 'Send text message follow-ups to homeowners after inspections.',
      connected: false,
      fields: [
        { label: 'Account SID', placeholder: 'Twilio Account SID', type: 'password' },
        { label: 'Auth Token', placeholder: 'Twilio Auth Token', type: 'password' },
        { label: 'Phone Number', placeholder: '+15551234567' },
      ],
    },
    {
      name: 'Google Drive',
      icon: Link2,
      description: 'Access contingency templates and company documents from Google Drive.',
      connected: false,
      fields: [
        { label: 'Service Account Key', placeholder: 'Paste JSON key', type: 'password' },
        { label: 'Shared Drive ID', placeholder: 'Google Drive folder ID' },
      ],
    },
  ];

  const [integrationStates, setIntegrationStates] = useState<Record<string, boolean>>(
    Object.fromEntries(integrations.map(i => [i.name, i.connected]))
  );

  const handleSave = () => {
    setSavedMessage('Settings saved successfully!');
    setTimeout(() => setSavedMessage(''), 3000);
  };

  const tabs = [
    { key: 'company' as const, label: 'Company Info', icon: Building2 },
    { key: 'integrations' as const, label: 'Integrations', icon: Key },
    { key: 'team' as const, label: 'Team', icon: Users },
    { key: 'notifications' as const, label: 'Notifications', icon: Bell },
  ];

  return (
    <AppShell>
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

        {savedMessage && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-green-700 text-sm">
            <CheckCircle className="w-4 h-4" />
            {savedMessage}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-lg">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Company Info */}
        {activeTab === 'company' && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold mb-4">Company Information</h2>
            <div className="grid grid-cols-2 gap-4">
              {Object.entries(companyInfo).map(([key, value]) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1 capitalize">
                    {key === 'license' ? 'License #' : key}
                  </label>
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => setCompanyInfo(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Company Logo</h3>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 bg-gradient-to-br from-orange-500 to-red-600 rounded-xl flex items-center justify-center">
                  <Building2 className="w-8 h-8 text-white" />
                </div>
                <button className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                  Upload Logo
                </button>
              </div>
            </div>
            <button onClick={handleSave} className="mt-6 px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700">
              Save Changes
            </button>
          </div>
        )}

        {/* Integrations */}
        {activeTab === 'integrations' && (
          <div className="space-y-4">
            {integrations.map(integration => (
              <div key={integration.name} className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                      <integration.icon className="w-5 h-5 text-gray-600" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">{integration.name}</h3>
                      <p className="text-sm text-gray-500">{integration.description}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setIntegrationStates(prev => ({ ...prev, [integration.name]: !prev[integration.name] }))}
                    className={`px-3 py-1 rounded-full text-xs font-medium ${
                      integrationStates[integration.name]
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {integrationStates[integration.name] ? 'Connected' : 'Disconnected'}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {integration.fields.map(field => (
                    <div key={field.label}>
                      <label className="block text-xs font-medium text-gray-600 mb-1">{field.label}</label>
                      <input
                        type={field.type || 'text'}
                        placeholder={field.placeholder}
                        className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                      />
                    </div>
                  ))}
                </div>
                <button onClick={handleSave} className="mt-3 px-3 py-1.5 bg-orange-600 text-white rounded-lg text-xs font-medium hover:bg-orange-700">
                  Save Configuration
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Team */}
        {activeTab === 'team' && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Team Members</h2>
              <button className="px-3 py-1.5 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700">
                Invite Member
              </button>
            </div>
            <div className="space-y-3">
              {users.map(user => (
                <div key={user.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-orange-600 rounded-full flex items-center justify-center text-white text-sm font-bold">
                      {user.name.split(' ').map(n => n[0]).join('')}
                    </div>
                    <div>
                      <p className="font-medium text-sm">{user.name}</p>
                      <p className="text-xs text-gray-500">{user.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      user.role === 'manager' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                    }`}>
                      {user.role === 'manager' ? 'Manager' : 'Sales Rep'}
                    </span>
                    <button className="text-xs text-gray-400 hover:text-gray-600">Edit</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notifications */}
        {activeTab === 'notifications' && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold mb-4">Notification Preferences</h2>
            {[
              { label: 'New lead assigned to me', defaultOn: true },
              { label: 'Claim status updates', defaultOn: true },
              { label: 'Contingency agreement signed', defaultOn: true },
              { label: 'Adjuster inspection scheduled', defaultOn: true },
              { label: 'Follow-up reminders', defaultOn: true },
              { label: 'Marketing campaign updates', defaultOn: false },
              { label: 'Daily summary email', defaultOn: false },
              { label: 'Weekly pipeline report', defaultOn: true },
            ].map(pref => (
              <label key={pref.label} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
                <span className="text-sm text-gray-700">{pref.label}</span>
                <input
                  type="checkbox"
                  defaultChecked={pref.defaultOn}
                  className="w-4 h-4 text-orange-600 rounded focus:ring-orange-500"
                />
              </label>
            ))}
            <button onClick={handleSave} className="mt-4 px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700">
              Save Preferences
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
