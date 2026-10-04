import type { RoofMeasurements } from '@/types';
import { round2 } from '@/lib/roof-report';

// Reads measurements out of Roof Measure (public/tools/roof-measure, copied
// unmodified from github.com/musab-creator/roof-measure) while it runs in a
// same-origin iframe.
//
// Roof Measure is plain scripts, so its top-level functions are properties of
// the frame's window. We only call two of them, both read-only:
//   computeTotals() - the same totals its sidebar summary and report print
//   serialize()     - the same object its "Export JSON" button saves
// and drive its own address box and Go button for prefill. If the tool is
// updated and these names change, readRoofMeasure() reports that clearly.

export const ROOF_MEASURE_URL = '/tools/roof-measure/index.html';
const KEY_STORAGE = 'rm.key';

interface LineTotal { plan: number; true: number; count: number }
interface RMTotals {
  sloped: number;
  pitched: number;
  flat: number;
  twoStory: number;
  facetCount: number;
  predominant: number | null;
  recWaste: number;
  byType: Record<'eave' | 'rake' | 'valley' | 'hip' | 'ridge' | 'wall' | 'step', LineTotal>;
}
interface RMSaved { address?: string; jobName?: string; defaultPitch?: number; facets?: unknown[] }
type RMWindow = Window & { computeTotals?: () => RMTotals; serialize?: () => RMSaved };

export interface RoofMeasureResult {
  address: { address: string; city: string; state: string; zip: string } | null;
  measurements: RoofMeasurements;
}

// Roof Measure's "Report summary" numbers, in the CRM's field names.
export function totalsToMeasurements(t: RMTotals, defaultPitch = 6): RoofMeasurements {
  const bt = t.byType;
  return {
    totalSqFt: round2(t.sloped),
    pitchedSqFt: round2(t.pitched),
    flatSqFt: round2(t.flat),
    twoStorySqFt: round2(t.twoStory),
    pitch: t.predominant ?? defaultPitch,
    facets: t.facetCount,
    eaves: round2(bt.eave.true),
    rakes: round2(bt.rake.true),
    valleys: round2(bt.valley.true),
    hipsRidges: round2(bt.hip.true + bt.ridge.true),
    eavesRakes: round2(bt.eave.true + bt.rake.true),
    flashing: round2(bt.wall.true + bt.step.true),
    penetrations: null, // Roof Measure does not count pipes or vents
    wastePct: t.recWaste, // its Roofr-method recommendation
  };
}

// "123 Main St, Jacksonville, FL 32256, USA" -> parts
export function splitAddress(full: string) {
  const parts = full.split(',').map((p) => p.trim()).filter((p) => p && !/^USA?$/i.test(p));
  const stateZip = (parts[2] || '').match(/^([A-Za-z]{2})\s*(\d{5})?/);
  return {
    address: parts[0] || '',
    city: parts[1] || '',
    state: stateZip ? stateZip[1].toUpperCase() : 'FL',
    zip: stateZip?.[2] || '',
  };
}

export function readRoofMeasure(frame: HTMLIFrameElement | null): RoofMeasureResult {
  const w = frame?.contentWindow as RMWindow | null | undefined;
  if (!w || typeof w.computeTotals !== 'function' || typeof w.serialize !== 'function') {
    throw new Error('Roof Measure is still loading (or its computeTotals / serialize functions were renamed).');
  }
  const saved = w.serialize();
  if (!saved.facets || saved.facets.length === 0) {
    throw new Error('No roof traced yet. Use "Get roof data" then "Auto-trace roof", or trace facets by hand, first.');
  }
  const totals = w.computeTotals();
  if (!(totals.sloped > 0)) throw new Error('The traced roof has no area yet.');
  const coords = /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(saved.address || '');
  return {
    address: saved.address && !coords ? splitAddress(saved.address) : null,
    measurements: totalsToMeasurements(totals, saved.defaultPitch),
  };
}

// Puts a deployment-wide Google Maps key into Roof Measure's own storage slot
// when the browser has none yet. A key the user saved in the tool always wins.
export function seedRoofMeasureKey() {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) return;
  try {
    if (!localStorage.getItem(KEY_STORAGE)) localStorage.setItem(KEY_STORAGE, key);
  } catch {
    /* storage blocked: the tool asks for a key itself */
  }
}

// Types the address and job name into Roof Measure and presses its Go button
// once its map is up. Returns a cancel function.
export function prefillRoofMeasure(frame: HTMLIFrameElement, address: string, jobName: string) {
  let tries = 0;
  const timer = setInterval(() => {
    const doc = frame.contentDocument;
    const addr = doc?.getElementById('address') as HTMLInputElement | null;
    const job = doc?.getElementById('jobName') as HTMLInputElement | null;
    if (!doc || !addr) return;
    if (tries === 0) {
      addr.value = address;
      if (job && jobName) {
        job.value = jobName;
        job.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    tries++;
    // Its Go button does nothing until Google Maps has drawn the map.
    if (doc.querySelector('#map .gm-style')) {
      (doc.getElementById('btnGo') as HTMLButtonElement | null)?.click();
      clearInterval(timer);
    } else if (tries > 60) clearInterval(timer); // no key / no map: the address stays typed in
  }, 500);
  return () => clearInterval(timer);
}
