// Roof Measure's Clay County permit search relay (port of /relay/clay in its
// serve.ps1). Clay's EnerGov portal blocks cross-site browser requests, so
// Roof Measure (public/tools/roof-measure/permits.js) posts its search here.
// Fixed target only — not an open proxy.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const CLAY_SEARCH = 'https://claycountyfl-energovpub.tylerhost.net/apps/selfservice/api/energov/search/search';

export async function POST(request: Request) {
  try {
    const json = await request.text();
    if (json.length > 20000) throw new Error('too large');
    const r = await fetch(CLAY_SEARCH, {
      method: 'POST',
      body: json,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': UA,
        tenantId: '1',
        tenantName: 'ClayCountyFL',
        'Tyler-TenantUrl': 'ClayCountyFL',
        'Tyler-Tenant-Culture': 'en-US',
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return new Response(await r.text(), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'relay failed' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
