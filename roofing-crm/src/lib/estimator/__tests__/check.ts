// Minimal assertion helpers for the estimator tests (no test framework is
// installed). Failures are collected and reported together; the process
// exits non-zero if any check failed.

let failures = 0;
let checks = 0;
// Number of leaf values compared by firstDifference(), for reporting.
export const compared = { leaves: 0 };

export function check(ok: unknown, message: string): void {
  checks++;
  if (!ok) {
    failures++;
    if (failures <= 50) console.error('  FAIL ' + message);
  }
}

// Strict structural equality (Object.is on leaves, so -0 ≠ 0 and NaN = NaN).
// Returns the first differing path, or null when equal.
export function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (typeof a !== 'object' || a === null) compared.leaves++;
  if (Object.is(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.join('|') !== kb.join('|')) return `${path}: keys [${ka}] vs [${kb}]`;
  for (const k of ka) {
    const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

export function checkEqual(actual: unknown, expected: unknown, message: string): void {
  const d = firstDifference(actual, expected);
  check(!d, `${message} — ${d}`);
}

export function finish(name: string): void {
  if (failures) {
    console.error(`${name}: ${failures} of ${checks} checks FAILED`);
    process.exit(1);
  }
  console.log(`${name}: all ${checks} checks passed`);
}
