import { SlotwiseError } from './errors.mjs';
import { dayRange, localParts } from './offset.mjs';
import { mergeIntervals } from './interval.mjs';

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// "HH:MM" to minutes after midnight. "24:00" is allowed and means the end of the day (1440).
export function parseClock(text) {
  const m = typeof text === 'string' ? /^(\d{2}):(\d{2})$/.exec(text) : null;
  const h = m ? Number(m[1]) : NaN;
  const mi = m ? Number(m[2]) : NaN;
  if (!m || mi > 59 || h > 24 || (h === 24 && mi !== 0)) throw new SlotwiseError('E_INVALID', `invalid clock: ${text}`);
  return (h % 24) * 60 + mi;
}

export function formatClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// Weekly opening hours: { mon: [['09:00', '12:00'], ['13:00', '17:00']], ... }. Returns every day as a sorted,
// merged list of { open, close } in minutes; days that are not given are closed.
export function validateHours(hours = {}) {
  const out = {};
  for (const key of Object.keys(hours)) {
    if (!DAYS.includes(key)) throw new SlotwiseError('E_INVALID', `invalid hours: unknown day ${key}`);
  }
  for (const day of DAYS) {
    const windows = (hours[day] ?? []).map((pair) => {
      const open = parseClock(pair[0]);
      const close = parseClock(pair[1]);
      if (close <= open) throw new SlotwiseError('E_INVALID', `invalid hours for ${day}`);
      return { start: open, end: close };
    });
    out[day] = mergeIntervals(windows).map((w) => ({ open: w.start, close: w.end }));
  }
  return out;
}

// Opening hours of one local calendar day as intervals of instants.
export function openIntervals(hours, date, offset) {
  const { start } = dayRange(date, offset);
  const { weekday } = localParts(start, offset);
  return mergeIntervals((hours[DAYS[weekday]] ?? []).map((w) => ({ start: start + w.open, end: start + w.close })));
}
