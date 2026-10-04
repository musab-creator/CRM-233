// Number and text formatting used by Roof Measure's panels and reports.
// Locale is fixed to en-US (the tool used the browser default, which is en-US
// for every user it was built for).

export const fmt = (n: number, d = 0) =>
  (Math.round(n * 10 ** d) / 10 ** d).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// 12.5 -> 12' 6"
export const ftIn = (ft: number) => {
  const f = Math.floor(ft);
  let i = Math.round((ft - f) * 12);
  let F = f;
  if (i === 12) { F += 1; i = 0; }
  return `${F}' ${i}"`;
};

// 12.5 -> 12ft 6in (Roofr style)
export const ftInR = (ft: number) => {
  const f = Math.floor(ft);
  let i = Math.round((ft - f) * 12);
  let F = f;
  if (i === 12) { F += 1; i = 0; }
  return `${F}ft ${i}in`;
};

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function pitchLabel(p: number) {
  return p === 0 ? 'Flat' : `${fmt(p, Number.isInteger(p) ? 0 : 1)}/12`;
}

export const degToPitch = (deg: number) => 12 * Math.tan((deg * Math.PI) / 180);

export function csvCell(v: unknown) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
