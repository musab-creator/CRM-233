'use client';

import { useSyncExternalStore } from 'react';
import { computeTotals, type Totals } from '@/lib/roof-measure/measure';
import type { Project } from '@/lib/roof-measure/model';
import { useRM } from './store';

// computeTotals() once per project version, shared by every panel.
const cache = new WeakMap<Project, Totals>();
export function totalsOf(p: Project): Totals {
  let t = cache.get(p);
  if (!t) { t = computeTotals(p); cache.set(p, t); }
  return t;
}
export function useTotals(): Totals {
  return totalsOf(useRM((s) => s.project));
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
