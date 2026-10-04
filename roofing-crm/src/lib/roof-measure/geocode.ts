import type { LatLng } from './geo';

// Address lookups behind the address box and the house pin (the non-UI
// parts of the tool's autocomplete.js and pin.js): Google Places (New)
// suggestions with Esri's free World geocoder as the fallback, forward and
// reverse geocoding, and the "lat, lng" input form.

export interface AddressSuggestion { text: string; src: 'google' | 'arcgis'; placeId?: string; main?: string; magicKey?: string }
export interface GeocodedPlace { location: LatLng; address: string }

const ESRI = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';
const PLACES = 'https://places.googleapis.com/v1';
export const DEFAULT_CENTER: LatLng = { lat: 30.33, lng: -81.66 }; // Jacksonville, when no map centre is known

const LATLNG_RE = /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/;
// "30.33, -81.66" typed into the address box.
export function parseLatLngInput(q: string): LatLng | null {
  const m = q.match(LATLNG_RE);
  return m ? { lat: +m[1], lng: +m[3] } : null;
}
// When the box should offer suggestions at all (3+ characters, not coordinates).
export const wantsSuggestions = (text: string) => text.trim().length >= 3 && !LATLNG_RE.test(text.trim());
// Label for a point with no street address.
export const coordsLabel = (loc: LatLng) => `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;

// ------------------------------------------------------------------ Esri (no key)

export async function esriSuggest(text: string, near?: LatLng | null, fetchImpl: typeof fetch = fetch): Promise<AddressSuggestion[]> {
  const q = new URLSearchParams({ text, category: 'Address,Postal', countryCode: 'USA', maxSuggestions: '6', f: 'json' });
  if (near) q.set('location', `${near.lng},${near.lat}`);
  const j = await fetchImpl(`${ESRI}/suggest?` + q).then((r) => r.json());
  return ((j.suggestions || []) as { text: string; magicKey: string }[]).map((s) => ({ text: s.text, magicKey: s.magicKey, src: 'arcgis' as const }));
}

export async function esriFindAddress(text: string, magicKey: string, fetchImpl: typeof fetch = fetch): Promise<GeocodedPlace> {
  const q = new URLSearchParams({ SingleLine: text, magicKey, maxLocations: '1', outFields: 'Match_addr', f: 'json' });
  const j = await fetchImpl(`${ESRI}/findAddressCandidates?` + q).then((r) => r.json());
  const c = j.candidates && j.candidates[0]; if (!c) throw new Error('not found');
  return { location: { lat: c.location.y, lng: c.location.x }, address: c.address || text };
}

// ------------------------------------------------------------------ Google Places (New), REST

// A random session token: one per typing session, cleared after a choice (Google bills per session).
export const newPlacesSessionToken = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

export async function googleSuggest(text: string, apiKey: string, sessionToken: string, near?: LatLng | null, fetchImpl: typeof fetch = fetch): Promise<AddressSuggestion[]> {
  const c = near || DEFAULT_CENTER;
  const r = await fetchImpl(`${PLACES}/places:autocomplete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
    body: JSON.stringify({ input: text, sessionToken, includedRegionCodes: ['us'], locationBias: { circle: { center: { latitude: c.lat, longitude: c.lng }, radius: 50000 } } }),
  });
  if (!r.ok) throw new Error('Places HTTP ' + r.status);
  const j = await r.json();
  type Pred = { placeId: string; text: { text: string }; structuredFormat?: { mainText?: { text: string } } };
  return ((j.suggestions || []) as { placePrediction?: Pred }[]).filter((s) => s.placePrediction).slice(0, 6).map((s) => {
    const p = s.placePrediction!;
    return { text: p.text.text, main: p.structuredFormat && p.structuredFormat.mainText ? p.structuredFormat.mainText.text : '', placeId: p.placeId, src: 'google' as const };
  });
}

export async function googlePlaceLocation(placeId: string, apiKey: string, sessionToken?: string, fetchImpl: typeof fetch = fetch): Promise<GeocodedPlace> {
  const q = sessionToken ? '?sessionToken=' + encodeURIComponent(sessionToken) : '';
  const r = await fetchImpl(`${PLACES}/places/${encodeURIComponent(placeId)}${q}`, { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'location,formattedAddress' } });
  if (!r.ok) throw new Error('Places HTTP ' + r.status);
  const j = await r.json();
  return { location: { lat: j.location.latitude, lng: j.location.longitude }, address: j.formattedAddress || '' };
}

// Suggestions as the tool gets them: Google Places first, Esri when Places fails (not enabled on the key).
export async function suggestAddresses(text: string, opts: { apiKey?: string; sessionToken?: string; near?: LatLng | null; fetch?: typeof fetch } = {}): Promise<{ source: 'google' | 'esri'; items: AddressSuggestion[] }> {
  const f = opts.fetch || fetch;
  if (opts.apiKey) {
    try { return { source: 'google', items: await googleSuggest(text, opts.apiKey, opts.sessionToken || newPlacesSessionToken(), opts.near, f) }; } catch { /* fall back to Esri */ }
  }
  try { return { source: 'esri', items: await esriSuggest(text, opts.near, f) }; } catch { return { source: 'esri', items: [] }; }
}

// Location of a chosen suggestion (null: fall back to plain geocoding of its text).
export async function resolveSuggestion(it: AddressSuggestion, opts: { apiKey?: string; sessionToken?: string; fetch?: typeof fetch } = {}): Promise<GeocodedPlace | null> {
  const f = opts.fetch || fetch;
  try {
    if (it.src === 'google' && it.placeId && opts.apiKey) { const p = await googlePlaceLocation(it.placeId, opts.apiKey, opts.sessionToken, f); return { location: p.location, address: p.address || it.text }; }
    if (it.magicKey) return await esriFindAddress(it.text, it.magicKey, f);
  } catch { /* fall back */ }
  return null;
}

// ------------------------------------------------------------------ Google Geocoding

export interface GeocodeResult { formatted_address: string; types: string[]; geometry: { location_type?: string; location: { lat: number; lng: number } | { lat(): number; lng(): number } } }

const llOf = (l: GeocodeResult['geometry']['location']): LatLng => (typeof l.lat === 'function' ? { lat: (l as { lat(): number }).lat(), lng: (l as { lng(): number }).lng() } : (l as LatLng));

// Address box "Go": coordinates as typed, else the first geocoder result.
export async function geocodeAddress(q: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<GeocodedPlace> {
  const ll = parseLatLngInput(q);
  if (ll) return { location: ll, address: q };
  const r = await fetchImpl(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`);
  const j = await r.json();
  const top = (j.results || [])[0] as GeocodeResult | undefined;
  if (!top) throw new Error(j.error_message || 'No results');
  return { location: llOf(top.geometry.location), address: top.formatted_address };
}

// Best street address among reverse-geocoder results: an exact rooftop street address, then a premise, then any street address.
export function pickReverseAddress(list: GeocodeResult[]): string | null {
  const pick = list.find((r) => r.types.includes('street_address') && r.geometry.location_type === 'ROOFTOP')
    || list.find((r) => r.types.includes('premise') || r.types.includes('subpremise'))
    || list.find((r) => r.types.includes('street_address')) || list[0];
  return pick ? pick.formatted_address : null;
}

export async function reverseAddress(loc: LatLng, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await fetchImpl(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${loc.lat},${loc.lng}&key=${encodeURIComponent(apiKey)}`);
    const j = await r.json();
    return pickReverseAddress((j.results || []) as GeocodeResult[]);
  } catch { return null; }
}

// Locking a house on the map: the exact clicked point plus its street address (or its coordinates).
export async function lockHouse(loc: LatLng, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<GeocodedPlace & { hasAddress: boolean }> {
  const addr = await reverseAddress(loc, apiKey, fetchImpl);
  return { location: loc, address: addr || coordsLabel(loc), hasAddress: !!addr };
}

// Property panel links.
export const streetViewUrl = (loc: LatLng) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${loc.lat},${loc.lng}`;
export const googleEarthUrl = (loc: LatLng) => `https://earth.google.com/web/@${loc.lat},${loc.lng},0a,120d,35y,0h,45t,0r`;

// Arrow-key steering while picking a house: map pan in pixels (Shift = fine).
export const PICK_PAN_STEPS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
export const pickPanPixels = (key: string, shift: boolean): [number, number] | null => { const d = PICK_PAN_STEPS[key]; const s = shift ? 12 : 80; return d ? [d[0] * s, d[1] * s] : null; };
