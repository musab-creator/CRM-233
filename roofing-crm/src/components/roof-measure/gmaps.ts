// Loads the Google Maps JavaScript API once per page (same URL and libraries
// as the original tool). Resolves immediately when google.maps is already on
// the page (a test stand-in, or a previous load).

type MapsWindow = Window & { google?: { maps?: unknown }; __rmMapsReady?: () => void; gm_authFailure?: () => void };

let pending: Promise<void> | null = null;
let loadedKey: string | null = null;

export const mapsLoaded = () => typeof window !== 'undefined' && !!(window as MapsWindow).google?.maps;
export const mapsKey = () => loadedKey;

export function loadGoogleMaps(key: string, onAuthFailure: () => void): Promise<void> {
  const w = window as MapsWindow;
  w.gm_authFailure = onAuthFailure;
  if (mapsLoaded()) { loadedKey = loadedKey || key; return Promise.resolve(); }
  if (pending) return pending;
  loadedKey = key;
  pending = new Promise<void>((resolve, reject) => {
    w.__rmMapsReady = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry&v=weekly&loading=async&callback=__rmMapsReady`;
    s.async = true;
    s.onerror = () => { pending = null; loadedKey = null; s.remove(); reject(new Error('Could not load Google Maps. Check the API key and that Maps JavaScript API is enabled.')); };
    document.head.appendChild(s);
  });
  return pending;
}
