// City of Jacksonville JAXEPICS permit search relay for the native Roof
// Measure engine (src/lib/roof-measure/permits.ts). The city's API only
// answers browser requests from its own site, so the three calls the tool's
// permits.js makes are relayed here. Fixed target and fixed paths only — not
// an open proxy:
//   GET  ?op=columns                 -> GET  /api/AdvancedSearches/GetColumns/82
//   POST ?op=advanced  (JSON body)   -> POST /api/AdvancedSearches/Advanced?page=1&pageSize=500&...
//   POST ?op=address&page=N&term=... -> POST /api/Searches/Permits/AddressSearch?page=N&pageSize=100&...
const API = 'https://jaxepicsapi.coj.net/api/';
const SITE = 'https://jaxepics.coj.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MAX_BODY = 20_000;
const MAX_RESPONSE = 5_000_000;

const fail = () => Response.json({ error: 'relay failed' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });

async function relay(url: string, init: RequestInit) {
  const r = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), 'User-Agent': UA, Accept: 'application/json', Origin: SITE, Referer: SITE + '/' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  if (text.length > MAX_RESPONSE) throw new Error('too large');
  return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  try {
    if (new URL(request.url).searchParams.get('op') !== 'columns') throw new Error('bad op');
    return await relay(API + 'AdvancedSearches/GetColumns/82', { method: 'GET' });
  } catch {
    return fail();
  }
}

export async function POST(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const op = params.get('op');
    const body = await request.text();
    if (body.length > MAX_BODY) throw new Error('too large');
    JSON.parse(body || '{}'); // JSON only
    const json = { 'Content-Type': 'application/json' };
    if (op === 'advanced') {
      return await relay(API + 'AdvancedSearches/Advanced?page=1&pageSize=500&filter=&sortActive=DateIssued&sortDirection=desc&forSpreadSheet=false', { method: 'POST', headers: json, body });
    }
    if (op === 'address') {
      const page = Number(params.get('page') || '1');
      const term = (params.get('term') || '').trim();
      if (!Number.isInteger(page) || page < 1 || page > 5 || !term || term.length > 120) throw new Error('bad search');
      return await relay(`${API}Searches/Permits/AddressSearch?page=${page}&pageSize=100&filter=&sortActive=Title&sortDirection=desc&forSpreadSheet=false&SearchTerm=${encodeURIComponent(term)}`, { method: 'POST', headers: json, body: '{}' });
    }
    throw new Error('bad op');
  } catch {
    return fail();
  }
}
