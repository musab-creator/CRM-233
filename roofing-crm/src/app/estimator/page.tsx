'use client';

import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { ESTIMATOR_URL } from '@/lib/estimator-handoff';
import { Calculator, ExternalLink, Ruler } from 'lucide-react';

// The Diversity Roofing Estimator is a self-contained app (public/tools/estimator.html).
// It is framed from the same origin so estimates handed over from a roof
// report (see lib/estimator-handoff.ts) open directly inside it.
export default function EstimatorPage() {
  return (
    <AppShell>
      <div className="flex h-[calc(100vh-7.5rem)] flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Calculator className="h-7 w-7 text-orange-500" />
            <h1 className="text-2xl font-bold text-gray-900">Estimator</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/roof-reports"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Ruler className="h-4 w-4" /> Roof Reports
            </Link>
            <a
              href={ESTIMATOR_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <ExternalLink className="h-4 w-4" /> Full screen
            </a>
          </div>
        </div>
        <iframe
          src={ESTIMATOR_URL}
          title="Diversity Roofing Estimator"
          className="w-full flex-1 rounded-xl border border-gray-200 bg-white shadow-sm"
        />
      </div>
    </AppShell>
  );
}
