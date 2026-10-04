'use client';

import { useCallback, useEffect, useRef } from 'react';
import { deepClone, type Estimate } from '@/lib/estimator';
import { useEstimatorStore } from '@/store/estimator';
import { useWorkingEstimate } from '../useWorkingEstimate';
import { toast } from './feedback';

// useWorkingEstimate plus what the estimate pages share:
//
// - Unsaved edits follow you between this estimate's Combined, Roof and
//   Gutter pages, the way the original kept one open estimate across its
//   screens. They live in memory (this tab) until saved or discarded; a draft
//   is dropped if the saved estimate changed underneath it.
// - Save shows a toast; Ctrl/Cmd+S saves; closing or reloading the tab with
//   unsaved changes asks first.

interface Draft {
  base: string; // updatedAt of the saved estimate the draft started from
  est: Estimate;
}

const drafts = new Map<string, Draft>();

export function discardDraft(id: string) {
  drafts.delete(id);
}

export function hasDraft(id: string) {
  return drafts.has(id);
}

export function useEstimateWorkspace(id: string) {
  const w = useWorkingEstimate(id);
  const { est, dirty, edit } = w;
  const savedUpdatedAt = useEstimatorStore((s) => s.estimates.find((e) => e.id === id)?.updatedAt);
  const restored = useRef(false);

  // Bring back unsaved edits made on another page of this estimate.
  useEffect(() => {
    if (!est || restored.current) return;
    restored.current = true;
    const d = drafts.get(id);
    if (!d) return;
    if (d.base !== savedUpdatedAt) {
      drafts.delete(id);
      return;
    }
    edit((draft) => {
      Object.assign(draft, deepClone(d.est));
    });
  }, [est, id, savedUpdatedAt, edit]);

  useEffect(() => {
    if (dirty && est && savedUpdatedAt && restored.current) drafts.set(id, { base: savedUpdatedAt, est });
  }, [dirty, est, id, savedUpdatedAt]);

  const saveRaw = w.save;
  const save = useCallback(() => {
    const stored = saveRaw();
    drafts.delete(id);
    if (stored) toast('Saved ' + stored.number);
    return stored;
  }, [saveRaw, id]);

  // Ctrl/Cmd+S.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  // Closing or reloading the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  return { ...w, save };
}

export type EstimateWorkspace = ReturnType<typeof useEstimateWorkspace>;
