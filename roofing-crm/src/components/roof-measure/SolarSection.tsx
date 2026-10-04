'use client';

import { Loader2 } from 'lucide-react';
import { compassDir, solarSummaryOf } from '@/lib/roof-measure/solar';
import { fmt, pitchLabel } from '@/lib/roof-measure/format';
import { useRM } from './store';
import { getController, runAutoTrace, runSolar, scanForStructures } from './actions';
import { Btn, Check, H4, Kpis, Muted, numCls, Out, Swatch, tableCls } from './ui';

// 2. Auto measure (Google Solar API): roof data, auto-trace, structure scan, planes on the map.

export default function SolarSection() {
  const solar = useRM((s) => s.project.solar);
  const otherSolar = useRM((s) => s.project.otherSolar);
  const location = useRM((s) => s.project.location);
  const busy = useRM((s) => s.busy);
  const error = useRM((s) => s.solarError);
  const showSolar = useRM((s) => s.showSolar);
  const setShowSolar = useRM((s) => s.setShowSolar);
  const setDefaultPitch = useRM((s) => s.setDefaultPitch);
  const showToast = useRM((s) => s.showToast);
  const s = solarSummaryOf(solar);

  return (
    <div>
      <Muted className="mb-3">Pulls Google&apos;s 3D roof model for this building: total roof area, footprint, and every roof plane with its pitch. Covers most US homes.</Muted>
      <div className="flex flex-wrap gap-2">
        <Btn variant="primary" disabled={!location || busy.solar} onClick={() => void runSolar()}>
          {busy.solar && <Loader2 className="h-4 w-4 animate-spin" />}Get roof data
        </Btn>
        <Btn variant="primary" disabled={!solar || busy.auto} title="Builds every facet and line automatically from Google's roof height model" onClick={() => void runAutoTrace()}>
          {busy.auto && <Loader2 className="h-4 w-4 animate-spin" />}{busy.auto ? 'Tracing...' : 'Auto-trace roof'}
        </Btn>
        <Btn disabled={!location || busy.scan} title="Probes 24 points around the pin to find detached garages, sheds and pool houses (24 Solar API lookups)" onClick={() => void scanForStructures()}>
          {busy.scan ? 'Scanning...' : 'Scan for other structures'}
        </Btn>
      </div>
      <div className="mt-1"><Check checked={showSolar} onChange={setShowSolar}>Show planes on map</Check></div>
      {busy.solar && !s && <Out><span className="text-gray-500">Fetching roof model...</span></Out>}
      {error && <Out><span className="text-red-600">{error}</span></Out>}
      {(s || otherSolar.length > 0) && (
        <Out testId="solar-out">
          {s && (
            <>
              <Kpis items={[{ v: fmt(s.total), l: 'roof sq ft' }, { v: fmt(s.total / 100, 1), l: 'squares' }, { v: pitchLabel(Math.round(s.predominant)), l: 'main pitch' }]} />
              <div className="text-xs text-gray-500">Footprint {fmt(s.ground)} sq ft · {s.segs.length} planes · imagery {s.imageryDate || '?'} ({(s.quality || '').toLowerCase()})</div>
              <div className="my-2">
                <Btn small onClick={() => { const p = Math.round(s.predominant); setDefaultPitch(p); showToast(`Default pitch set to ${pitchLabel(p)}`); }}>
                  Use {pitchLabel(Math.round(s.predominant))} as default pitch
                </Btn>
              </div>
              <table className={tableCls}>
                <thead><tr><th>#</th><th>Pitch</th><th>Faces</th><th className={numCls}>Sq ft</th></tr></thead>
                <tbody>
                  {s.segs.map((g, i) => (
                    <tr key={i}><td>{i + 1}</td><td>{pitchLabel(Math.round(g.pitch))} <span className="text-gray-400">({fmt(g.pitchDeg, 1)}&deg;)</span></td><td>{compassDir(g.az)}</td><td className={numCls}>{fmt(g.area)}</td></tr>
                  ))}
                  <tr className="border-t border-gray-200 font-semibold"><td colSpan={3}>Total</td><td className={numCls}>{fmt(s.total)}</td></tr>
                </tbody>
              </table>
            </>
          )}
          {otherSolar.length > 0 ? (
            <>
              <H4>Other structures on the lot</H4>
              <div className="flex flex-col gap-1">
                {otherSolar.map((o, i) => {
                  const q = solarSummaryOf(o);
                  return (
                    <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs">
                      <Swatch color="#ff7a00" />
                      <span className="font-semibold">#{i + 2}</span>
                      <span>{q ? pitchLabel(Math.round(q.predominant)) : ''}</span>
                      <span className="ml-auto truncate text-gray-500">{q ? `${fmt(q.total)} sf roof · ${fmt(q.ground)} sf footprint` : 'no data'}</span>
                      <Btn small variant="ghost" onClick={() => { if (o.center) getController()?.panTo({ lat: o.center.latitude, lng: o.center.longitude }, 21); }}>Zoom</Btn>
                    </div>
                  );
                })}
              </div>
              <Muted className="mt-1.5">Orange boxes on the map. Trace each one with the Facet tool; it is reported as its own structure.</Muted>
            </>
          ) : s ? (
            <Muted className="mt-2">Only the main building was returned. Use <b>Scan for other structures</b> to look for sheds, detached garages and pool houses around it.</Muted>
          ) : null}
        </Out>
      )}
    </div>
  );
}
