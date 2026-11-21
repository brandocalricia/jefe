// Output formatting helpers.
import { safe } from '../../hooks/projects.mjs';

// A moment as `YYYY-MM-DD HH:MM zone` in the local time zone (zone: the short name the system gives, e.g. MST, or GMT-7).
export function stampOf(t) {
  const d = t instanceof Date ? t : new Date(t);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  const p = (n) => String(n).padStart(2, '0');
  let zone = '';
  try {
    zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value || '';
  } catch {
    zone = '';
  }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${zone ? ` ${zone}` : ''}`;
}

export const oneLine =(t, max) => {
  const x = safe(String(t)).replace(/\s+/g, ' ').trim();
  return x.length > max ? x.slice(0, max - 3) + '...' : x;
};
