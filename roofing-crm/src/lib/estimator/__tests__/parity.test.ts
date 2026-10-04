/* eslint-disable @typescript-eslint/no-explicit-any -- compares against the untyped original */
// Randomized parity test: the port against the ORIGINAL estimator code,
// extracted verbatim from public/tools/estimator.html (see original-source.mjs)
// and run in a vm context. Every case feeds the same estimate + price book to
// both and requires identical results, compared leaf by leaf with Object.is.
//
//   node --experimental-strip-types src/lib/estimator/__tests__/parity.test.ts
//   PARITY_CASES=5000 PARITY_SEED=7 node --experimental-strip-types ...
import { register } from 'node:module';
import vm from 'node:vm';

register('./resolve-ts.mjs', import.meta.url);
const { check, checkEqual, compared, finish } = (await import('./check' as string)) as typeof import('./check');
const E = (await import('../index' as string)) as typeof import('../index');
const src = (await import('./original-source.mjs' as string)) as {
  loadOriginal: (o: { now?: number }) => { original: any; context: vm.Context };
  fixtureMatchesHtml: () => boolean | null;
};

const CASES = Number(process.env.PARITY_CASES) || 1000;
const SEED = Number(process.env.PARITY_SEED) || 20260824;
const NOW = Date.parse('2026-10-04T15:00:00Z');

const matches = src.fixtureMatchesHtml();
check(matches !== false, 'fixture matches the estimator.html bundle');
console.log(matches === null ? '  (estimator.html not present; using the committed extract)' : '  fixture verified against estimator.html');

const { original: O, context } = src.loadOriginal({ now: NOW });

// Inline view computations from the original screens, copied verbatim from
// the bundle (names as minified there: u toNumber, d round2, P totals, $ cost
// structure, T price-for-margin, eY margin tone).
vm.runInContext(
  String.raw`
globalThis.VIEWS = {
  // ts: price scenarios
  scenarios(est, t, e) {
    if (e.sell <= 0) return null;
    let r = $(est, t, e);
    return [-5, 0, 5, 10].map((n) => {
      let a, l = d(e.sell * (1 + n / 100));
      if ("profit" === r.mode) { let e2 = r.direct + (r.overheadRate + r.financingRate) * l; a = d(e2 + r.commRate * Math.max(0, l - e2)); }
      else a = d(r.direct + (r.overheadRate + r.financingRate + r.commRate) * l);
      let s = d(l - a), i = l > 0 ? (s / l) * 100 : 0;
      return { changePct: n, price: l, cost: a, profit: s, margin: i };
    });
  },
  // tr: where the price goes
  breakdown(e) {
    if (e.sell <= 0) return null;
    let t = e.R, r = t.sections.reduce((e, t) => e + t.base, 0), n = t.sections.reduce((e, t) => e + t.pitchAmt + t.storyAmt, 0),
      a = t.sections.reduce((e, t) => e + t.psAmt, 0), l = Math.max(0, e.R.subtotal - r - n - a),
      s = [d(r), d(n), d(a), d(l), d(e.G.subtotal)], i = s.reduce((e, t) => e + t, 0), c = Math.max(0, i - e.sell);
    return { values: s, total: i, overshoot: c };
  },
  // tn: cost / profit split
  split(e) {
    if (e.sell <= 0 || e.totalCost <= 0) return null;
    let t = e.c;
    return { values: [d(u(t.material)), d(u(t.labor)), d(u(t.dumpster) + u(t.permit) + u(t.delivery) + u(t.repairs) + u(t.decking)),
      d(u(t.gutter)), d(u(t.overhead) + u(t.commission) + u(t.financing) + u(t.other)), d(Math.max(0, e.gp))], loss: e.gp < 0 ? -e.gp : 0 };
  },
  // to: actual job cost
  actuals(r, e, t) {
    let n = r.actuals || {}, a = "accepted" === r.status || "completed" === r.status,
      l = ["material", "labor", "other"].reduce((e, t) => e + u(n[t]), 0), s = l > 0, i = d(e.sell - l), c = e.sell > 0 ? (i / e.sell) * 100 : 0;
    return { isClosed: a, hasActuals: s, actualCost: l, kept: i, actualMargin: c, estimatedMargin: e.margin, underEstimate: l <= e.totalCost,
      variance: Math.abs(l - e.totalCost), tone: c >= u(t.targets.minMargin) ? "ok" : "bad" };
  },
  // e5: what it has to sell for
  sellFor(r, t, e) {
    if (!r || e.sell <= 0) return null;
    let n = T(r, t, e, 0), a = T(r, t, e, t.targets.minMargin), l = T(r, t, e, t.targets.goodMargin);
    if (!n || !a || !l) return null;
    return { n, a, l, belowMin: e.sell < a.price, belowGood: e.sell < l.price, perSq: e.R.billable > 0 ? l.perSq : null, perLF: e.G.lf > 0 ? l.perLF : null };
  },
  // e9: margin ladder and per-unit cost table
  ladder(n, t, e) {
    let l = [0, u(t.targets.minMargin), u(t.targets.goodMargin), 50, 60], out = [];
    l.forEach((r) => { let a = T(n, t, e, r); a && out.push({ target: a, covered: e.sell >= a.price }); });
    return out;
  },
  perUnit(n, t, e) {
    let a = $(n, t, e), i = e.sell ? e.totalCost / e.sell : 0, B = e.R.billable, L = e.G.lf;
    let row = (x, ps, pl) => [x, B > 0 ? (ps === undefined ? x / B : ps) : null, L > 0 ? (pl === undefined ? x / L : pl) : null];
    let rows = [row(a.direct), row(e.c.overhead), row(e.c.commission)];
    u(e.c.financing) && rows.push(row(e.c.financing));
    rows.push(row(e.totalCost)); rows.push(row(e.sell, e.effSq, e.effLF));
    return { rows, ratio: i, tone: i <= 0.7 ? "ok" : i <= 0.8 ? "warn" : "bad" };
  },
  // tl: auto column of the internal cost table
  costAutos(e, t) {
    return [e.auto.material, e.auto.labor, e.auto.dumpster, e.auto.permit, e.auto.delivery, e.auto.repairs, e.auto.decking, e.auto.gutter,
      "profit" === t.cost.commissionBasis ? e.c.commission : d((e.sell * u(t.cost.commissionPct)) / 100),
      "flat" === t.cost.overheadBasis ? u(t.cost.overheadFlat) : d((e.sell * u(t.cost.overheadPct)) / 100),
      d((e.sell * u(t.cost.financingPct)) / 100), 0];
  },
  // te: roof section card
  section(e, r) {
    let l = e.mfrs[r.mfr], s = F(e, r), i = S(e, r.mfr, r.tier, r.custom), c = "custom" === r.tier && (i < u(l.min) || i > u(l.max)),
      dd = C(e, r.pitch), h = N(e, r.stories), m = L(e, r, s), g = s * i + s * dd + s * h + m * u(e.roof.peelStick);
    return { total: g, outOfRange: c ? (i < u(l.min) ? "below" : "above") : null };
  },
  // tt: gutter run card
  run(e, r) {
    let a = e.gutter[r.size], l = E(e, r), s = "labor" === r.mode ? l < u(e.gutter.laborOnly.min) : l < u(a.min), i = d(r.lf),
      c = r.guards ? (u(r.guardLF) > 0 ? d(r.guardLF) : i) : 0,
      p = i * l + (r.removal ? i * u(e.gutter.removalLF) : 0) + c * u(e.gutter.guardLF) + (u(r.stories) >= 2 ? i * u(e.gutter.story2LF) : 0) + (r.difficult ? i * u(e.gutter.difficultLF) : 0);
    return { total: p, belowMinimum: s };
  },
  // tI: proposal payment schedule and insurance total
  proposal(n, s) {
    let i = s.ins, m = d((n.sell * u(s.pay.sign)) / 100), v = d((n.sell * u(s.pay.delivery)) / 100), b = d(n.sell - m - v),
      y = d(u(i.acv) + u(i.depreciation) + u(i.deductible) + u(i.upgradesAmt));
    return { m, v, b, y, balancePct: 100 - u(s.pay.sign) - u(s.pay.delivery) };
  },
  // td: dashboard
  dashboard(list, e) {
    let t = list.map((t) => ({ e: t, T: P(t, e) })), r = t.filter((e) => "draft" === e.e.status || "sent" === e.e.status),
      n = t.filter((e) => "accepted" === e.e.status), a = r.reduce((e, t) => e + t.T.sell, 0), l = n.reduce((e, t) => e + t.T.sell, 0),
      s = n.reduce((e, t) => e + t.T.gp, 0), i = t.length ? t.reduce((e, t) => e + t.T.margin, 0) / t.length : 0,
      c = t.filter((t) => t.T.margin < u(e.targets.minMargin) && t.T.sell > 0),
      f = Math.round((Date.now() - new Date(e.version + "T12:00:00").getTime()) / 864e5), g = { draft: 0, sent: 0, accepted: 0, lost: 0 };
    t.forEach((e) => { g[e.e.status] = (g[e.e.status] || 0) + e.T.sell; });
    let v = Object.values(g).reduce((e, t) => e + t, 0);
    return { openCount: r.length, pipeline: a, soldCount: n.length, soldTotal: l, soldProfit: s, soldMargin: l ? (s / l) * 100 : null,
      averageMargin: t.length ? i : null, belowTarget: c.map((x) => x.e.id), seg: [d(g.draft || 0), d(g.sent || 0), d(g.accepted || 0), d(g.lost || 0)],
      statusTotal: v, age: f, stale: f > u(e.targets.staleAfterDays) };
  },
  // tw: estimate vs actual
  vsActual(list, e) {
    return list.filter((e) => { let t = e.actuals || {}; return u(t.material) + u(t.labor) + u(t.other) > 0; }).map((t) => {
      let r = P(t, e), n = t.actuals, a = u(n.material) + u(n.labor) + u(n.other), l = r.sell > 0 ? ((r.sell - a) / r.sell) * 100 : 0;
      return { id: t.id, contract: r.sell, estimatedCost: r.totalCost, actualCost: a, underEstimate: a <= r.totalCost, variance: Math.abs(a - r.totalCost), estimatedMargin: r.margin, actualMargin: l };
    });
  },
};`,
  context,
);
const V = (context as any).VIEWS;

// ---------- seeded random inputs ----------

let state = SEED >>> 0;
function rand(): number {
  // mulberry32
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p: number) => rand() < p;
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const dec = (lo: number, hi: number, places = 2) => Number((lo + rand() * (hi - lo)).toFixed(places));
// Numeric field the way forms and old saves leave them: numbers, numeric
// strings, blanks, junk.
function loose(n: number): any {
  const r = rand();
  if (r < 0.06) return String(n);
  if (r < 0.08) return '';
  if (r < 0.09) return null;
  if (r < 0.095) return 'abc';
  if (r < 0.1) return pick([n + 'abc', ' ' + n + ' ', n.toLocaleString('en-US'), n + '%']); // parseFloat-lenient junk
  return n;
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function randomPricing(): any {
  const p: any = E.defaultPriceBook();
  const scale = (obj: any, key: string, lo = 0.6, hi = 1.5) => {
    if (chance(0.3)) obj[key] = loose(Number((obj[key] * dec(lo, hi, 3)).toFixed(2)));
  };
  for (const m of Object.keys(p.mfrs)) for (const k of ['competitive', 'standard', 'high', 'min', 'max']) scale(p.mfrs[m], k, 0.8, 1.2);
  for (const k of Object.keys(p.roof)) if (typeof p.roof[k] === 'number') scale(p.roof, k);
  for (const k of ['removalLF', 'guardLF', 'story2LF', 'difficultLF', 'miterInside', 'endCap', 'outlet', 'elbow']) scale(p.gutter, k);
  for (const g of ['g6', 'g7']) for (const k of ['sell', 'min']) scale(p.gutter[g], k, 0.8, 1.3);
  for (const k of ['def', 'min']) scale(p.gutter.laborOnly, k);
  for (const k of Object.keys(p.cost)) if (typeof p.cost[k] === 'number') scale(p.cost, k, 0, 2);
  if (chance(0.15)) p.roof.pitchFreeUpTo = pick([4, 5, 7, '6']);
  if (chance(0.25)) p.cost.steepPerSq = dec(0, 8);
  if (chance(0.35)) p.cost.commissionBasis = 'profit';
  if (chance(0.3)) p.cost.commissionPct = pick([10, 25, 50, 0, '15']);
  if (chance(0.3)) p.cost.overheadBasis = 'flat';
  if (chance(0.3)) p.cost.financingPct = pick([0, 2.5, 3, '3.5']);
  if (chance(0.15)) p.cost.overheadPct = pick([0, 10, 35, 60]);
  if (chance(0.25)) p.targets.minMargin = pick([20, 25, 35, '30']);
  if (chance(0.25)) p.targets.goodMargin = pick([35, 45, 50]);
  if (chance(0.25)) p.targets.maxDiscountPct = pick([0, 5, 15]);
  if (chance(0.25)) p.targets.staleAfterDays = pick([30, 365, '90']);
  if (chance(0.4)) p.version = pick(['2026-08-24', '2026-01-02', '2025-06-30', '2026-09-30', '2026-06-06']);
  if (chance(0.1)) p.mfrs.GAF = { label: 'GAF', competitive: 590, standard: 610, high: 640, min: 590, max: 640, products: [], colors: [] };
  return p;
}

function randomEstimate(p: any, seq: number): any {
  const est: any = E.newEstimate(p, seq);
  est.scope = pick(['roof', 'gutter', 'both', 'both']);
  est.status = pick(['draft', 'draft', 'sent', 'accepted', 'lost', 'completed']);
  const mfrs = Object.keys(p.mfrs);
  const nSections = pick([0, 1, 1, 1, 2, 2, 3, 4]);
  est.roof.sections = [];
  for (let i = 0; i < nSections; i++) {
    const s: any = E.newRoofSection(p, i + 1);
    s.measured = loose(pick([0, int(5, 60), dec(0.5, 80), dec(10, 40, 3)]));
    s.waste = loose(pick([0, 10, 12, 14, 15, dec(0, 25)]));
    if (chance(0.15)) s.billableOverride = loose(pick([dec(5, 70), int(1, 50), 0]));
    s.mfr = pick(mfrs);
    s.tier = pick(['competitive', 'standard', 'standard', 'high', 'custom']);
    if (s.tier === 'custom') s.custom = loose(pick([dec(400, 750), int(500, 650), 0]));
    if (chance(0.03) && s.tier !== 'custom') s.mfr = 'NOPE'; // unknown manufacturer prices at $0
    s.pitch = loose(pick([0, 2, 4, 6, 7, 8, 9, 10, 12, dec(3, 12, 1)]));
    s.stories = loose(pick([1, 1, 2, 3, 4, 0]));
    s.psMode = pick(['none', 'none', 'full', 'partial']);
    if (s.psMode === 'partial' || chance(0.1)) s.psSquares = loose(dec(0, 30));
    s.name = chance(0.1) ? '' : s.name;
    est.roof.sections.push(s);
  }
  est.roof.items.forEach((it: any) => {
    it.on = chance(0.4) ? !it.on : it.on;
    if (chance(0.5)) it.qty = loose(pick([0, 1, int(1, 400), dec(0.5, 300)]));
    if (chance(0.2)) it.rate = loose(Number((it.rate * dec(0.5, 1.5)).toFixed(2)));
  });
  const nRuns = pick([0, 1, 1, 2, 3]);
  est.gutter.runs = [];
  for (let i = 0; i < nRuns; i++) {
    const r: any = E.newGutterRun(p, i + 1);
    r.size = pick(['g6', 'g7']);
    r.lf = loose(pick([0, int(20, 400), dec(10, 300)]));
    r.mode = pick(['new', 'new', 'labor', 'material']);
    if (chance(0.2)) r.sellOverride = loose(pick([dec(5, 25), 0]));
    if (r.mode === 'labor') r.laborRate = loose(pick([3, 4, 4.5, 5, dec(2, 7)]));
    r.stories = loose(pick([1, 1, 2, 3]));
    r.difficult = chance(0.3);
    r.removal = chance(0.5);
    r.guards = chance(0.35);
    if (r.guards && chance(0.5)) r.guardLF = loose(pick([dec(10, 200), 0]));
    est.gutter.runs.push(r);
  }
  est.gutter.items.forEach((it: any) => {
    it.on = chance(0.45);
    if (it.k === 'ds') {
      const size = pick(['2x3', '3x4', '4x5']);
      if (chance(0.9)) it.meta = { size, count: loose(int(0, 10)), len: loose(pick([0, 10, 11, 20, dec(8, 25)])) };
      else delete it.meta;
      it.rate = p.gutter.downspouts[size];
      if (chance(0.3)) it.qty = loose(int(0, 50));
    } else if (chance(0.6)) it.qty = loose(pick([0, int(1, 20), dec(1, 150)]));
  });
  const lines = (signed: boolean) =>
    Array.from({ length: pick([0, 0, 1, 2, 3]) }, () => ({
      label: chance(0.2) ? pick(['', '   ']) : pick(['Upgrade', 'Repeat customer', 'Storm special']),
      amount: loose(signed && chance(0.4) ? -dec(0, 2000) : dec(0, 3000)),
    }));
  for (const scope of [est.roof, est.gutter]) {
    scope.upgrades = lines(false);
    scope.discounts = lines(false);
    scope.adjustments = lines(true);
  }
  if (chance(0.3)) {
    est.roof.taxOn = 'total';
    est.roof.taxRate = loose(pick([6, 7, 7.5, dec(0, 9)]));
  }
  if (chance(0.4)) {
    const keys = ['material', 'labor', 'dumpster', 'permit', 'delivery', 'repairs', 'decking', 'gutter', 'other', 'overhead', 'financing', 'commission'];
    for (const k of keys) if (chance(0.2)) est.costs.overrides[k] = pick([0, '', null, dec(0, 9000), String(int(0, 5000)), -dec(0, 300)]);
  }
  if (chance(0.3)) est.actuals = { material: loose(dec(0, 15000)), labor: loose(dec(0, 8000)), other: loose(pick([0, dec(0, 2000)])) };
  if (chance(0.3)) {
    est.proposal.pay = { sign: loose(pick([0, 10, 25])), delivery: loose(pick([50, 40, 0])) };
    est.proposal.ins = { ...est.proposal.ins, acv: loose(dec(0, 20000)), depreciation: loose(dec(0, 5000)), deductible: loose(pick([0, 1000, 2500])), upgradesAmt: '' };
  }
  return est;
}

// ---------- shape mapping (port -> original) ----------

function originalTotals(t: any): any {
  return {
    R: {
      ...t.roof,
      sections: t.roof.sections.map((s: any) => ({
        id: s.id, name: s.name, billable: s.billable, price: s.price, pS: s.pitchSurcharge, sS: s.storySurcharge, psSq: s.psSquares,
        base: s.base, pitchAmt: s.pitchAmt, storyAmt: s.storyAmt, psAmt: s.psAmt, total: s.total, sec: s.section,
      })),
    },
    G: {
      ...t.gutter,
      runs: t.gutter.runs.map((r: any) => ({
        id: r.id, name: r.name, lf: r.lf, rate: r.rate, base: r.base, removal: r.removal, guardLF: r.guardLF, guards: r.guards,
        story: r.story, diff: r.difficult, total: r.total, run: r.run,
      })),
    },
    preTax: t.preTax, tax: t.tax, taxRate: t.taxRate, sell: t.sell, auto: t.autoCosts, c: t.costs, totalCost: t.totalCost,
    gp: t.grossProfit, margin: t.margin, markup: t.markup, effSq: t.effectivePerSquare, effLF: t.effectivePerLF,
    addOns: t.addOns, discounts: t.discounts, adjustments: t.adjustments,
  };
}
const originalWarning = (w: any) => ({ ...(w.managerOnly ? { mgr: 1 } : {}), lv: w.level, t: w.title, d: w.detail });
const originalTarget = (m: any) => m && { margin: m.margin, price: m.price, delta: m.delta, perSq: m.perSquare, perLF: m.perLF };

// ---------- the cases ----------

let caseCount = 0;
let warningCount = 0;
const batch: { est: any; p: any }[] = [];
let pricing = randomPricing();
for (let i = 0; i < CASES; i++) {
  if (i % 10 === 0) pricing = randomPricing();
  const est = randomEstimate(pricing, 1001 + i);
  const label = `case ${i} (seed ${SEED})`;
  const mine = E.estimateTotals(clone(est), clone(pricing));
  const theirs = O.totals(clone(est), clone(pricing));
  checkEqual(originalTotals(mine), theirs, `${label} totals`);

  const myWarnings = E.estimateWarnings(clone(est), clone(pricing), E.estimateTotals(clone(est), clone(pricing)), NOW);
  const theirWarnings = O.warnings(clone(est), clone(pricing), O.totals(clone(est), clone(pricing)));
  warningCount += theirWarnings.length;
  checkEqual(myWarnings.map(originalWarning), theirWarnings, `${label} warnings`);

  const cs = E.costStructure(est, pricing, mine);
  const ocs = O.costStructure(est, pricing, theirs);
  checkEqual(
    { direct: cs.direct, overheadRate: cs.overheadRate, financingRate: cs.financingRate, commRate: cs.commissionRate, mode: cs.mode },
    { direct: ocs.direct, overheadRate: ocs.overheadRate, financingRate: ocs.financingRate, commRate: ocs.commRate, mode: ocs.mode },
    `${label} cost structure`,
  );
  for (const m of [0, pricing.targets.minMargin, pricing.targets.goodMargin, 50, 60, dec(0, 70), 95, '35', '']) {
    checkEqual(originalTarget(E.priceForMargin(est, pricing, mine, m)), O.priceForMargin(est, pricing, theirs, m), `${label} price for ${m}% margin`);
  }

  // View-level computations.
  const scen = E.priceScenarios(est, pricing, mine);
  checkEqual(scen, V.scenarios(est, pricing, theirs), `${label} price scenarios`);
  const bd = E.priceBreakdown(mine);
  const obd = V.breakdown(theirs);
  checkEqual(bd && { values: bd.segments.map((s) => s.value), total: bd.total, overshoot: bd.overshoot }, obd, `${label} price breakdown`);
  const sp = E.costProfitSplit(mine);
  checkEqual(sp && { values: sp.segments.map((s) => s.value), loss: sp.loss }, V.split(theirs), `${label} cost/profit split`);
  checkEqual(E.jobActuals(est, mine, pricing), V.actuals(est, theirs, pricing), `${label} job actuals`);
  const sf = E.sellForTargets(est, pricing, mine);
  const osf = V.sellFor(est, pricing, theirs);
  checkEqual(
    sf && { n: originalTarget(sf.breakEven), a: originalTarget(sf.atMin), l: originalTarget(sf.atGood), belowMin: sf.belowMin, belowGood: sf.belowGood, perSq: sf.perSquareAtGood, perLF: sf.perLFAtGood },
    osf,
    `${label} sell-for targets`,
  );
  checkEqual(
    E.marginLadder(est, pricing, mine).map((r) => ({ target: originalTarget(r.target), covered: r.covered })),
    V.ladder(est, pricing, theirs),
    `${label} margin ladder`,
  );
  const cap = E.costAgainstPrice(est, pricing, mine);
  checkEqual({ rows: cap.rows.map((r) => [r.amount, r.perSquare, r.perLF]), ratio: cap.ratio, tone: cap.tone }, V.perUnit(est, pricing, theirs), `${label} cost against price`);
  checkEqual(E.costRows(est, pricing, mine).map((r) => r.auto), V.costAutos(theirs, pricing), `${label} cost table auto column`);
  checkEqual(E.marginTone(mine.margin, pricing), O.marginTone(theirs.margin, pricing), `${label} margin tone`);
  est.roof.sections.forEach((s: any, j: number) => {
    const sv = E.sectionPreview(pricing, s);
    checkEqual({ total: sv.total, outOfRange: sv.outOfRange }, V.section(pricing, s), `${label} section card ${j}`);
  });
  est.gutter.runs.forEach((r: any, j: number) => {
    const rv = E.gutterRunPreview(pricing, r);
    checkEqual({ total: rv.total, belowMinimum: rv.belowMinimum }, V.run(pricing, r), `${label} run card ${j}`);
  });
  const pf = E.proposalFigures(est, pricing, mine);
  checkEqual(
    { m: pf.payments.atSigning, v: pf.payments.onDelivery, b: pf.payments.balance, y: pf.insuranceTotal, balancePct: pf.payments.balancePct },
    V.proposal(theirs, est.proposal),
    `${label} proposal payments`,
  );
  check(E.measurementConfidence(est) === O.confidence(est), `${label} confidence`);
  batch.push({ est, p: pricing });
  caseCount++;
}

// Dashboard and estimate-vs-actual over batches of estimates sharing a price book.
for (let i = 0; i < batch.length; i += 10) {
  const group = batch.slice(i, i + 10);
  const p = group[0].p;
  const ests = group.filter((g) => g.p === p).map((g) => g.est);
  const ds = E.dashboardStats(clone(ests), clone(p), NOW);
  checkEqual(
    {
      openCount: ds.openCount, pipeline: ds.pipeline, soldCount: ds.soldCount, soldTotal: ds.soldTotal, soldProfit: ds.soldProfit,
      soldMargin: ds.soldMargin, averageMargin: ds.averageMargin, belowTarget: ds.belowTarget.map((e) => e.id),
      seg: ds.statusSegments.map((s) => s.value), statusTotal: ds.statusTotal, age: ds.pricingAgeDays, stale: ds.pricingStale,
    },
    V.dashboard(clone(ests), clone(p)),
    `dashboard batch ${i / 10}`,
  );
  checkEqual(
    E.estimateVsActual(clone(ests), clone(p)).map((r) => ({
      id: r.estimate.id, contract: r.contract, estimatedCost: r.estimatedCost, actualCost: r.actualCost, underEstimate: r.underEstimate,
      variance: r.variance, estimatedMargin: r.estimatedMargin, actualMargin: r.actualMargin,
    })),
    V.vsActual(clone(ests), clone(p)),
    `estimate vs actual batch ${i / 10}`,
  );
}

// Self-test rows under random price books.
for (let i = 0; i < 40; i++) {
  const p = randomPricing();
  // The self-test's hand-worked expectations need real numbers.
  const numeric = JSON.parse(JSON.stringify(p), (_k, v) => (typeof v === 'string' && v !== '' && isFinite(Number(v)) ? Number(v) : v));
  const mine = E.runSelfTest(numeric);
  const theirs = O.selfTest(numeric);
  checkEqual(
    { pass: mine.passed, total: mine.total, rows: mine.rows.map((r) => ({ name: r.name, pass: r.pass, got: r.got, expected: r.expected, span: r.summary })) },
    { pass: theirs.pass, total: theirs.total, rows: theirs.rows.map((r: any) => ({ name: r.name, pass: r.pass, got: r.got, expected: r.expected, span: r.span })) },
    `self-test under random pricing ${i}`,
  );
}

// ---------- factories, helpers ----------

const stripVolatile = (x: any): any =>
  JSON.parse(JSON.stringify(x), (k, v) => (['id', 'createdAt', 'updatedAt', 'date'].includes(k) ? '<volatile>' : v));
for (let i = 0; i < 20; i++) {
  const p = randomPricing();
  checkEqual(stripVolatile(E.newEstimate(p, 1000 + i)), stripVolatile(O.newEstimate(p, 1000 + i)), `newEstimate ${i}`);
  checkEqual(stripVolatile(E.newRoofSection(p, i)), stripVolatile(O.newSection(p, i)), `newRoofSection ${i}`);
  checkEqual(stripVolatile(E.newGutterRun(p, i)), stripVolatile(O.newRun(p, i)), `newGutterRun ${i}`);
}
checkEqual(E.defaultPriceBook(), O.priceBook(), 'default price book');
{
  const p = E.defaultPriceBook();
  const ei: any = { state: { pricing: p, estimates: [], seq: 1001 } };
  O.seedSamples(ei, () => {});
  const mine = E.sampleEstimates(p, 1001);
  checkEqual(stripVolatile(mine.estimates), stripVolatile(ei.state.estimates), 'seeded sample estimates');
  check(mine.seq === ei.state.seq, 'seq after seeding');
}

const numberish = [0, -0, 1, -1, 1.005, 2.675, -2.675, 0.125, 1234.5678, -1234.5, 1e21, 1e-7, '12.5', ' 7 ', '1,234', '3abc', '', null, undefined, NaN, Infinity, -Infinity, true, '0x10', '-0', '.5'];
for (const v of numberish) {
  check(Object.is(E.toNumber(v), O.toNumber(v)), `toNumber(${String(v)})`);
  check(Object.is(E.round2(v), O.round2(v)), `round2(${String(v)})`);
  check(E.formatMoney(v) === O.money(v), `formatMoney(${String(v)})`);
  check(E.formatMoneyWhole(v) === O.moneyWhole(v), `formatMoneyWhole(${String(v)})`);
  if (typeof v === 'number') check(E.formatPct(v) === O.pct(v), `formatPct(${v})`);
}
for (let i = 0; i < 200; i++) {
  const v = rand() < 0.5 ? dec(-100000, 100000, int(0, 6)) : rand() * 1e6 - 5e5;
  check(Object.is(E.round2(v), O.round2(v)) && E.formatMoney(v) === O.money(v) && E.formatPct(v) === O.pct(v), `number helpers on ${v}`);
}
for (const date of ['2026-08-24', '2026-03-07', '2025-12-31', '2026-11-01', '2024-02-28']) {
  for (const days of [0, 1, 30, 45, 120, '30', '', -10]) check(E.addDays(date, days) === O.addDays(date, days), `addDays(${date}, ${days})`);
  check(E.formatDate(date) === O.formatDate(date), `formatDate(${date})`);
}
check(E.formatDate('') === O.formatDate(''), 'formatDate blank');
{
  const base = E.defaultPriceBook();
  const over = { roof: { pitchStep: 25, extra: { a: 1 } }, mfrs: { IKO: { products: ['X'] } }, gutter: { downspouts: { '5x6': 20 } }, version: '2027-01-01' };
  checkEqual(E.deepMerge(base, over), O.deepMerge(base, over), 'deepMerge');
  checkEqual(E.deepMerge(base, null), O.deepMerge(base, null), 'deepMerge null');
  const a = clone(base);
  const b = clone(base);
  for (const [path, value] of [['roof.pitchStep', 30], ['gutter.downspouts.3x4', 13], ['mfrs.OC.products.1', 'Z'], ['nope.x.y', 1], ['cost.commissionBasis', 'profit']] as const) {
    E.setPath(a, path, value);
    O.setPath(b, path, value);
    check(Object.is(E.getPath(a, path), O.getPath(b, path)), `getPath ${path}`);
  }
  checkEqual(a, b, 'setPath');
}

console.log(`  ${caseCount} randomized estimates (seed ${SEED}), ${warningCount} original warnings matched, ${compared.leaves} leaf values compared`);
finish('parity');
