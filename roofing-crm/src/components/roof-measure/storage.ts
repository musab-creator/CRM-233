// localStorage helpers for Roof Measure. Every read and write is guarded:
// storage can be blocked (private mode, quota), and the page must still work.
// The keys are the original tool's, so roofs, company details and the API key
// carry over between the tool and this page.

export const KEYS = {
  apiKey: 'rm.key',
  company: 'rm.company',
  permitManual: 'rm.permitManual',
  comOpts: 'rm.comOpts',
  projects: 'rm.projects',
  mode: 'rm.mode',
  lastLoc: 'rm.lastLoc',
  // The CRM page's own: the roof in progress, restored after a reload.
  autosave: 'crm.roofMeasure.autosave',
} as const;

export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

// Returns false when the browser refused the write (storage full or blocked).
export function writeString(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function writeJSON(key: string, value: unknown): boolean {
  return writeString(key, JSON.stringify(value));
}

export function removeKey(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// Puts a deployment-wide Google Maps key (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) into
// the key slot when this browser has none yet. A key saved in the page wins.
export function seedRoofMeasureKey() {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) return;
  try {
    if (!localStorage.getItem(KEYS.apiKey)) localStorage.setItem(KEYS.apiKey, key);
  } catch {
    /* storage blocked: the page asks for a key itself */
  }
}
