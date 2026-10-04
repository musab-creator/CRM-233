// Number, money, date and object helpers, ported one-for-one from the
// original estimator so every figure rounds and prints identically.

// Lenient numeric coercion: "12.5" -> 12.5, "" / null / "abc" / Infinity -> 0.
export function toNumber(value: unknown): number {
  const n = parseFloat(value as string);
  return isFinite(n) ? n : 0;
}

// Round to cents. The EPSILON nudge makes 1.005 round up like a person would.
export function round2(value: unknown): number {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

// "$1,234.56" / "-$12.00"
export function formatMoney(value: unknown): string {
  return (
    (toNumber(value) < 0 ? '-$' : '$') +
    Math.abs(round2(value)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

// "$1,235" — whole dollars.
export function formatMoneyWhole(value: unknown): string {
  return (toNumber(value) < 0 ? '-$' : '$') + Math.abs(Math.round(toNumber(value))).toLocaleString('en-US');
}

// "32.5%"; "—%" for NaN/Infinity.
export function formatPct(value: number): string {
  return (isFinite(value) ? round2(value).toFixed(1) : '—') + '%';
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// YYYY-MM-DD plus a number of days (noon local time, so DST never shifts the day).
export function addDays(date: string, days: unknown): string {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() + toNumber(days));
  return d.toISOString().slice(0, 10);
}

// "Aug 24, 2026"; "—" for a blank date.
export function formatDate(date: string | undefined | null): string {
  return date
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
}

type Json = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

// Recursively overlays `over` onto `base`; arrays and scalars in `over` replace.
export function deepMerge<T>(base: T, over: unknown): T {
  const out = (Array.isArray(base) ? base.slice() : Object.assign({}, base)) as Json;
  if (over && typeof over === 'object') {
    for (const key in over as Json) {
      const v = (over as Json)[key];
      const b = (base as Json)[key];
      out[key] = isPlainObject(v) && isPlainObject(b) ? deepMerge(b, v) : v;
    }
  }
  return out as T;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Reads a dotted path ("gutter.downspouts.3x4", "roof.items.4.qty").
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[parseInt(key, 10)] : (cur as Json)[key];
  }
  return cur;
}

// Writes a dotted path in place. Does nothing if an intermediate step is missing.
export function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    cur = Array.isArray(cur) ? cur[parseInt(key, 10)] : (cur as Json)[key];
    if (cur == null) return;
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(cur)) cur[parseInt(last, 10)] = value;
  else (cur as Json)[last] = value;
}
