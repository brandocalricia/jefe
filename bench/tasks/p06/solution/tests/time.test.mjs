import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstant, formatInstant, parseDate, formatDate, addDays, weekdayOf } from '../src/time.mjs';

test('parseInstant reads UTC and offset forms', () => {
  assert.equal(parseInstant('1970-01-01T00:00Z'), 0);
  assert.equal(parseInstant('1970-01-01T01:00+01:00'), 0);
  assert.equal(parseInstant('2025-03-10T09:00-05:00'), parseInstant('2025-03-10T14:00Z'));
  assert.equal(parseInstant('2025-03-10T09:00+05:30'), parseInstant('2025-03-10T03:30Z'));
  assert.equal(parseInstant('1969-12-31T23:59Z'), -1);
});

test('parseInstant rejects malformed text', () => {
  for (const bad of ['2025-03-10 09:00Z', '2025-02-30T09:00Z', '2025-03-10T24:00Z', '2025-03-10T09:60Z', '2025-03-10T09:00:00Z', '2025-03-10T09:00+15:00', '2025-03-10T09:00-12:30', '2025-03-10T09:00', 42, null]) {
    assert.throws(() => parseInstant(bad), { code: 'E_INVALID', message: `invalid instant: ${bad}` });
  }
  assert.equal(parseInstant('2025-03-10T09:00+14:00'), parseInstant('2025-03-09T19:00Z'));
  assert.equal(parseInstant('2025-03-10T09:00-12:00'), parseInstant('2025-03-10T21:00Z'));
  assert.equal(parseInstant('2024-02-29T00:00Z') + 1440, parseInstant('2024-03-01T00:00Z'));
});

test('formatInstant writes the given offset with a numeric suffix', () => {
  assert.equal(formatInstant(0), '1970-01-01T00:00+00:00');
  const t = parseInstant('2025-03-10T09:00Z');
  assert.equal(formatInstant(t, 120), '2025-03-10T11:00+02:00');
  assert.equal(formatInstant(t, -300), '2025-03-10T04:00-05:00');
  assert.equal(formatInstant(t, 330), '2025-03-10T14:30+05:30');
  assert.equal(formatInstant(0, -300), '1969-12-31T19:00-05:00');
  assert.equal(parseInstant(formatInstant(t, -90)), t);
});

test('dates', () => {
  assert.equal(parseDate('1970-01-02'), 1);
  assert.equal(formatDate(parseDate('2025-03-10')), '2025-03-10');
  assert.equal(addDays('2025-02-28', 1), '2025-03-01');
  assert.equal(addDays('2025-03-01', -1), '2025-02-28');
  assert.equal(addDays('2024-12-31', 1), '2025-01-01');
  assert.throws(() => parseDate('2025-13-01'), { code: 'E_INVALID', message: 'invalid date: 2025-13-01' });
  assert.throws(() => parseDate('2025-3-1'), { code: 'E_INVALID' });
});

test('weekdayOf counts from Sunday', () => {
  assert.equal(weekdayOf('2025-03-09'), 0);
  assert.equal(weekdayOf('2025-03-10'), 1);
  assert.equal(weekdayOf('2025-03-15'), 6);
  assert.equal(weekdayOf('1970-01-01'), 4);
  assert.equal(weekdayOf('1969-12-31'), 3);
});
