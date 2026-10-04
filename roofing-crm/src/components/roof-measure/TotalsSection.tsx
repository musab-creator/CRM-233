'use client';

import { useState } from 'react';
import { fmt, pitchLabel } from '@/lib/roof-measure/format';
import { computeMaterials, EDGE_TYPES, type EdgeTypeInfo } from '@/lib/roof-measure/measure';
import type { EdgeType, MaterialAssumptions } from '@/lib/roof-measure/model';
import { useRM } from './store';
import { useTotals } from './hooks';
import { inputCls, Kpis, LField, numCls, Out, tableCls } from './ui';

// 4. Measurements & materials: totals, structures, line footage, waste factor, quick materials list and the
// coverage assumptions behind it.

const WASTE_CHOICES: [number, string][] = [[0, '0%'], [5, '5%'], [10, '10% (simple gable)'], [12, '12%'], [15, '15% (hip / cut-up)'], [18, '18%'], [20, '20%']];
const ASSUMPTIONS: [keyof MaterialAssumptions, string, number][] = [
  ['ridgeCapLF', 'Ridge cap LF / bundle', 1], ['starterLF', 'Starter LF / bundle', 1], ['underlaySq', 'Underlayment squares / roll', 0.5], ['iwLF', 'Ice & water LF / roll (36" wide)', 0.1],
  ['dripStick', 'Drip edge stick (ft)', 1], ['valleyStick', 'Valley metal stick (ft)', 1], ['nailsPerSq', 'Nails / square', 10], ['nailsPerBox', 'Nails / box', 100],
];

function AssumptionInput({ k, step }: { k: keyof MaterialAssumptions; step: number }) {
  const value = useRM((s) => s.project.mat[k]);
  const setMat = useRM((s) => s.setMat);
  const [text, setText] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) { setSeen(value); setText(String(value)); }
  return (
    <input className={inputCls} type="number" step={step} value={text} inputMode="decimal"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { const v = +text; if (v) setMat(k, v); else setText(String(value)); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

export default function TotalsSection() {
  const project = useRM((s) => s.project);
  const setWaste = useRM((s) => s.setWaste);
  const t = useTotals();
  const empty = !project.facets.length && !project.edges.length;
  const lineRows = (Object.entries(EDGE_TYPES) as [EdgeType, EdgeTypeInfo][]).filter(([k]) => t.byType[k].count);
  const extras = [
    t.flat ? `flat ${fmt(t.flat)} sf` : '', t.twoStory ? `two story ${fmt(t.twoStory)} sf` : '', t.twoLayer ? `two layer ${fmt(t.twoLayer)} sf` : '',
  ].filter(Boolean);

  return (
    <div>
      {empty ? (
        <Out><span className="text-gray-500">Trace facets and lines to see totals here.</span></Out>
      ) : (
        <Out testId="summary-out">
          <Kpis items={[
            { v: fmt(t.sloped), l: 'roof sq ft', testId: 'kpi-sqft' },
            { v: fmt(t.squares, 2), l: 'squares', testId: 'kpi-squares' },
            { v: fmt(t.squaresWaste, 2), l: `sq with ${project.waste}% waste`, testId: 'kpi-waste' },
          ]} />
          <div data-testid="summary-meta" className="text-xs text-gray-600">
            Footprint (plan) {fmt(t.plan)} sf · {t.facetCount} facet{t.facetCount === 1 ? '' : 's'}{t.cutouts.length ? ` · ${t.cutouts.length} excluded` : ''} · {t.structures.length} structure{t.structures.length === 1 ? '' : 's'} · predominant pitch {t.predominant == null ? '-' : pitchLabel(t.predominant)} · recommended waste (Roofr method) <b data-testid="rec-waste">{t.recWaste}%</b>{extras.map((x) => ` · ${x}`).join('')}
          </div>
          {t.structures.length > 1 && (
            <table className={`${tableCls} mt-2`}>
              <thead><tr><th>Structure</th><th className={numCls}>Facets</th><th className={numCls}>Sq ft</th><th>Pitch</th></tr></thead>
              <tbody>{t.structures.map((s) => <tr key={s.index}><td>Structure #{s.index}</td><td className={numCls}>{s.facetCount}</td><td className={numCls}>{fmt(s.sloped)}</td><td>{s.predominant == null ? '-' : pitchLabel(s.predominant)}</td></tr>)}</tbody>
            </table>
          )}
          {lineRows.length > 0 && (
            <table data-testid="line-totals" className={`${tableCls} mt-2`}>
              <thead><tr><th>Line</th><th className={numCls}>Plan ft</th><th className={numCls}>Actual ft</th></tr></thead>
              <tbody>{lineRows.map(([k, v]) => (
                <tr key={k} data-type={k}><td><span style={{ color: v.color }}>&#9632;</span> {v.plural}</td><td className={numCls}>{fmt(t.byType[k].plan, 1)}</td><td className={numCls}><b>{fmt(t.byType[k].true, 1)}</b></td></tr>
              ))}</tbody>
            </table>
          )}
        </Out>
      )}
      <LField label="Waste factor" className="mt-3">
        <select data-testid="waste" className={inputCls} value={project.waste} onChange={(e) => setWaste(+e.target.value)}>
          {WASTE_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          {!WASTE_CHOICES.some(([v]) => v === project.waste) && <option value={project.waste}>{project.waste}%</option>}
        </select>
      </LField>
      {t.sloped > 0 && (
        <Out testId="materials-out">
          <table className={tableCls}>
            <thead><tr><th>Material</th><th className={numCls}>Qty</th><th>Basis</th></tr></thead>
            <tbody>{computeMaterials(t, project.mat, project.waste).map((i) => (
              <tr key={i.name}><td>{i.name}</td><td className={numCls}><b>{i.qty}</b> {i.unit}</td><td className="text-[11px] text-gray-500">{i.basis}</td></tr>
            ))}</tbody>
          </table>
        </Out>
      )}
      <details className="mt-3 text-xs text-gray-600">
        <summary className="cursor-pointer font-medium text-orange-700">Material coverage assumptions</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {ASSUMPTIONS.map(([k, label, step]) => <LField key={k} label={label}><AssumptionInput k={k} step={step} /></LField>)}
        </div>
      </details>
    </div>
  );
}
