// Tiny assertion helpers for the engine tests (no test framework in this repo).
let passed = 0, failed = 0;
const failures = [];

export function check(name, ok, detail) {
  if (ok) passed++;
  else { failed++; failures.push(`${name}${detail !== undefined ? ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}

// Deep comparison: numbers within a relative tolerance (absolute near zero), everything else exactly.
// Returns a list of differences "path: a vs b".
export function diff(a, b, tol = 1e-9, path = '$', out = [], limit = 20) {
  if (out.length >= limit) return out;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return out;
    if (a === b) return out;
    const d = Math.abs(a - b), s = Math.max(Math.abs(a), Math.abs(b));
    if (!(d <= tol * Math.max(s, 1e-6))) out.push(`${path}: ${a} vs ${b}`);
    return out;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 200)} vs ${JSON.stringify(b)?.slice(0, 200)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${path}: array vs object`); return out; }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a) || !(k in b)) {
      const va = a[k], vb = b[k];
      if (va === undefined && vb === undefined) continue;
      out.push(`${path}.${k}: ${k in a ? 'only in first' : 'only in second'}`);
      continue;
    }
    diff(a[k], b[k], tol, `${path}.${k}`, out, limit);
  }
  return out;
}

// Counts compared leaf values (numbers, strings, booleans, null).
export function countLeaves(v) {
  if (v === null || typeof v !== 'object') return 1;
  let n = 0; for (const k of Object.keys(v)) n += countLeaves(v[k]);
  return n;
}

export function summary(name) {
  console.log(`${name}: ${passed} passed, ${failed} failed`);
  for (const f of failures.slice(0, 40)) console.log('  FAIL ' + f);
  if (failed) process.exitCode = 1;
  return { passed, failed };
}
