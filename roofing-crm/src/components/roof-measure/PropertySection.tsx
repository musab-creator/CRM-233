'use client';

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Crosshair, Search } from 'lucide-react';
import { googleEarthUrl, newPlacesSessionToken, resolveSuggestion, streetViewUrl, suggestAddresses, wantsSuggestions, type AddressSuggestion } from '@/lib/roof-measure/geocode';
import { pFmt, pDate, roofAgeSentence } from '@/lib/roof-measure/permits';
import { useRM } from './store';
import { ensurePermits, getController, goToAddress, lockHouse, setLocation } from './actions';
import { Btn, H4, inputCls, Label, LField, Out } from './ui';

// 1. Property: Google Maps API key, address with suggestions, pick the house on the map, Street View /
// Google Earth links, and permits & roof age.

export function ApiKeyField({ onSave }: { onSave: (key: string) => void }) {
  const apiKey = useRM((s) => s.apiKey);
  const showToast = useRM((s) => s.showToast);
  const [value, setValue] = useState(apiKey);
  const [show, setShow] = useState(false);
  const [seen, setSeen] = useState(apiKey);
  if (apiKey !== seen) { setSeen(apiKey); setValue(apiKey); } // a key loaded after the first render

  const copy = async () => {
    const v = value.trim();
    if (!v) { showToast('No key saved yet', true); return; }
    try { await navigator.clipboard.writeText(v); showToast('API key copied'); } catch { setShow(true); showToast('Press Ctrl+C to copy'); }
  };
  return (
    <div className="mb-3">
      <Label>Google Maps API key</Label>
      <div className="flex flex-wrap gap-1.5">
        <input
          data-testid="api-key" className={`${inputCls} min-w-[10rem] flex-1`} type={show ? 'text' : 'password'} placeholder="Paste API key" autoComplete="off" value={value}
          onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSave(value.trim()); }}
        />
        <div className="flex gap-1.5">
          <Btn variant="ghost" small title="Show or hide the saved key" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</Btn>
          <Btn variant="ghost" small title="Copy the saved key" onClick={copy}>Copy</Btn>
          <Btn variant="primary" small onClick={() => onSave(value.trim())}>Save</Btn>
        </div>
      </div>
      <details className="mt-2 text-xs text-gray-600">
        <summary className="cursor-pointer font-medium text-orange-700">How to get a key (one time, about 5 minutes)</summary>
        <ol className="mt-1.5 list-decimal space-y-1 pl-5 leading-relaxed">
          <li>Go to <b>console.cloud.google.com</b>, create a project, and enable billing. Google includes a monthly free credit that covers typical use.</li>
          <li>APIs &amp; Services &rarr; Library &rarr; enable <b>Maps JavaScript API</b>, <b>Geocoding API</b>, <b>Solar API</b>, and <b>Maps Static API</b> (used for the report photo). <b>Places API (New)</b> is optional: it gives address suggestions (without it they come from Esri&apos;s free geocoder).</li>
          <li>Credentials &rarr; Create credentials &rarr; API key. Under API restrictions, limit it to those APIs. Under website restrictions, allow this CRM&apos;s address.</li>
          <li>Paste the key above and click Save. It is stored only in this browser.</li>
        </ol>
      </details>
    </div>
  );
}

function AddressBox() {
  const addressInput = useRM((s) => s.addressInput);
  const setAddressInput = useRM((s) => s.setAddressInput);
  const apiKey = useRM((s) => s.apiKey);
  const [items, setItems] = useState<AddressSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [source, setSource] = useState<'google' | 'esri'>('esri');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const token = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const close = () => { setItems([]); setActive(-1); };
  const query = async (text: string) => {
    if (!wantsSuggestions(text)) { close(); return; }
    const n = ++seq.current;
    if (!token.current) token.current = newPlacesSessionToken();
    const near = getController()?.center() || null;
    const r = await suggestAddresses(text.trim(), { apiKey, sessionToken: token.current, near });
    if (n !== seq.current || document.activeElement !== input.current) return; // a newer keystroke, or the box lost focus
    setItems(r.items); setSource(r.source); setActive(r.items.length ? 0 : -1);
  };
  const choose = async (i: number) => {
    const it = items[i];
    if (!it) return;
    close();
    setAddressInput(it.text);
    const place = await resolveSuggestion(it, { apiKey, sessionToken: token.current || undefined });
    if (it.src === 'google') token.current = null; // a choice ends the billing session
    if (place) setLocation(place.location, place.address || it.text);
    else void goToAddress(); // fall back to the normal geocoder
  };

  return (
    <div className="relative mb-2">
      <Label>Address (or &quot;lat, lng&quot;)</Label>
      <div className="flex gap-1.5">
        <input
          ref={input} data-testid="address" className={`${inputCls} flex-1`} type="text" placeholder="123 Main St, Jacksonville, FL" autoComplete="off" value={addressInput}
          onChange={(e) => {
            setAddressInput(e.target.value);
            if (timer.current) clearTimeout(timer.current);
            const v = e.target.value;
            timer.current = setTimeout(() => void query(v), 180);
          }}
          onKeyDown={(e) => {
            if (items.length) {
              if (e.key === 'ArrowDown') { setActive((active + 1) % items.length); e.preventDefault(); return; }
              if (e.key === 'ArrowUp') { setActive((active - 1 + items.length) % items.length); e.preventDefault(); return; }
              if (e.key === 'Enter' && active >= 0) { e.preventDefault(); void choose(active); return; }
              if (e.key === 'Escape') { close(); e.preventDefault(); return; }
            }
            if (e.key === 'Enter') { close(); void goToAddress(); }
          }}
          onBlur={() => setTimeout(close, 150)}
        />
        <Btn variant="primary" onMouseDown={close} onClick={() => void goToAddress()} aria-label="Go to address"><Search className="h-4 w-4" />Go</Btn>
      </div>
      {items.length > 0 && (
        <div role="listbox" className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          {items.map((it, i) => (
            <div
              key={i} role="option" aria-selected={i === active}
              className={`cursor-pointer border-b border-gray-100 px-3 py-2.5 text-sm ${i === active ? 'bg-orange-50 text-gray-900' : 'text-gray-700 hover:bg-gray-50'}`}
              onMouseDown={(e) => { e.preventDefault(); void choose(i); }}
            >
              {it.text}
            </div>
          ))}
          <div className="px-3 py-1 text-right text-[10px] text-gray-400">{source === 'google' ? 'powered by Google' : 'suggestions by Esri'}</div>
        </div>
      )}
    </div>
  );
}

function PermitsBlock() {
  const permit = useRM((s) => s.permit);
  const manualAll = useRM((s) => s.permitManual);
  const setPermitManual = useRM((s) => s.setPermitManual);
  const location = useRM((s) => s.project.location);
  const d = permit.data;
  const manual = permit.key ? manualAll[permit.key] || {} : {};
  const sortKey = (p: { issued: string | null; submitted: string | null }) => +(pDate(p.issued || p.submitted) || 0);
  const rows = d ? d.permits.slice().sort((a, b) => sortKey(b) - sortKey(a)).slice(0, 6) : [];
  const save = (patch: { date?: string; number?: string }) => { if (permit.key) setPermitManual(permit.key, { date: manual.date || '', number: manual.number || '', ...patch }); };

  return (
    <>
      <H4>Permits &amp; roof age</H4>
      <Out testId="permit-out">
        {permit.pending && !d ? <span className="text-gray-500">Looking up permits...</span>
          : !d ? <span className="text-gray-500">Enter an address to look up the permit history.</span>
          : (
            <div className="space-y-1.5">
              <div className="font-semibold">{roofAgeSentence(d, manual)}</div>
              <div className="text-xs text-gray-500">{[d.jurisdiction, d.yearBuilt ? 'built ' + d.yearBuilt : null, d.roofCover ? 'roof cover: ' + d.roofCover : null].filter(Boolean).join(' · ')}</div>
              {rows.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs [&_td]:py-0.5 [&_td]:pr-2 [&_th]:pr-2 [&_th]:text-left [&_th]:text-[10px] [&_th]:uppercase [&_th]:text-gray-500">
                    <thead><tr><th>Permit</th><th>Type</th><th>Date</th></tr></thead>
                    <tbody>{rows.map((p) => (
                      <tr key={p.number}><td>{p.link ? <a className="text-orange-700 underline" href={p.link} target="_blank" rel="noopener noreferrer">{p.number}</a> : p.number}</td><td>{p.type}</td><td className="whitespace-nowrap">{pFmt(p.issued || p.submitted)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : d.searched ? <div className="text-xs text-gray-500">No permits found at this address.</div> : null}
              {d.errors.map((e, i) => <div key={'e' + i} className="text-xs text-red-600">{e}</div>)}
              {d.notes.map((n, i) => <div key={'n' + i} className="text-xs text-gray-500">{n}</div>)}
              {d.portal && (
                <div className="text-xs">
                  <a className="text-orange-700 underline" href={d.portal.url} target="_blank" rel="noopener noreferrer">{d.portal.name}</a>
                  {d.paoUrl && <> · <a className="text-orange-700 underline" href={d.paoUrl} target="_blank" rel="noopener noreferrer">Property appraiser record</a></>}
                </div>
              )}
            </div>
          )}
      </Out>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <LField label="Last roof permit date (if not found)">
          <input data-testid="pm-date" type="date" className={inputCls} value={manual.date || ''} disabled={!permit.key} onChange={(e) => save({ date: e.target.value })} />
        </LField>
        <LField label="Permit #">
          <input type="text" className={inputCls} placeholder="optional" value={manual.number || ''} disabled={!permit.key} onChange={(e) => save({ number: e.target.value.trim() })} />
        </LField>
      </div>
      <div className="mt-2">
        <Btn variant="ghost" small disabled={!location} title="Search the city / county permit records again" onClick={() => void ensurePermits(true)}>Look up permits again</Btn>
      </div>
    </>
  );
}

export default function PropertySection({ onSaveKey }: { onSaveKey: (key: string) => void }) {
  const picking = useRM((s) => s.picking);
  const setPicking = useRM((s) => s.setPicking);
  const location = useRM((s) => s.project.location);
  const mapReady = useRM((s) => s.mapStatus === 'ready');
  return (
    <div>
      <ApiKeyField onSave={onSaveKey} />
      <AddressBox />
      <div className="flex flex-wrap items-center gap-2">
        <Btn
          variant={picking ? 'primary' : 'secondary'} small disabled={!mapReady}
          title="Click the house on the map, or steer with the arrow keys and press Enter"
          onClick={() => setPicking(!picking)}
        >
          <Crosshair className="h-3.5 w-3.5" />{picking ? 'Cancel pick' : 'Pick on map'}
        </Btn>
        {picking && (
          <Btn variant="primary" small title="Lock the house under the + in the middle of the map (Enter)" onClick={() => { const c = getController(); if (c) void lockHouse(c.center()); }}>Lock center</Btn>
        )}
        <span className="text-xs text-gray-500">or double-click a house on the map</span>
      </div>
      {location && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <a className="inline-flex min-h-9 items-center gap-1 text-orange-700 hover:underline" href={streetViewUrl(location)} target="_blank" rel="noopener noreferrer">Street View <ExternalLink className="h-3 w-3" /></a>
          <a className="inline-flex min-h-9 items-center gap-1 text-orange-700 hover:underline" href={googleEarthUrl(location)} target="_blank" rel="noopener noreferrer">Google Earth 3D <ExternalLink className="h-3 w-3" /></a>
        </div>
      )}
      <PermitsBlock />
    </div>
  );
}
