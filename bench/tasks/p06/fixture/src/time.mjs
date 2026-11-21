import { SlotwiseError } from './errors.mjs';

// Instants are whole minutes since 1970-01-01T00:00Z. Text form: YYYY-MM-DDTHH:MM followed by Z or +HH:MM / -HH:MM.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MINUTES = 1440;

const pad = (n, width = 2) => String(n).padStart(width, '0');

function validCivil(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function suffixMinutes(suffix) {
  if (suffix === 'Z') return 0;
  const sign = suffix[0] === '-' ? -1 : 1;
  const mins = Number(suffix.slice(4, 6));
  const total = sign * (Number(suffix.slice(1, 3)) * 60 + mins);
  return mins < 60 && total >= -720 && total <= 840 ? total : null;
}

export function parseDate(text) {
  const m = typeof text === 'string' ? DATE.exec(text) : null;
  if (!m || !validCivil(Number(m[1]), Number(m[2]), Number(m[3]))) throw new SlotwiseError('E_INVALID', `invalid date: ${text}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

export function formatDate(dayNumber) {
  const t = new Date(dayNumber * 86400000);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function addDays(text, n) {
  return formatDate(parseDate(text) + n);
}

// 0 = Sunday ... 6 = Saturday. Day 0 (1970-01-01) was a Thursday.
export function weekdayOf(text) {
  return (((parseDate(text) + 4) % 7) + 7) % 7;
}

export function parseInstant(text) {
  const m = typeof text === 'string' ? INSTANT.exec(text) : null;
  const fail = () => new SlotwiseError('E_INVALID', `invalid instant: ${text}`);
  if (!m) throw fail();
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const offset = suffixMinutes(m[6]);
  if (!validCivil(y, mo, d) || h > 23 || mi > 59 || offset === null) throw fail();
  return Date.UTC(y, mo - 1, d) / 60000 + h * 60 + mi - offset;
}

export function formatInstant(instant, offset = 0) {
  const local = instant + offset;
  const day = Math.floor(local / DAY_MINUTES);
  const rest = local - day * DAY_MINUTES;
  const abs = Math.abs(offset);
  const suffix = `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${formatDate(day)}T${pad(Math.floor(rest / 60))}:${pad(rest % 60)}${suffix}`;
}
