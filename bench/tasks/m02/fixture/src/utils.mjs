// ---- strings ----

// "ann o'neil" -> "Ann O'neil"; whitespace is kept as it is
export function titleCase(s) {
  return s.toLowerCase().replace(/(^|\s)(\S)/g, (_, space, ch) => space + ch.toUpperCase());
}

// Keeps at most n characters, the last one being the ellipsis when something was cut.
export function truncate(s, n) {
  if (s.length <= n) return s;
  if (n < 1) return '';
  return s.slice(0, n - 1) + '…';
}

export function pad(value, width, ch = ' ') {
  return String(value).padStart(width, ch);
}

// ---- numbers ----

export function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}

export function roundTo(x, digits = 0) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function percent(part, total) {
  return total === 0 ? 0 : roundTo((part / total) * 100, 1);
}

// ---- dates ----
const DAY = 86400000;

export function fmtDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new TypeError('invalid date');
  return d.toISOString().slice(0, 10);
}

// signed, whole days, rounded
export function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / DAY);
}

export function addDays(d, n) {
  return new Date(d.getTime() + n * DAY);
}
