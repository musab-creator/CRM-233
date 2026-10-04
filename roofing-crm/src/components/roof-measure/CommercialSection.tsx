'use client';

import { useState } from 'react';
import { Download, Loader2, Printer } from 'lucide-react';
import { fmt } from '@/lib/roof-measure/format';
import { commercialTotals, type CommercialOptions } from '@/lib/roof-measure/commercial';
import { useRM } from './store';
import { buildCommercialReport, download, runCommercial } from './actions';
import { openReport } from './ReportViewer';
import { Btn, Check, H4, inputCls, LField, Muted, Out, tableCls } from './ui';

// 2. Commercial roof: measure, roof system and insulation options, site counts, the commercial report.

const SQFT = 10.7639104, FT = 3.28084;
const SYSTEMS: [string, string][] = [
  ['tpo_ma', 'TPO 60 mil, mechanically attached'], ['tpo_fa', 'TPO 60 mil, fully adhered'], ['pvc_ma', 'PVC 60 mil, mechanically attached'],
  ['epdm_fa', 'EPDM 60 mil, fully adhered'], ['modbit', 'SBS modified bitumen, 2-ply'], ['silicone', 'Silicone coating (restoration)'],
];

// Number fields: typed text is kept as typed; the option is parsed like the original (parseFloat).
function NumOpt({ k, step, min, max, title, testId }: { k: 'waste' | 'rTarget' | 'windMph'; step: number; min: number; max?: number; title?: string; testId?: string }) {
  const value = useRM((s) => s.comOpts[k]);
  const setComOpt = useRM((s) => s.setComOpt);
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : '');
  const [seen, setSeen] = useState(value);
  if (value !== seen && !(Number.isNaN(value) && Number.isNaN(seen))) { setSeen(value); setText(Number.isFinite(value) ? String(value) : ''); }
  return <input data-testid={testId} className={inputCls} type="number" inputMode="decimal" step={step} min={min} max={max} title={title} value={text} onChange={(e) => { setText(e.target.value); const v = parseFloat(e.target.value); setSeen(v); setComOpt(k, v); }} />;
}
function SiteOpt({ k, placeholder }: { k: 'drains' | 'scuppers' | 'skylights' | 'hatches' | 'heightFt'; placeholder: string }) {
  const value = useRM((s) => s.comOpts[k]);
  const setComOpt = useRM((s) => s.setComOpt);
  return <input data-testid={`c-${k}`} className={inputCls} type="number" inputMode="numeric" min={0} placeholder={placeholder} value={value} onChange={(e) => setComOpt(k, e.target.value)} />;
}

export function CommercialSummary() {
  const M = useRM((s) => s.comModel);
  const opts = useRM((s) => s.comOpts);
  if (!M) return <Out><span className="text-gray-500">Enter the address, then press Measure commercial roof.</span></Out>;
  const T = commercialTotals(M, opts);
  return (
    <Out testId="com-out">
      <div className="mb-1 text-base"><b>{fmt(T.totalSF)} sqft</b> ({fmt(T.squares, 1)} sq) · {M.sections.length} section{M.sections.length > 1 ? 's' : ''} · roof {T.heightFt ? fmt(T.heightFt) + ' ft' : '-'} high</div>
      <div>Perimeter {fmt(T.perimLF)} LF: parapet {fmt(T.parLF)} LF (avg {fmt(T.parAvgFt, 1)} ft), open edge {fmt(T.edgeLF)} LF</div>
      <div>Interior walls {fmt(T.wallLF)} LF · HVAC units {T.rtus.length} · vents/penetrations {T.vents.length} · drains (est.) {T.drains}</div>
      <table className={`${tableCls} mt-2`}>
        <thead><tr><th>Sec</th><th>sqft</th><th>slope</th><th>height</th></tr></thead>
        <tbody>{M.sections.map((s) => (
          <tr key={s.sid}><td>{s.letter}</td><td>{fmt(s.areaM2 * SQFT)}</td><td>{s.steep ? fmt(s.slope * 12, 1) + '/12' : fmt(s.slope * 12, 2) + '"/ft'}</td><td>{s.elevM != null ? fmt(s.elevM * FT) + ' ft' : '-'}</td></tr>
        ))}</tbody>
      </table>
      <div className="mt-1 text-xs text-gray-500">Imagery {M.imageryDate || '-'} · {M.quality || ''} · {((M.ms || 0) / 1000).toFixed(1)} s</div>
    </Out>
  );
}

export default function CommercialSection() {
  const busy = useRM((s) => s.busy);
  const system = useRM((s) => s.comOpts.system);
  const cover = useRM((s) => s.comOpts.cover);
  const taper = useRM((s) => s.comOpts.taper);
  const setComOpt = useRM((s) => s.setComOpt);

  const report = async (mode: 'print' | 'download') => {
    const S = useRM.getState();
    if (S.busy.comReport) return;
    S.setBusy('comReport', true);
    try {
      const r = await buildCommercialReport();
      if (!r) return;
      if (mode === 'download') download(r.fileName, r.downloadDoc, 'text/html');
      else openReport(r, true);
    } catch (e) {
      S.showToast('Report failed: ' + (e instanceof Error ? e.message : String(e)), true);
    } finally {
      useRM.getState().setBusy('comReport', false);
    }
  };

  return (
    <div>
      <Muted className="mb-3">Flat and low-slope roofs: outline, roof levels, parapet walls and heights, rooftop units, wind zones and a full material estimate. Enter the address above first.</Muted>
      <Btn variant="primary" disabled={busy.com} onClick={() => void runCommercial()} data-testid="btn-com">
        {busy.com && <Loader2 className="h-4 w-4 animate-spin" />}{busy.com ? 'Measuring...' : 'Measure commercial roof'}
      </Btn>
      <CommercialSummary />
      <H4>Roof system</H4>
      <div className="grid grid-cols-2 gap-2">
        <LField label="System" className="col-span-2 sm:col-span-1">
          <select data-testid="c-system" className={inputCls} value={system} onChange={(e) => setComOpt('system', e.target.value as CommercialOptions['system'])}>
            {SYSTEMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </LField>
        <LField label="Waste %"><NumOpt k="waste" step={1} min={0} max={30} /></LField>
        <LField label="Insulation target R"><NumOpt k="rTarget" step={1} min={0} max={60} title="FBC Energy climate zone 2: R-25 continuous above deck. 0 = no new insulation" /></LField>
        <LField label="Wind speed (mph)"><NumOpt k="windMph" step={5} min={90} max={200} /></LField>
      </div>
      <div className="mt-1 flex flex-col">
        <Check checked={!!cover} onChange={(v) => setComOpt('cover', v)}>1/2&quot; HD cover board</Check>
        <Check checked={!!taper} onChange={(v) => setComOpt('taper', v)}>Tapered insulation / crickets</Check>
      </div>
      <H4>Site counts (override)</H4>
      <div className="grid grid-cols-2 gap-2">
        <LField label="Roof drains"><SiteOpt k="drains" placeholder="estimate" /></LField>
        <LField label="Overflow scuppers"><SiteOpt k="scuppers" placeholder="estimate" /></LField>
        <LField label="Skylights"><SiteOpt k="skylights" placeholder="0" /></LField>
        <LField label="Roof hatches"><SiteOpt k="hatches" placeholder="0" /></LField>
        <LField label="Roof height ft"><SiteOpt k="heightFt" placeholder="measured" /></LField>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn variant="primary" disabled={busy.comReport} onClick={() => void report('print')} data-testid="btn-com-report">{busy.comReport ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}Print / PDF commercial report</Btn>
        <Btn disabled={busy.comReport} onClick={() => void report('download')}><Download className="h-4 w-4" />Download commercial report</Btn>
      </div>
    </div>
  );
}
