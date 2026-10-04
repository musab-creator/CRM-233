// The estimator's own built-in self-test, ported. Run from roofing-crm/:
//   node --experimental-strip-types src/lib/estimator/__tests__/selftest.test.ts
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
const { check, finish } = (await import('./check' as string)) as typeof import('./check');
const E = (await import('../index' as string)) as typeof import('../index');

const result = E.runSelfTest(E.defaultPriceBook());
for (const row of result.rows) {
  console.log(`  ${row.pass ? 'pass' : 'FAIL'}  ${row.name}${row.summary ? ' — ' + row.summary : ` (${row.qty}: expected ${row.expected}, got ${row.got})`}`);
  check(row.pass, row.name);
}
check(result.total === 8, 'eight self-test rows');
check(result.passed === result.total, `${result.passed} / ${result.total} pass`);

// The solver must also hold under the other commission and overhead plans.
const variants: [string, (p: ReturnType<typeof E.defaultPriceBook>) => void][] = [
  ['commission on profit', (p) => (p.cost.commissionBasis = 'profit')],
  ['flat overhead', (p) => (p.cost.overheadBasis = 'flat')],
  ['profit commission + flat overhead + financing', (p) => {
    p.cost.commissionBasis = 'profit';
    p.cost.commissionPct = 25;
    p.cost.overheadBasis = 'flat';
    p.cost.financingPct = 2.5;
  }],
];
for (const [label, tweak] of variants) {
  const p = E.defaultPriceBook();
  tweak(p);
  const r = E.runSelfTest(p);
  check(r.passed === r.total, `${label}: ${r.passed} / ${r.total} pass`);
}

// Known quirk inherited from the original (it fails the same way): with a 3%
// financing fee the solver's cent rounding puts the small 6" gutter job's
// break-even price 0.0001% off, just outside the 1e-4 tolerance.
{
  const p = E.defaultPriceBook();
  p.cost.financingPct = 3;
  const r = E.runSelfTest(p);
  check(r.passed === 7 && !r.rows[6].pass && /5 — 6" gutter installation @ 0%/.test(r.rows[6].summary || ''),
    'financing 3%: solver row fails exactly like the original');
}

finish('self-test');
