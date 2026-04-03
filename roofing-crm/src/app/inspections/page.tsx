'use client';

import { useState } from 'react';
import AppShell from '@/components/AppShell';
import { useCRMStore } from '@/store';
import { formatDate, formatDateTime, generateId } from '@/lib/utils';
import {
  Camera,
  Calendar,
  MessageSquare,
  Send,
  CheckCircle,
  Image,
  FileText,
  Plus,
  Phone,
  MapPin,
} from 'lucide-react';
import type { Inspection } from '@/types';

const statusConfig: Record<Inspection['status'], { label: string; color: string }> = {
  scheduled: { label: 'Scheduled', color: 'bg-blue-100 text-blue-800' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-800' },
  completed: { label: 'Completed', color: 'bg-green-100 text-green-800' },
  report_generated: { label: 'Report Generated', color: 'bg-purple-100 text-purple-800' },
};

const severityColors: Record<string, string> = {
  minor: 'bg-yellow-100 text-yellow-800',
  moderate: 'bg-orange-100 text-orange-800',
  severe: 'bg-red-100 text-red-800',
};

const photoPlaceholderColors = [
  'bg-slate-300',
  'bg-orange-200',
  'bg-amber-200',
  'bg-red-200',
  'bg-sky-200',
  'bg-emerald-200',
  'bg-violet-200',
  'bg-rose-200',
];

export default function InspectionsPage() {
  const {
    inspections,
    homeowners,
    leads,
    currentUser,
    addInspection,
    updateInspection,
    addActivity,
  } = useCRMStore();

  const [expandedPhotos, setExpandedPhotos] = useState<string | null>(null);
  const [smsPanel, setSmsPanel] = useState<string | null>(null);
  const [smsText, setSmsText] = useState('');
  const [smsSent, setSmsSent] = useState<string | null>(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [apiKey, setApiKey] = useState('••••••••••••••••••••');
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [generatingReport, setGeneratingReport] = useState<string | null>(null);

  // Schedule modal state
  const [scheduleLeadId, setScheduleLeadId] = useState('');
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleNotes, setScheduleNotes] = useState('');

  const getHomeowner = (homeownerId: string) =>
    homeowners.find((h) => h.id === homeownerId);

  // Stats
  const scheduledCount = inspections.filter((i) => i.status === 'scheduled').length;
  const inProgressCount = inspections.filter((i) => i.status === 'in_progress').length;
  const completedCount = inspections.filter(
    (i) => i.status === 'completed' || i.status === 'report_generated'
  ).length;

  // Open SMS panel
  const openSmsPanel = (inspection: Inspection) => {
    const ho = getHomeowner(inspection.homeownerId);
    if (!ho) return;
    const repName = currentUser?.name ?? 'Your Rep';
    const firstName = ho.firstName;
    const address = ho.address;
    const findings = inspection.findings || 'some areas that need attention';
    const template = `Hi ${firstName}, this is ${repName} from StormShield Roofing. I completed the inspection of your property at ${address} and found ${findings}. I'd like to discuss the next steps with you. When is a good time to talk?`;
    setSmsText(template);
    setSmsPanel(inspection.id);
    setSmsSent(null);
  };

  const handleSendSms = (inspection: Inspection) => {
    const ho = getHomeowner(inspection.homeownerId);
    if (!ho) return;
    addActivity({
      id: generateId(),
      leadId: inspection.leadId,
      userId: currentUser?.id ?? '',
      type: 'text',
      description: `SMS follow-up sent to ${ho.firstName} ${ho.lastName} at ${ho.phone}`,
      createdAt: new Date().toISOString(),
    });
    setSmsSent(inspection.id);
    setTimeout(() => {
      setSmsPanel(null);
      setSmsSent(null);
    }, 3000);
  };

  const handleGenerateReport = (inspection: Inspection) => {
    setGeneratingReport(inspection.id);
    setTimeout(() => {
      updateInspection(inspection.id, {
        status: 'report_generated',
        reportUrl: `https://app.companycam.com/reports/${inspection.projectId || generateId()}`,
      });
      setGeneratingReport(null);
    }, 1500);
  };

  const handleSchedule = () => {
    if (!scheduleLeadId || !scheduleDate) return;
    const lead = leads.find((l) => l.id === scheduleLeadId);
    if (!lead) return;
    const newInspection: Inspection = {
      id: generateId(),
      leadId: lead.id,
      homeownerId: lead.homeownerId,
      scheduledDate: new Date(scheduleDate).toISOString(),
      photos: [],
      notes: scheduleNotes,
      findings: '',
      status: 'scheduled',
    };
    addInspection(newInspection);
    addActivity({
      id: generateId(),
      leadId: lead.id,
      userId: currentUser?.id ?? '',
      type: 'inspection',
      description: `Inspection scheduled for ${formatDateTime(newInspection.scheduledDate)}`,
      createdAt: new Date().toISOString(),
    });
    setShowScheduleModal(false);
    setScheduleLeadId('');
    setScheduleDate('');
    setScheduleNotes('');
  };

  const handleSaveApiKey = () => {
    setApiKeySaved(true);
    setTimeout(() => setApiKeySaved(false), 2000);
  };

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Inspections &amp; Reports
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Manage property inspections, sync photos from CompanyCam, and follow up with homeowners.
            </p>
          </div>
          <button
            onClick={() => setShowScheduleModal(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-orange-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Schedule Inspection
          </button>
        </div>

        {/* CompanyCam Integration Banner */}
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
                <Camera className="h-6 w-6 text-orange-600" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-gray-900">
                    CompanyCam Integration
                  </h2>
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    Connected
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-500">
                  Sync inspection photos and generate reports directly from CompanyCam projects.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="CompanyCam API Key"
                    className="w-64 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  />
                  <button
                    onClick={handleSaveApiKey}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    {apiKeySaved ? 'Saved!' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
            <button className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 transition-colors">
              <CheckCircle className="h-4 w-4" />
              Connected
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
                <Calendar className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Scheduled</p>
                <p className="text-2xl font-bold text-gray-900">{scheduledCount}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100">
                <Camera className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">In Progress</p>
                <p className="text-2xl font-bold text-gray-900">{inProgressCount}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
                <FileText className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Completed / Reports</p>
                <p className="text-2xl font-bold text-gray-900">{completedCount}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Inspections List */}
        <div className="space-y-4">
          {inspections.length === 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-12 text-center shadow-sm">
              <Camera className="mx-auto h-12 w-12 text-gray-300" />
              <h3 className="mt-3 text-lg font-semibold text-gray-900">No inspections yet</h3>
              <p className="mt-1 text-sm text-gray-500">
                Schedule your first inspection to get started.
              </p>
            </div>
          )}
          {inspections.map((inspection) => {
            const ho = getHomeowner(inspection.homeownerId);
            if (!ho) return null;
            const cfg = statusConfig[inspection.status];
            const isPhotosExpanded = expandedPhotos === inspection.id;
            const isSmsOpen = smsPanel === inspection.id;
            const isSmsSent = smsSent === inspection.id;
            const isGenerating = generatingReport === inspection.id;

            return (
              <div
                key={inspection.id}
                className="rounded-xl border border-gray-200 bg-white shadow-sm"
              >
                {/* Main card content */}
                <div className="p-5">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="space-y-1">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-semibold text-gray-900">
                          {ho.firstName} {ho.lastName}
                        </h3>
                        <span
                          className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.color}`}
                        >
                          {cfg.label}
                        </span>
                        {inspection.damageSeverity && (
                          <span
                            className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${severityColors[inspection.damageSeverity]}`}
                          >
                            {inspection.damageSeverity.charAt(0).toUpperCase() +
                              inspection.damageSeverity.slice(1)}{' '}
                            Damage
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-sm text-gray-500">
                        <MapPin className="h-3.5 w-3.5" />
                        {ho.address}, {ho.city}, {ho.state} {ho.zip}
                      </div>
                      <div className="flex items-center gap-4 text-sm text-gray-500">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3.5 w-3.5" />
                          {inspection.status === 'scheduled'
                            ? `Scheduled: ${formatDateTime(inspection.scheduledDate)}`
                            : inspection.completedDate
                              ? `Completed: ${formatDate(inspection.completedDate)}`
                              : `Scheduled: ${formatDateTime(inspection.scheduledDate)}`}
                        </span>
                        <span className="flex items-center gap-1">
                          <Image className="h-3.5 w-3.5" />
                          {inspection.photos.length} photo{inspection.photos.length !== 1 ? 's' : ''}
                        </span>
                        {inspection.damageType && (
                          <span className="text-gray-600 font-medium">
                            {inspection.damageType === 'hail'
                              ? 'Hail'
                              : inspection.damageType === 'wind'
                                ? 'Wind'
                                : 'Hail & Wind'}
                          </span>
                        )}
                      </div>
                      {inspection.findings && (
                        <p className="mt-2 text-sm text-gray-600">
                          <span className="font-medium">Findings:</span> {inspection.findings}
                        </p>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() =>
                          setExpandedPhotos(isPhotosExpanded ? null : inspection.id)
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <Image className="h-4 w-4" />
                        View Photos
                      </button>
                      {(inspection.status === 'completed') && (
                        <button
                          onClick={() => handleGenerateReport(inspection)}
                          disabled={isGenerating}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-orange-300 bg-orange-50 px-3 py-1.5 text-sm font-medium text-orange-700 hover:bg-orange-100 transition-colors disabled:opacity-60"
                        >
                          <FileText className="h-4 w-4" />
                          {isGenerating ? 'Generating...' : 'Generate Report'}
                        </button>
                      )}
                      {inspection.status === 'report_generated' && inspection.reportUrl && (
                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-purple-50 border border-purple-200 px-3 py-1.5 text-sm font-medium text-purple-700">
                          <CheckCircle className="h-4 w-4" />
                          Report Ready
                        </span>
                      )}
                      <button
                        onClick={() => openSmsPanel(inspection)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-sm font-semibold text-white shadow hover:bg-orange-700 transition-colors"
                      >
                        <MessageSquare className="h-4 w-4" />
                        Send Follow-Up Text
                      </button>
                    </div>
                  </div>
                </div>

                {/* Photo Grid (expanded) */}
                {isPhotosExpanded && (
                  <div className="border-t border-gray-200 bg-gray-50 p-5">
                    <h4 className="mb-3 text-sm font-semibold text-gray-700">
                      Inspection Photos
                    </h4>
                    {inspection.photos.length === 0 ? (
                      <p className="text-sm text-gray-500 italic">
                        No photos synced yet. Connect CompanyCam to import photos.
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6">
                        {inspection.photos.map((photo, idx) => (
                          <div key={photo.id} className="space-y-1">
                            <div
                              className={`aspect-square rounded-lg ${photoPlaceholderColors[idx % photoPlaceholderColors.length]} flex items-center justify-center`}
                            >
                              <Camera className="h-6 w-6 text-gray-500 opacity-40" />
                            </div>
                            <p className="truncate text-xs text-gray-500">
                              {photo.caption}
                            </p>
                            <span className="inline-block rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                              {photo.category}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* SMS Follow-Up Panel */}
                {isSmsOpen && (
                  <div className="border-t border-orange-200 bg-orange-50 p-5">
                    <div className="max-w-2xl">
                      <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                        <MessageSquare className="h-4 w-4 text-orange-600" />
                        SMS Follow-Up
                      </h4>
                      <div className="mt-3 flex items-center gap-4 text-sm text-gray-700">
                        <span className="font-medium">
                          {ho.firstName} {ho.lastName}
                        </span>
                        <span className="flex items-center gap-1 text-gray-500">
                          <Phone className="h-3.5 w-3.5" />
                          {ho.phone}
                        </span>
                      </div>
                      {isSmsSent ? (
                        <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-100 border border-green-200 p-4 text-sm font-medium text-green-800">
                          <CheckCircle className="h-5 w-5 text-green-600" />
                          Text message sent successfully to {ho.phone}
                        </div>
                      ) : (
                        <>
                          <textarea
                            rows={4}
                            value={smsText}
                            onChange={(e) => setSmsText(e.target.value)}
                            className="mt-3 w-full rounded-lg border border-gray-300 p-3 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none resize-y"
                          />
                          <div className="mt-3 flex items-center gap-2">
                            <button
                              onClick={() => handleSendSms(inspection)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-orange-700 transition-colors"
                            >
                              <Send className="h-4 w-4" />
                              Send Text Message
                            </button>
                            <button
                              onClick={() => setSmsPanel(null)}
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
            );
          })}
        </div>

        {/* Schedule Inspection Modal */}
        {showScheduleModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
              <h2 className="text-lg font-bold text-gray-900">Schedule Inspection</h2>
              <p className="mt-1 text-sm text-gray-500">
                Select a lead and pick a date/time for the property inspection.
              </p>
              <div className="mt-5 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Lead</label>
                  <select
                    value={scheduleLeadId}
                    onChange={(e) => setScheduleLeadId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  >
                    <option value="">Select a lead...</option>
                    {leads.map((lead) => {
                      const lho = getHomeowner(lead.homeownerId);
                      if (!lho) return null;
                      return (
                        <option key={lead.id} value={lead.id}>
                          {lho.firstName} {lho.lastName} - {lho.address}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Date &amp; Time
                  </label>
                  <input
                    type="datetime-local"
                    value={scheduleDate}
                    onChange={(e) => setScheduleDate(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Notes</label>
                  <textarea
                    rows={3}
                    value={scheduleNotes}
                    onChange={(e) => setScheduleNotes(e.target.value)}
                    placeholder="Any notes for this inspection..."
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none resize-y"
                  />
                </div>
              </div>
              <div className="mt-6 flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    setShowScheduleModal(false);
                    setScheduleLeadId('');
                    setScheduleDate('');
                    setScheduleNotes('');
                  }}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSchedule}
                  disabled={!scheduleLeadId || !scheduleDate}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-orange-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Calendar className="h-4 w-4" />
                  Schedule
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
