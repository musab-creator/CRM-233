// Pulls the original estimator's pure functions out of its minified bundle
// (public/tools/estimator.html), verbatim, so the parity tests can run the
// original code side by side with the port.
//
//   node src/lib/estimator/__tests__/original-source.mjs   # refresh the fixture
//
// The extract is kept as a fixture so the tests keep working after the
// embedded estimator is retired; when estimator.html is present the tests
// also check the fixture still matches it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

export const HTML_PATH = new URL('../../../../public/tools/estimator.html', import.meta.url);
export const FIXTURE_PATH = new URL('./fixtures/original-estimator.js', import.meta.url);

function between(src, start, end, { includeEnd = false } = {}) {
  const a = src.indexOf(start);
  if (a < 0) throw new Error('anchor not found: ' + start);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error('anchor not found: ' + end);
  if (src.indexOf(start, a + 1) >= 0) throw new Error('anchor not unique: ' + start);
  return src.slice(a, includeEnd ? b + end.length : b);
}

export function extractOriginal(html) {
  const pieces = [
    // Helpers (u d f p h m g x v b), price book y(), factories j k w, and all
    // pricing math S C N F L E P $ T R z.
    between(html, 'let u=e=>{let t=parseFloat(e)', 'let O=(...e)=>'),
    // Margin tone.
    between(html, 'function eY(e,t){', 'function eX(e,t){'),
    // Path get/set.
    between(html, 'function eM(e,t,r){', 'function eB(e,t){'),
    // Roof report text parser.
    between(html, 'function eW(e){', 'async function eV('),
    // Built-in self-test.
    between(html, 'function tc(e,t){', 'function td(){'),
    // "Apply to this estimate" (an inline function in the roof page).
    'var applyTakeoff=' + between(html, 'function(e,t,r,n){if(n.address)', '(e,ei.state.pricing,t,t.takeoff)') + ';',
    // First-run sample estimates (reads/writes the app state object `ei`).
    'function seedSamples(ei,em){' +
      between(html, 'if(ei.state.estimates.length||ei.state.seededReports)return;', '}(),eF()') + '}',
  ];
  return (
    '/* eslint-disable */\n// Extracted verbatim from public/tools/estimator.html by original-source.mjs. Do not edit.\n' +
    pieces.join('\n') +
    '\n'
  );
}

// Runs the extract in a fresh context and returns its functions. `now`
// pins Date.now() so the stale-pricing warning is deterministic.
export function loadOriginal({ now } = {}) {
  const source = readFileSync(FIXTURE_PATH, 'utf8');
  const ctx = vm.createContext({ console });
  if (now !== undefined) vm.runInContext(`Date.now = () => ${Number(now)};`, ctx);
  vm.runInContext(
    source +
      '\nglobalThis.ORIGINAL = { toNumber: u, round2: d, money: f, moneyWhole: p, pct: h, addDays: g, formatDate: x,' +
      ' deepMerge: v, deepClone: b, priceBook: y, newSection: j, newRun: k, newEstimate: w, sectionPrice: S,' +
      ' pitchSurcharge: C, storySurcharge: N, billable: F, peelStick: L, gutterRate: E, totals: P, costStructure: $,' +
      ' priceForMargin: T, warnings: R, confidence: z, marginTone: eY, setPath: eM, getPath: eI, parseReport: eH,' +
      ' selfTestCase: tc, selfTest: tu, applyTakeoff, seedSamples };',
    ctx,
  );
  return { original: ctx.ORIGINAL, context: ctx };
}

export function fixtureMatchesHtml() {
  if (!existsSync(HTML_PATH)) return null; // estimator.html retired; nothing to compare
  return extractOriginal(readFileSync(HTML_PATH, 'utf8')) === readFileSync(FIXTURE_PATH, 'utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(FIXTURE_PATH, extractOriginal(readFileSync(HTML_PATH, 'utf8')));
  console.log('wrote', FIXTURE_PATH.pathname);
}
