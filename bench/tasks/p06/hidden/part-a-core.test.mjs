// Part A: time, offsets, intervals, opening hours, recurring rules (issues 1-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstant, formatInstant, parseDate, addDays, weekdayOf, formatDate } from '../src/time.mjs';
import { parseOffset, formatOffset, localParts, dayRange } from '../src/offset.mjs';
import { makeInterval, overlaps, contains, intersect, mergeIntervals, subtractIntervals, totalLength, coverageAtLeast } from '../src/interval.mjs';
import { parseClock, formatClock, validateHours, openIntervals } from '../src/hours.mjs';
import { validateRule, occurrenceDates, ruleIntervals } from '../src/rules.mjs';
import { createResource } from '../src/resource.mjs';
import { openWindows } from '../src/availability.mjs';

const iv = (start, end) => ({ start, end });

test('issue 1: touching intervals do not overlap', () => {
  assert.equal(overlaps(iv(0, 10), iv(10, 20)), false);
  assert.equal(overlaps(iv(10, 20), iv(0, 10)), false);
  assert.equal(overlaps(iv(0, 10), iv(9, 20)), true);
  assert.equal(overlaps(iv(0, 10), iv(3, 4)), true);
  assert.equal(overlaps(iv(0, 10), iv(11, 12)), false);
  assert.deepEqual(coverageAtLeast([iv(0, 10), iv(10, 20)], 2), []);
});

test('issue 2: merging never shrinks an interval', () => {
  assert.deepEqual(mergeIntervals([iv(0, 100), iv(10, 20)]), [iv(0, 100)]);
  assert.deepEqual(mergeIntervals([iv(10, 20), iv(0, 100), iv(30, 40)]), [iv(0, 100)]);
  assert.deepEqual(mergeIntervals([iv(0, 10), iv(10, 20), iv(30, 35)]), [iv(0, 20), iv(30, 35)]);
  const hours = validateHours({ mon: [['09:00', '17:00'], ['10:00', '12:00']] });
  assert.deepEqual(hours.mon, [{ open: 540, close: 1020 }]);
  const room = createResource({ id: 'r', name: 'R', hours: { mon: [['09:00', '17:00']] }, rules: [{ frequency: 'weekly', start: '2025-03-10', count: 3, from: '10:00', to: '12:00' }] });
  assert.deepEqual(openWindows(room, '2025-03-10'), [iv(parseInstant('2025-03-10T09:00Z'), parseInstant('2025-03-10T17:00Z'))]);
});

test('issue 3: hours may end at 24:00', () => {
  assert.equal(parseClock('24:00'), 1440);
  assert.equal(parseClock('00:00'), 0);
  assert.equal(formatClock(1440), '24:00');
  assert.deepEqual(validateHours({ fri: [['18:00', '24:00']] }).fri, [{ open: 1080, close: 1440 }]);
  assert.deepEqual(openIntervals(validateHours({ fri: [['08:00', '24:00']] }), '2025-03-14', 0), [iv(parseInstant('2025-03-14T08:00Z'), parseInstant('2025-03-15T00:00Z'))]);
  assert.throws(() => parseClock('24:01'), { code: 'E_INVALID', message: 'invalid clock: 24:01' });
  assert.throws(() => validateHours({ fri: [['24:00', '24:00']] }), { message: 'invalid hours for fri' });
});

test('issue 4: a rule includes its until date', () => {
  const rule = { frequency: 'weekly', start: '2025-04-02', until: '2025-04-30', from: '10:00', to: '12:00' };
  assert.deepEqual(occurrenceDates(rule, '2025-04-01', '2025-06-01'), ['2025-04-02', '2025-04-09', '2025-04-16', '2025-04-23', '2025-04-30']);
  assert.deepEqual(occurrenceDates({ frequency: 'daily', start: '2025-04-02', until: '2025-04-02', from: '10:00', to: '11:00' }, '2025-04-01', '2025-04-05'), ['2025-04-02']);
  assert.equal(ruleIntervals(rule, '2025-04-30', 0).length, 1);
  assert.deepEqual(ruleIntervals(rule, '2025-05-07', 0), []);
  assert.deepEqual(occurrenceDates({ ...rule, count: 2 }, '2025-04-01', '2025-06-01'), ['2025-04-02', '2025-04-09']);
});

test('regression: time conversions', () => {
  assert.equal(parseInstant('2025-03-10T09:00+02:00'), parseInstant('2025-03-10T07:00Z'));
  assert.equal(formatInstant(parseInstant('2025-03-10T07:00Z'), -300), '2025-03-10T02:00-05:00');
  assert.equal(formatInstant(0), '1970-01-01T00:00+00:00');
  assert.throws(() => parseInstant('2025-03-10T09:00:00Z'), { code: 'E_INVALID', message: 'invalid instant: 2025-03-10T09:00:00Z' });
  assert.throws(() => parseDate('2025-02-29'), { message: 'invalid date: 2025-02-29' });
  assert.equal(addDays('2025-03-31', 1), '2025-04-01');
  assert.equal(weekdayOf('2025-03-09'), 0);
  assert.equal(weekdayOf('2025-03-15'), 6);
  assert.equal(formatDate(parseDate('2024-02-29')), '2024-02-29');
});

test('regression: offsets and local days', () => {
  assert.equal(parseOffset('-12:00'), -720);
  assert.equal(parseOffset('+05:30'), 330);
  assert.throws(() => parseOffset('+14:30'), { message: 'invalid offset: +14:30' });
  assert.equal(formatOffset(-570), '-09:30');
  assert.deepEqual(localParts(parseInstant('2025-03-10T23:30Z'), 60), { date: '2025-03-11', minuteOfDay: 30, weekday: 2 });
  assert.deepEqual(dayRange('2025-03-10', 120), { start: parseInstant('2025-03-09T22:00Z'), end: parseInstant('2025-03-10T22:00Z') });
});

test('regression: interval helpers', () => {
  assert.throws(() => makeInterval(3, 3), { code: 'E_INVALID', message: 'invalid interval' });
  assert.equal(contains(iv(0, 10), iv(0, 10)), true);
  assert.equal(contains(iv(0, 10), iv(5, 11)), false);
  assert.deepEqual(intersect(iv(0, 10), iv(5, 15)), iv(5, 10));
  assert.equal(intersect(iv(0, 5), iv(5, 9)), null);
  assert.deepEqual(subtractIntervals([iv(0, 100)], [iv(50, 60), iv(10, 20)]), [iv(0, 10), iv(20, 50), iv(60, 100)]);
  assert.deepEqual(subtractIntervals([iv(0, 10)], [iv(0, 10)]), []);
  assert.equal(totalLength([iv(0, 10), iv(5, 20)]), 20);
  assert.deepEqual(coverageAtLeast([iv(0, 10), iv(5, 15), iv(8, 20)], 2), [iv(5, 15)]);
  const list = [iv(5, 6), iv(0, 1)];
  mergeIntervals(list);
  assert.deepEqual(list, [iv(5, 6), iv(0, 1)]);
});

test('regression: hours and rules validation, resources', () => {
  assert.deepEqual(validateHours({ mon: [['13:00', '17:00'], ['09:00', '13:00']] }).mon, [{ open: 540, close: 1020 }]);
  assert.throws(() => validateHours({ mon: [['10:00', '09:00']] }), { message: 'invalid hours for mon' });
  assert.throws(() => validateHours({ funday: [] }), { message: 'invalid hours: unknown day funday' });
  assert.deepEqual(validateRule({ frequency: 'weekly', start: '2025-04-02', count: 2, from: '10:00', to: '11:00' }).weekdays, ['wed']);
  assert.throws(() => validateRule({ frequency: 'daily', start: '2025-04-02', from: '10:00', to: '11:00' }), { message: 'invalid rule: needs until or count' });
  assert.deepEqual(occurrenceDates({ frequency: 'weekly', interval: 2, start: '2025-04-01', weekdays: ['tue'], count: 3, from: '10:00', to: '11:00' }, '2025-04-01', '2025-12-31'), ['2025-04-01', '2025-04-15', '2025-04-29']);
  const r = createResource({ id: 'room-1', name: 'Room 1', offset: '+02:00', capacity: 2, buffer: 10 });
  assert.deepEqual([r.offset, r.capacity, r.buffer], [120, 2, 10]);
  assert.throws(() => createResource({ id: 'Bad Id', name: 'x' }), { message: 'invalid resource: id' });
  assert.equal(createResource({ id: 'a', name: 'A' }).capacity, 1);
});
