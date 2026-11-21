const DAY = 86400000;

export function formatDate(d) {
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
