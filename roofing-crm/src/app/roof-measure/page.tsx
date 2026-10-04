'use client';

import { Suspense } from 'react';
import AppShell from '@/components/AppShell';
import RoofMeasureApp, { RoofMeasureFallback } from '@/components/roof-measure/RoofMeasureApp';

// Roof Measure: satellite roof measuring, native in the CRM.
// /roof-measure?leadId=<lead> prefills the lead's address and attaches the roof report to it;
// /roof-measure?address=<text> prefills an address.
export default function RoofMeasurePage() {
  return (
    <AppShell>
      {/* useSearchParams needs a Suspense boundary on a prerendered route */}
      <Suspense fallback={<RoofMeasureFallback />}>
        <RoofMeasureApp />
      </Suspense>
    </AppShell>
  );
}
