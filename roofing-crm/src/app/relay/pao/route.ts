import { NextRequest } from 'next/server';

// Roof Measure's Duval County Property Appraiser relay (port of /relay/pao in
// its serve.ps1). The appraiser's site blocks cross-site browser requests, so
// Roof Measure's permit lookup (src/lib/roof-measure/permits.ts) fetches the record
// through here. Fixed target only — not an open proxy.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export async function GET(request: NextRequest) {
  const re = (request.nextUrl.searchParams.get('re') || '').replace(/[^0-9]/g, '');
  try {
    if (re.length < 6 || re.length > 12) throw new Error('bad RE');
    const r = await fetch('https://paopropertysearch.coj.net/Basic/Detail.aspx?RE=' + re, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return new Response(await r.text(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'relay failed' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
