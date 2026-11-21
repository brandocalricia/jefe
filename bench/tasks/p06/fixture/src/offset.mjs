import { SlotwiseError } from './errors.mjs';
import { formatDate, parseDate } from './time.mjs';

// A time zone is a fixed offset from UTC in whole minutes, between -720 (-12:00) and +840 (+14:00).
export function parseOffset(text) {
  const m = typeof text === 'string' ? /^(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(text) : null;
  if (!m) throw new SlotwiseError('E_INVALID', `invalid offset: ${text}`);
  if (text === 'Z') return 0;
  const total = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  if (Number(m[3]) > 59 || total < -720 || total > 840) throw new SlotwiseError('E_INVALID', `invalid offset: ${text}`);
  return total;
}

export function formatOffset(minutes) {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// Calendar date, minute of the local day and weekday (0 = Sunday) of an instant in the given offset.
export function localParts(instant, offset) {
  const local = instant + offset;
  const day = Math.floor(local / 1440);
  return { date: formatDate(day), minuteOfDay: local - day * 1440, weekday: (((day + 4) % 7) + 7) % 7 };
}

// The instants from local midnight (inclusive) to the next local midnight (exclusive).
export function dayRange(date, offset) {
  const start = parseDate(date) * 1440 - offset;
  return { start, end: start + 1440 };
}
