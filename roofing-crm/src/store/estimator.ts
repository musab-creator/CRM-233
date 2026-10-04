import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import type { RoofReport, User } from '@/types';
import type {
  AuditEntry, Estimate, EstimateScope, EstimateStatus, EstimatorData, EstimatorUser, PriceBook,
} from '@/lib/estimator';
import {
  applyTakeoff, deepClone, deepMerge, defaultPriceBook, estimateTotals, FIRST_ESTIMATE_SEQ, getPath, newEstimate,
  newEstimateForScope, newId, round2, roofReportSourceName, sampleEstimates, setPath, takeoffFromRoofReport,
} from '@/lib/estimator';
import { useCRMStore } from '@/store';

// The estimator's saved data: price book, estimates, price-change log and
// the next estimate number, persisted in localStorage["crm-estimator-v1"].
//
// Hydration is manual (skipHydration) so server rendering never touches
// localStorage and the first client render matches the server's. Screens
// call useEstimatorHydrated() and render once it is true; every action
// hydrates first, so an early action can't overwrite saved data.
//
// On the very first load the old embedded estimator's data
// (localStorage["dr_estimator_v1"]) is imported, so estimates made there
// carry over; with no old data, the same three sample estimates the
// estimator always started with are seeded.

export const ESTIMATOR_STORE_KEY = 'crm-estimator-v1';
export const LEGACY_ESTIMATOR_KEY = 'dr_estimator_v1';
const STORE_VERSION = 1;
const AUDIT_LIMIT = 500;
const REVISION_LIMIT = 20;

// ==================== ROLES ====================

// Managers see every estimate, costs and margins; sales reps see only their
// own estimates and selling prices. No user (signed out) sees nothing.
export function isEstimatorManager(user: Pick<EstimatorUser, 'role'> | null | undefined): boolean {
  return user?.role === 'manager';
}

export function visibleEstimates(estimates: Estimate[], user: EstimatorUser | null | undefined): Estimate[] {
  if (!user) return [];
  if (isEstimatorManager(user)) return estimates;
  return estimates.filter((e) => e.ownerId === user.id);
}

function toEstimatorUser(user: User | null | undefined): EstimatorUser | null {
  return user ? { id: user.id, name: user.name, role: user.role } : null;
}

// The signed-in CRM user, as the estimator sees them.
export function currentEstimatorUser(): EstimatorUser | null {
  return toEstimatorUser(useCRMStore.getState().currentUser);
}

const resolveUser = (user: EstimatorUser | null | undefined) => (user === undefined ? currentEstimatorUser() : user);
const displayName = (user: EstimatorUser | null) => user?.name || 'Manager';

// ==================== FIRST-RUN DATA ====================

function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readJson(storage: Storage, key: string): Record<string, unknown> | null {
  try {
    const raw = storage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function seededData(pricing: PriceBook = defaultPriceBook(), seq = FIRST_ESTIMATE_SEQ): EstimatorData {
  const seeded = sampleEstimates(pricing, seq);
  return { pricing, estimates: seeded.estimates, audit: [], seq: seeded.seq };
}

// Converts the old estimator's saved state. Its PIN, rep profiles, theme and
// signed-in user are dropped; CRM accounts replace them.
export function importLegacyState(legacy: Record<string, unknown>): EstimatorData {
  const pricing = deepMerge(defaultPriceBook(), legacy.pricing || {});
  const estimates = Array.isArray(legacy.estimates) ? (legacy.estimates as Estimate[]) : [];
  const audit = Array.isArray(legacy.audit) ? (legacy.audit as AuditEntry[]) : [];
  const seq = Number(legacy.seq) || FIRST_ESTIMATE_SEQ;
  // The old estimator seeded its samples on boot whenever it had no estimates
  // and had not seeded before.
  if (!estimates.length && !legacy.seededReports) return { ...seededData(pricing, seq), audit };
  return { pricing, estimates, audit, seq };
}

function firstRunData(storage: Storage): EstimatorData {
  const legacy = readJson(storage, LEGACY_ESTIMATOR_KEY);
  return legacy ? importLegacyState(legacy) : seededData();
}

// localStorage, read lazily so nothing runs at import or on the server.
const storage: PersistStorage<EstimatorData> = {
  getItem: (name) => {
    const ls = browserStorage();
    if (!ls) return null;
    const saved = readJson(ls, name) as StorageValue<EstimatorData> | null;
    if (saved?.state) return saved;
    const value: StorageValue<EstimatorData> = { state: firstRunData(ls), version: STORE_VERSION };
    ls.setItem(name, JSON.stringify(value));
    return value;
  },
  setItem: (name, value) => {
    try {
      browserStorage()?.setItem(name, JSON.stringify(value));
    } catch (err) {
      // Usually the storage quota (large photo attachments).
      console.error('Could not save estimator data to this browser', err);
    }
  },
  removeItem: (name) => browserStorage()?.removeItem(name),
};

// ==================== STORE ====================

export interface RoofReportCustomer {
  name: string;
  phone?: string;
  email?: string;
}

export interface EstimatorState extends EstimatorData {
  // A blank, unsaved estimate numbered with the next sequence number.
  createEstimate: (scope?: EstimateScope) => Estimate;
  // Saves a new or edited estimate and returns the stored copy. Records a
  // revision when the selling price moved by half a cent or more.
  saveEstimate: (est: Estimate, user?: EstimatorUser | null) => Estimate;
  // A working copy of a saved estimate the user may see, or null.
  openEstimate: (id: string, user?: EstimatorUser | null) => Estimate | null;
  // An unsaved copy of an estimate as a new draft with the next number.
  duplicateEstimate: (id: string, user?: EstimatorUser | null) => Estimate | null;
  deleteEstimate: (id: string) => void;
  setEstimateStatus: (id: string, status: EstimateStatus) => void;
  // Changes one price-book rule by dotted path and logs it. Returns false
  // when the value is unchanged.
  updatePricing: (path: string, value: unknown, user?: EstimatorUser | null) => boolean;
  resetPricing: (user?: EstimatorUser | null) => void;
  exportBackup: () => string;
  importBackup: (json: string) => void;
}

const pickData = (s: EstimatorData): EstimatorData => ({
  pricing: s.pricing,
  estimates: s.estimates,
  audit: s.audit,
  seq: s.seq,
});

export const useEstimatorStore = create<EstimatorState>()(
  persist(
    (set, get) => ({
      pricing: defaultPriceBook(),
      estimates: [],
      audit: [],
      seq: FIRST_ESTIMATE_SEQ,

      createEstimate: (scope = 'both') => {
        ensureHydrated();
        return newEstimateForScope(get().pricing, get().seq, scope);
      },

      saveEstimate: (est, userArg) => {
        ensureHydrated();
        const user = resolveUser(userArg);
        const { pricing, estimates, seq } = get();
        const now = new Date().toISOString();
        const saved = deepClone(est);
        saved.updatedAt = now;
        if (!saved.ownerId) {
          saved.ownerId = user ? user.id : 'mgr';
          saved.ownerName = displayName(user);
        }
        const index = estimates.findIndex((e) => e.id === saved.id);
        if (index < 0) {
          set({ estimates: [saved, ...estimates], seq: seq + 1 });
          return deepClone(saved);
        }
        const previous = estimates[index];
        const before = estimateTotals(previous, pricing).sell;
        const after = estimateTotals(saved, pricing).sell;
        if (Math.abs(before - after) >= 0.005) {
          saved.revisions = (previous.revisions || []).slice(-(REVISION_LIMIT - 1));
          saved.revisions.push({ at: now, who: displayName(user), from: round2(before), to: round2(after) });
        }
        set({ estimates: estimates.map((e, i) => (i === index ? saved : e)) });
        return deepClone(saved);
      },

      openEstimate: (id, userArg) => {
        ensureHydrated();
        const found = visibleEstimates(get().estimates, resolveUser(userArg)).find((e) => e.id === id);
        if (!found) return null;
        const copy = deepClone(found);
        copy.reports = copy.reports || [];
        return copy;
      },

      duplicateEstimate: (id, userArg) => {
        ensureHydrated();
        const user = resolveUser(userArg);
        const { estimates, seq } = get();
        const source = estimates.find((e) => e.id === id);
        if (!source) return null;
        const copy = deepClone(source);
        const now = new Date().toISOString();
        copy.id = newId();
        copy.number = 'DR-' + seq;
        copy.status = 'draft';
        copy.ownerId = user ? user.id : 'mgr';
        copy.ownerName = displayName(user);
        copy.date = now.slice(0, 10);
        copy.createdAt = now;
        // The original reserved the number at duplication time; saving the
        // copy advances the sequence again, as it did there.
        set({ seq: seq + 1 });
        return copy;
      },

      deleteEstimate: (id) => {
        ensureHydrated();
        set({ estimates: get().estimates.filter((e) => e.id !== id) });
      },

      setEstimateStatus: (id, status) => {
        ensureHydrated();
        const now = new Date().toISOString();
        set({ estimates: get().estimates.map((e) => (e.id === id ? { ...e, status, updatedAt: now } : e)) });
      },

      updatePricing: (path, value, userArg) => {
        ensureHydrated();
        const { pricing, audit } = get();
        const before = getPath(pricing, path);
        if (String(before) === String(value)) return false;
        const next = deepClone(pricing);
        setPath(next, path, value);
        const entry: AuditEntry = {
          id: newId(),
          at: new Date().toISOString(),
          who: displayName(resolveUser(userArg)),
          path,
          before,
          after: value,
        };
        set({ pricing: next, audit: [entry, ...audit].slice(0, AUDIT_LIMIT) });
        return true;
      },

      resetPricing: (userArg) => {
        ensureHydrated();
        const entry: AuditEntry = {
          id: newId(),
          at: new Date().toISOString(),
          who: displayName(resolveUser(userArg)),
          path: '(all pricing rules)',
          before: 'custom',
          after: 'defaults',
        };
        set({ pricing: defaultPriceBook(), audit: [entry, ...get().audit].slice(0, AUDIT_LIMIT) });
      },

      // Same file format as the old estimator's "Export backup".
      exportBackup: () => {
        ensureHydrated();
        return JSON.stringify(
          { app: 'DR Estimator', v: '2.0', exported: new Date().toISOString(), state: pickData(get()) },
          null,
          2,
        );
      },

      // Accepts this store's backups and the old estimator's. Replaces everything.
      importBackup: (json) => {
        ensureHydrated();
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object' || !parsed.state) throw new Error('not a backup');
        const state = parsed.state as Partial<EstimatorData>;
        set({
          pricing: deepMerge(defaultPriceBook(), state.pricing || {}),
          estimates: Array.isArray(state.estimates) ? state.estimates : [],
          audit: Array.isArray(state.audit) ? state.audit : [],
          seq: Number(state.seq) || FIRST_ESTIMATE_SEQ,
        });
      },
    }),
    {
      name: ESTIMATOR_STORE_KEY,
      version: STORE_VERSION,
      storage,
      skipHydration: true,
      partialize: (s) => pickData(s),
      merge: (persisted, current) => {
        const saved = persisted as Partial<EstimatorData> | undefined;
        if (!saved) return current;
        return {
          ...current,
          estimates: Array.isArray(saved.estimates) ? saved.estimates : current.estimates,
          audit: Array.isArray(saved.audit) ? saved.audit : current.audit,
          seq: Number(saved.seq) || current.seq,
          // Rules added to the default price book reach books saved before them.
          pricing: deepMerge(defaultPriceBook(), saved.pricing || {}),
        };
      },
    },
  ),
);

// Loads saved data on the client (no-op on the server or once loaded).
export function ensureHydrated(): void {
  if (typeof window === 'undefined') return;
  if (!useEstimatorStore.persist.hasHydrated()) void useEstimatorStore.persist.rehydrate();
}

const subscribeHydration = (cb: () => void) => useEstimatorStore.persist.onFinishHydration(cb);

// True once saved estimator data is loaded. Render estimator screens only
// after this, so server and first client render agree.
export function useEstimatorHydrated(): boolean {
  useEffect(() => {
    ensureHydrated();
  }, []);
  return useSyncExternalStore(subscribeHydration, () => useEstimatorStore.persist.hasHydrated(), () => false);
}

// The signed-in CRM user as an estimator user (null when signed out).
export function useEstimatorUser(): EstimatorUser | null {
  const user = useCRMStore((s) => s.currentUser);
  return useMemo(() => toEstimatorUser(user), [user]);
}

// Estimates the signed-in user may see (all for managers, own for reps).
export function useVisibleEstimates(): Estimate[] {
  const estimates = useEstimatorStore((s) => s.estimates);
  const user = useEstimatorUser();
  return useMemo(() => visibleEstimates(estimates, user), [estimates, user]);
}

// ==================== ROOF REPORT HANDOFF ====================

// Builds an estimate from a CRM roof report, the way the estimator's
// "Apply to this estimate" does, and saves it. Replaces the old
// sendReportToEstimator() handoff into the embedded estimator.
export function createEstimateFromRoofReport(
  report: RoofReport,
  customer: RoofReportCustomer,
  user: EstimatorUser | null = currentEstimatorUser(),
): { id: string; number: string } {
  ensureHydrated();
  const { pricing, seq, saveEstimate } = useEstimatorStore.getState();
  const est = newEstimate(pricing, seq);
  Object.assign(est.customer, {
    name: customer.name || report.address,
    address: report.address,
    city: report.city,
    state: report.state || 'FL',
    zip: report.zip,
    phone: customer.phone || '',
    email: customer.email || '',
  });
  const from = roofReportSourceName(report);
  // The customer's address comes from the report record, not the takeoff text.
  applyTakeoff(est, pricing, takeoffFromRoofReport(report), { from, fillAddress: false });
  const m = report.measurements;
  est.costs.notes = [
    `Built from the CRM roof report (${from}, ${report.createdAt.slice(0, 10)}).`,
    report.simulated
      ? 'SIMULATED measurements from a mocked provider — do not send this estimate until a real report replaces them.'
      : '',
    m.penetrations === null ? 'Penetrations not on the report — do the aerial count before sending.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const saved = saveEstimate(est, user);
  return { id: saved.id, number: saved.number };
}
