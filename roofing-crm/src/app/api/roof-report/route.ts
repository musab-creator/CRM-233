import { NextRequest, NextResponse } from 'next/server';
import { extractText, getDocumentProxy } from 'unpdf';
import { defaultWaste, emptyMeasurements, parseRoofReportText, round2 } from '@/lib/roof-report';

// Roof measurement reports.
//
// POST multipart/form-data { file }  -> reads a Roofr, GAF QuickMeasure or
//   EagleView PDF and returns its measurements. This path is real, not mocked.
//
// POST JSON { action: 'order', provider: 'eagleview', address, city, state, zip }
//   -> orders a report. MOCKED: returns simulated measurements flagged
//   `simulated: true`. Roofr and GAF QuickMeasure publish no ordering API, so
//   their reports come in through the PDF upload above.
//
//   In production (EagleView REST API, https://restdoc.eagleview.com):
//   1. OAuth2: exchange EAGLEVIEW_CLIENT_ID / EAGLEVIEW_CLIENT_SECRET for a
//      bearer token (tokens last 24h, refresh tokens 30 days).
//   2. Place a measurement order for the address; EagleView returns a report id.
//   3. Poll the order-status methods until the report is complete (reports are
//      produced by EagleView, not instantly).
//   4. Retrieve the report file and run it through the PDF parser above.
//   Sandbox host: https://sandbox.apicenter.eagleview.com

const MAX_PDF_BYTES = 15 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const type = request.headers.get('content-type') || '';
  try {
    if (type.includes('multipart/form-data')) return await parseUpload(request);
    return await orderReport(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Roof report error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function parseUpload(request: NextRequest) {
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: 'PDF is over 15 MB' }, { status: 413 });
  }

  const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
  const { text } = await extractText(pdf, { mergePages: true });
  const parsed = parseRoofReportText(text);

  if (!parsed.ok) {
    return NextResponse.json(
      {
        error:
          'No measurements found. Supported: Roofr, GAF QuickMeasure and EagleView report PDFs. Scanned (image-only) PDFs have no text to read — enter the numbers manually.',
      },
      { status: 422 },
    );
  }
  return NextResponse.json({ success: true, fileName: file.name, ...parsed });
}

async function orderReport(request: NextRequest) {
  const { action, provider, address } = await request.json();
  if (action !== 'order' || provider !== 'eagleview') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
  if (!address) {
    return NextResponse.json({ error: 'Address is required' }, { status: 400 });
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Deterministic per address so re-ordering the same house gives the same numbers.
  let h = 5381;
  for (const c of String(address)) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  const rand = (min: number, max: number) => {
    h = (h * 1103515245 + 12345) | 0;
    return min + (Math.abs(h) % 1000) / 1000 * (max - min);
  };

  const m = emptyMeasurements();
  m.totalSqFt = Math.round(rand(1800, 4200));
  m.pitchedSqFt = m.totalSqFt;
  m.pitch = Math.round(rand(4, 9));
  m.facets = Math.round(rand(6, 20));
  m.eaves = round2(Math.sqrt(m.totalSqFt) * rand(2.6, 3.4));
  m.rakes = round2(m.eaves * rand(0.25, 0.5));
  m.valleys = round2(m.facets > 8 ? rand(20, 110) : 0);
  m.hipsRidges = round2(Math.sqrt(m.totalSqFt) * rand(1.6, 2.6));
  m.eavesRakes = round2(m.eaves + m.rakes);
  m.penetrations = Math.round(rand(2, 7));
  m.wastePct = defaultWaste(m.facets);

  return NextResponse.json({
    success: true,
    simulated: true,
    orderId: `EV-${Date.now().toString(36).toUpperCase()}`,
    source: 'eagleview',
    measurements: m,
  });
}
