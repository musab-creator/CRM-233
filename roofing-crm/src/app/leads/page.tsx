'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import StatusBadge from '@/components/StatusBadge';
import { useCRMStore } from '@/store';
import {
  formatCurrency,
  formatDate,
  getLeadStatusLabel,
  getLeadStatusColor,
  generateId,
  getInsurancePipelineStages,
  getRetailPipelineStages,
} from '@/lib/utils';
import type { Lead, LeadStatus, JobType, LeadSource } from '@/types';
import {
  Plus,
  Table as TableIcon,
  Columns3,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Eye,
  X,
  User,
  MapPin,
  DollarSign,
} from 'lucide-react';

type FilterTab = 'all' | 'insurance' | 'retail';
type ViewMode = 'table' | 'pipeline';
type SortField =
  | 'homeowner'
  | 'address'
  | 'jobType'
  | 'status'
  | 'assignedTo'
  | 'estimatedValue'
  | 'createdAt';
type SortDirection = 'asc' | 'desc';

const LEAD_SOURCES: { value: LeadSource; label: string }[] = [
  { value: 'door_knock', label: 'Door Knock' },
  { value: 'referral', label: 'Referral' },
  { value: 'website', label: 'Website' },
  { value: 'social_media', label: 'Social Media' },
  { value: 'storm_chaser', label: 'Storm Chaser' },
  { value: 'marketing_campaign', label: 'Marketing Campaign' },
  { value: 'companycam', label: 'CompanyCam' },
  { value: 'other', label: 'Other' },
];

export default function LeadsPage() {
  const leads = useCRMStore((s) => s.leads);
  const homeowners = useCRMStore((s) => s.homeowners);
  const users = useCRMStore((s) => s.users);
  const addLead = useCRMStore((s) => s.addLead);
  const addHomeowner = useCRMStore((s) => s.addHomeowner);

  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [showNewLeadModal, setShowNewLeadModal] = useState(false);
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Form state
  const [formJobType, setFormJobType] = useState<JobType>('insurance');
  const [formFirstName, setFormFirstName] = useState('');
  const [formLastName, setFormLastName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formCity, setFormCity] = useState('');
  const [formState, setFormState] = useState('');
  const [formZip, setFormZip] = useState('');
  const [formSource, setFormSource] = useState<LeadSource>('door_knock');
  const [formAssignedTo, setFormAssignedTo] = useState('');
  const [formNotes, setFormNotes] = useState('');

  const getHomeowner = (id: string) => homeowners.find((h) => h.id === id);
  const getUser = (id: string) => users.find((u) => u.id === id);

  const filteredLeads = useMemo(() => {
    let result = leads;
    if (filterTab === 'insurance') result = result.filter((l) => l.jobType === 'insurance');
    if (filterTab === 'retail') result = result.filter((l) => l.jobType === 'retail');
    return result;
  }, [leads, filterTab]);

  const sortedLeads = useMemo(() => {
    const sorted = [...filteredLeads].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'homeowner': {
          const ha = getHomeowner(a.homeownerId);
          const hb = getHomeowner(b.homeownerId);
          cmp = `${ha?.lastName} ${ha?.firstName}`.localeCompare(
            `${hb?.lastName} ${hb?.firstName}`
          );
          break;
        }
        case 'address': {
          const ha = getHomeowner(a.homeownerId);
          const hb = getHomeowner(b.homeownerId);
          cmp = (ha?.address || '').localeCompare(hb?.address || '');
          break;
        }
        case 'jobType':
          cmp = a.jobType.localeCompare(b.jobType);
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
        case 'assignedTo': {
          const ua = getUser(a.assignedTo);
          const ub = getUser(b.assignedTo);
          cmp = (ua?.name || '').localeCompare(ub?.name || '');
          break;
        }
        case 'estimatedValue':
          cmp = (a.estimatedValue || 0) - (b.estimatedValue || 0);
          break;
        case 'createdAt':
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [filteredLeads, sortField, sortDirection, homeowners, users]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="ml-1 h-3.5 w-3.5 text-gray-400" />;
    return sortDirection === 'asc' ? (
      <ArrowUp className="ml-1 h-3.5 w-3.5 text-orange-600" />
    ) : (
      <ArrowDown className="ml-1 h-3.5 w-3.5 text-orange-600" />
    );
  };

  const resetForm = () => {
    setFormJobType('insurance');
    setFormFirstName('');
    setFormLastName('');
    setFormEmail('');
    setFormPhone('');
    setFormAddress('');
    setFormCity('');
    setFormState('');
    setFormZip('');
    setFormSource('door_knock');
    setFormAssignedTo('');
    setFormNotes('');
  };

  const handleSubmitLead = () => {
    if (!formFirstName.trim() || !formLastName.trim()) return;

    const homeownerId = generateId();
    const leadId = generateId();
    const now = new Date().toISOString();

    addHomeowner({
      id: homeownerId,
      firstName: formFirstName.trim(),
      lastName: formLastName.trim(),
      email: formEmail.trim(),
      phone: formPhone.trim(),
      address: formAddress.trim(),
      city: formCity.trim(),
      state: formState.trim(),
      zip: formZip.trim(),
      propertyType: 'residential',
      notes: formNotes.trim() || undefined,
      createdAt: now,
    });

    addLead({
      id: leadId,
      homeownerId,
      assignedTo: formAssignedTo || users[0]?.id || '',
      jobType: formJobType,
      status: 'new',
      source: formSource,
      notes: formNotes.trim(),
      createdAt: now,
      updatedAt: now,
      estimatedValue: 0,
    });

    resetForm();
    setShowNewLeadModal(false);
  };

  // Pipeline stages based on the active filter
  const insuranceStages = getInsurancePipelineStages();
  const retailStages = getRetailPipelineStages();

  // For pipeline view, determine which pipeline sets to show
  const pipelineConfigs = useMemo(() => {
    if (filterTab === 'insurance') {
      return [{ label: 'Insurance Pipeline', stages: insuranceStages, jobType: 'insurance' as JobType }];
    }
    if (filterTab === 'retail') {
      return [{ label: 'Retail Pipeline', stages: retailStages, jobType: 'retail' as JobType }];
    }
    return [
      { label: 'Insurance Pipeline', stages: insuranceStages, jobType: 'insurance' as JobType },
      { label: 'Retail Pipeline', stages: retailStages, jobType: 'retail' as JobType },
    ];
  }, [filterTab]);

  const getLeadsForStage = (status: LeadStatus, jobType: JobType) =>
    leads.filter((l) => l.status === status && l.jobType === jobType);

  const filterTabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'insurance', label: 'Insurance' },
    { key: 'retail', label: 'Retail' },
  ];

  const salesReps = users.filter((u) => u.role === 'sales_rep' || u.role === 'manager');

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Leads &amp; Jobs</h1>
            <p className="mt-1 text-sm text-gray-500">
              Manage your roofing leads and job pipeline
            </p>
          </div>
          <button
            onClick={() => setShowNewLeadModal(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-orange-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Lead
          </button>
        </div>

        {/* Filter Tabs + View Toggle */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
            {filterTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilterTab(tab.key)}
                className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                  filterTab === tab.key
                    ? 'bg-white text-orange-700 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
            <button
              onClick={() => setViewMode('table')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                viewMode === 'table'
                  ? 'bg-white text-orange-700 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              <TableIcon className="h-4 w-4" />
              Table
            </button>
            <button
              onClick={() => setViewMode('pipeline')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                viewMode === 'pipeline'
                  ? 'bg-white text-orange-700 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              <Columns3 className="h-4 w-4" />
              Pipeline
            </button>
          </div>
        </div>

        {/* Table View */}
        {viewMode === 'table' && (
          <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    {[
                      { field: 'homeowner' as SortField, label: 'Homeowner' },
                      { field: 'address' as SortField, label: 'Address' },
                      { field: 'jobType' as SortField, label: 'Job Type' },
                      { field: 'status' as SortField, label: 'Status' },
                      { field: 'assignedTo' as SortField, label: 'Assigned To' },
                      { field: 'estimatedValue' as SortField, label: 'Est. Value' },
                      { field: 'createdAt' as SortField, label: 'Created' },
                    ].map((col) => (
                      <th
                        key={col.field}
                        onClick={() => handleSort(col.field)}
                        className="cursor-pointer px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-700 select-none"
                      >
                        <span className="inline-flex items-center">
                          {col.label}
                          <SortIcon field={col.field} />
                        </span>
                      </th>
                    ))}
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sortedLeads.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-500">
                        No leads found. Click &quot;New Lead&quot; to create one.
                      </td>
                    </tr>
                  ) : (
                    sortedLeads.map((lead) => {
                      const ho = getHomeowner(lead.homeownerId);
                      const rep = getUser(lead.assignedTo);
                      return (
                        <tr key={lead.id} className="hover:bg-gray-50 transition-colors">
                          <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">
                            {ho ? `${ho.firstName} ${ho.lastName}` : 'Unknown'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                            {ho ? `${ho.address}, ${ho.city}` : '-'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm">
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                                lead.jobType === 'insurance'
                                  ? 'bg-blue-100 text-blue-800'
                                  : 'bg-emerald-100 text-emerald-800'
                              }`}
                            >
                              {lead.jobType === 'insurance' ? 'Insurance' : 'Retail'}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm">
                            <StatusBadge
                              label={getLeadStatusLabel(lead.status)}
                              colorClass={getLeadStatusColor(lead.status)}
                            />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                            {rep?.name || 'Unassigned'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                            {lead.estimatedValue ? formatCurrency(lead.estimatedValue) : '-'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                            {formatDate(lead.createdAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right text-sm">
                            <Link
                              href={`/leads/${lead.id}`}
                              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-orange-600 hover:bg-orange-50 transition-colors"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              View
                            </Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Pipeline / Kanban View */}
        {viewMode === 'pipeline' && (
          <div className="space-y-8">
            {pipelineConfigs.map((config) => (
              <div key={config.jobType}>
                <h2 className="mb-3 text-lg font-semibold text-gray-800">{config.label}</h2>
                <div className="flex gap-4 overflow-x-auto pb-4">
                  {config.stages.map((stage) => {
                    const stageLeads = getLeadsForStage(stage, config.jobType);
                    return (
                      <div
                        key={stage}
                        className="flex w-64 min-w-[16rem] flex-col rounded-xl bg-gray-50 ring-1 ring-gray-200"
                      >
                        {/* Column header */}
                        <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2.5">
                          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                            {getLeadStatusLabel(stage)}
                          </h3>
                          <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-gray-200 px-1.5 text-xs font-medium text-gray-700">
                            {stageLeads.length}
                          </span>
                        </div>

                        {/* Cards */}
                        <div className="flex flex-col gap-2 p-2" style={{ minHeight: '4rem' }}>
                          {stageLeads.length === 0 && (
                            <div className="py-4 text-center text-xs text-gray-400">No leads</div>
                          )}
                          {stageLeads.map((lead) => {
                            const ho = getHomeowner(lead.homeownerId);
                            const rep = getUser(lead.assignedTo);
                            return (
                              <Link
                                key={lead.id}
                                href={`/leads/${lead.id}`}
                                className="block rounded-lg bg-white p-3 shadow-sm ring-1 ring-gray-200 hover:shadow-md transition-shadow"
                              >
                                <div className="flex items-start justify-between">
                                  <p className="text-sm font-medium text-gray-900">
                                    {ho ? `${ho.firstName} ${ho.lastName}` : 'Unknown'}
                                  </p>
                                </div>
                                <div className="mt-1.5 flex items-center gap-1 text-xs text-gray-500">
                                  <MapPin className="h-3 w-3 flex-shrink-0" />
                                  <span className="truncate">
                                    {ho ? `${ho.address}, ${ho.city}` : '-'}
                                  </span>
                                </div>
                                <div className="mt-2 flex items-center justify-between">
                                  <span className="flex items-center gap-1 text-xs font-medium text-gray-700">
                                    <DollarSign className="h-3 w-3 text-green-600" />
                                    {lead.estimatedValue
                                      ? formatCurrency(lead.estimatedValue)
                                      : '$0'}
                                  </span>
                                  <span className="flex items-center gap-1 text-xs text-gray-500">
                                    <User className="h-3 w-3" />
                                    {rep?.name?.split(' ')[0] || 'N/A'}
                                  </span>
                                </div>
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* New Lead Modal */}
      {showNewLeadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              resetForm();
              setShowNewLeadModal(false);
            }}
          />

          {/* Modal */}
          <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 pb-4">
              <h2 className="text-xl font-bold text-gray-900">New Lead</h2>
              <button
                onClick={() => {
                  resetForm();
                  setShowNewLeadModal(false);
                }}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 space-y-5">
              {/* Job Type */}
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-gray-700">Job Type</legend>
                <div className="flex gap-4">
                  {(['insurance', 'retail'] as JobType[]).map((type) => (
                    <label
                      key={type}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
                        formJobType === type
                          ? 'border-orange-500 bg-orange-50 text-orange-700'
                          : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="jobType"
                        value={type}
                        checked={formJobType === type}
                        onChange={() => setFormJobType(type)}
                        className="sr-only"
                      />
                      {type === 'insurance' ? 'Insurance' : 'Retail'}
                    </label>
                  ))}
                </div>
              </fieldset>

              {/* Name */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    First Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formFirstName}
                    onChange={(e) => setFormFirstName(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    placeholder="John"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Last Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formLastName}
                    onChange={(e) => setFormLastName(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    placeholder="Smith"
                  />
                </div>
              </div>

              {/* Contact */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
                  <input
                    type="email"
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    placeholder="john@example.com"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Phone</label>
                  <input
                    type="tel"
                    value={formPhone}
                    onChange={(e) => setFormPhone(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>

              {/* Address */}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Address</label>
                <input
                  type="text"
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  placeholder="123 Main St"
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">City</label>
                  <input
                    type="text"
                    value={formCity}
                    onChange={(e) => setFormCity(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    placeholder="Dallas"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">State</label>
                  <input
                    type="text"
                    value={formState}
                    onChange={(e) => setFormState(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    placeholder="TX"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Zip</label>
                  <input
                    type="text"
                    value={formZip}
                    onChange={(e) => setFormZip(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    placeholder="75201"
                  />
                </div>
              </div>

              {/* Source & Assigned To */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Source</label>
                  <select
                    value={formSource}
                    onChange={(e) => setFormSource(e.target.value as LeadSource)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  >
                    {LEAD_SOURCES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Assigned To
                  </label>
                  <select
                    value={formAssignedTo}
                    onChange={(e) => setFormAssignedTo(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  >
                    <option value="">Select a rep...</option>
                    {salesReps.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
                <textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  placeholder="Additional notes about this lead..."
                />
              </div>
            </div>

            {/* Actions */}
            <div className="mt-6 flex items-center justify-end gap-3 border-t border-gray-200 pt-4">
              <button
                onClick={() => {
                  resetForm();
                  setShowNewLeadModal(false);
                }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitLead}
                disabled={!formFirstName.trim() || !formLastName.trim()}
                className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Create Lead
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
