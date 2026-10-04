/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw storage JSON */
// The estimator store (src/store/estimator.ts): server-render safety,
// first-run seeding, migration from the old embedded estimator, save /
// revision rules, roles, the pricing audit log, and the roof-report handoff
// against the retired embedded-estimator handoff it replaced (kept as
// fixtures/estimator-handoff.ts).
//
//   node --experimental-strip-types src/lib/estimator/__tests__/store.test.ts
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
const { check, checkEqual, finish } = (await import('./check' as string)) as typeof import('./check');

class MemoryStorage {
  data = new Map<string, string>();
  reads = 0;
  getItem(k: string) {
    this.reads++;
    return this.data.has(k) ? (this.data.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
}
const local = new MemoryStorage();
const session = new MemoryStorage();

// ---- server render: importing and reading the store never touches storage ----
const S = (await import('@/store/estimator' as string)) as typeof import('@/store/estimator');
const E = (await import('../index' as string)) as typeof import('../index');
const store = S.useEstimatorStore;
check(typeof (globalThis as any).window === 'undefined', 'test starts without a window');
check(store.getState().estimates.length === 0 && !store.persist.hasHydrated(), 'not hydrated at import');
S.ensureHydrated();
check(!store.persist.hasHydrated(), 'ensureHydrated is a no-op on the server');

// ---- now a browser ----
Object.assign(globalThis, { window: { localStorage: local }, localStorage: local, sessionStorage: session });
const KEY = S.ESTIMATOR_STORE_KEY;
const LEGACY = S.LEGACY_ESTIMATOR_KEY;
const stored = () => JSON.parse(local.getItem(KEY) as string).state;
const rehydrate = () => void store.persist.rehydrate();

const manager = { id: '1', name: 'Mike Johnson', role: 'manager' as const };
const rep = { id: '2', name: 'Sarah Davis', role: 'sales_rep' as const };
const rep2 = { id: '3', name: 'Tom Wilson', role: 'sales_rep' as const };

// First run, nothing saved anywhere: the three sample estimates.
S.ensureHydrated();
check(store.persist.hasHydrated(), 'hydrates in the browser');
{
  const s = store.getState();
  checkEqual(s.estimates.map((e) => e.number), ['DR-1001', 'DR-1002', 'DR-1003'], 'seeded sample numbers');
  check(s.seq === 1004, 'seq after seeding');
  checkEqual(stored().estimates.length, 3, 'seeded data written to crm-estimator-v1');
  const src = (await import('./original-source.mjs' as string)) as { loadOriginal: (o: object) => { original: any } };
  const O = src.loadOriginal({}).original;
  const ei: any = { state: { pricing: O.priceBook(), estimates: [], seq: 1001 } };
  O.seedSamples(ei, () => {});
  checkEqual(
    s.estimates.map((e) => E.estimateTotals(e, s.pricing).sell),
    ei.state.estimates.map((e: any) => O.totals(e, ei.state.pricing).sell),
    'samples price as in the original',
  );
}

// Migration from the old estimator's localStorage.
{
  const legacyEst = E.newEstimate(E.defaultPriceBook(), 1200);
  legacyEst.customer.name = 'Legacy customer';
  legacyEst.roof.sections[0].measured = 25;
  legacyEst.ownerId = 'mgr';
  const legacy = {
    pricing: { roof: { pitchStep: 25 }, version: '2026-09-01' },
    estimates: [legacyEst],
    audit: [{ id: 'a1', at: '2026-09-01T00:00:00Z', who: 'Manager', path: 'roof.pitchStep', before: 20, after: 25 }],
    seq: 1201,
    user: { name: 'Musab', role: 'admin' },
    auth: { pin: '12345' },
    profiles: [{ id: 'p1', name: 'Rep', pin: 'x' }],
    seededReports: true,
  };
  local.clear();
  local.setItem(LEGACY, JSON.stringify(legacy));
  rehydrate();
  const s = store.getState();
  checkEqual(s.estimates, [legacyEst], 'legacy estimates imported unchanged');
  check(s.seq === 1201 && s.audit.length === 1, 'legacy seq and audit imported');
  check(s.pricing.roof.pitchStep === 25 && s.pricing.roof.story2 === 20 && s.pricing.version === '2026-09-01', 'legacy pricing merged over defaults');
  check(!('profiles' in stored()) && !('auth' in stored()), 'PIN and profiles dropped');
  check(local.getItem(LEGACY) !== null, 'legacy key left in place');

  // A later load uses crm-estimator-v1 and ignores the legacy key.
  local.setItem(LEGACY, JSON.stringify({ ...legacy, estimates: [], seq: 5000 }));
  rehydrate();
  check(store.getState().seq === 1201 && store.getState().estimates.length === 1, 'existing CRM data wins over legacy');

  // Legacy state that never seeded and has no estimates gets the samples.
  local.clear();
  local.setItem(LEGACY, JSON.stringify({ pricing: {}, estimates: [], audit: [], seq: 1500 }));
  rehydrate();
  checkEqual(store.getState().estimates.map((e) => e.number), ['DR-1500', 'DR-1501', 'DR-1502'], 'unseeded empty legacy gets samples');

  // Corrupt legacy data is ignored.
  local.clear();
  local.setItem(LEGACY, '{not json');
  rehydrate();
  check(store.getState().estimates.length === 3 && store.getState().seq === 1004, 'corrupt legacy data falls back to samples');
}

// ---- saving and revisions ----
{
  const s = store.getState();
  const draft = s.createEstimate('roof');
  check(draft.number === 'DR-1004' && draft.scope === 'roof', 'createEstimate numbers from seq');
  draft.roof.sections[0].measured = 30;
  const saved = store.getState().saveEstimate(draft, rep);
  check(saved.ownerId === rep.id && saved.ownerName === rep.name, 'new estimate owned by the saving user');
  check(store.getState().seq === 1005 && store.getState().estimates[0].id === draft.id, 'new estimate saved first, seq advanced');
  check(saved.revisions.length === 0, 'no revision on first save');

  const again = store.getState().saveEstimate({ ...saved, customer: { ...saved.customer, name: 'Renamed' } }, manager);
  check(again.revisions.length === 0 && again.ownerId === rep.id, 'no revision when the price is unchanged; owner kept');

  const before = E.estimateTotals(again, store.getState().pricing).sell;
  const edited = E.deepClone(again);
  edited.roof.sections[0].measured = 32;
  const revised = store.getState().saveEstimate(edited, manager);
  const after = E.estimateTotals(revised, store.getState().pricing).sell;
  checkEqual(revised.revisions.map((r) => [r.who, r.from, r.to]), [['Mike Johnson', before, after]], 'price change records a revision');

  let cur = revised;
  for (let i = 0; i < 25; i++) {
    const next = E.deepClone(cur);
    next.roof.sections[0].measured = 33 + i;
    cur = store.getState().saveEstimate(next, manager);
  }
  check(cur.revisions.length === 20, 'revision history keeps the last 20');
  check(store.getState().seq === 1005, 'editing does not advance seq');

  // A cent-and-a-half change is recorded; a 0.4-cent one is not.
  const tiny = E.deepClone(cur);
  tiny.roof.adjustments = [{ label: 'rounding', amount: 0.004 }];
  check(store.getState().saveEstimate(tiny, manager).revisions.length === 20 && store.getState().estimates[0].revisions.at(-1)?.to === cur.revisions.at(-1)?.to, 'sub-half-cent change: no revision');

  // Roles.
  const repOwn = store.getState().estimates.filter((e) => e.ownerId === rep.id).length;
  check(S.visibleEstimates(store.getState().estimates, manager).length === store.getState().estimates.length, 'manager sees all');
  check(S.visibleEstimates(store.getState().estimates, rep).length === repOwn && repOwn === 1, 'rep sees own');
  check(S.visibleEstimates(store.getState().estimates, rep2).length === 0 && S.visibleEstimates(store.getState().estimates, null).length === 0, 'other rep / signed out see none');
  check(store.getState().openEstimate(saved.id, rep2) === null && store.getState().openEstimate(saved.id, rep)?.id === saved.id, 'open respects ownership');

  // Duplicate, status, delete.
  const dup = store.getState().duplicateEstimate(saved.id, rep2);
  check(!!dup && dup.number === 'DR-1005' && dup.status === 'draft' && dup.ownerId === rep2.id && dup.id !== saved.id, 'duplicate is a new draft');
  check(store.getState().seq === 1006, 'duplicate reserves a number');
  store.getState().setEstimateStatus(saved.id, 'sent');
  check(store.getState().estimates.find((e) => e.id === saved.id)?.status === 'sent', 'status set');
  store.getState().deleteEstimate(saved.id);
  check(!store.getState().estimates.some((e) => e.id === saved.id), 'deleted');
  check(stored().estimates.length === store.getState().estimates.length, 'changes persisted');
}

// ---- pricing and audit ----
{
  const st = store.getState();
  check(st.updatePricing('roof.pitchStep', 30, manager) === true, 'pricing change applied');
  check(store.getState().pricing.roof.pitchStep === 30, 'pricing updated');
  const entry = store.getState().audit[0];
  check(entry.path === 'roof.pitchStep' && entry.before === 20 && entry.after === 30 && entry.who === 'Mike Johnson', 'audit entry');
  check(store.getState().updatePricing('roof.pitchStep', '30', manager) === false, 'same value (as text) is not a change');
  for (let i = 0; i < 520; i++) store.getState().updatePricing('cost.dumpster', 500 + i, manager);
  check(store.getState().audit.length === 500, 'audit capped at 500');
  store.getState().resetPricing(manager);
  checkEqual(store.getState().pricing, E.defaultPriceBook(), 'pricing reset');
  check(store.getState().audit[0].path === '(all pricing rules)', 'reset logged');

  const backup = store.getState().exportBackup();
  const count = store.getState().estimates.length;
  store.getState().importBackup(JSON.stringify({ app: 'DR Estimator', v: '2.0', state: { pricing: { roof: { permit: 400 } }, estimates: [], audit: [], seq: 2000, auth: { pin: 'x' } } }));
  check(store.getState().pricing.roof.permit === 400 && store.getState().seq === 2000 && store.getState().estimates.length === 0, 'old-format backup imported');
  store.getState().importBackup(backup);
  check(store.getState().estimates.length === count, 'own backup round-trips');
  let threw = false;
  try {
    store.getState().importBackup('{"x":1}');
  } catch {
    threw = true;
  }
  check(threw, 'non-backup rejected');
}

// ---- roof report handoff vs estimator-handoff.ts ----
{
  const H = (await import('./fixtures/estimator-handoff.ts' as string)) as typeof import('./fixtures/estimator-handoff');
  const reports: any[] = [
    {
      id: 'r1', address: '1923 Sterling Lane', city: 'Fernandina Beach', state: 'FL', zip: '32034', source: 'roofr',
      fileName: 'Roof Report - 1923 Sterling Lane.pdf', simulated: true, createdAt: '2026-07-20T12:00:00Z', createdBy: '1', estimates: [],
      measurements: { totalSqFt: 2802, pitchedSqFt: 2197, flatSqFt: 605, twoStorySqFt: 300, pitch: 6.4, facets: 9, eaves: 188.58, rakes: 79.67,
        valleys: 41.17, hipsRidges: 150.25, eavesRakes: 268.25, flashing: 40.5, penetrations: null, wastePct: 12 },
    },
    {
      id: 'r2', address: '2322 West Clovelly Lane', city: 'St. Augustine', state: '', zip: '32092', source: 'gaf_quickmeasure', orderId: 'QM-77',
      createdAt: '2026-04-27T12:00:00Z', createdBy: '1', estimates: [],
      measurements: { totalSqFt: 4697, pitchedSqFt: 4697, flatSqFt: 0, twoStorySqFt: 0, pitch: 7, facets: 18, eaves: 338, rakes: 111,
        valleys: 108, hipsRidges: 270, eavesRakes: 449, flashing: 0, penetrations: 2, wastePct: 15 },
    },
    {
      id: 'r3', address: '9 Oak Ct', city: '', state: 'GA', zip: '', source: 'roof_measure', createdAt: '2026-09-01T12:00:00Z', createdBy: '1',
      estimates: [], measurements: { totalSqFt: 1800, pitchedSqFt: 0, flatSqFt: 40, twoStorySqFt: 0, pitch: 14, facets: 4, eaves: 0, rakes: 0,
        valleys: 0, hipsRidges: 60, eavesRakes: 0, flashing: 0, penetrations: 0, wastePct: 12 },
    },
  ];
  const volatile = new Set(['id', 'createdAt', 'updatedAt', 'date', 'ownerId', 'ownerName']);
  const normalize = (x: any) => JSON.parse(JSON.stringify(x), (k, v) => (volatile.has(k) ? '<v>' : v));
  for (const report of reports) {
    const customer = { name: report.id === 'r2' ? '' : 'Jordan Moore', phone: '9045550100' };
    local.clear();
    H.sendReportToEstimator(report, customer);
    const legacyState = JSON.parse(local.getItem(LEGACY) as string);
    const theirs = legacyState.estimates[0];

    rehydrate(); // fresh CRM store: samples DR-1001..1003, next is DR-1004
    const { id, number } = S.createEstimateFromRoofReport(report, customer, manager);
    const mine = store.getState().estimates.find((e) => e.id === id);
    check(number === store.getState().estimates[0].number && mine?.ownerId === manager.id, `${report.id}: saved first, owned by the user`);
    checkEqual(normalize({ ...mine, number: '<n>' }), normalize({ ...theirs, number: '<n>' }), `${report.id}: same estimate as the old handoff`);
  }
}

finish('store');
