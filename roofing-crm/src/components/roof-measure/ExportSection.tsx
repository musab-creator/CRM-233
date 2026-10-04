'use client';

import { useState } from 'react';
import { Download, FileJson, FileSpreadsheet, Loader2, Printer, Save, Upload, X } from 'lucide-react';
import type { Company } from '@/lib/roof-measure/report';
import { useRM } from './store';
import { buildResidentialReport, deleteSavedRoof, download, exportCSV, exportJSON, importJSONFile, loadSavedRoof, saveRoof, savedRoofs } from './actions';
import { openReport } from './ReportViewer';
import { Btn, H4, inputCls, LField } from './ui';
import TransferButtons from './TransferButtons';

// 5. Report, save & export: job name, rep, the Roofr-format report (print / download), CSV / JSON export and
// import, company details, saved roofs in this browser.

const COMPANY_FIELDS: [keyof Company, string][] = [['name', 'Company name'], ['phone', 'Phone'], ['email', 'Email'], ['website', 'Website'], ['license', 'License #'], ['address', 'Office address']];

export function CompanyInput({ k }: { k: keyof Company }) {
  const value = useRM((s) => s.company[k]);
  const setCompany = useRM((s) => s.setCompany);
  return <input data-testid={`co-${k}`} className={inputCls} type="text" value={value || ''} onChange={(e) => setCompany(k, e.target.value)} onBlur={(e) => setCompany(k, e.target.value.trim())} placeholder={k === 'rep' ? 'Your name' : undefined} />;
}

export function useReportRunner() {
  const busy = useRM((s) => s.busy.report);
  const run = async (mode: 'print' | 'download') => {
    const S = useRM.getState();
    if (S.busy.report) return;
    S.setBusy('report', true);
    try {
      const r = await buildResidentialReport();
      if (!r) return;
      if (mode === 'download') download(r.fileName, r.downloadDoc, 'text/html');
      else openReport(r, true);
    } catch (e) {
      S.showToast('Report failed: ' + (e instanceof Error ? e.message : String(e)), true);
    } finally {
      useRM.getState().setBusy('report', false);
    }
  };
  return { busy: !!busy, run };
}

function SavedRoofs() {
  const [, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  const list = savedRoofs();
  const project = useRM((s) => s.project);
  const save = () => {
    const name = (project.jobName || project.address || '').trim() || window.prompt('Name this roof:')?.trim();
    if (!name) return;
    if (saveRoof(name)) refresh();
  };
  return (
    <>
      <H4>Saved roofs (this browser)</H4>
      <Btn onClick={save} data-testid="save-roof"><Save className="h-4 w-4" />Save this roof</Btn>
      <div data-testid="saved-list" className="mt-2 flex flex-col gap-1">
        {list.length ? list.map(({ name, saved }) => (
          <div key={name} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-gray-200 bg-white px-2 text-sm hover:bg-gray-50" onClick={() => loadSavedRoof(name)} data-name={name}>
            <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
            <span className="flex-none text-xs text-gray-500">{(saved.facets || []).length} facets · {new Date(saved.savedAt).toLocaleDateString('en-US')}</span>
            <button type="button" className="-mr-1 flex h-9 w-9 flex-none items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600" title="Delete" aria-label={`Delete saved roof ${name}`}
              onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete saved roof "${name}"?`)) { deleteSavedRoof(name); refresh(); } }}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )) : <div className="py-1 text-xs text-gray-500">Nothing saved yet.</div>}
      </div>
    </>
  );
}

export default function ExportSection() {
  const jobName = useRM((s) => s.project.jobName);
  const setJobName = useRM((s) => s.setJobName);
  const mode = useRM((s) => s.mode);
  const { busy, run } = useReportRunner();

  return (
    <div>
      <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-3">
        <p className="text-sm font-semibold text-gray-900">Turn this roof into a full estimate</p>
        <p className="mb-2 mt-0.5 text-xs text-gray-600">
          Saves the roof report to the CRM and opens a priced estimate built from these measurements — or go straight to
          its customer proposal.
        </p>
        <TransferButtons />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <LField label="Customer / job name"><input data-testid="job-name" className={inputCls} type="text" placeholder="Smith residence" value={jobName} onChange={(e) => setJobName(e.target.value)} /></LField>
        <LField label="Prepared by (rep)"><CompanyInput k="rep" /></LField>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {mode === 'res' && (
          <>
            <Btn variant="primary" disabled={busy} onClick={() => void run('print')} data-testid="btn-report">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}Print / PDF report</Btn>
            <Btn disabled={busy} title="Self-contained report file you can email or open later" onClick={() => void run('download')} data-testid="btn-report-html"><Download className="h-4 w-4" />Download report</Btn>
          </>
        )}
        <Btn onClick={exportCSV} data-testid="btn-csv"><FileSpreadsheet className="h-4 w-4" />Export CSV</Btn>
        <Btn onClick={exportJSON} data-testid="btn-json"><FileJson className="h-4 w-4" />Export JSON</Btn>
        <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50">
          <Upload className="h-4 w-4" />Import JSON
          <input data-testid="file-json" type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJSONFile(f); e.target.value = ''; }} />
        </label>
      </div>
      <details className="mt-3 text-xs text-gray-600">
        <summary className="cursor-pointer font-medium text-orange-700">Company details shown on the report</summary>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {COMPANY_FIELDS.map(([k, label]) => <LField key={k} label={label}><CompanyInput k={k} /></LField>)}
        </div>
      </details>
      <SavedRoofs />
    </div>
  );
}
