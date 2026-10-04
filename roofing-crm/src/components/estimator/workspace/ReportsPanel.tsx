'use client';

import { useRef, useState } from 'react';
import { FileText, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ParsedRoofReport } from '@/lib/roof-report';
import {
  applyTakeoff, formatDate, round2, takeoffFromParsed, type ReportAttachment, type ReportTakeoff,
} from '@/lib/estimator';
import type { EstimateWorkspace } from './useEstimateWorkspace';
import { toast } from './feedback';
import { Button, Card, CardBody, CardHeader, Pill } from './ui';

// "Roof reports & photos" (the original's e7): attach PDFs and photos to the
// estimate; a measurement report PDF is read by the CRM's /api/roof-report
// and its takeoff can be applied to the estimate.

const MAX_BYTES = 2621440; // 2.5 MB, as in the original

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

async function readReport(file: File): Promise<ReportTakeoff | null> {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch('/api/roof-report', { method: 'POST', body });
  if (res.status === 422) return null;
  const json = (await res.json().catch(() => null)) as (ParsedRoofReport & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error || 'error ' + res.status);
  if (!json.ok) return null;
  return takeoffFromParsed(json);
}

function openAttachment(att: ReportAttachment) {
  if (!att.data) return;
  try {
    const [head, b64] = att.data.split(',');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const type = (head.match(/data:(.*?);/) || [])[1] || 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 6e4);
  } catch {
    toast('Could not open that file in this viewer.');
  }
}

function TakeoffCard({ takeoff, onApply }: { takeoff: ReportTakeoff; onApply: () => void }) {
  const t = takeoff;
  const rows: [string, string][] = [
    ['Address', t.address || '—'],
    ['Total roof', `${round2(t.total)} sq ft = ${round2(t.total / 100)} sq`],
    ['Pitched area', `${round2(t.pitched)} sq ft`],
    ['Flat / low-slope', `${round2(t.flat)} sq ft`],
    ['Predominant pitch', `${t.pitch}/12`],
    ['Facets', String(t.facets || '—')],
    ['Eaves (gutter line)', `${round2(t.eaves)} LF`],
    ['Drip edge (eaves+rakes)', `${round2(t.eavesRakes)} LF`],
    ['Ridge cap (hips+ridges)', `${round2(t.hipsRidges)} LF`],
    ['Valleys', `${round2(t.valleys)} LF`],
    ['Penetrations', t.penetrations == null ? 'not on report' : String(t.penetrations)],
    ['Suggested waste', `${t.waste}%`],
  ];
  return (
    <div className="overflow-hidden rounded-xl border-2 border-blue-200 bg-white">
      <CardHeader title={`Measurements read from ${t.vendor}`} right={<Pill tone="navy">auto-extracted</Pill>} />
      <dl className="grid grid-cols-1 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 border-b border-gray-100 px-4 py-2 text-sm sm:odd:border-r">
            <dt className="flex-shrink-0 text-gray-600">{label}</dt>
            <dd className="min-w-0 text-right tabular-nums text-gray-900">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
        <Button variant="primary" onClick={onApply}>
          Apply to this estimate
        </Button>
        <span className="text-xs text-gray-500">
          Fills the roof sections, item quantities and gutter footage. Nothing is billed until you switch each line item on.
        </span>
      </div>
    </div>
  );
}

export default function ReportsPanel({ ws }: { ws: EstimateWorkspace }) {
  const est = ws.est!;
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const reports = est.reports || [];

  async function addFiles(files: FileList) {
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast(file.name + ' is over 2.5 MB — attach a smaller export.');
        continue;
      }
      const kind: ReportAttachment['kind'] = file.type.startsWith('image/') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'file';
      let data: string;
      try {
        data = await readAsDataUrl(file);
      } catch {
        toast('Could not read ' + file.name);
        continue;
      }
      const att: ReportAttachment = { name: file.name, size: file.size, kind, data, added: new Date().toISOString().slice(0, 10) };
      ws.edit((d) => {
        d.reports = d.reports || [];
        d.reports.push(att);
      });
      toast('Attached ' + file.name);
      if (kind !== 'pdf') continue;
      try {
        toast('Reading measurements from ' + file.name + '…');
        const takeoff = await readReport(file);
        if (takeoff) {
          ws.edit((d) => {
            const target = (d.reports || []).find((r) => r.name === att.name && r.size === att.size && r.added === att.added && !r.takeoff);
            if (target) target.takeoff = takeoff;
          });
          toast(takeoff.vendor + ' report read — ' + round2(takeoff.total / 100) + ' squares found');
        } else {
          toast('Could not find measurements — is it a Roofr or QuickMeasure report?');
        }
      } catch (err) {
        toast('Could not read that PDF (' + ((err instanceof Error && err.message) || 'error') + ')');
      }
    }
  }

  return (
    <Card>
      <CardHeader title="Roof reports & photos" sub="Roofr, GAF QuickMeasure, EagleView, photos" />
      <CardBody className="flex flex-col gap-3">
        <input
          ref={input}
          type="file"
          multiple
          accept="application/pdf,image/*"
          className="hidden"
          data-testid="report-file-input"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
          }}
          className={cn(
            'w-full rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors',
            over ? 'border-orange-500 bg-orange-50' : 'border-gray-300 bg-gray-50 hover:border-orange-400 hover:bg-orange-50/50',
          )}
        >
          <Upload className="mx-auto mb-1.5 h-6 w-6 text-gray-400" />
          <b className="text-sm text-gray-900">Add a roof report</b>
          <div className="mt-1 text-xs text-gray-500">
            Tap to browse, or drop a PDF or photo here — up to 2.5 MB each. A Roofr or QuickMeasure PDF is read automatically.
          </div>
        </button>
        {reports.map((att, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
              <div className="grid h-11 w-11 flex-shrink-0 place-items-center overflow-hidden rounded-md bg-gray-200 text-[10px] font-semibold text-gray-500">
                {att.kind === 'image' && att.data ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={att.data} alt="" className="h-full w-full object-cover" />
                ) : att.kind === 'pdf' ? (
                  <FileText className="h-5 w-5 text-red-500" aria-label="PDF" />
                ) : (
                  'FILE'
                )}
              </div>
              <div className="min-w-0 flex-1">
                <b className="block truncate text-sm text-gray-900">{att.name}</b>
                <span className="text-xs text-gray-500">
                  {(att.size / 1024).toFixed(0)} KB · added {formatDate(att.added)}
                </span>
              </div>
              <div className="flex flex-shrink-0 flex-wrap justify-end gap-1.5">
                {att.data ? (
                  <Button size="sm" onClick={() => openAttachment(att)}>
                    Open
                  </Button>
                ) : (
                  <Pill tone="mut" title="The file bytes stay on the device that attached it">
                    file on another device
                  </Pill>
                )}
                <Button size="sm" variant="danger" onClick={() => ws.edit((d) => void d.reports.splice(i, 1))}>
                  Remove
                </Button>
              </div>
            </div>
            {att.takeoff && att.takeoff.ok ? (
              <TakeoffCard
                takeoff={att.takeoff}
                onApply={() => {
                  ws.edit((d) => {
                    applyTakeoff(d, ws.pricing, att.takeoff!, { from: att.name });
                  });
                  toast('Report applied — quantities are loaded, switch items on to bill them');
                }}
              />
            ) : null}
          </div>
        ))}
        {reports.length ? (
          <div className="text-[11.5px] text-gray-500">
            Attached files are stored with the estimate on this device. They are never shown on the customer proposal.
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
