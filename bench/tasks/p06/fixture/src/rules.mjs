import { SlotwiseError } from './errors.mjs';
import { dayRange } from './offset.mjs';
import { formatDate, parseDate, weekdayOf } from './time.mjs';
import { DAYS, parseClock } from './hours.mjs';

const bad = (what) => new SlotwiseError('E_INVALID', `invalid rule: ${what}`);

// A recurring availability rule opens an extra window (from-to) on every date it produces.
//   { frequency: 'daily' | 'weekly', interval: 1, start: 'YYYY-MM-DD', until: 'YYYY-MM-DD', count: 10,
//     weekdays: ['mon', 'wed'], from: '10:00', to: '12:00' }
export function validateRule(rule) {
  if (rule === null || typeof rule !== 'object') throw bad('not an object');
  if (rule.frequency !== 'daily' && rule.frequency !== 'weekly') throw bad('frequency');
  const interval = rule.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) throw bad('interval');
  let start;
  try { parseDate(rule.start); start = rule.start; } catch { throw bad('start'); }
  let until = null;
  if (rule.until !== undefined && rule.until !== null) {
    try { parseDate(rule.until); } catch { throw bad('until'); }
    if (rule.until < start) throw bad('until');
    until = rule.until;
  }
  const count = rule.count ?? null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) throw bad('count');
  if (until === null && count === null) throw bad('needs until or count');
  let weekdays = [];
  if (rule.frequency === 'weekly') {
    weekdays = rule.weekdays ?? [DAYS[weekdayOf(start)]];
    if (!Array.isArray(weekdays) || weekdays.length === 0 || weekdays.some((d) => !DAYS.includes(d))) throw bad('weekdays');
    weekdays = DAYS.filter((d) => weekdays.includes(d));
  }
  if (parseClock(rule.from) >= parseClock(rule.to)) throw bad('window');
  return { frequency: rule.frequency, interval, start, until, count, weekdays, from: rule.from, to: rule.to };
}

function matches(rule, day, first, weekdayNumbers) {
  if (rule.frequency === 'daily') return (day - first) % rule.interval === 0;
  const weekday = (((day + 4) % 7) + 7) % 7;
  return weekdayNumbers.includes(weekday) && Math.floor((day - first) / 7) % rule.interval === 0;
}

// Dates (YYYY-MM-DD, ascending) from fromDate to toDate inclusive on which the rule produces a window.
// `count` counts occurrences from the rule's start, not from fromDate; `until` is the last allowed date.
export function occurrenceDates(rule, fromDate, toDate) {
  const r = validateRule(rule);
  const first = parseDate(r.start);
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  const weekdayNumbers = r.weekdays.map((d) => DAYS.indexOf(d));
  const out = [];
  let seen = 0;
  for (let day = first; day <= to; day++) {
    if (r.until !== null && day >= parseDate(r.until)) break;
    if (!matches(r, day, first, weekdayNumbers)) continue;
    seen++;
    if (day >= from) out.push(formatDate(day));
    if (r.count !== null && seen >= r.count) break;
  }
  return out;
}

// The rule's window on one local date as an interval of instants, or [] when the rule does not occur that day.
export function ruleIntervals(rule, date, offset) {
  if (occurrenceDates(rule, date, date).length === 0) return [];
  const r = validateRule(rule);
  const { start } = dayRange(date, offset);
  return [{ start: start + parseClock(r.from), end: start + parseClock(r.to) }];
}

