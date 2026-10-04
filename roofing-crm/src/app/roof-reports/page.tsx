'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useDropzone } from 'react-dropzone';
import AppShell from '@/components/AppShell';
import { useCRMStore } from '@/store';
import { useBuildEstimate } from '@/components/useBuildEstimate';
import { formatDate, generateId } from '@/lib/utils';
import { SOURCE_LABELS, defaultWaste, emptyMeasurements, round2, squares } from '@/lib/roof-report';
import { ROOF_MEASURE_URL, prefillRoofMeasure, readRoofMeasure, seedRoofMeasureKey } from '@/lib/roof-measure-bridge';
import {
  Ruler, Upload, Satellite, PencilLine, Calculator, Loader2, AlertTriangle, FileText, X, Map as MapIcon, ExternalLink, ArrowDownToLine,
} from 'lucide-react';
import type { RoofMeasurements, RoofReport, RoofReportSource } from '@/types';

type Method = 'measure' | 'upload' | 'order' | 'manual';

interface Draft {
  source: RoofReportSource;
  fileName?: string;
  orderId?: string;
  simulated?: boolean;
  measurements: RoofMeasurements;
}

const FIELDS: { key: keyof RoofMeasurements; label: string; unit: string }[] = [
  { key: 'totalSqFt', label: 'Total roof area', unit: 'sq ft' },
  { key: 'pitchedSqFt', label: 'Pitched area', unit: 'sq ft' },
  { key: 'flatSqFt', label: 'Flat / low-slope area', unit: 'sq ft' },
  { key: 'twoStorySqFt', label: 'Two-story area', unit: 'sq ft' },
  { key: 'pitch', label: 'Predominant pitch', unit: '/12' },
  { key: 'facets', label: 'Facets', unit: '' },
  { key: 'eaves', label: 'Eaves', unit: 'LF' },
  { key: 'rakes', label: 'Rakes', unit: 'LF' },
  { key: 'eavesRakes', label: 'Drip edge (eaves + rakes)', unit: 'LF' },
  { key: 'hipsRidges', label: 'Hips + ridges', unit: 'LF' },
  { key: 'valleys', label: 'Valleys', unit: 'LF' },
  { key: 'flashing', label: 'Wall + step flashing', unit: 'LF' },
  { key: 'penetrations', label: 'Penetrations', unit: 'ea' },
  { key: 'wastePct', label: 'Waste', unit: '%' },
];

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500';

function RoofReportsContent() {
  const searchParams = useSearchParams();
  const { leads, homeowners, roofReports, currentUser, addRoofReport, addActivity } = useCRMStore();
  const buildEstimate = useBuildEstimate();

  const [leadId, setLeadId] = useState('');
  const [address, setAddress] = useState({ address: '', city: '', state: 'FL', zip: '' });
  const [method, setMethod] = useState<Method>('measure');
  const [measureReady, setMeasureReady] = useState(false);
  const measureFrame = useRef<HTMLIFrameElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectLead = useCallback(
    (id: string) => {
      setLeadId(id);
      const lead = leads.find((l) => l.id === id);
      const owner = lead && homeowners.find((h) => h.id === lead.homeownerId);
      if (owner) setAddress({ address: owner.address, city: owner.city, state: owner.state, zip: owner.zip });
    },
    [leads, homeowners],
  );

  useEffect(() => {
    seedRoofMeasureKey();
    setMeasureReady(true);
  }, []);

  useEffect(() => {
    const fromUrl = searchParams.get('leadId');
    if (fromUrl) selectLead(fromUrl);
  }, [searchParams, selectLead]);

  const onDrop = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      setBusy(true);
      setError('');
      try {
        const body = new FormData();
        body.append('file', file);
        const res = await fetch('/api/roof-report', { method: 'POST', body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not read that PDF');
        setDraft({ source: data.source, fileName: data.fileName, measurements: data.measurements });
        // Fill the address from the report when no lead was picked.
        if (!leadId && data.address) {
          const parts = String(data.address).split(',').map((p: string) => p.trim());
          const stateZip = (parts[2] || '').match(/([A-Za-z]{2}|Florida|Georgia)\s*(\d{5})?/);
          setAddress({
            address: parts[0] || '',
            city: parts[1] || '',
            state: stateZip ? (stateZip[1].length === 2 ? stateZip[1].toUpperCase() : stateZip[1] === 'Georgia' ? 'GA' : 'FL') : 'FL',
            zip: stateZip?.[2] || '',
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read that PDF');
      } finally {
        setBusy(false);
      }
    },
    [leadId],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    multiple: false,
    disabled: busy,
  });

  const orderEagleView = async () => {
    if (!address.address) {
      setError('Pick a lead or enter the property address first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/roof-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'order', provider: 'eagleview', ...address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Order failed');
      setDraft({ source: 'eagleview', orderId: data.orderId, simulated: data.simulated, measurements: data.measurements });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Order failed');
    } finally {
      setBusy(false);
    }
  };

  // Sends the picked property to Roof Measure once it (and its map) has loaded.
  const prefillMeasure = useCallback(() => {
    const frame = measureFrame.current;
    if (!frame || !address.address) return;
    const lead = leads.find((l) => l.id === leadId);
    const owner = lead && homeowners.find((h) => h.id === lead.homeownerId);
    const full = [address.address, address.city, `${address.state} ${address.zip}`.trim()].filter(Boolean).join(', ');
    return prefillRoofMeasure(frame, full, owner ? `${owner.firstName} ${owner.lastName}` : '');
  }, [address, leadId, leads, homeowners]);

  const pullFromRoofMeasure = () => {
    setError('');
    try {
      const { address: found, measurements } = readRoofMeasure(measureFrame.current);
      setDraft({ source: 'roof_measure', measurements });
      if (!address.address && found) setAddress(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read Roof Measure');
    }
  };

  const chooseMethod = (m: Method) => {
    setMethod(m);
    setError('');
    setDraft(m === 'manual' ? { source: 'manual', measurements: emptyMeasurements() } : null);
  };

  const setField = (key: keyof RoofMeasurements, raw: string) => {
    if (!draft) return;
    const m = { ...draft.measurements };
    if (key === 'penetrations') {
      m.penetrations = raw === '' ? null : Math.max(0, Math.round(Number(raw)));
    } else {
      m[key] = Number(raw) || 0;
    }
    // Hand-typed reports: keep derived fields in step until the rep overrides them.
    if (draft.source === 'manual') {
      if (key === 'eaves' || key === 'rakes') m.eavesRakes = round2(m.eaves + m.rakes);
      if (key === 'facets') m.wastePct = defaultWaste(m.facets);
      if (key === 'totalSqFt' || key === 'flatSqFt') m.pitchedSqFt = Math.max(0, m.totalSqFt - m.flatSqFt);
    }
    setDraft({ ...draft, measurements: m });
  };

  const canSave = !!draft && draft.measurements.totalSqFt > 0 && !!address.address;

  const save = (andBuild: boolean) => {
    if (!draft || !canSave) return;
    const lead = leads.find((l) => l.id === leadId);
    const report: RoofReport = {
      id: generateId(),
      leadId: lead?.id,
      homeownerId: lead?.homeownerId,
      ...address,
      source: draft.source,
      fileName: draft.fileName,
      orderId: draft.orderId,
      simulated: draft.simulated,
      measurements: draft.measurements,
      createdAt: new Date().toISOString(),
      createdBy: currentUser?.id || '',
      estimates: [],
    };
    addRoofReport(report);
    addActivity({
      id: generateId(),
      leadId: report.leadId,
      userId: currentUser?.id || '',
      type: 'document',
      description: `Roof report (${SOURCE_LABELS[report.source]}) added for ${report.address} — ${squares(report.measurements)} sq`,
      createdAt: report.createdAt,
    });
    setDraft(method === 'manual' ? { source: 'manual', measurements: emptyMeasurements() } : null);
    if (andBuild) buildEstimate(report);
  };

  const leadName = (id?: string) => {
    const lead = leads.find((l) => l.id === id);
    const owner = lead && homeowners.find((h) => h.id === lead.homeownerId);
    return owner ? `${owner.firstName} ${owner.lastName}` : null;
  };

  const methods: { id: Method; label: string; sub: string; icon: typeof Upload }[] = [
    { id: 'measure', label: 'Measure on satellite', sub: 'Roof Measure — auto-trace or trace by hand', icon: MapIcon },
    { id: 'upload', label: 'Upload report PDF', sub: 'Roofr, GAF QuickMeasure, EagleView', icon: Upload },
    { id: 'order', label: 'Order from EagleView', sub: 'Simulated until API keys are added', icon: Satellite },
    { id: 'manual', label: 'Enter manually', sub: 'Hand measurements or another vendor', icon: PencilLine },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Ruler className="mt-1 h-7 w-7 flex-shrink-0 text-orange-500" />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">Roof Reports</h1>
            <p className="text-sm text-gray-500">
              Pull measurements for a property, then send them straight into the estimator.
            </p>
          </div>
        </div>
        <Link
          href="/estimator"
          className="inline-flex flex-shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <Calculator className="h-4 w-4" /> Open Estimator
        </Link>
      </div>

      {/* Step 1: property */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">1. Property</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
          <select
            value={leadId}
            onChange={(e) => (e.target.value ? selectLead(e.target.value) : setLeadId(''))}
            className={`${inputCls} md:col-span-6`}
          >
            <option value="">No lead — enter an address</option>
            {leads.map((l) => {
              const owner = homeowners.find((h) => h.id === l.homeownerId);
              return owner ? (
                <option key={l.id} value={l.id}>
                  {owner.firstName} {owner.lastName} — {owner.address}, {owner.city}
                </option>
              ) : null;
            })}
          </select>
          <input className={`${inputCls} md:col-span-3`} placeholder="Street address" value={address.address}
            onChange={(e) => setAddress({ ...address, address: e.target.value })} />
          <input className={`${inputCls} md:col-span-1`} placeholder="City" value={address.city}
            onChange={(e) => setAddress({ ...address, city: e.target.value })} />
          <input className={`${inputCls} md:col-span-1`} placeholder="State" value={address.state}
            onChange={(e) => setAddress({ ...address, state: e.target.value })} />
          <input className={`${inputCls} md:col-span-1`} placeholder="ZIP" value={address.zip}
            onChange={(e) => setAddress({ ...address, zip: e.target.value })} />
        </div>
      </div>

      {/* Step 2: measurements */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">2. Get measurements</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {methods.map((m) => (
            <button
              key={m.id}
              onClick={() => chooseMethod(m.id)}
              className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                method === m.id ? 'border-orange-500 bg-orange-50 ring-2 ring-orange-100' : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <m.icon className="mt-0.5 h-5 w-5 text-orange-600" />
              <span>
                <span className="block text-sm font-semibold text-gray-800">{m.label}</span>
                <span className="block text-xs text-gray-500">{m.sub}</span>
              </span>
            </button>
          ))}
        </div>

        {method === 'measure' && measureReady && (
          <div className="mt-4 overflow-hidden rounded-xl border border-gray-200">
            <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2.5">
              <p className="w-full text-xs text-gray-600 sm:w-auto sm:flex-1">
                Find the house, press <strong>Get roof data</strong> then <strong>Auto-trace roof</strong> (or trace facets and
                lines by hand). When the totals look right, pull them in.
              </p>
              <button
                onClick={prefillMeasure}
                disabled={!address.address}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Go to property
              </button>
              <a
                href={ROOF_MEASURE_URL}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Full screen
              </a>
              <button
                onClick={pullFromRoofMeasure}
                className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
              >
                <ArrowDownToLine className="h-3.5 w-3.5" /> Use these measurements
              </button>
            </div>
            <iframe
              ref={measureFrame}
              src={ROOF_MEASURE_URL}
              title="Roof Measure"
              onLoad={prefillMeasure}
              className="block h-[78vh] min-h-[560px] w-full bg-white"
            />
          </div>
        )}

        {method === 'upload' && !draft && (
          <div
            {...getRootProps()}
            className={`mt-4 cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-all ${
              isDragActive ? 'border-orange-500 bg-orange-50' : 'border-gray-300 bg-gray-50 hover:border-orange-400'
            }`}
          >
            <input {...getInputProps()} />
            {busy ? (
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-600" />
            ) : (
              <>
                <FileText className="mx-auto h-8 w-8 text-orange-600" />
                <p className="mt-2 text-sm font-semibold text-gray-700">
                  {isDragActive ? 'Drop the report here' : 'Drag & drop a roof report PDF, or click to browse'}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Measurements are read from the PDF text — you review them before saving.
                </p>
              </>
            )}
          </div>
        )}

        {method === 'order' && !draft && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p>
              EagleView ordering is <strong>simulated</strong>: it returns made-up measurements so the workflow can be
              tried end to end. Real orders need EagleView API credentials and take EagleView&apos;s turnaround time.
              Until then, order on EagleView&apos;s site and upload the PDF here.
            </p>
            <button
              onClick={orderEagleView}
              disabled={busy}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Satellite className="h-4 w-4" />}
              Order simulated report
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {error}
          </div>
        )}

        {draft && (
          <div className="mt-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                {SOURCE_LABELS[draft.source]}
              </span>
              {draft.fileName && <span className="text-xs text-gray-500">{draft.fileName}</span>}
              {draft.simulated && (
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                  Simulated — not real measurements
                </span>
              )}
              <span className="ml-auto text-sm font-semibold text-gray-800">
                {squares(draft.measurements)} squares
              </span>
              {method !== 'manual' && (
                <button onClick={() => setDraft(null)} className="rounded p-1 text-gray-400 hover:bg-gray-100" title="Discard">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
              {FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="mb-1 block text-xs text-gray-500">
                    {f.label} {f.unit && <span className="text-gray-400">({f.unit})</span>}
                  </span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    className={inputCls}
                    value={draft.measurements[f.key] ?? ''}
                    placeholder={f.key === 'penetrations' ? 'not counted' : undefined}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={() => save(true)}
                disabled={!canSave}
                className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Calculator className="h-4 w-4" /> Save & build estimate
              </button>
              <button
                onClick={() => save(false)}
                disabled={!canSave}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save report
              </button>
              {!canSave && (
                <span className="text-xs text-gray-500">Needs a property address and a total roof area.</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Saved reports */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-gray-700">Saved reports ({roofReports.length})</h2>
        </div>
        {roofReports.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">No roof reports yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-4 py-3">Property</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3 text-right">Squares</th>
                  <th className="px-4 py-3 text-right">Pitch</th>
                  <th className="px-4 py-3 text-right">Drip edge</th>
                  <th className="px-4 py-3 text-right">Hips+ridges</th>
                  <th className="px-4 py-3 text-right">Valleys</th>
                  <th className="px-4 py-3">Estimates</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {roofReports.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{r.address}</p>
                      <p className="text-xs text-gray-500">
                        {r.leadId && leadName(r.leadId) ? (
                          <Link href={`/leads/${r.leadId}`} className="text-orange-600 hover:underline">{leadName(r.leadId)}</Link>
                        ) : (
                          [r.city, r.state].filter(Boolean).join(', ')
                        )}
                        {' · '}{formatDate(r.createdAt)}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      {SOURCE_LABELS[r.source]}
                      {r.simulated && (
                        <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">Simulated</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{squares(r.measurements).toFixed(2)}</td>
                    <td className="px-4 py-3 text-right font-mono">{r.measurements.pitch}/12</td>
                    <td className="px-4 py-3 text-right font-mono">{Math.round(r.measurements.eavesRakes)} LF</td>
                    <td className="px-4 py-3 text-right font-mono">{Math.round(r.measurements.hipsRidges)} LF</td>
                    <td className="px-4 py-3 text-right font-mono">{Math.round(r.measurements.valleys)} LF</td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {r.estimates.length ? r.estimates.map((e) => e.number).join(', ') : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => buildEstimate(r)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
                      >
                        <Calculator className="h-3.5 w-3.5" /> Build estimate
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function RoofReportsPage() {
  return (
    <AppShell>
      <Suspense fallback={<div className="py-10 text-center text-gray-400">Loading...</div>}>
        <RoofReportsContent />
      </Suspense>
    </AppShell>
  );
}
